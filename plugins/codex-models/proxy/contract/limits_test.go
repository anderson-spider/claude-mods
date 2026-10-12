//go:build contract

package contract

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// J1: the status endpoint's codexLimits. The headers are the Codex CLI's:
// x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}.

const (
	whamPath = "/backend-api/wham/usage"
	// whamBody has both windows and an extra field that must never be logged.
	whamBody = `{"plan_type":"plus","rate_limit":{"primary_window":{"used_percent":30,"limit_window_seconds":18000,"reset_at":1790000000},` +
		`"secondary_window":{"used_percent":60.5,"limit_window_seconds":604800,"reset_at":1790500000}},"note":"SENTINEL_WHAM"}`
)

// limit is one row of codexLimits as a client reads it.
type limit struct {
	Kind          string  `json:"kind"`
	PercentUsed   float64 `json:"percentUsed"`
	ResetsAt      string  `json:"resetsAt"`
	WindowMinutes int     `json:"windowMinutes"`
	ObservedAt    string  `json:"observedAt"`
}

const (
	plainStatus   = "/__ccmproxy/status"
	refreshStatus = "/__ccmproxy/status?refresh=limits"
)

// limitsOf asks the status endpoint with the opt-in that may call the usage
// endpoint, and returns the rows and the raw array. plainLimitsOf asks
// without it, as the session-start probe and the installer do.
func limitsOf(t *testing.T, e *env) ([]limit, string) {
	t.Helper()
	return limitsAt(t, e, refreshStatus)
}

func plainLimitsOf(t *testing.T, e *env) ([]limit, string) {
	t.Helper()
	return limitsAt(t, e, plainStatus)
}

func limitsAt(t *testing.T, e *env, path string) ([]limit, string) {
	t.Helper()
	r := e.do(http.MethodGet, path, nil, nil)
	if r.Status != 200 {
		t.Fatalf("status = %d: %s", r.Status, r.Body)
	}
	var body map[string]json.RawMessage
	must(t, json.Unmarshal(r.Body, &body))
	raw, ok := body["codexLimits"]
	if !ok {
		t.Fatalf("no codexLimits in %s", r.Body)
	}
	rows := []limit{}
	must(t, json.Unmarshal(raw, &rows))
	return rows, string(raw)
}

// usageHits counts the requests the Codex fake got for the usage endpoint.
func usageHits(e *env) int {
	n := 0
	for _, r := range e.cdx.all() {
		if strings.HasSuffix(r.Path, "/wham/usage") {
			n++
		}
	}
	return n
}

func setHeaders(w http.ResponseWriter, kv ...string) {
	for i := 0; i < len(kv); i += 2 {
		w.Header().Set(kv[i], kv[i+1])
	}
}

// codexHandler answers the Responses path with headers and a stream, a JSON
// error, or whatever answer says, and fails the test on a usage request.
func codexHandler(t *testing.T, headers []string, answer handlerFunc) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request, got rec) {
		if strings.HasSuffix(got.Path, "/wham/usage") {
			t.Errorf("an unexpected usage request: %s %s", got.Method, got.Path)
			http.Error(w, "unexpected", http.StatusInternalServerError)
			return
		}
		setHeaders(w, headers...)
		answer(w, r, got)
	}
}

var windowHeaders = []string{
	"X-Codex-Primary-Used-Percent", "36.5", "X-Codex-Primary-Window-Minutes", "300", "X-Codex-Primary-Reset-At", "1790000000",
	"X-Codex-Secondary-Used-Percent", "21", "X-Codex-Secondary-Window-Minutes", "10080", "X-Codex-Secondary-Reset-At", "1790500000",
}

