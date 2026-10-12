package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/codex"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/httplog"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/netx"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/proxy"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/router"
)

const (
	// shutdownGrace is how long requests still running when serve is told to
	// stop get to finish: a Codex answer streaming then is not cut at once.
	// It is the proxy's only stop grace.
	shutdownGrace = 5 * time.Second
	// upstreamLookupTimeout bounds the start-up lookup of the upstream host.
	upstreamLookupTimeout = 5 * time.Second
)

// runServe checks the config, builds the handler and serves it on the
// configured loopback address until SIGINT or SIGTERM. A stop by signal is a
// clean exit (status 0): the LaunchAgent restarts the proxy only after an
// unclean one.
func runServe(args []string) error {
	cfg, err := loadConfig("serve", args, nil)
	if err != nil {
		return err
	}
	if cfg.AuthToken == "" || cfg.SessionSalt == "" {
		return fmt.Errorf("%s has no auth_token or session_salt; run `ccmproxy config init` to generate them", cfg.Path())
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if !contractSkipsUpstreamCheck(cfg.Upstream) {
		if err := checkUpstream(ctx, cfg.Upstream, net.DefaultResolver.LookupNetIP); err != nil {
			return err
		}
	}

	if cfg.Codex.Remote != "" && !config.RemoteAllowsLoopback(cfg.Codex.Remote) {
		if err := checkUpstream(ctx, cfg.Codex.Remote, net.DefaultResolver.LookupNetIP); err != nil {
			return fmt.Errorf("Codex remote: %w", err)
		}
	}

	handler, err := newHandler(cfg)
	if err != nil {
		return err
	}
	logStart(cfg)

	listener, err := listenHTTP(cfg.ListenHTTP)
	if err != nil {
		return err
	}
	return serveHTTP(ctx, listener, handler, shutdownGrace)
}

// listenHTTP opens the loopback listener (proxy.Listen refuses a socket
// bound anywhere else), its errors prefixed "http: " like serveHTTP's.
func listenHTTP(addr string) (net.Listener, error) {
	listener, err := proxy.Listen(addr)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	return listener, nil
}

// newHandler wires independent direct transports for Anthropic and the remote.
func newHandler(cfg *config.Config) (http.Handler, error) {
	transport := &httplog.Transport{Next: netx.DirectTransport()}
	remoteTransport := &httplog.Transport{Next: netx.RemoteTransport(cfg.Codex.Remote)}
	backend := codex.NewBackend(cfg.Codex.Remote, cfg.Codex.ManagementKey, remoteTransport)
	backend.RefreshAuth()
	routes, err := router.New(cfg, codex.NewRegistry(), backend, transport)
	if err != nil {
		return nil, err
	}
	routes.Version = version
	guarded, err := router.Guard(cfg, routes)
	if err != nil {
		return nil, err
	}
	return httplog.Log(guarded), nil
}

func logStart(cfg *config.Config) {
	logx.Infof("ccmproxy %s", version)
	logx.Infof("upstream: %s", cfg.Upstream)
	if cfg.Codex.Remote == "" {
		logx.Warnf("Codex remote is not configured")
	}
	if cfg.Codex.ManagementKey == "" {
		logx.Warnf("Codex management key is missing; quota is unavailable")
	}
	logx.Infof("point Claude Code at http://%s (`ccmproxy env` prints the settings)", cfg.ListenHTTP)
}

// serveHTTP serves handler on listener until ctx is cancelled, then stops
// taking connections and waits up to grace for the requests in flight to
// finish. What is still running after grace is cut by closing its
// connection. Either way the stop returns nil; a server that ends on its own
// is an error.
func serveHTTP(ctx context.Context, listener net.Listener, handler http.Handler, grace time.Duration) error {
	server := proxy.NewServer(handler)
	ended := make(chan error, 1)
	logx.Infof("http listening on %s", listener.Addr())
	go func() { ended <- server.Serve(listener) }()

	select {
	case err := <-ended:
		return fmt.Errorf("http: %w", err)
	case <-ctx.Done():
	}

	logx.Infof("stopping: waiting up to %s for requests in flight", grace)
	graceCtx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	if err := server.Shutdown(graceCtx); err != nil {
		logx.Warnf("requests still running after %s; closing their connections", grace)
		_ = server.Close()
	}
	// Serve returned http.ErrServerClosed as soon as Shutdown began.
	if err := <-ended; !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("http: %w", err)
	}
	return nil
}

// lookupFunc resolves a host name, as net.Resolver.LookupNetIP does.
type lookupFunc func(ctx context.Context, network, host string) ([]netip.Addr, error)

// checkUpstream refuses to start when the upstream host resolves to a
// loopback or unspecified address: that is a leftover hosts-file redirect,
// which would send the passthrough, and Claude Code itself, back to this
// machine instead of to Anthropic. A failed lookup is only a warning, so a
// proxy started before the network is up still comes up.
func checkUpstream(ctx context.Context, upstream string, lookup lookupFunc) error {
	u, err := url.Parse(upstream)
	if err != nil || u.Hostname() == "" {
		return fmt.Errorf("upstream %q has no host", upstream)
	}
	host := u.Hostname()
	if ip, err := netip.ParseAddr(host); err == nil {
		return refuseLocal(host, []netip.Addr{ip})
	}
	ctx, cancel := context.WithTimeout(ctx, upstreamLookupTimeout)
	defer cancel()
	addrs, err := lookup(ctx, "ip", host)
	if err != nil {
		logx.Warnf("could not resolve %s to check it is not redirected to this machine: %v", host, err)
		return nil
	}
	return refuseLocal(host, addrs)
}

// refuseLocal returns an error naming the first loopback or unspecified
// address among addrs, IPv4-mapped IPv6 included.
func refuseLocal(host string, addrs []netip.Addr) error {
	for _, addr := range addrs {
		addr = addr.Unmap()
		if addr.IsLoopback() || addr.IsUnspecified() {
			return fmt.Errorf("%s resolves to %s, a local address: remove the %s line from /etc/hosts "+
				"(an older ccmproxy setup redirected it), then start the proxy again", host, addr, host)
		}
	}
	return nil
}
