// Package router serves the Anthropic API surface: it forwards traffic to the
// real API untouched, extends the advertised model list, and answers requests
// for the added models from their own provider.
//
// Which way a Messages request goes is read from its body with the same JSON
// rules translate uses, so a request is never routed by one reading of the
// body and translated by another.
package router

import (
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
)

// adminPrefix holds the proxy's own endpoints, which never reach an upstream.
const adminPrefix = "/__ccmproxy/"

// Router implements http.Handler for the intercepted Anthropic endpoints.
type Router struct {
	cfg      *config.Config
	registry *codex.Registry
	backend  *codex.Backend

	upstream *url.URL
	// proxy forwards everything the router does not answer itself.
	proxy *httputil.ReverseProxy
	// client fetches the upstream model list, which is merged before it
	// goes back.
	client *http.Client

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
	return &Router{
		cfg:          cfg,
		registry:     registry,
		backend:      backend,
		upstream:     upstream,
		proxy:        passthroughProxy(upstream, transport),
		client:       listClient(transport),
		pingInterval: initialPingInterval(),
	}, nil
}

// ServeHTTP dispatches one request.
func (r *Router) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	path := req.URL.Path
	switch {
	case strings.HasPrefix(path, adminPrefix):
		r.serveAdmin(w, req)
	case req.Method == http.MethodGet && (path == "/v1/models" || path == "/v1/models/"):
		r.serveModels(w, req)
	case req.Method == http.MethodPost && path == "/v1/messages":
		r.serveMessages(w, req)
	case req.Method == http.MethodPost && path == "/v1/messages/count_tokens":
		r.serveCountTokens(w, req)
	default:
		logx.Debugf("passthrough %s %s", req.Method, path)
		r.proxy.ServeHTTP(w, req)
	}
}
