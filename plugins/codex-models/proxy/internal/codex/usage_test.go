package codex

import (
	"context"
	"errors"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// usageBody is a usage answer with both windows.
const usageBody = `{"plan_type":"plus","rate_limit":{"primary_window":{"used_percent":30,"limit_window_seconds":18000,"reset_at":1790000000},` +
	`"secondary_window":{"used_percent":60,"limit_window_seconds":604800,"reset_at":1790500000}}}`

// loggedInStore saves a token that does not expire soon.
func loggedInStore(t *testing.T) *Store {
	t.Helper()
	store := NewStore(nil, StoreOptions{Dir: t.TempDir()})
	if err := store.Save(&Token{AccessToken: "secret-access", AccountID: "acct-1", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	return store
}

// usageServer serves handler under /backend-api and counts the requests it gets.
type usageServer struct {
	*httptest.Server
	hits atomic.Int32
	mu   sync.Mutex
	last *http.Request
}

func newUsageServer(t *testing.T, handler http.HandlerFunc) *usageServer {
	t.Helper()
	s := &usageServer{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.hits.Add(1)
		s.mu.Lock()
		s.last = r.Clone(context.Background())
		s.mu.Unlock()
		handler(w, r)
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *usageServer) lastRequest() *http.Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.last
}

func waitDone(t *testing.T, done <-chan struct{}) {
	t.Helper()
	if done == nil {
		t.Fatal("no usage request was started")
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the usage request did not end")
	}
}

func TestResponsesObservesTheRateLimitHeadersOnAnyAnswer(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusTooManyRequests} {
		server := newUsageServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Codex-Primary-Used-Percent", "44")
			w.Header().Set("X-Codex-Primary-Window-Minutes", "300")
			w.Header().Set("X-Codex-Primary-Reset-At", "1790000000")
			w.WriteHeader(status)
			_, _ = io.WriteString(w, `{"error":{"type":"usage_limit_reached"}}`)
		})
		backend := NewBackend(server.URL, loggedInStore(t), nil)
		resp, err := backend.Responses(context.Background(), []byte(`{}`), "")
		if resp != nil {
			_ = resp.Body.Close()
		}
		if (status == http.StatusOK) != (err == nil) {
			t.Fatalf("status %d: err = %v", status, err)
		}
		got := backend.Limits.Snapshot()
		if len(got) != 1 || got[0].Kind != "five_hour" || got[0].PercentUsed != 44 || got[0].ResetsAt.Unix() != 1790000000 {
			t.Fatalf("status %d: Snapshot = %+v", status, got)
		}
	}
}

func TestResponsesWithoutLimitsOrHeadersIsUnchanged(t *testing.T) {
	server := newUsageServer(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "ok") })
	bare := &Backend{BaseURL: server.URL, Store: loggedInStore(t), HTTP: server.Client()}
	resp, err := bare.Responses(context.Background(), []byte(`{}`), "")
	if err != nil {
		t.Fatalf("bare Backend: %v", err)
	}
	_ = resp.Body.Close()

	backend := NewBackend(server.URL, loggedInStore(t), nil)
	resp, err = backend.Responses(context.Background(), []byte(`{}`), "")
	if err != nil {
		t.Fatalf("Responses: %v", err)
	}
	_ = resp.Body.Close()
	if got := backend.Limits.Snapshot(); len(got) != 0 {
		t.Fatalf("Snapshot = %+v, want none", got)
	}
}

