package proxy

import (
	"context"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestListenOnIPv6Loopback(t *testing.T) {
	listener, err := Listen("[::1]:0")
	if err != nil {
		t.Skipf("no IPv6 loopback here: %v", err)
	}
	_ = listener.Close()
}

func TestBoundAddressMustBeTCPLoopback(t *testing.T) {
	for _, addr := range []net.Addr{
		&net.TCPAddr{IP: net.IPv4(0, 0, 0, 0), Port: 1},
		&net.TCPAddr{IP: net.IPv4(192, 168, 1, 2), Port: 1},
		&net.TCPAddr{IP: net.IPv6unspecified, Port: 1},
		&net.UnixAddr{Name: "/tmp/sock", Net: "unix"},
	} {
		err := boundToLoopback(addr)
		if err == nil || !strings.Contains(err.Error(), "not a loopback address") {
			t.Errorf("%v: %v, want a refusal", addr, err)
		}
	}
	for _, addr := range []net.Addr{
		&net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1},
		&net.TCPAddr{IP: net.IPv4(127, 9, 8, 7), Port: 1},
		&net.TCPAddr{IP: net.IPv6loopback, Port: 1},
	} {
		if err := boundToLoopback(addr); err != nil {
			t.Errorf("%v: %v", addr, err)
		}
	}
}

func TestServeReportsAListenFailure(t *testing.T) {
	held, err := Listen("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()

	done := make(chan error, 1)
	go func() {
		done <- Serve(context.Background(), "http", held.Addr().String(), http.NotFoundHandler())
	}()
	select {
	case err := <-done:
		if err == nil || !strings.HasPrefix(err.Error(), "http: listen on ") {
			t.Fatalf("Serve on a taken port = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return on a taken port")
	}
}

func TestServeRefusesAWildcardBind(t *testing.T) {
	err := Serve(context.Background(), "http", "0.0.0.0:0", http.NotFoundHandler())
	if err == nil || !strings.Contains(err.Error(), "not a loopback address") {
		t.Fatalf("Serve(0.0.0.0:0) = %v, want a refusal", err)
	}
}

func TestNewServerSettings(t *testing.T) {
	s := NewServer(http.NotFoundHandler())
	if !s.DisableGeneralOptionsHandler {
		t.Fatal("net/http would answer OPTIONS * before the guard")
	}
	if s.ReadHeaderTimeout != 30*time.Second || s.IdleTimeout != 5*time.Minute {
		t.Fatalf("timeouts = %v, %v", s.ReadHeaderTimeout, s.IdleTimeout)
	}
	if s.ReadTimeout != 0 || s.WriteTimeout != 0 {
		t.Fatal("a whole-request deadline would cut long Codex streams")
	}
}
