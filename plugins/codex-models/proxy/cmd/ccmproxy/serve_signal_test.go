//go:build contract

package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// TestServeFinishesAStreamOnSignal runs the contract-built binary against a
// fake upstream that holds a streamed answer open, signals it mid-stream and
// checks the answer still arrives whole and the process exits 0.
func TestServeFinishesAStreamOnSignal(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "ccmproxy")
	if out, err := exec.Command("go", "build", "-tags", "contract", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	for name, sig := range map[string]syscall.Signal{"SIGTERM": syscall.SIGTERM, "SIGINT": syscall.SIGINT} {
		t.Run(name, func(t *testing.T) { finishesOnSignal(t, bin, sig) })
	}
}

func finishesOnSignal(t *testing.T, bin string, sig syscall.Signal) {
	started, release := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: first\ndata: {}\n\n")
		w.(http.Flusher).Flush()
		close(started)
		select {
		case <-release:
			_, _ = io.WriteString(w, "event: last\ndata: {}\n\n")
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()

	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := probe.Addr().String()
	_ = probe.Close()
	cfg, _ := json.Marshal(map[string]any{
		"listen_http":  addr,
		"upstream":     upstream.URL,
		"auth_token":   testToken,
		"session_salt": strings.Repeat("ab", 32),
		"auth_dir":     filepath.Join(home, "auth"),
	})
	if err := os.WriteFile(filepath.Join(home, "config.json"), cfg, 0o600); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(bin, "serve")
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + home,
		"TMPDIR=" + home,
		"CCMPROXY_HOME=" + home,
		"CODEX_HOME=" + filepath.Join(home, "codex-cli"),
		"CCMPROXY_CONTRACT_UPSTREAM=" + upstream.URL,
	}
	var log strings.Builder
	cmd.Stderr = &syncWriter{w: &log}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	defer func() {
		_ = cmd.Process.Kill()
		if t.Failed() {
			t.Logf("ccmproxy log:\n%s", cmd.Stderr.(*syncWriter).String())
		}
	}()

	client := &http.Client{Transport: &http.Transport{Proxy: nil, DisableCompression: true}}
	defer client.CloseIdleConnections()
	waitForHello(t, client, addr, exited)

	req, _ := http.NewRequest(http.MethodPost, "http://"+addr+"/v1/messages",
		strings.NewReader(`{"model":"claude-sonnet-4-5","max_tokens":1,"stream":true,"messages":[]}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Ccmproxy-Token", testToken)
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer res.Body.Close()
	reader := bufio.NewReader(res.Body)
	if line, err := reader.ReadString('\n'); err != nil || line != "event: first\n" {
		t.Fatalf("first line %q, %v (status %d)", line, err, res.StatusCode)
	}
	<-started

	if err := cmd.Process.Signal(sig); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-exited:
		t.Fatalf("ccmproxy exited (%v) with a stream in flight", err)
	case <-time.After(300 * time.Millisecond):
	}

	close(release)
	rest, err := io.ReadAll(reader)
	if err != nil || !strings.Contains(string(rest), "event: last\n") {
		t.Fatalf("rest of the stream %q, %v", rest, err)
	}
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("ccmproxy ended with %v after %v, want exit 0", err, sig)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("ccmproxy did not exit within 5 s of the stream ending")
	}
}

func waitForHello(t *testing.T, client *http.Client, addr string, exited <-chan error) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-exited:
			t.Fatalf("ccmproxy exited at start: %v", err)
		default:
		}
		req, _ := http.NewRequest(http.MethodHead, "http://"+addr+"/api/hello", nil)
		if res, err := client.Do(req); err == nil {
			_ = res.Body.Close()
			if res.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("ccmproxy did not answer HEAD /api/hello")
}

// syncWriter lets the test read the process's stderr while it is written.
type syncWriter struct {
	mu sync.Mutex
	w  *strings.Builder
}

func (s *syncWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.Write(p)
}

func (s *syncWriter) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.String()
}
