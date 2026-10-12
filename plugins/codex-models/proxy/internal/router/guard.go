package router

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net"
	"net/http"
	"strings"

	"github.com/jclab-joseph/claude-code-model-proxy/internal/config"
)

// helloPath is Claude Code's start-up probe. It arrives as HEAD with neither
// the secret nor a bearer, so it is answered here and never forwarded.
const helloPath = "/api/hello"

// Guard wraps the router so that nothing reaches it, or any upstream, unless
// the request names this proxy in Host and carries the secret.
//
// The secret is removed from the request before next runs, so no outbound
// path can copy it. A refusal is 403, never 401: Claude Code reads a 401 as
// an expired OAuth token, refreshes and ends up asking for /login. No CORS
// header is ever set, so a web page cannot read an answer, and OPTIONS is
// refused outright.
//
// Threat model: the secret sits in plain text in the person's settings. It
// keeps out other local processes and web pages (including a DNS rebinding
// page, which the Host check also stops), not malware running as the person.
func Guard(cfg *config.Config, next http.Handler) (http.Handler, error) {
	if cfg.AuthToken == "" {
		return nil, errors.New("router: no auth_token; run `ccmproxy config init`")
	}
	hosts, err := allowedHosts(cfg.ListenHTTP)
	if err != nil {
		return nil, err
	}
	want := sha256.Sum256([]byte(cfg.AuthToken))

	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		// Taken off first, whatever happens next.
		presented := req.Header.Values(config.TokenHeader)
		req.Header.Del(config.TokenHeader)

		if _, ok := hosts[strings.ToLower(req.Host)]; !ok {
			writeAnthropicError(w, http.StatusForbidden, "permission_error", "ccmproxy: unexpected Host header")
			return
		}
		// Claude Code sends only GET, POST and HEAD. Every other method
		// (OPTIONS preflights, CONNECT tunnels, TRACE echoes, lowercase or
		// extension methods) is refused, even with the secret. Methods are
		// case-sensitive, so "trace" is not "TRACE" and is refused too.
		if !allowedMethods[req.Method] {
			writeAnthropicError(w, http.StatusForbidden, "permission_error", "ccmproxy: this method is not served")
			return
		}
		if req.Method == http.MethodHead && req.URL.Path == helloPath {
			w.WriteHeader(http.StatusOK)
			return
		}
		if !tokenMatches(presented, want) {
			writeAnthropicError(w, http.StatusForbidden, "permission_error",
				"ccmproxy: missing or wrong "+config.TokenHeader)
			return
		}
		next.ServeHTTP(w, req)
	}), nil
}

// allowedMethods are the methods Claude Code sends to its base URL.
var allowedMethods = map[string]bool{
	http.MethodGet:  true,
	http.MethodPost: true,
	http.MethodHead: true,
}

// tokenMatches accepts exactly one header value whose SHA-256 digest equals
// want. Comparing digests keeps the comparison constant time and independent
// of the length of either value.
func tokenMatches(presented []string, want [sha256.Size]byte) bool {
	if len(presented) != 1 {
		return false
	}
	got := sha256.Sum256([]byte(presented[0]))
	return subtle.ConstantTimeCompare(got[:], want[:]) == 1
}

// allowedHosts lists the Host values that name this proxy: the listen
// address itself, and localhost on the same port when the listener is
// 127.0.0.1 (which is where localhost points).
func allowedHosts(listen string) (map[string]struct{}, error) {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return nil, errors.New("router: listen_http " + listen + " is not host:port")
	}
	hosts := map[string]struct{}{
		strings.ToLower(net.JoinHostPort(host, port)): {},
	}
	if host == "127.0.0.1" {
		hosts["localhost:"+port] = struct{}{}
	}
	if port == "80" {
		// A client omits the default port from Host.
		for h := range hosts {
			hosts[strings.TrimSuffix(h, ":80")] = struct{}{}
		}
	}
	return hosts, nil
}
