package router

import (
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net"
	"net/http"
	"strings"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
)

// helloPath is Claude Code's start-up probe. It arrives as HEAD with neither
// the secret nor a bearer, so it is answered here and never forwarded.
const helloPath = "/api/hello"

// servedMethods are the methods Claude Code sends to its base URL. Methods
// are case-sensitive, so "trace" or "get" is not on the list either.
var servedMethods = map[string]bool{
	http.MethodGet:  true,
	http.MethodPost: true,
	http.MethodHead: true,
}

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
	hosts, err := listenerHosts(cfg.ListenHTTP)
	if err != nil {
		return nil, err
	}
	g := &guard{next: next, hosts: hosts, want: sha256.Sum256([]byte(cfg.AuthToken))}
	return g, nil
}

type guard struct {
	next  http.Handler
	hosts map[string]bool
	want  [sha256.Size]byte
}

func (g *guard) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	// The secret comes off before anything else looks at the request,
	// whatever is decided below.
	presented := req.Header.Values(config.TokenHeader)
	req.Header.Del(config.TokenHeader)

	switch {
	case !g.hosts[strings.ToLower(req.Host)]:
		refuse(w, "ccmproxy: unexpected Host header")
	case !servedMethods[req.Method]:
		// OPTIONS preflights, CONNECT tunnels, TRACE echoes and extension
		// methods are refused even with the secret.
		refuse(w, "ccmproxy: this method is not served")
	case req.Method == http.MethodHead && req.URL.Path == helloPath:
		w.WriteHeader(http.StatusOK)
	case !g.secretMatches(presented):
		refuse(w, "ccmproxy: missing or wrong "+config.TokenHeader)
	default:
		g.next.ServeHTTP(w, req)
	}
}

// secretMatches accepts exactly one header value whose SHA-256 digest is the
// secret's. Comparing digests keeps the comparison constant time whatever the
// length of either value.
func (g *guard) secretMatches(presented []string) bool {
	if len(presented) != 1 {
		return false
	}
	got := sha256.Sum256([]byte(presented[0]))
	return subtle.ConstantTimeCompare(got[:], g.want[:]) == 1
}

func refuse(w http.ResponseWriter, message string) {
	writeAnthropicError(w, http.StatusForbidden, "permission_error", message)
}

// listenerHosts lists the Host values, lowercased, that name this proxy: the
// listen address itself, localhost on the same port when the listener is
// 127.0.0.1 (where localhost points), and each of those without the port
// when it is 80, which a client leaves out.
func listenerHosts(listen string) (map[string]bool, error) {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return nil, errors.New("router: listen_http " + listen + " is not host:port")
	}
	names := []string{strings.ToLower(net.JoinHostPort(host, port))}
	if host == "127.0.0.1" {
		names = append(names, "localhost:"+port)
	}
	hosts := map[string]bool{}
	for _, name := range names {
		hosts[name] = true
		if port == "80" {
			hosts[strings.TrimSuffix(name, ":80")] = true
		}
	}
	return hosts, nil
}
