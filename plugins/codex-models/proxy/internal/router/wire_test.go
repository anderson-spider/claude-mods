package router

// The guard behind the production http.Server (proxy.NewServer), so the
// server's own handling of the request line sits in front of it as it does
// in `ccmproxy serve`.

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/proxy"
)

type wireServer struct {
	h    *harness
	addr string
}

func newWireServer(t *testing.T) *wireServer {
	t.Helper()
	h := newHarness(t, nil, nil, true)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	handler := guarded(t, h, addr)
	srv := &httptest.Server{Listener: ln, Config: proxy.NewServer(handler)}
	srv.Start()
	t.Cleanup(srv.Close)
	return &wireServer{h: h, addr: addr}
}

// raw writes the request verbatim and reads one response.
func (w *wireServer) raw(t *testing.T, requestLine string, headers ...string) (*http.Response, string) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", w.addr, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	request := requestLine + "\r\n" + strings.Join(append(headers, "Connection: close"), "\r\n") + "\r\n\r\n"
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatal(err)
	}
	all, _ := io.ReadAll(conn)
	resp, err := http.ReadResponse(bufio.NewReader(strings.NewReader(string(all))), nil)
	if err != nil {
		t.Fatalf("%s: unreadable reply %q: %v", requestLine, all, err)
	}
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

func TestOptionsStarIsRefusedOnTheWire(t *testing.T) {
	w := newWireServer(t)
	for _, host := range []string{w.addr, "evil.test"} {
		for _, secret := range []string{"", config.TokenHeader + ": " + guardToken} {
			w.h.reset()
			headers := []string{"Host: " + host, "Origin: https://evil.test"}
			if secret != "" {
				headers = append(headers, secret)
			}
			resp, body := w.raw(t, "OPTIONS * HTTP/1.1", headers...)
			label := "OPTIONS * Host=" + host
			if resp.StatusCode != http.StatusForbidden || !strings.Contains(body, "permission_error") {
				t.Fatalf("%s: %d %q, want 403 permission_error", label, resp.StatusCode, body)
			}
			for name := range resp.Header {
				if strings.HasPrefix(strings.ToLower(name), "access-control-") {
					t.Fatalf("%s: response carries %s", label, name)
				}
			}
			if w.h.reachedUpstream() {
				t.Fatalf("%s reached an upstream", label)
			}
		}
	}
}

func TestOnlyGetPostAndHeadPassOnTheWire(t *testing.T) {
	w := newWireServer(t)
	secret := config.TokenHeader + ": " + guardToken
	for _, line := range []string{
		"CONNECT " + w.addr + " HTTP/1.1",
		"CONNECT api.anthropic.com:443 HTTP/1.1",
		"TRACE /v1/messages HTTP/1.1",
		"TRACE * HTTP/1.1",
		"trace /v1/messages HTTP/1.1",
		"FOO /v1/messages HTTP/1.1",
		"get /v1/models HTTP/1.1",
		"PUT /v1/messages HTTP/1.1",
		"DELETE /v1/models HTTP/1.1",
	} {
		w.h.reset()
		host := w.addr
		if strings.HasPrefix(line, "CONNECT api.") {
			host = "api.anthropic.com:443"
		}
		resp, body := w.raw(t, line, "Host: "+host, secret)
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s: %d %q, want 403", line, resp.StatusCode, body)
		}
		if strings.Contains(body, guardToken) {
			t.Fatalf("%s: the reply echoes the secret", line)
		}
		if w.h.reachedUpstream() {
			t.Fatalf("%s reached an upstream", line)
		}
	}
}

func TestGetPostAndHeadStillPassOnTheWire(t *testing.T) {
	w := newWireServer(t)
	secret := config.TokenHeader + ": " + guardToken
	for _, line := range []string{"GET /v1/models HTTP/1.1", "HEAD /v1/models HTTP/1.1", "GET /__ccmproxy/status HTTP/1.1"} {
		resp, body := w.raw(t, line, "Host: "+w.addr, secret)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: %d %q, want 200", line, resp.StatusCode, body)
		}
	}
}
