// Package proxy runs the proxy's single listener: plain HTTP on a loopback
// address, which Claude Code reaches through ANTHROPIC_BASE_URL.
//
// The config accepts only a literal loopback IP with an explicit port
// (config.ValidateListenAddr); Listen checks the socket it got as well.
package proxy

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

const (
	// readHeaderTimeout bounds a client that opens a connection and never
	// finishes its headers. Bodies and responses have no server-side
	// deadline: a Codex answer streams for as long as it takes.
	readHeaderTimeout = 30 * time.Second
	// idleTimeout closes a kept-alive connection nobody reuses.
	idleTimeout = 5 * time.Minute
	// shutdownGrace is how long in-flight requests get once Serve's context
	// is cancelled.
	shutdownGrace = 5 * time.Second
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

// Serve listens on addr and serves handler over plain HTTP until ctx is
// cancelled. name prefixes its errors and its "listening" line.
//
// It returns nil once cancellation has begun the shutdown, which then gives
// in-flight requests up to shutdownGrace in the background; any other end
// of the server is an error.
func Serve(ctx context.Context, name, addr string, handler http.Handler) error {
	listener, err := Listen(addr)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	server := NewServer(handler)

	served := make(chan struct{})
	defer close(served)
	go func() {
		select {
		case <-ctx.Done():
		case <-served: // the server failed on its own; nothing to shut down
			return
		}
		grace, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		_ = server.Shutdown(grace)
	}()

	logx.Infof("%s listening on %s", name, listener.Addr())
	if err := server.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}