func TestStatusCodexLimitsFromAnswerHeaders(t *testing.T) {
	stream := answerWith(evCreated, evText("hi"), evCompleted)
	tooMany := func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"slow down","type":"usage_limit_reached"}}`))
	}
	cases := []struct {
		name       string
		stream     bool
		answer     handlerFunc
		wantStatus int
	}{
		{"stream", true, stream, 200},
		{"non-stream", false, stream, 200},
		{"429", true, tooMany, 429},
		{"429 non-stream", false, tooMany, 429},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := loggedIn(t, opts{})
			e.cdx.set(codexHandler(t, windowHeaders, c.answer))
			before := time.Now().UTC().Add(-2 * time.Second)

			if r := e.post("/v1/messages", claudeReq("gpt-6-astra", c.stream, nil)); r.Status != c.wantStatus {
				t.Fatalf("message status = %d, want %d: %s", r.Status, c.wantStatus, r.Body)
			}
			rows, raw := limitsOf(t, e)
			if len(rows) != 2 {
				t.Fatalf("codexLimits = %s", raw)
			}
			five, seven := rows[0], rows[1]
			if five.Kind != "five_hour" || five.PercentUsed != 36.5 || five.WindowMinutes != 300 || five.ResetsAt != "2026-09-21T14:13:20Z" {
				t.Fatalf("five-hour row = %+v", five)
			}
			if seven.Kind != "seven_day" || seven.PercentUsed != 21 || seven.WindowMinutes != 10080 || seven.ResetsAt != "2026-09-27T09:06:40Z" {
				t.Fatalf("seven-day row = %+v", seven)
			}
			for _, row := range rows {
				observed, err := time.Parse(time.RFC3339, row.ObservedAt)
				if err != nil || observed.Before(before) || observed.After(time.Now().UTC().Add(2*time.Second)) {
					t.Fatalf("observedAt = %q (%v)", row.ObservedAt, err)
				}
			}
			if !strings.Contains(raw, `{"kind":"five_hour","percentUsed":36.5,"resetsAt":"2026-09-21T14:13:20Z","windowMinutes":300,"observedAt":"`) {
				t.Fatalf("row layout: %s", raw)
			}
			// Passive: the fresh reading asked nothing of the usage endpoint
			// (codexHandler fails the test on one), and nothing was added to
			// the message request.
			if usageHits(e) != 0 || e.cdx.count() != 1 {
				t.Fatalf("Codex requests = %d, usage = %d", e.cdx.count(), usageHits(e))
			}
		})
	}

	t.Run("golden shape", func(t *testing.T) {
		e := loggedIn(t, opts{})
		e.cdx.set(codexHandler(t, windowHeaders, stream))
		e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
		_, raw := limitsOf(t, e)
		golden(t, "status_codex_limits.golden.json", canonical(t, []byte(raw)))
	})
}

func TestStatusCodexLimitsKeepTheLatestPerWindow(t *testing.T) {
	e := loggedIn(t, opts{})
	percent := "10"
	e.cdx.set(func(w http.ResponseWriter, r *http.Request, got rec) {
		setHeaders(w, "X-Codex-Primary-Used-Percent", percent, "X-Codex-Primary-Window-Minutes", "300", "X-Codex-Primary-Reset-After-Seconds", "3600")
		sseAnswer(w, evCreated, evCompleted)
	})
	e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
	percent = "55"
	e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
	rows, raw := limitsOf(t, e)
	if len(rows) != 1 || rows[0].PercentUsed != 55 {
		t.Fatalf("codexLimits = %s", raw)
	}
	// reset-after-seconds became an absolute time about an hour out.
	resets, err := time.Parse(time.RFC3339, rows[0].ResetsAt)
	if d := time.Until(resets); err != nil || d < 55*time.Minute || d > 65*time.Minute {
		t.Fatalf("resetsAt = %q, %v from now (%v)", rows[0].ResetsAt, d, err)
	}
}

func TestStatusCodexLimitsUnknownWindowIsNamedByMinutes(t *testing.T) {
	e := loggedIn(t, opts{})
	e.cdx.set(codexHandler(t, []string{
		"X-Codex-Primary-Used-Percent", "5", "X-Codex-Primary-Window-Minutes", "10080", "X-Codex-Primary-Reset-At", "1790500000",
		"X-Codex-Secondary-Used-Percent", "9", "X-Codex-Secondary-Window-Minutes", "90", "X-Codex-Secondary-Reset-At", "1790000000",
	}, answerWith(evCreated, evCompleted)))
	e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
	rows, raw := limitsOf(t, e)
	var kinds []string
	for _, row := range rows {
		kinds = append(kinds, row.Kind)
	}
	// Told by minutes, not by slot: a weekly window in "primary" is seven_day.
	if strings.Join(kinds, ",") != "window_90m,seven_day" || rows[0].WindowMinutes != 90 {
		t.Fatalf("codexLimits = %s", raw)
	}
}

