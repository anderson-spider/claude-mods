package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const usageBody = `{"rate_limit":{"primary_window":{"used_percent":12,"limit_window_seconds":604800,"reset_after_seconds":60}}}`
const oneAccount = `{"files":[{"provider":"codex","type":"codex","status":"active","disabled":false,"unavailable":false,"auth_index":"account-test"}]}`

func testBackend(t *testing.T, handler http.HandlerFunc) *Backend {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	return NewBackend(server.URL, "private-management-key", server.Client().Transport)
}

func await(t *testing.T, done <-chan struct{}) {
	t.Helper()
	if done == nil {
		t.Fatal("request was not started")
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not finish")
	}
}

func usageReply(w http.ResponseWriter) {
	_ = json.NewEncoder(w).Encode(map[string]any{"status_code": 200, "body": usageBody})
}

func TestCredentialsAreCachedNonblockingAndQuotaUsesTheOnlyAccount(t *testing.T) {
	var auth, usage atomic.Int32
	release := make(chan struct{})
	defer close(release)
	b := testBackend(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-management-key" {
			t.Error("management credential missing")
		}
		switch r.URL.Path {
		case "/v8/management/credentials":
			auth.Add(1)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			fmt.Fprint(w, oneAccount)
		case "/v8/management/requests/api-call":
			usage.Add(1)
			if r.Method != http.MethodPost {
				t.Error("usage is not POST")
			}
			data, _ := io.ReadAll(r.Body)
			var payload struct {
				AuthIndex string            `json:"auth_index"`
				Method    string            `json:"method"`
				URL       string            `json:"url"`
				Header    map[string]string `json:"header"`
			}
			if json.Unmarshal(data, &payload) != nil || payload.AuthIndex != "account-test" || payload.Method != "GET" || payload.URL != usageTarget || len(payload.Header) != 1 || payload.Header["Authorization"] != "Bearer $TOKEN$" {
				t.Errorf("unexpected api-call body: %s", data)
			}
			usageReply(w)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	})
	began := time.Now()
	flight := b.RefreshAuth()
	if b.LoggedIn() || b.RefreshAuth() != flight || time.Since(began) > time.Second {
		t.Fatal("account check blocks or duplicates requests")
	}
	if b.RefreshLimits(5*time.Minute) != nil {
		t.Fatal("unknown account may not read quota")
	}
	release <- struct{}{}
	await(t, flight)
	if !b.LoggedIn() || auth.Load() != 1 || b.RefreshAuth() != nil || usage.Load() != 0 {
		t.Fatal("account caching made a usage call")
	}
	await(t, b.RefreshLimits(5*time.Minute))
	rows := b.LimitSnapshot()
	if len(rows) != 1 || rows[0].Kind != KindSevenDay || rows[0].PercentUsed != 12 {
		t.Fatalf("limits: %+v", rows)
	}
	if b.RefreshLimits(5*time.Minute) != nil || usage.Load() != 1 {
		t.Fatal("fresh usage was re-read")
	}
}

func TestAccountSelectionFailsClosed(t *testing.T) {
	for name, body := range map[string]string{
		"none":          `{"files":[]}`,
		"disabled":      `{"files":[{"type":"codex","status":"active","disabled":true,"auth_index":"x"}]}`,
		"unavailable":   `{"files":[{"type":"codex","status":"active","unavailable":true,"auth_index":"x"}]}`,
		"inactive":      `{"files":[{"type":"codex","status":"error","auth_index":"x"}]}`,
		"missing index": `{"files":[{"type":"codex","status":"active"}]}`,
		"multiple":      `{"files":[{"type":"codex","status":"active","auth_index":"x"},{"provider":"codex","status":"active","auth_index":"y"}]}`,
		"malformed":     `{"files":false}`,
	} {
		t.Run(name, func(t *testing.T) {
			b := testBackend(t, func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) })
			b.authIndex = "old"
			b.Limits.put(Window{Kind: KindSevenDay, WindowMinutes: 10080, ObservedAt: time.Now()})
			await(t, b.RefreshAuth())
			if b.LoggedIn() || len(b.LimitSnapshot()) != 0 || len(b.Limits.Snapshot()) != 0 || b.RefreshLimits(5*time.Minute) != nil {
				t.Fatal("ambiguous or unavailable account retained quota")
			}
		})
	}
}

