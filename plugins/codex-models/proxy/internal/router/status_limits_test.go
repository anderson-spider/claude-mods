package router

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const wham = `{"rate_limit":{"primary_window":{"used_percent":30,"limit_window_seconds":18000,"reset_at":1790000000},` +
	`"secondary_window":{"used_percent":60.5,"limit_window_seconds":604800,"reset_after_seconds":7200}}}`

// statusBody asks a plain status; statusRefresh asks with the opt-in that may
// call the usage endpoint.
func statusBody(t *testing.T, h *harness) (string, map[string]json.RawMessage) {
	t.Helper()
	return statusAt(t, h, "/__ccmproxy/status")
}

func statusRefresh(t *testing.T, h *harness) (string, map[string]json.RawMessage) {
	t.Helper()
	return statusAt(t, h, "/__ccmproxy/status?refresh=limits")
}

func statusAt(t *testing.T, h *harness, target string) (string, map[string]json.RawMessage) {
	t.Helper()
	rec := h.do(t, http.MethodGet, target, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &keys); err != nil {
		t.Fatalf("body %q: %v", rec.Body.String(), err)
	}
	return rec.Body.String(), keys
}

// The four original keys keep their bytes and order; codexLimits is added at
// the end, [] with no reading.
func TestStatusAddsCodexLimitsAfterTheOtherKeys(t *testing.T) {
	h := newHarness(t, nil, nil, false)
	h.router.Version = "1.2.3"
	body, keys := statusBody(t, h)
	if string(keys["codexLimits"]) != "[]" {
		t.Fatalf("codexLimits = %s, want []", keys["codexLimits"])
	}
	head := `{"service":"ccmproxy","version":"1.2.3","codexLogin":false,"models":[`
	if !strings.HasPrefix(body, head) || !strings.HasSuffix(body, `],"codexLimits":[]}`+"\n") {
		t.Fatalf("body = %s", body)
	}
	if h.codex.method != "" {
		t.Fatalf("a status without a login reached Codex: %s %s", h.codex.method, h.codex.path)
	}
}

func TestStatusAsksTheUsageEndpointWhenThereIsNoReading(t *testing.T) {
	var usage atomic.Int32
	h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v8/management/requests/api-call" {
			http.NotFound(w, r)
			return
		}
		usage.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, usageEnvelope(wham))
	}, true)

	_, keys := statusRefresh(t, h)
	var limits []Limit
	if err := json.Unmarshal(keys["codexLimits"], &limits); err != nil || len(limits) != 2 {
		t.Fatalf("codexLimits = %s (%v)", keys["codexLimits"], err)
	}
	if limits[0].Kind != "five_hour" || limits[1].Kind != "seven_day" || limits[1].PercentUsed != 60.5 || limits[1].ResetsAt == "" {
		t.Fatalf("limits = %+v", limits)
	}
	// Now fresh: another status asks nothing.
	statusRefresh(t, h)
	if usage.Load() != 1 {
		t.Fatalf("usage requests = %d, want 1", usage.Load())
	}
}

func TestStatusSurvivesAFailingUsageEndpoint(t *testing.T) {
	h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusBadGateway)
	}, true)
	_, keys := statusRefresh(t, h)
	if string(keys["codexLimits"]) != "[]" || string(keys["codexLogin"]) != "true" {
		t.Fatalf("keys = %v", keys)
	}
}

// A hung usage endpoint holds a status request for usageWait and no longer;
// the request goes on and a later status reads its answer.
func TestStatusDoesNotWaitLongerThanUsageWait(t *testing.T) {
	release := make(chan struct{})
	var usage atomic.Int32
	h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
		usage.Add(1)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = io.WriteString(w, usageEnvelope(wham))
	}, true)
	h.router.usageWait = 50 * time.Millisecond

	began := time.Now()
	_, keys := statusRefresh(t, h)
	if took := time.Since(began); took > 2*time.Second {
		t.Fatalf("status took %v with a hung usage endpoint", took)
	}
	if string(keys["codexLimits"]) != "[]" {
		t.Fatalf("codexLimits = %s", keys["codexLimits"])
	}
	// Concurrent statuses share the one request in flight.
	statusRefresh(t, h)
	statusRefresh(t, h)
	if usage.Load() != 1 {
		t.Fatalf("usage requests = %d, want 1", usage.Load())
	}

	close(release)
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, keys = statusRefresh(t, h); string(keys["codexLimits"]) != "[]" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the usage answer never reached the status")
}

// A status that does not ask for it never calls OpenAI, however stale the
// readings and whoever sends it (the session-start probe, the installer).
func TestStatusWithoutTheOptInNeverCallsTheUsageEndpoint(t *testing.T) {
	var usage atomic.Int32
	h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
		usage.Add(1)
		_, _ = io.WriteString(w, usageEnvelope(wham))
	}, true)

	for _, target := range []string{
		"/__ccmproxy/status",
		"/__ccmproxy/status?refresh=",
		"/__ccmproxy/status?refresh=all",
		"/__ccmproxy/status?refresh=Limits",
		"/__ccmproxy/status?limits=1",
		"/__ccmproxy/status?x=refresh%3Dlimits",
	} {
		_, keys := statusAt(t, h, target)
		if string(keys["codexLimits"]) != "[]" || len(keys) != 5 {
			t.Fatalf("%s: keys = %v", target, keys)
		}
	}
	if usage.Load() != 0 || h.codex.method != "" {
		t.Fatalf("a plain status reached Codex: %d usage requests", usage.Load())
	}

	_, keys := statusRefresh(t, h)
	if usage.Load() != 1 || string(keys["codexLimits"]) == "[]" || len(keys) != 5 {
		t.Fatalf("opted in: %d usage requests, keys = %v", usage.Load(), keys)
	}
}

// A failing endpoint is asked once per five minutes, not once per status.
func TestStatusBacksOffAFailingUsageEndpoint(t *testing.T) {
	var usage atomic.Int32
	h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
		usage.Add(1)
		http.NotFound(w, r)
	}, true)
	for range 5 {
		statusRefresh(t, h)
	}
	if usage.Load() != 1 {
		t.Fatalf("usage requests = %d after 5 opted-in statuses, want 1", usage.Load())
	}
}

func usageEnvelope(body string) string {
	data, _ := json.Marshal(map[string]any{"status_code": 200, "body": body})
	return string(data)
}
