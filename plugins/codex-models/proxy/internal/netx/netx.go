// Package netx holds the one outbound transport every proxy connection uses.
package netx

import (
	"net"
	"net/http"
	"sync"
	"time"
)

// DirectTransport dials upstreams without consulting HTTPS_PROXY and the
// other proxy environment variables (Proxy is nil): a value left in the shell
// from an older CONNECT setup would otherwise aim the proxy at a listener that
// no longer exists, or at itself, and would send the OAuth bearer through it.
func DirectTransport() *http.Transport {
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	t := &http.Transport{
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	contractTrust(t)
	return t
}

var (
	sharedOnce sync.Once
	shared     *http.Transport
)

// Shared is one DirectTransport for the constructors that are given no
// transport, used instead of http.DefaultTransport, which honours the proxy
// environment variables.
func Shared() *http.Transport {
	sharedOnce.Do(func() { shared = DirectTransport() })
	return shared
}
