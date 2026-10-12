package proxy

import "testing"

func TestListenRefusesANonLoopbackBind(t *testing.T) {
	// 0.0.0.0 binds every interface; the bound address is unspecified, not
	// loopback, so the listener must be closed and refused.
	if listener, err := Listen("0.0.0.0:0"); err == nil {
		_ = listener.Close()
		t.Fatal("Listen(0.0.0.0:0) succeeded, want a refusal")
	}
}
