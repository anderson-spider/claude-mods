package router

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// passthroughProxy forwards a request to upstream as the client made it:
// method, path, query, headers and body bytes, with only Host and the target
// changed. It calls transport directly, so a redirect is never followed: the
// 3xx goes back to the client as it came.
func passthroughProxy(upstream *url.URL, transport http.RoundTripper) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Transport: transport,
		Rewrite: func(pr *httputil.ProxyRequest) {
			out := pr.Out
			out.URL.Scheme = upstream.Scheme
			out.URL.Host = upstream.Host
			if upstream.Path != "" && upstream.Path != "/" {
				out.URL.Path = strings.TrimSuffix(upstream.Path, "/") + out.URL.Path
			}
			// The upstream TLS certificate and API routing both key off
			// Host, so it names the real API, not the proxy.
			out.Host = upstream.Host
			// Guard already removed the secret; this keeps it off the wire
			// should a request ever reach the router another way.
			out.Header.Del(config.TokenHeader)
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
}

// listClient is the client the model list is fetched with. It never follows
// a redirect, which would resend the Authorization header, possibly
// downgraded to http.
func listClient(transport http.RoundTripper) *http.Client {
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// hopByHop are the headers that describe one connection, not the message,
// and are never copied from one exchange to another.
var hopByHop = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
	"host":                true,
}

func isHopByHop(name string) bool { return hopByHop[strings.ToLower(name)] }

// isCORS reports an Access-Control-* header, which the proxy never sends.
func isCORS(name string) bool {
	return strings.HasPrefix(strings.ToLower(name), "access-control-")
}

func dropCORS(header http.Header) {
	for name := range header {
		if isCORS(name) {
			header.Del(name)
		}
	}
}

// copyResponseHeader copies an upstream answer's headers onto a buffered
// reply: no hop-by-hop or CORS header, and no Content-Length, which the
// reply sets for its own body.
func copyResponseHeader(dst, src http.Header) {
	for name, values := range src {
		if isHopByHop(name) || isCORS(name) || strings.EqualFold(name, "Content-Length") {
			continue
		}
		for _, value := range values {
			dst.Add(name, value)
		}
	}
}