func TestStatusCodexLimitsIgnoreMalformedHeaders(t *testing.T) {
	bad := [][]string{
		{"X-Codex-Primary-Used-Percent", "NaN", "X-Codex-Primary-Window-Minutes", "300"},
		{"X-Codex-Primary-Used-Percent", "10", "X-Codex-Primary-Window-Minutes", "five"},
		{"X-Codex-Primary-Used-Percent", "10", "X-Codex-Primary-Window-Minutes", "300", "X-Codex-Primary-Reset-At", "tomorrow"},
		{"X-Codex-Primary-Used-Percent", "-4", "X-Codex-Primary-Window-Minutes", "300"},
		{"X-Codex-Primary-Used-Percent", "10"},
		{"X-Codex-Secondary-Window-Minutes", "10080", "X-Codex-Secondary-Reset-At", "1790500000"},
	}
	for i, headers := range bad {
		t.Run(strings.Join(headers, " "), func(t *testing.T) {
			e := loggedIn(t, opts{})
			// Stale readings ask the usage endpoint, which says nothing here.
			e.cdx.set(func(w http.ResponseWriter, r *http.Request, got rec) {
				if strings.HasSuffix(got.Path, "/wham/usage") {
					http.Error(w, "no", http.StatusNotFound)
					return
				}
				setHeaders(w, headers...)
				sseAnswer(w, evCreated, evText("fine"), evCompleted)
			})
			if r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)); r.Status != 200 {
				t.Fatalf("case %d: a malformed header failed the request: %d %s", i, r.Status, r.Body)
			}
			if _, raw := limitsOf(t, e); raw != "[]" {
				t.Fatalf("case %d: codexLimits = %s, want []", i, raw)
			}
		})
	}
}

func TestStatusCodexLimitsEmptyBeforeAnyReading(t *testing.T) {
	t.Run("logged out", func(t *testing.T) {
		e := newEnv(t, opts{})
		if _, raw := limitsOf(t, e); raw != "[]" {
			t.Fatalf("codexLimits = %s, want []", raw)
		}
		if e.cdx.count() != 0 {
			t.Fatalf("a status without a login reached Codex %d times", e.cdx.count())
		}
	})
	t.Run("logged in, usage endpoint unavailable", func(t *testing.T) {
		e := loggedIn(t, opts{}) // the unscripted fake answers 500
		if _, raw := limitsOf(t, e); raw != "[]" {
			t.Fatalf("codexLimits = %s, want []", raw)
		}
		if usageHits(e) != 1 {
			t.Fatalf("usage requests = %d, want 1", usageHits(e))
		}
	})
}

// A status without ?refresh=limits sends nothing to OpenAI, however stale
// the readings, with the same body shape.
func TestStatusWithoutTheOptInNeverCallsTheUsageEndpoint(t *testing.T) {
	e := loggedIn(t, opts{})
	e.cdx.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte(whamBody)) })
	for _, path := range []string{plainStatus, plainStatus + "?refresh=", plainStatus + "?refresh=all", plainStatus + "?limits=1"} {
		if _, raw := limitsAt(t, e, path); raw != "[]" {
			t.Fatalf("%s: codexLimits = %s, want []", path, raw)
		}
	}
	if e.cdx.count() != 0 {
		t.Fatalf("a plain status sent %d requests to Codex", e.cdx.count())
	}
	if rows, _ := limitsOf(t, e); len(rows) != 2 || usageHits(e) != 1 {
		t.Fatalf("opted in: rows = %+v, usage requests = %d", rows, usageHits(e))
	}
}