func TestRefreshLimitsAsksOnceWhenStaleWithTheResponsesCredentials(t *testing.T) {
	server := newUsageServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, usageBody)
	})
	backend := NewBackend(server.URL+"/backend-api/codex", loggedInStore(t), nil)

	waitDone(t, backend.RefreshLimits(5*time.Minute))
	if server.hits.Load() != 1 {
		t.Fatalf("hits = %d, want 1", server.hits.Load())
	}
	req := server.lastRequest()
	if req.Method != http.MethodGet || req.URL.Path != "/backend-api/wham/usage" || req.URL.RawQuery != "" {
		t.Fatalf("request = %s %s?%s", req.Method, req.URL.Path, req.URL.RawQuery)
	}
	for header, want := range map[string]string{
		"Authorization": "Bearer secret-access", "Chatgpt-Account-Id": "acct-1", "User-Agent": config.UserAgent, "Originator": config.Originator,
	} {
		if got := req.Header.Get(header); got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
	if got := backend.Limits.Snapshot(); len(got) != 2 || got[0].Kind != "five_hour" || got[1].PercentUsed != 60 {
		t.Fatalf("Snapshot = %+v", got)
	}

	// Fresh now: no second request.
	if done := backend.RefreshLimits(5 * time.Minute); done != nil {
		t.Fatal("a fresh reading started a request")
	}
	if server.hits.Load() != 1 {
		t.Fatalf("hits = %d after a fresh call", server.hits.Load())
	}
	// Older than maxAge: asks again.
	backend.Limits.now = func() time.Time { return time.Now().Add(6 * time.Minute) }
	waitDone(t, backend.RefreshLimits(5*time.Minute))
	if server.hits.Load() != 2 {
		t.Fatalf("hits = %d after a stale call, want 2", server.hits.Load())
	}
}

func TestRefreshLimitsSkipsAFreshReading(t *testing.T) {
	server := newUsageServer(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, usageBody) })
	backend := NewBackend(server.URL, loggedInStore(t), nil)
	backend.Limits.Observe(headers("x-codex-primary-used-percent", "1", "x-codex-primary-window-minutes", "300"))
	if done := backend.RefreshLimits(5 * time.Minute); done != nil {
		t.Fatal("a fresh passive reading started a request")
	}
	if server.hits.Load() != 0 {
		t.Fatalf("hits = %d", server.hits.Load())
	}
}

func TestRefreshLimitsIsSingleFlight(t *testing.T) {
	release := make(chan struct{})
	var once sync.Once
	closeRelease := func() { once.Do(func() { close(release) }) }
	// Registered after the server's own cleanup, so it runs first: a failure
	// before the explicit release still lets the held handler end.
	t.Cleanup(closeRelease)
	server := newUsageServer(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, usageBody)
	})
	backend := NewBackend(server.URL, loggedInStore(t), nil)

	const callers = 8
	channels := make([]<-chan struct{}, callers)
	var wg sync.WaitGroup
	for i := range channels {
		wg.Add(1)
		go func() {
			defer wg.Done()
			channels[i] = backend.RefreshLimits(5 * time.Minute)
		}()
	}
	wg.Wait()
	for i, ch := range channels {
		if ch == nil || ch != channels[0] {
			t.Fatalf("caller %d got a different flight", i)
		}
	}
	closeRelease()
	waitDone(t, channels[0])
	if server.hits.Load() != 1 {
		t.Fatalf("hits = %d, want 1", server.hits.Load())
	}
}

func TestRefreshLimitsFailureLeavesTheReadingsAlone(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"500":         func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", http.StatusInternalServerError) },
		"404":         func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) },
		"not json":    func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "<html>") },
		"other shape": func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, `{"limits":[1,2]}`) },
	}
	for name, handler := range cases {
		t.Run(name, func(t *testing.T) {
			server := newUsageServer(t, handler)
			backend := NewBackend(server.URL, loggedInStore(t), nil)
			backend.Limits.put(Window{Kind: "five_hour", PercentUsed: 7, WindowMinutes: 300, ObservedAt: time.Now().Add(-time.Hour)})
			waitDone(t, backend.RefreshLimits(5*time.Minute))
			got := backend.Limits.Snapshot()
			if len(got) != 1 || got[0].PercentUsed != 7 {
				t.Fatalf("Snapshot = %+v, want the earlier reading", got)
			}
			// The flight is over and the failure counts as an attempt: no
			// new request until maxAge has passed.
			if done := backend.RefreshLimits(5 * time.Minute); done != nil {
				t.Fatal("a failed request was repeated at once")
			}
			backend.Limits.now = func() time.Time { return time.Now().Add(6 * time.Minute) }
			if done := backend.RefreshLimits(5 * time.Minute); done == nil {
				t.Fatal("a failed request left the flight held")
			}
		})
	}
}