func TestUsageSingleFlightAndFiveMinuteBackoffIncludingFailure(t *testing.T) {
	var hits atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	b := testBackend(t, func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		close(entered)
		<-release
		w.WriteHeader(500)
	})
	b.authIndex = "account-test"
	flight := b.RefreshLimits(5 * time.Minute)
	<-entered
	for range 20 {
		if b.RefreshLimits(5*time.Minute) != flight {
			t.Fatal("usage flight was not shared")
		}
	}
	close(release)
	await(t, flight)
	if b.RefreshLimits(5*time.Minute) != nil || hits.Load() != 1 {
		t.Fatal("failed refresh was not backed off")
	}
}

func TestUsageEnvelopeFailuresKeepReadingsButRemoteFailureClearsThem(t *testing.T) {
	for name, tc := range map[string]struct {
		status int
		body   string
		clear  bool
	}{
		"inner 401":      {200, `{"status_code":401,"body":"private error"}`, false},
		"inner 500":      {200, `{"status_code":500,"body":"private error"}`, false},
		"missing status": {200, `{"body":"{}"}`, false},
		"body object":    {200, `{"status_code":200,"body":{}}`, false},
		"body null":      {200, `{"status_code":200,"body":null}`, false},
		"malformed body": {200, `{"status_code":200,"body":"{"}`, false},
		"outer 500":      {500, `private error`, true},
		"outer 403":      {403, `private error`, false},
		"redirect":       {307, `private error`, false},
	} {
		t.Run(name, func(t *testing.T) {
			b := testBackend(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); fmt.Fprint(w, tc.body) })
			b.authIndex = "account-test"
			b.Limits.put(Window{Kind: KindSevenDay, WindowMinutes: 10080, ObservedAt: time.Now().Add(-time.Hour)})
			await(t, b.RefreshLimits(5*time.Minute))
			if (len(b.Limits.Snapshot()) == 0) != tc.clear {
				t.Fatalf("readings changed incorrectly: %+v", b.Limits.Snapshot())
			}
		})
	}
	b := NewBackend("https://remote.invalid", "private-management-key", roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("transport private-management-key")
	}))
	b.authIndex = "account-test"
	b.Limits.put(Window{Kind: KindSevenDay, WindowMinutes: 10080, ObservedAt: time.Now().Add(-time.Hour)})
	await(t, b.RefreshLimits(5*time.Minute))
	if len(b.Limits.Snapshot()) != 0 {
		t.Fatal("transport failure kept readings")
	}
}

func TestAccountChangeOrInferenceFailureDiscardsInFlightQuota(t *testing.T) {
	for _, changeAccount := range []bool{true, false} {
		release, entered := make(chan struct{}), make(chan struct{})
		b := testBackend(t, func(w http.ResponseWriter, r *http.Request) { close(entered); <-release; usageReply(w) })
		b.authIndex = "account-test"
		flight := b.RefreshLimits(5 * time.Minute)
		<-entered
		if changeAccount {
			b.mu.Lock()
			b.authIndex = "different"
			b.generation++
			b.mu.Unlock()
		} else {
			b.ClearLimits()
		}
		close(release)
		await(t, flight)
		if len(b.Limits.Snapshot()) != 0 {
			t.Fatal("old in-flight usage resurrected invalidated readings")
		}
	}
}

func TestMissingManagementKeyDoesNotDisableInference(t *testing.T) {
	b := testBackend(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" || r.Header.Get("Authorization") != "" {
			t.Error("inference carried a credential or reached management")
		}
		fmt.Fprint(w, `{"type":"message","content":[]}`)
	})
	b.ManagementKey = ""
	if b.RefreshAuth() != nil || b.RefreshLimits(time.Minute) != nil || b.LoggedIn() {
		t.Fatal("missing key triggered management")
	}
	resp, err := b.Messages(context.Background(), []byte(`{}`), http.Header{})
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestManagementAndInferenceNeverFollowRedirects(t *testing.T) {
	var hits atomic.Int32
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer target.Close()
	b := testBackend(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", target.URL)
		w.WriteHeader(307)
	})
	if _, err := b.fetchAuth(context.Background()); err == nil {
		t.Fatal("account redirect accepted")
	}
	if _, err := b.fetchUsage(context.Background(), "x"); err == nil {
		t.Fatal("usage redirect accepted")
	}
	if _, err := b.Messages(context.Background(), nil, http.Header{}); err == nil {
		t.Fatal("inference redirect accepted")
	}
	if hits.Load() != 0 {
		t.Fatal("redirect was followed")
	}
}

