package netx

import (
	"context"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestRemoteTransportIsDirectAndRefusesLocalDNSAnswers(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	transport := RemoteTransport("https://remote.example")
	if transport.Proxy != nil || transport.TLSHandshakeTimeout != 3*time.Second {
		t.Fatal("remote transport is not short-dial and direct")
	}
	for _, address := range []string{"127.0.0.1:1", "[::1]:1", "localhost:1"} {
		_, err := transport.DialContext(context.Background(), "tcp", address)
		if err == nil || !strings.Contains(err.Error(), "local address refused") {
			t.Fatalf("local remote not refused: %s %v", address, err)
		}
	}
	if DirectTransport().TLSHandshakeTimeout != tlsHandshakeTimeout {
		t.Fatal("remote timing changed Anthropic passthrough")
	}
}

func TestLocalAddressIncludesMappedAndUnspecified(t *testing.T) {
	for _, raw := range []string{"127.1.2.3", "::1", "::ffff:127.0.0.1", "0.0.0.0", "::"} {
		if !localAddress(netip.MustParseAddr(raw)) {
			t.Errorf("accepted local %s", raw)
		}
	}
	if localAddress(netip.MustParseAddr("192.0.2.1")) {
		t.Fatal("remote address denied")
	}
}
