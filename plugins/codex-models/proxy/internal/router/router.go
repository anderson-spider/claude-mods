// Package router serves the Anthropic API surface: it forwards traffic to the
// real API untouched, extends the advertised model list, and answers requests
// for the added models from their own provider.
package router

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/codex"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/netx"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/translate"
	"github.com/tidwall/gjson"
)

// maxRequestBody bounds the request bodies the proxy buffers to inspect.
// Anthropic's own limit is well below this.
const maxRequestBody = 64 << 20

// Router implements http.Handler for the intercepted Anthropic endpoints.
type Router struct {
	cfg      *config.Config
	registry *codex.Registry
	backend  *codex.Backend

	upstream *url.URL
	proxy    *httputil.ReverseProxy
	client   *http.Client

	// Version is reported by the status endpoint, so a caller can tell
	// which build it reached.
	Version string

	// pingInterval is how long a streamed Codex answer may stay silent
	// before a ping goes out; tests shorten it.
	pingInterval time.Duration
}

// New builds a router. transport carries pass-through traffic to the upstream
// API and must not itself route through this proxy; nil means the shared
// direct transport, never http.DefaultTransport, which honours HTTPS_PROXY.
func New(cfg *config.Config, registry *codex.Registry, backend *codex.Backend, transport http.RoundTripper) (*Router, error) {
	upstream, err := url.Parse(cfg.Upstream)
	if err != nil {
		// url.Error repeats the input, which could hold credentials.
		return nil, fmt.Errorf("router: upstream is not a valid URL")
	}
	if transport == nil {
		transport = netx.Shared()
	}

	r := &Router{
		cfg:      cfg,
		registry: registry,
		backend:  backend,
		upstream: upstream,

		pingInterval: defaultPingInterval,
		// Redirects are never followed: a followed redirect would resend
		// the Authorization header, possibly downgraded to http. The 3xx goes
		// back to the client as it came. The ReverseProxy below calls the
		// transport directly and never follows one either.
		client: &http.Client{
			Transport: transport,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}

	r.proxy = &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = upstream.Scheme
			pr.Out.URL.Host = upstream.Host
			if upstream.Path != "" && upstream.Path != "/" {
				pr.Out.URL.Path = strings.TrimSuffix(upstream.Path, "/") + pr.Out.URL.Path
			}
			// The upstream TLS certificate and API routing both key off the
			// Host header, so it must name the real API, not the proxy.
			pr.Out.Host = upstream.Host
			// Guard already removed the secret; this keeps it off the wire
			// should a request ever reach the router another way.
			pr.Out.Header.Del(config.TokenHeader)
		},
		// Server-sent events must not sit in a buffer.
		FlushInterval: -1,
		// No CORS header ever leaves the proxy, so a web page cannot read
		// an answer even if the upstream would allow it.
		ModifyResponse: func(resp *http.Response) error {
			dropCORS(resp.Header)
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, req *http.Request, err error) {
			logx.Errorf("passthrough %s %s: %v", req.Method, req.URL.Path, err)
			writeAnthropicError(w, http.StatusBadGateway, "api_error", "upstream request failed: "+err.Error())
		},
	}
	return r, nil
}

// ServeHTTP dispatches one request.
func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	path := req.URL.Path

	switch {
	case strings.HasPrefix(path, "/__ccmproxy/"):
		r.serveAdmin(w, req)
		return
	case req.Method == http.MethodGet && (path == "/v1/models" || path == "/v1/models/"):
		r.serveModels(w, req)
		return
	case req.Method == http.MethodPost && path == "/v1/messages":
		r.serveMessages(w, req)
		return
	case req.Method == http.MethodPost && path == "/v1/messages/count_tokens":
		r.serveCountTokens(w, req)
		return
	}

	logx.Debugf("passthrough %s %s", req.Method, path)
	r.proxy.ServeHTTP(w, req)
}

// serveMessages routes a Messages request either to the Codex backend or to
// Anthropic, based on the model the body names.
func (r *Router) serveMessages(w http.ResponseWriter, req *http.Request) {
	body, err := readBody(req)
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}

	model := gjson.GetBytes(body.JSON, "model").String()
	resolution, isCodex := r.registry.Resolve(model)
	if !isCodex {
		if model == "" && body.Compressed() && !body.Readable() {
			// Worth saying out loud: an unreadable body is why a request for
			// an added model would silently go to Anthropic instead.
			logx.Warnf("could not read the model from a %s encoded body; routing to %s", body.Encoding, r.cfg.Upstream)
		}
		// Reasoning state this proxy issued would be rejected by Anthropic,
		// so it is dropped when a session switches back to a Claude model.
		if cleaned, changed := translate.StripProxySignatures(body.JSON); changed {
			logx.Debugf("dropped proxy-issued thinking blocks before passing %s upstream", model)
			body.forwardModified(req, cleaned)
		} else {
			body.forward(req)
		}
		logx.Debugf("passthrough messages model=%s", model)
		r.proxy.ServeHTTP(w, req)
		return
	}

	effort := resolveEffort(body.JSON, resolution)
	logx.Infof("codex messages model=%s -> %s effort=%s (%s body)",
		model, resolution.Model.ID, effort, bodyEncodingLabel(body))
	r.serveCodexMessages(w, req, body.JSON, resolution, effort)
}

// serveCountTokens answers token counts for Codex models locally and lets
// Anthropic answer for its own.
func (r *Router) serveCountTokens(w http.ResponseWriter, req *http.Request) {
	body, err := readBody(req)
	if err != nil {
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}

	model := gjson.GetBytes(body.JSON, "model").String()
	if _, isCodex := r.registry.Resolve(model); !isCodex {
		if cleaned, changed := translate.StripProxySignatures(body.JSON); changed {
			body.forwardModified(req, cleaned)
		} else {
			body.forward(req)
		}
		r.proxy.ServeHTTP(w, req)
		return
	}

	r.writeCodexTokenCount(w, body.JSON)
}

func (r *Router) serveAdmin(w http.ResponseWriter, req *http.Request) {
	switch req.URL.Path {
	case "/__ccmproxy/status":
		if req.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeAnthropicError(w, http.StatusMethodNotAllowed, "invalid_request_error", "ccmproxy: status is GET only")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(r.status())
	default:
		http.NotFound(w, req)
	}
}

// Status is the body of GET /__ccmproxy/status. It names the service so a
// caller knows it reached this proxy, and carries no paths, emails or tokens.
type Status struct {
	Service    string   `json:"service"`
	Version    string   `json:"version"`
	CodexLogin bool     `json:"codexLogin"`
	Models     []string `json:"models"`
}

func (r *Router) status() Status {
	version := r.Version
	if version == "" {
		version = "dev"
	}
	models := r.registry.AdvertisedIDs()
	if models == nil {
		models = []string{}
	}
	return Status{
		Service:    "ccmproxy",
		Version:    version,
		CodexLogin: r.backend != nil && r.backend.Store.Authenticated(),
		Models:     models,
	}
}

// bodyEncodingLabel describes how the client sent the body, which is the
// detail that decides whether the model name can be read at all.
func bodyEncodingLabel(body *requestBody) string {
	if !body.Compressed() {
		return "identity"
	}
	return body.Encoding
}

// writeAnthropicError renders an error in the shape Anthropic clients expect.
func writeAnthropicError(w http.ResponseWriter, status int, kind, message string) {
	payload := map[string]any{
		"type": "error",
		"error": map[string]string{
			"type":    kind,
			"message": message,
		},
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
