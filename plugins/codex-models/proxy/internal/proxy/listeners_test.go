package proxy

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestListenRefusesANonLoopbackBind(t *testing.T) {
	// 0.0.0.0 binds every interface; the bound address is unspecified, not
	// loopback, so the listener must be closed and refused.
	if listener, err := Listen("0.0.0.0:0"); err == nil {
		_ = listener.Close()
		t.Fatal("Listen(0.0.0.0:0) succeeded, want a refusal")
	}
}

func TestServeAnswersOnLoopback(t *testing.T) {
	listener, err := Listen("127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	addr := listener.Addr().String()
	_ = listener.Close()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, "http", addr, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, "ok")
		}))
	}()

	var body []byte
	deadline := time.Now().Add(2 * time.Second)
	for {
		resp, err := http.Get("http://" + addr + "/")
		if err == nil {
			body, _ = io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("GET: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if string(body) != "ok" {
		t.Fatalf("body = %q", body)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not stop after the context was cancelled")
	}
}
