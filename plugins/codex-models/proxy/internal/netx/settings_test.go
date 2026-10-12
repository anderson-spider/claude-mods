package netx

import (
	"testing"
	"time"
)

func TestDirectTransportSettings(t *testing.T) {
	a, b := DirectTransport(), DirectTransport()
	if a == b {
		t.Fatal("DirectTransport must build a new transport each call")
	}
	if a.Proxy != nil || a.DialContext == nil || !a.ForceAttemptHTTP2 {
		t.Fatal("want no proxy, our own dialer and HTTP/2")
	}
	if a.TLSHandshakeTimeout != 15*time.Second || a.IdleConnTimeout != 90*time.Second ||
		a.ExpectContinueTimeout != time.Second || a.MaxIdleConns != 100 {
		t.Fatalf("timings changed: %+v", a)
	}
	if a.ResponseHeaderTimeout != 0 {
		t.Fatal("a response header deadline would cut a slow Codex start")
	}
}