func TestRefreshLimitsTimesOut(t *testing.T) {
	release := make(chan struct{})
	server := newUsageServer(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	defer close(release)
	backend := NewBackend(server.URL, loggedInStore(t), nil)
	backend.UsageTimeout = 100 * time.Millisecond
	began := time.Now()
	waitDone(t, backend.RefreshLimits(5*time.Minute))
	if took := time.Since(began); took > 3*time.Second {
		t.Fatalf("the request took %v with a 100 ms timeout", took)
	}
	if len(backend.Limits.Snapshot()) != 0 {
		t.Fatal("a timed out request left a reading")
	}
}

func TestRefreshLimitsWithoutALoginAsksNothing(t *testing.T) {
	server := newUsageServer(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, usageBody) })
	empty := NewStore(nil, StoreOptions{Dir: t.TempDir()})
	for name, backend := range map[string]*Backend{
		"no token":    NewBackend(server.URL, empty, nil),
		"no store":    NewBackend(server.URL, nil, nil),
		"no limits":   {BaseURL: server.URL, Store: loggedInStore(t), HTTP: server.Client()},
		"nil backend": nil,
	} {
		if done := backend.RefreshLimits(5 * time.Minute); done != nil {
			t.Errorf("%s: started a request", name)
		}
	}
	if server.hits.Load() != 0 {
		t.Fatalf("hits = %d, want 0", server.hits.Load())
	}
}

// The usage request carries the access token: no redirect is followed.
func TestUsageRedirectIsNotFollowed(t *testing.T) {
	for _, tc := range redirectCases {
		t.Run(strings.Join([]string{http.StatusText(tc.status), tc.host}, " to "), func(t *testing.T) {
			origin, elsewhere, hits := redirectPair(t, tc.status, tc.host)
			backend := NewBackend(origin.URL+"/backend-api/codex", loggedInStore(t), origin.Client().Transport)
			_, err := backend.fetchUsage(context.Background(), "secret-access", "acct-1")
			assertRedirectRefused(t, err, tc.status, elsewhere, hits)
			if strings.Contains(err.Error(), "secret-access") {
				t.Fatalf("error %q repeats the access token", err)
			}

			waitDone(t, backend.RefreshLimits(5*time.Minute))
			if hits.Load() != 0 || len(backend.Limits.Snapshot()) != 0 {
				t.Fatalf("redirect target hits = %d, readings = %+v", hits.Load(), backend.Limits.Snapshot())
			}
		})
	}
}

func TestReasonOfDropsTheURL(t *testing.T) {
	server := newUsageServer(t, func(w http.ResponseWriter, r *http.Request) {})
	url := server.URL
	server.Close()
	backend := NewBackend(url+"/backend-api/codex", loggedInStore(t), nil)
	_, err := backend.fetchUsage(context.Background(), "secret-access", "acct-1")
	if err == nil {
		t.Fatal("a closed server answered")
	}
	if reason := reasonOf(err); strings.Contains(reason, url) || strings.Contains(reason, "secret-access") {
		t.Fatalf("reason %q carries the URL or the token", reason)
	}
}

// A failing endpoint is asked at most once per maxAge, whatever the outcome.
func TestRefreshLimitsBacksOffAfterAFailure(t *testing.T) {
	server := newUsageServer(t, func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	backend := NewBackend(server.URL, loggedInStore(t), nil)
	for range 5 {
		if done := backend.RefreshLimits(5 * time.Minute); done != nil {
			waitDone(t, done)
		}
	}
	if server.hits.Load() != 1 {
		t.Fatalf("hits = %d after 5 calls against a 404, want 1", server.hits.Load())
	}
	now := time.Now().Add(5*time.Minute + time.Second)
	backend.Limits.now = func() time.Time { return now }
	waitDone(t, backend.RefreshLimits(5*time.Minute))
	if server.hits.Load() != 2 {
		t.Fatalf("hits = %d after maxAge, want 2", server.hits.Load())
	}
}

// The usage request never refreshes a token or waits for a refresh: a token
// due for expiry skips it, and the token endpoint is not called.
func TestRefreshLimitsNeverRefreshesTheToken(t *testing.T) {
	var tokenCalls atomic.Int32
	oauth := newUsageServer(t, func(w http.ResponseWriter, r *http.Request) {
		tokenCalls.Add(1)
		time.Sleep(2 * time.Second) // a slow token endpoint
		_, _ = io.WriteString(w, `{"access_token":"new","refresh_token":"rt2","expires_in":3600}`)
	})
	usage := newUsageServer(t, func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, usageBody) })
	store := NewStore(NewClient(&http.Client{Transport: redirectTo(oauth.URL)}), StoreOptions{Dir: t.TempDir()})
	for name, expires := range map[string]time.Time{"expired": time.Now().Add(-time.Hour), "due": time.Now().Add(time.Minute)} {
		if err := store.Save(&Token{AccessToken: "old", RefreshToken: "rt", AccountID: "acct-1", ExpiresAt: expires}); err != nil {
			t.Fatalf("Save: %v", err)
		}
		backend := NewBackend(usage.URL, store, nil)
		began := time.Now()
		if done := backend.RefreshLimits(5 * time.Minute); done != nil {
			t.Fatalf("%s: a token due for refresh started a usage request", name)
		}
		if took := time.Since(began); took > time.Second {
			t.Fatalf("%s: RefreshLimits took %v", name, took)
		}
	}
	if tokenCalls.Load() != 0 || usage.hits.Load() != 0 {
		t.Fatalf("token endpoint calls = %d, usage hits = %d, want 0 and 0", tokenCalls.Load(), usage.hits.Load())
	}
}

