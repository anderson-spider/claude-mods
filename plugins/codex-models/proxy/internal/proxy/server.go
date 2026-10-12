// Package proxy sets up the proxy's single listener: plain HTTP on a loopback
// address, which Claude Code reaches through ANTHROPIC_BASE_URL. The serve
// command runs it and owns the stop (cmd/ccmproxy, serveHTTP).
//
// The config accepts only a literal loopback IP with an explicit port
// (config.ValidateListenAddr); Listen checks the socket it got as well.
package proxy

import (
	"net/http"
	"time"
)

const (
	// readHeaderTimeout bounds a client that opens a connection and never
	// finishes its headers. Bodies and responses have no server-side
	// deadline: a Codex answer streams for as long as it takes.
	readHeaderTimeout = 30 * time.Second
	// idleTimeout closes a kept-alive connection nobody reuses.
	idleTimeout = 5 * time.Minute
)

// NewServer returns the http.Server that serves handler.
//
// net/http answers `OPTIONS *` with a 200 on its own unless
// DisableGeneralOptionsHandler is set; it is set so that request, like every
// other, goes through the handler, where the guard refuses it and the access
// log records it.
func NewServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:                      handler,
		ReadHeaderTimeout:            readHeaderTimeout,
		IdleTimeout:                  idleTimeout,
		DisableGeneralOptionsHandler: true,
	}
}
