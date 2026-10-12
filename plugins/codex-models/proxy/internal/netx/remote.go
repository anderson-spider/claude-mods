package netx

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
)

const remoteDialTimeout = 3 * time.Second

// RemoteTransport leaves the Anthropic transport unchanged. Resolution, TCP
// connect and TLS are bounded separately; no timer bounds a running stream.
// Checking resolved addresses on every new connection also prevents DNS changes
// from sending the management credential to a local listener after startup.
func RemoteTransport(remote string) *http.Transport {
	t := DirectTransport()
	t.TLSHandshakeTimeout = remoteDialTimeout
	t.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		ctx, cancel := context.WithTimeout(ctx, remoteDialTimeout)
		defer cancel()
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, errors.New("remote: invalid address")
		}
		addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil || len(addrs) == 0 {
			return nil, errors.New("remote: lookup failed")
		}
		for _, addr := range addrs {
			if !config.RemoteAllowsLoopback(remote) && localAddress(addr) {
				return nil, errors.New("remote: local address refused")
			}
		}
		dialer := &net.Dialer{Timeout: remoteDialTimeout, KeepAlive: tcpKeepAlive}
		for _, addr := range addrs {
			conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(addr.String(), port))
			if err == nil {
				return conn, nil
			}
		}
		return nil, errors.New("remote: connect failed")
	}
	return t
}

func localAddress(addr netip.Addr) bool {
	addr = addr.Unmap()
	return addr.IsLoopback() || addr.IsUnspecified()
}