// The usage request never refreshes a token or waits for a refresh: with an
// expired login and a slow token endpoint the status answers at once and the
// token endpoint is not called.
func TestStatusNeverRidesOnATokenRefresh(t *testing.T) {
	e := newEnv(t, opts{noStart: true})
	e.writeLogin(login{expires: time.Now().Add(-time.Hour)})
	var tokenCalls atomic.Int32
	e.oauth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		tokenCalls.Add(1)
		time.Sleep(3 * time.Second)
		refreshing("new-access", "new-refresh", false)(w, nil, rec{})
	})
	e.start()
	e.cdx.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte(whamBody)) })

	began := time.Now()
	_, raw := limitsOf(t, e)
	if took := time.Since(began); took > 1500*time.Millisecond {
		t.Fatalf("status took %v with an expired login and a slow token endpoint", took)
	}
	if raw != "[]" || tokenCalls.Load() != 0 || e.cdx.count() != 0 {
		t.Fatalf("codexLimits = %s, token endpoint calls = %d, Codex requests = %d", raw, tokenCalls.Load(), e.cdx.count())
	}
}

// A failing endpoint is asked once, not once per status.
func TestStatusBacksOffAFailingUsageEndpoint(t *testing.T) {
	e := loggedIn(t, opts{})
	e.cdx.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { w.WriteHeader(http.StatusNotFound) })
	for range 5 {
		limitsOf(t, e)
	}
	if usageHits(e) != 1 {
		t.Fatalf("usage requests = %d after 5 opted-in statuses, want 1", usageHits(e))
	}
}

