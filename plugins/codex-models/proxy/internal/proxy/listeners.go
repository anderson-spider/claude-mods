// Package proxy runs the proxy's one listener: plain HTTP on a loopback
// address, which Claude Code reaches through ANTHROPIC_BASE_URL.
package proxy

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// NewServer builds the HTTP server, tuned for long streaming responses.
//
// DisableGeneralOptionsHandler matters: without it net/http answers
// `OPTIONS *` itself with a 200, before the handler (and so before the guard
// and the log) ever sees the request.
func NewServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:                      handler,
		ReadHeaderTimeout:            30 * time.Second,
		IdleTimeout:                  5 * time.Minute,
		DisableGeneralOptionsHandler: true,
	}
}

// Listen opens addr and refuses a socket that is not bound to loopback. The
// configuration already accepts only literal loopback addresses; checking
// the bound address too keeps that true whatever the operating system did
// with the request.
func Listen(addr string) (net.Listener, error) {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", addr, err)
	}
	tcp, ok := listener.Addr().(*net.TCPAddr)
	if !ok || !tcp.IP.IsLoopback() {
		_ = listener.Close()
		return nil, fmt.Errorf("listen on %s: bound to %s, which is not a loopback address", addr, listener.Addr())
	}
	return listener, nil
}

// Serve runs handler over plain HTTP on addr until ctx is cancelled.
func Serve(ctx context.Context, name, addr string, handler http.Handler) error {
	listener, err := Listen(addr)
	if err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	server := NewServer(handler)
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	logx.Infof("%s listening on %s", name, listener.Addr())
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("%s: %w", name, err)
	}
	return nil
}
