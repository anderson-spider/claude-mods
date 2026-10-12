//go:build contract

package contract

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

const apiCallPath = "/v8/management/requests/api-call"

type limitsStatus struct {
	CodexLogin  bool `json:"codexLogin"`
	CodexLimits []struct {
		Kind          string  `json:"kind"`
		PercentUsed   float64 `json:"percentUsed"`
		ResetsAt      string  `json:"resetsAt"`
		WindowMinutes int     `json:"windowMinutes"`
		ObservedAt    string  `json:"observedAt"`
	} `json:"codexLimits"`
}

func (e *env) limits(refresh bool) limitsStatus {
	e.t.Helper()
	path := "/__ccmproxy/status"
	if refresh {
		path += "?refresh=limits"
	}
	r := e.do(http.MethodGet, path, nil, nil)
	if r.Status != 200 {
		e.t.Fatalf("status = %d: %s", r.Status, r.Body)
	}
	var s limitsStatus
	must(e.t, json.Unmarshal(r.Body, &s))
	if s.CodexLimits == nil {
		e.t.Fatalf("codexLimits is absent or null: %s", r.Body)
	}
	return s
}

// Plain status never asks for usage; ?refresh=limits reads the weekly window
// through the management api-call, with the remote substituting the token.
func TestLimitsComeOnlyFromAnExplicitRefresh(t *testing.T) {
	e := withAccount(t, opts{})
	if s := e.limits(false); len(s.CodexLimits) != 0 {
		t.Fatalf("plain status has readings: %+v", s.CodexLimits)
	}
	if n := e.mgmt.countPath(apiCallPath); n != 0 {
		t.Fatalf("plain status made %d usage calls", n)
	}

	s := e.limits(true)
	if len(s.CodexLimits) != 1 {
		t.Fatalf("limits = %+v", s.CodexLimits)
	}
	w := s.CodexLimits[0]
	if w.Kind != "seven_day" || w.PercentUsed != 12 || w.WindowMinutes != 10080 || w.ResetsAt == "" || w.ObservedAt == "" {
		t.Fatalf("window = %+v", w)
	}
	if n := e.mgmt.countPath(apiCallPath); n != 1 {
		t.Fatalf("usage calls = %d", n)
	}
	var call struct {
		AuthIndex string            `json:"auth_index"`
		Method    string            `json:"method"`
		URL       string            `json:"url"`
		Header    map[string]string `json:"header"`
	}
	for _, got := range e.mgmt.all() {
		if got.Path == apiCallPath {
			must(t, json.Unmarshal(got.Body, &call))
		}
	}
	if call.AuthIndex != accountIndex || call.Method != "GET" || call.URL != "https://chatgpt.com/backend-api/wham/usage" ||
		len(call.Header) != 1 || call.Header["Authorization"] != "Bearer $TOKEN$" {
		t.Fatalf("api-call = %+v", call)
	}

	// A second refresh inside the backoff reuses the reading.
	if s := e.limits(true); len(s.CodexLimits) != 1 || e.mgmt.countPath(apiCallPath) != 1 {
		t.Fatalf("second refresh: %+v, calls %d", s.CodexLimits, e.mgmt.countPath(apiCallPath))
	}
}

func TestLimitReachedReadsAsFull(t *testing.T) {
	e := newEnv(t, opts{noStart: true})
	e.mgmt.set(e.management(false, usageBody(40, true)))
	e.start()
	e.waitLoggedIn()
	if s := e.limits(true); len(s.CodexLimits) != 1 || s.CodexLimits[0].PercentUsed != 100 {
		t.Fatalf("limits = %+v", s.CodexLimits)
	}
}

