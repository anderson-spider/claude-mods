//go:build contract

package contract

import (
	"bufio"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

// A client that goes away cancels the request to the remote.
func TestClientGoneCancelsTheRemoteRequest(t *testing.T) {
	e := withAccount(t, opts{race: true})
	cancelled := make(chan struct{})
	e.cdx.set(func(w http.ResponseWriter, r *http.Request, _ rec) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl := w.(http.Flusher)
		sseChunk(w, fl, evStart)
		sseChunk(w, fl, evTextStart)
		sseChunk(w, fl, evText("first"))
		select {
		case <-r.Context().Done():
			close(cancelled)
		case <-time.After(10 * time.Second):
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.url("/v1/messages"), strings.NewReader(string(claudeReq("gpt-6-astra", true, nil))))
	must(t, err)
	req.Header.Set("X-Ccmproxy-Token", e.token)
	req.Header.Set("Content-Type", "application/json")
	res, err := e.client.Do(req)
	must(t, err)
	sc := bufio.NewScanner(res.Body)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "event: content_block_delta") {
			break
		}
	}
	cancel() // the client hangs up mid-stream
	_ = res.Body.Close()

	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("the remote request kept running after the client went away")
	}
}

// The /v1/models client does not follow a redirect either.
func TestModelsRequestDoesNotFollowRedirects(t *testing.T) {
	for _, account := range []bool{false, true} {
		name := map[bool]string{false: "without a remote account", true: "with a remote account"}[account]
		t.Run(name, func(t *testing.T) {
			e := newEnv(t, opts{noStart: true, noAccount: !account})
			target := newFake(t, false)
			e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
				w.Header().Set("Location", target.URL+"/models")
				w.WriteHeader(http.StatusFound)
			})
			e.start()
			if account {
				e.waitLoggedIn()
			}
			r := e.do(http.MethodGet, "/v1/models", nil, map[string]string{"Authorization": "Bearer oauth"})
			if account && r.Status != 200 {
				t.Fatalf("status = %d", r.Status)
			}
			if !account && r.Status != http.StatusFound {
				t.Fatalf("status = %d, want the 302 as it came", r.Status)
			}
			if target.count() != 0 {
				t.Fatalf("the redirect was followed, carrying %v", target.last(t).Header)
			}
			if e.anth.count() != 1 {
				t.Fatalf("upstream requests = %d", e.anth.count())
			}
		})
	}
}

// The LaunchAgent restarts the proxy unless it exited cleanly.
func TestServeExitsCleanlyOnSIGTERM(t *testing.T) {
	e := withAccount(t, opts{})
	if err := e.stop(); err != nil {
		t.Fatalf("serve ended with %v after SIGTERM:\n%s", err, e.stderr.String())
	}
	if _, err := e.client.Head(e.url("/api/hello")); err == nil {
		t.Fatal("the listener is still open")
	}
}