func TestStatusCodexUsageEndpoint(t *testing.T) {
	t.Run("fetched when stale, then cached", func(t *testing.T) {
		e := loggedIn(t, opts{})
		e.cdx.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(whamBody))
		})
		rows, raw := limitsOf(t, e)
		if len(rows) != 2 || rows[0].Kind != "five_hour" || rows[0].PercentUsed != 30 || rows[1].Kind != "seven_day" || rows[1].PercentUsed != 60.5 {
			t.Fatalf("codexLimits = %s", raw)
		}
		req := e.cdx.last(t)
		if req.Method != http.MethodGet || req.Path != whamPath || req.Query != "" || len(req.Body) != 0 {
			t.Fatalf("usage request = %s %s?%s body=%d", req.Method, req.Path, req.Query, len(req.Body))
		}
		if !strings.HasPrefix(req.Header.Get("Authorization"), "Bearer ") || req.Header.Get("Chatgpt-Account-Id") != "acct-1" {
			t.Fatalf("usage request lacks the Responses credentials: %v", req.Header)
		}
		if req.Header.Get("X-Ccmproxy-Token") != "" {
			t.Fatal("the proxy's secret reached Codex")
		}
		// Fresh now: more status requests ask nothing.
		for range 3 {
			limitsOf(t, e)
		}
		if usageHits(e) != 1 {
			t.Fatalf("usage requests = %d, want 1", usageHits(e))
		}
		// Nothing but the usage endpoint was ever called (no reset-credits).
		for _, r := range e.cdx.all() {
			if r.Path != whamPath {
				t.Fatalf("unexpected Codex request %s %s", r.Method, r.Path)
			}
		}
	})

	t.Run("a passive reading makes it unnecessary", func(t *testing.T) {
		e := loggedIn(t, opts{})
		e.cdx.set(codexHandler(t, windowHeaders, answerWith(evCreated, evCompleted)))
		e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))
		limitsOf(t, e)
		if usageHits(e) != 0 {
			t.Fatalf("usage requests = %d, want 0", usageHits(e))
		}
	})

	t.Run("single flight, and the status does not wait past its grace", func(t *testing.T) {
		e := loggedIn(t, opts{race: true})
		var hits atomic.Int32
		release := make(chan struct{})
		e.cdx.set(func(w http.ResponseWriter, r *http.Request, _ rec) {
			hits.Add(1)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			_, _ = w.Write([]byte(whamBody))
		})
		began := time.Now()
		_, raw := limitsOf(t, e)
		if took := time.Since(began); raw != "[]" || took > 3*time.Second {
			t.Fatalf("hung usage endpoint: codexLimits = %s after %v", raw, took)
		}
		// Statuses while it is in flight share it.
		done := make(chan struct{})
		for range 4 {
			go func() { limitsOf(t, e); done <- struct{}{} }()
		}
		for range 4 {
			<-done
		}
		if hits.Load() != 1 {
			t.Fatalf("usage requests = %d while one was in flight", hits.Load())
		}
		close(release)
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			if rows, _ := limitsOf(t, e); len(rows) == 2 {
				return
			}
			time.Sleep(25 * time.Millisecond)
		}
		t.Fatal("the usage answer never reached the status")
	})

	t.Run("no redirect is followed", func(t *testing.T) {
		e := loggedIn(t, opts{})
		elsewhere := newFake(t, false)
		elsewhere.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte(whamBody)) })
		e.cdx.set(func(w http.ResponseWriter, r *http.Request, _ rec) {
			w.Header().Set("Location", elsewhere.URL+"/collect")
			w.WriteHeader(http.StatusTemporaryRedirect)
		})
		if _, raw := limitsOf(t, e); raw != "[]" {
			t.Fatalf("codexLimits = %s", raw)
		}
		if elsewhere.count() != 0 {
			t.Fatalf("the redirect target got %d requests, with the token", elsewhere.count())
		}
	})

	t.Run("failures leave the status as it was", func(t *testing.T) {
		for name, answer := range map[string]handlerFunc{
			"500": func(w http.ResponseWriter, _ *http.Request, _ rec) {
				http.Error(w, "boom", http.StatusInternalServerError)
			},
			"not json":  func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte("<html>")) },
			"no window": func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte(`{"rate_limit":{}}`)) },
		} {
			t.Run(name, func(t *testing.T) {
				e := loggedIn(t, opts{})
				e.cdx.set(answer)
				r := e.do(http.MethodGet, refreshStatus, nil, nil)
				if r.Status != 200 {
					t.Fatalf("status = %d", r.Status)
				}
				var body map[string]json.RawMessage
				must(t, json.Unmarshal(r.Body, &body))
				keys := make([]string, 0, len(body))
				for k := range body {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				if strings.Join(keys, ",") != "codexLimits,codexLogin,models,service,version" || string(body["codexLimits"]) != "[]" {
					t.Fatalf("status = %s", r.Body)
				}
			})
		}
	})

	t.Run("no login, no request", func(t *testing.T) {
		e := newEnv(t, opts{})
		e.cdx.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte(whamBody)) })
		for range 3 {
			if _, raw := limitsOf(t, e); raw != "[]" {
				t.Fatalf("codexLimits = %s", raw)
			}
		}
		if e.cdx.count() != 0 {
			t.Fatalf("Codex got %d requests without a login", e.cdx.count())
		}
	})
}

func TestStatusCodexLimitsStayBehindTheSecretAndOutOfTheLog(t *testing.T) {
	e := loggedIn(t, opts{})
	e.cdx.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		_, _ = w.Write([]byte(whamBody))
	})
	if r := e.do(http.MethodGet, "/__ccmproxy/status", nil, map[string]string{"X-Ccmproxy-Token": "-"}); r.Status != http.StatusForbidden {
		t.Fatalf("status without the secret = %d", r.Status)
	}
	if e.cdx.count() != 0 {
		t.Fatal("a refused status request reached Codex")
	}
	limitsOf(t, e)
	log := e.stderr.String()
	for _, leak := range []string{"SENTINEL_WHAM", "Bearer", e.token, "1790000000", "60.5"} {
		if strings.Contains(log, leak) {
			t.Fatalf("the log carries %q:\n%s", leak, log)
		}
	}
	// Logs carry the path, never the query.
	if strings.Contains(log, "refresh=") {
		t.Fatalf("the log carries the query:\n%s", log)
	}
	if !strings.Contains(log, "codex usage") {
		t.Fatalf("the usage request left no debug line:\n%s", log)
	}
}
