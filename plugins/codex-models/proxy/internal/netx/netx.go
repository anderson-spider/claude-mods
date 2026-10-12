// Package netx builds the transport behind every outbound connection the
// proxy makes: to Anthropic and to the credential-owning Codex remote.
package netx

import (
	"net"
	"net/http"
	"sync"
	"time"
)

// Connection timings. None of them bounds a whole response: a Codex stream
// can stay open for minutes, and its deadline is the request's context.
const (
	dialTimeout           = 30 * time.Second
	tcpKeepAlive          = 30 * time.Second
	tlsHandshakeTimeout   = 15 * time.Second
	idleConnTimeout       = 90 * time.Second
	expectContinueTimeout = time.Second
	maxIdleConns          = 100
)

// DirectTransport returns a new transport that always dials the upstream
// itself.
//
// Its Proxy field is nil on purpose, so HTTPS_PROXY, HTTP_PROXY, ALL_PROXY
// and NO_PROXY are never read. A value left in the shell would otherwise
// route requests, with the Claude bearer or the management credential, through
// whatever listens there, or back into this proxy. Do not copy
// http.DefaultTransport here: its Proxy is http.ProxyFromEnvironment.
func DirectTransport() *http.Transport {
	dialer := &net.Dialer{Timeout: dialTimeout, KeepAlive: tcpKeepAlive}
	transport := &http.Transport{
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          maxIdleConns,
		IdleConnTimeout:       idleConnTimeout,
		TLSHandshakeTimeout:   tlsHandshakeTimeout,
		ExpectContinueTimeout: expectContinueTimeout,
	}
	contractTrust(transport)
	return transport
}

// shared is built on first use, so a contract build reads its CA file only
// once a connection is needed.
var shared = sync.OnceValue(DirectTransport)

// Shared returns the one DirectTransport that clients built without a
// transport of their own use, so they share its connection pool. It is what
// they get instead of http.DefaultTransport.
func Shared() *http.Transport { return shared() }