func TestLimitReachedOverridesUsedPercent(t *testing.T) {
	for _, body := range []string{
		`{"rate_limit":{"limit_reached":true,"primary_window":{"used_percent":8,"limit_window_seconds":604800}}}`,
		`{"rate_limit":{"primary_window":{"limit_reached":true,"used_percent":8,"limit_window_seconds":604800}}}`,
	} {
		rows := parseUsage([]byte(body), time.Now())
		if len(rows) != 1 || rows[0].PercentUsed != 100 || rows[0].Kind != KindSevenDay {
			t.Fatalf("limit reached: %+v", rows)
		}
	}
}

func TestMessagesHeaderAllowlist(t *testing.T) {
	b := testBackend(t, func(w http.ResponseWriter, r *http.Request) {
		for _, name := range []string{"Authorization", "X-Api-Key", "Cookie", "User-Agent", "X-Ccmproxy-Token", "X-Ccmproxy-Future", "X-Unrelated"} {
			if r.Header.Get(name) != "" {
				t.Errorf("forbidden header %s", name)
			}
		}
		if r.Header.Get("Anthropic-Beta") != "beta-a,beta-b" || r.Header.Get("Anthropic-Version") != "2023-06-01" {
			t.Error("allowed headers lost")
		}
		fmt.Fprint(w, `{}`)
	})
	headers := http.Header{}
	for _, name := range []string{"Authorization", "X-Api-Key", "Cookie", "User-Agent", "X-Ccmproxy-Token", "X-Ccmproxy-Future", "X-Unrelated"} {
		headers.Set(name, "private-anthropic-token")
	}
	headers.Set("Content-Type", "application/json")
	headers.Set("Accept", "text/event-stream")
	headers.Set("Anthropic-Beta", "beta-a,beta-b")
	headers.Set("Anthropic-Version", "2023-06-01")
	resp, err := b.Messages(context.Background(), []byte(`{}`), headers)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
}

func TestTransportErrorsNeverContainTheCredential(t *testing.T) {
	b := NewBackend("https://remote.invalid", "private-management-key", roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("private-management-key in a planted transport error")
	}))
	_, err := b.Messages(context.Background(), nil, http.Header{})
	if !errors.Is(err, ErrUnreachable) || strings.Contains(err.Error(), b.ManagementKey) {
		t.Fatalf("unsafe error: %v", err)
	}
}

func TestAccountInvalidationDoesNotResetUsageFailureBackoff(t *testing.T) {
	var usage atomic.Int32
	now := time.Now()
	b := testBackend(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v8/management/credentials" {
			fmt.Fprint(w, oneAccount)
			return
		}
		usage.Add(1)
		w.WriteHeader(500)
	})
	b.Limits.now = func() time.Time { return now }
	b.authIndex = "account-test"
	await(t, b.RefreshLimits(5*time.Minute))
	b.mu.Lock()
	b.authIndex = ""
	b.mu.Unlock()
	now = now.Add(time.Minute)
	await(t, b.RefreshAuth())
	if b.RefreshLimits(5*time.Minute) != nil || usage.Load() != 1 {
		t.Fatal("account recheck bypassed the usage failure backoff")
	}
}

func TestNilHTTPFallbackRemainsDirectAndShortDial(t *testing.T) {
	for _, client := range []*http.Client{nil, {}} {
		configured := withoutRedirects(client, "https://remote.example")
		transport, ok := configured.Transport.(*http.Transport)
		if !ok || transport.Proxy != nil || transport.TLSHandshakeTimeout != 3*time.Second || configured.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
			t.Fatal("fallback lost the remote safety settings")
		}
	}
}
