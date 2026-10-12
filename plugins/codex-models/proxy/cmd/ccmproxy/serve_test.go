package main

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/proxy"
)

// startServe runs serveHTTP on a loopback listener and returns its address
// and the channel its result arrives on.
func startServe(t *testing.T, ctx context.Context, handler http.Handler, grace time.Duration) (string, <-chan error) {
	t.Helper()
	listener, err := proxy.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- serveHTTP(ctx, listener, handler, grace) }()
	return listener.Addr().String(), done
}

// streamingHandler writes "first\n", then waits for release (or for the
// request to be cut) before writing "last\n".
func streamingHandler(started chan<- struct{}, release <-chan struct{}) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "first\n")
		w.(http.Flusher).Flush()
		close(started)
		select {
		case <-release:
			_, _ = io.WriteString(w, "last\n")
		case <-r.Context().Done():
		}
	})
}

func TestServeWaitsForRequestsInFlight(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	started, release := make(chan struct{}), make(chan struct{})
	addr, done := startServe(t, ctx, streamingHandler(started, release), 5*time.Second)

	client := &http.Client{Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	res, err := client.Get("http://" + addr + "/")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	reader := bufio.NewReader(res.Body)
	if line, err := reader.ReadString('\n'); err != nil || line != "first\n" {
		t.Fatalf("first line %q, %v", line, err)
	}
	<-started

	stop()
	select {
	case err := <-done:
		t.Fatalf("serve returned %v with a request in flight", err)
	case <-time.After(300 * time.Millisecond):
	}
	// No new connection is taken while the stream finishes.
	if conn, err := net.DialTimeout("tcp", addr, time.Second); err == nil {
		_ = conn.Close()
		t.Fatal("the listener still takes connections after the stop")
	}

	close(release)
	rest, err := io.ReadAll(reader)
	if err != nil || string(rest) != "last\n" {
		t.Fatalf("rest of the stream %q, %v", rest, err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve = %v, want a clean stop", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not return once the request finished")
	}
}

func TestServeCutsWhatOutlivesTheGrace(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	started, never := make(chan struct{}), make(chan struct{})
	addr, done := startServe(t, ctx, streamingHandler(started, never), 200*time.Millisecond)

	client := &http.Client{Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	res, err := client.Get("http://" + addr + "/")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	<-started

	stopped := time.Now()
	stop()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve = %v, want a clean stop after the grace", err)
		}
		if waited := time.Since(stopped); waited < 200*time.Millisecond {
			t.Fatalf("serve returned after %v, before the grace ran out", waited)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not return after the grace ran out")
	}
	body, _ := io.ReadAll(res.Body)
	if strings.Contains(string(body), "last") {
		t.Fatalf("the stream finished although it outlived the grace: %q", body)
	}
}

func TestServeStopsAtOnceWhenIdle(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	addr, done := startServe(t, ctx, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}), 5*time.Second)

	// A kept-alive idle connection does not hold the stop.
	client := &http.Client{Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	res, err := client.Get("http://" + addr + "/")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	_, _ = io.ReadAll(res.Body)
	_ = res.Body.Close()

	stop()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("an idle connection held the stop")
	}
}

func TestServeReportsAServerThatEnds(t *testing.T) {
	listener, err := proxy.Listen("127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	_ = listener.Close()
	err = serveHTTP(context.Background(), listener, http.NotFoundHandler(), time.Second)
	if err == nil || !strings.HasPrefix(err.Error(), "http: ") {
		t.Fatalf("serve on a closed listener = %v, want an http: error", err)
	}
}