// The management key goes only to management paths, never to inference or Anthropic.
func TestManagementKeyStaysOnManagementPaths(t *testing.T) {
	e := withAccount(t, opts{})
	e.cdx.set(jsonAnswer(`[{"type":"text","text":"ok"}]`))
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte(`{}`)) })
	e.limits(true)
	e.post("/v1/messages", claudeReq("gpt-6-astra", false, nil))
	e.post("/v1/messages", claudeReq("claude-sonnet-5", false, nil))

	if e.mgmt.count() == 0 {
		t.Fatal("no management calls")
	}
	for _, got := range e.mgmt.all() {
		if !strings.HasPrefix(got.Path, "/v8/management/") || got.Header.Get("Authorization") != "Bearer "+e.mgmtKey {
			t.Fatalf("management call %s with Authorization %q", got.Path, got.Header.Get("Authorization"))
		}
	}
	for name, f := range map[string]*fake{"remote inference": e.cdx, "anthropic": e.anth} {
		if f.count() == 0 {
			t.Fatalf("%s saw no request", name)
		}
		for _, got := range f.all() {
			for h, values := range got.Header {
				for _, v := range values {
					if strings.Contains(v, e.mgmtKey) {
						t.Fatalf("%s got the management key in %s", name, h)
					}
				}
			}
			if strings.Contains(string(got.Body), e.mgmtKey) {
				t.Fatalf("%s got the management key in the body", name)
			}
		}
	}
}

// Without a remote account the proxy is logged out and reads no usage.
func TestLimitsWithoutAnAccount(t *testing.T) {
	e := newEnv(t, opts{noAccount: true})
	waitUntil(t, "credentials read", 5*time.Second, func() bool { return e.mgmt.countPath("/v8/management/credentials") > 0 })
	if s := e.limits(true); s.CodexLogin || len(s.CodexLimits) != 0 {
		t.Fatalf("status = %+v", s)
	}
	if n := e.mgmt.countPath(apiCallPath); n != 0 {
		t.Fatalf("usage calls without an account: %d", n)
	}
}

// A remote that stops answering clears the readings rather than keep stale ones.
func TestRemoteDownClearsTheReadings(t *testing.T) {
	e := withAccount(t, opts{})
	if s := e.limits(true); len(s.CodexLimits) != 1 {
		t.Fatalf("limits = %+v", s.CodexLimits)
	}
	e.cdx.Close()
	if r := e.post("/v1/messages", claudeReq("gpt-6-astra", false, nil)); r.Status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d: %s", r.Status, r.Body)
	}
	if s := e.limits(false); len(s.CodexLimits) != 0 {
		t.Fatalf("stale readings kept: %+v", s.CodexLimits)
	}
}

// A client that hangs up, before the remote answers or mid-stream, says
// nothing about the remote: the readings stay.
func TestClientCancelKeepsTheReadings(t *testing.T) {
	for _, midStream := range []bool{false, true} {
		name := map[bool]string{false: "before headers", true: "mid-stream"}[midStream]
		t.Run(name, func(t *testing.T) {
			e := withAccount(t, opts{})
			if s := e.limits(true); len(s.CodexLimits) != 1 {
				t.Fatalf("limits = %+v", s.CodexLimits)
			}
			reached := make(chan struct{})
			e.cdx.set(func(w http.ResponseWriter, r *http.Request, _ rec) {
				if midStream {
					w.Header().Set("Content-Type", "text/event-stream")
					w.WriteHeader(http.StatusOK)
					fl := w.(http.Flusher)
					sseChunk(w, fl, evStart)
					sseChunk(w, fl, evTextStart)
				}
				close(reached)
				select {
				case <-r.Context().Done():
				case <-time.After(10 * time.Second):
				}
			})
			ctx, cancel := context.WithCancel(context.Background())
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.url("/v1/messages"), strings.NewReader(string(claudeReq("gpt-6-astra", true, nil))))
			must(t, err)
			req.Header.Set("X-Ccmproxy-Token", e.token)
			req.Header.Set("Content-Type", "application/json")
			done := make(chan struct{})
			go func() {
				if res, err := e.client.Do(req); err == nil {
					_, _ = io.Copy(io.Discard, res.Body)
					_ = res.Body.Close()
				}
				close(done)
			}()
			<-reached
			cancel()
			<-done
			time.Sleep(200 * time.Millisecond) // let the proxy see the cancellation
			if s := e.limits(false); len(s.CodexLimits) != 1 {
				t.Fatalf("readings cleared by a client cancel: %+v", s.CodexLimits)
			}
		})
	}
}