func TestHeldNeitherRefreshesNorWaits(t *testing.T) {
	store := loggedInStore(t)
	if access, account, err := store.Held(); err != nil || access != "secret-access" || account != "acct-1" {
		t.Fatalf("Held = %q, %q, %v", access, account, err)
	}
	// A busy store (a refresh in progress holds it) is skipped, not waited for.
	store.mu.Lock()
	done := make(chan error, 1)
	go func() { _, _, err := store.Held(); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Error("Held answered from a busy store")
		}
	case <-time.After(2 * time.Second):
		t.Error("Held waited for the store")
	}
	store.mu.Unlock()

	empty := NewStore(nil, StoreOptions{Dir: t.TempDir()})
	if _, _, err := empty.Held(); !errors.Is(err, ErrNotAuthenticated) {
		t.Fatalf("Held without a login = %v", err)
	}
	if err := store.Save(&Token{AccessToken: "x", ExpiresAt: time.Now().Add(time.Minute)}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Held(); !errors.Is(err, ErrTokenDue) {
		t.Fatalf("Held within the refresh lead = %v, want ErrTokenDue", err)
	}
}

// A window the headers stopped carrying must not hide behind the fresh ones:
// staleness follows the oldest window, and the usage answer that no longer
// lists it drops it.
func TestRefreshLimitsFollowsTheOldestWindow(t *testing.T) {
	server := newUsageServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"rate_limit":{"primary_window":{"used_percent":9,"limit_window_seconds":604800,"reset_at":1790500000}}}`)
	})
	backend := NewBackend(server.URL, loggedInStore(t), nil)
	now := time.Now()
	backend.Limits.now = func() time.Time { return now }
	backend.Limits.Observe(headers(
		"x-codex-primary-used-percent", "80", "x-codex-primary-window-minutes", "300",
		"x-codex-secondary-used-percent", "10", "x-codex-secondary-window-minutes", "10080"))
	// Four minutes on, only the weekly window is still sent.
	now = now.Add(4 * time.Minute)
	backend.Limits.Observe(headers("x-codex-primary-used-percent", "11", "x-codex-primary-window-minutes", "10080"))
	if done := backend.RefreshLimits(5 * time.Minute); done != nil {
		t.Fatal("asked before any window was 5 minutes old")
	}
	now = now.Add(2 * time.Minute)
	waitDone(t, backend.RefreshLimits(5*time.Minute))
	got := backend.Limits.Snapshot()
	if len(got) != 1 || got[0].Kind != "seven_day" || got[0].PercentUsed != 9 {
		t.Fatalf("Snapshot = %+v, want only the weekly window from the usage answer", got)
	}
}

// redirectTo sends every request to the server at base, whatever its host,
// so a client built for the real token endpoint reaches a fake.
func redirectTo(base string) http.RoundTripper {
	target, _ := url.Parse(base)
	return roundTripFunc(func(req *http.Request) (*http.Response, error) {
		req = req.Clone(req.Context())
		req.URL.Scheme, req.URL.Host = target.Scheme, target.Host
		return http.DefaultTransport.RoundTrip(req)
	})
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }
