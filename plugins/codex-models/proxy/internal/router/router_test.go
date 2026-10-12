package router

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/codex"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/jsontest"
)

// recorded captures what a fake upstream received.
type recorded struct {
	method string
	path   string
	query  string
	header http.Header
	body   string
}

// harness wires a Router against a fake Anthropic API and a fake Codex
// backend so the whole request path can be exercised without network access.
type harness struct {
	router    *Router
	anthropic *recorded
	codex     *recorded
}

// newHarness builds the harness. anthropicHandler and codexHandler produce the
// fake upstream responses; either may be nil for a default.
func newHarness(t *testing.T, anthropicHandler, codexHandler http.HandlerFunc, authenticate bool) *harness {
	t.Helper()

	h := &harness{anthropic: &recorded{}, codex: &recorded{}}

	record := func(into *recorded, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		into.method = r.Method
		into.path = r.URL.Path
		into.query = r.URL.RawQuery
		into.header = r.Header.Clone()
		into.body = string(body)
		r.Body = io.NopCloser(strings.NewReader(string(body)))
	}

	if anthropicHandler == nil {
		anthropicHandler = func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":"anthropic"}`))
		}
	}
	anthropicServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		record(h.anthropic, r)
		anthropicHandler(w, r)
	}))
	t.Cleanup(anthropicServer.Close)

	if codexHandler == nil {
		codexHandler = func(w http.ResponseWriter, r *http.Request) {
			if readHead([]byte(h.codex.body)).Stream {
				writeSSE(w, `{"type":"message_start","message":{"id":"msg_test","type":"message","content":[],"usage":{}}}`)
				writeSSE(w, `{"type":"message_stop"}`)
			} else {
				fmt.Fprint(w, `{"id":"msg_test","type":"message","content":[],"stop_reason":"end_turn","usage":{}}`)
			}
		}
	}
	codexServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v8/management/credentials" {
			fmt.Fprint(w, `{"files":[{"type":"codex","provider":"codex","status":"active","auth_index":"account-test"}]}`)
			return
		}
		record(h.codex, r)
		codexHandler(w, r)
	}))
	t.Cleanup(codexServer.Close)

	cfg := config.Default()
	cfg.Upstream = anthropicServer.URL
	cfg.Codex.Remote = codexServer.URL
	cfg.SessionSalt = strings.Repeat("a", 64)
	if authenticate {
		cfg.Codex.ManagementKey = "management-test-key"
	}
	backend := codex.NewBackend(cfg.Codex.Remote, cfg.Codex.ManagementKey, codexServer.Client().Transport)
	if authenticate {
		<-backend.RefreshAuth()
	}
	registry := codex.NewRegistry()

	router, err := New(cfg, registry, backend, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	h.router = router
	return h
}

func writeSSE(w http.ResponseWriter, payload string) {
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", jsontest.Get(payload, "type").String(), payload)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (h *harness) do(t *testing.T, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, reader)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")
	req.Header.Set("x-api-key", "sk-ant-test")
	rec := httptest.NewRecorder()
	h.router.ServeHTTP(rec, req)
	return rec
}

func TestModelListMergesCodexModels(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[
			{"type":"model","id":"claude-opus-5","display_name":"Claude Opus 5","created_at":"2026-01-01T00:00:00Z"}
		],"has_more":false,"first_id":"claude-opus-5","last_id":"claude-opus-5"}`))
	}, nil, true)

	rec := h.do(t, http.MethodGet, "/v1/models?limit=1000", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}

	ids := map[string]string{}
	jsontest.Get(rec.Body.String(), "data").ForEach(func(_, model jsontest.Result) bool {
		ids[model.Get("id").String()] = model.Get("display_name").String()
		return true
	})

	if _, ok := ids["claude-opus-5"]; !ok {
		t.Fatalf("upstream models were dropped: %v", ids)
	}
	if len(ids) != 4 {
		t.Fatalf("expected one Anthropic model and exactly the three crew twins: %v", ids)
	}
	for _, id := range []string{"gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"} {
		if _, ok := ids[id]; !ok {
			t.Fatalf("crew twin model %s was not added: %v", id, ids)
		}
	}
	if _, ok := ids["gpt-6-luna-high"]; ok {
		t.Fatal("effort variant must not be advertised")
	}
	if got := jsontest.Get(rec.Body.String(), "first_id").String(); got != "claude-opus-5" {
		t.Fatalf("first_id = %q", got)
	}
	if got := jsontest.Get(rec.Body.String(), "last_id").String(); got == "claude-opus-5" {
		t.Fatal("last_id was not updated after appending models")
	}
}

func TestModelListFallsBackToCodexOnlyWhenUpstreamRejects(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"authentication_error","message":"no key"}}`))
	}, nil, true)

	rec := h.do(t, http.MethodGet, "/v1/models", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 so the added models stay usable: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"gpt-6-luna"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestModelListForwardsUpstreamErrorWithoutCodexLogin(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"type":"error","error":{"type":"authentication_error","message":"no key"}}`))
	}, nil, false)

	rec := h.do(t, http.MethodGet, "/v1/models", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want the upstream 401 forwarded", rec.Code)
	}
}

func TestModelListPaginatedPageIsPassedThrough(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"type":"model","id":"claude-sonnet-5"}],"has_more":false}`))
	}, nil, true)

	rec := h.do(t, http.MethodGet, "/v1/models?after_id=claude-opus-5", "")
	if strings.Contains(rec.Body.String(), "gpt-6-luna") {
		t.Fatal("models must not be appended to a cursor page, which would duplicate them")
	}
}

func TestClaudeModelRequestIsPassedThroughByteForByte(t *testing.T) {
	h := newHarness(t, nil, nil, true)

	body := `{"model":"claude-opus-5","max_tokens":1024,"messages":[{"role":"user","content":"hello"}]}`
	rec := h.do(t, http.MethodPost, "/v1/messages", body)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if h.anthropic.body != body {
		t.Fatalf("upstream body was altered:\n got %s\nwant %s", h.anthropic.body, body)
	}
	if h.anthropic.path != "/v1/messages" {
		t.Fatalf("upstream path = %q", h.anthropic.path)
	}
	if got := h.anthropic.header.Get("x-api-key"); got != "sk-ant-test" {
		t.Fatalf("client credentials were not forwarded: %q", got)
	}
	if got := h.anthropic.header.Get("anthropic-version"); got != "2023-06-01" {
		t.Fatalf("anthropic-version = %q", got)
	}
	if h.codex.method != "" {
		t.Fatal("a Claude model request must never reach the Codex backend")
	}
}

func TestUnknownPathIsPassedThrough(t *testing.T) {
	h := newHarness(t, nil, nil, true)

	rec := h.do(t, http.MethodPost, "/v1/complete?beta=true", `{"prompt":"x"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if h.anthropic.path != "/v1/complete" || h.anthropic.query != "beta=true" {
		t.Fatalf("upstream saw %s?%s", h.anthropic.path, h.anthropic.query)
	}
	if h.anthropic.body != `{"prompt":"x"}` {
		t.Fatalf("upstream body = %q", h.anthropic.body)
	}
}

func TestBootstrapIsPassedThroughUntouched(t *testing.T) {
	// The bootstrap rewrite is gone: Claude Code fetches bootstrap from
	// Anthropic directly, so a request that does arrive is plain passthrough.
	const body = `{"additional_model_options":[]}`
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}, nil, true)

	rec := h.do(t, http.MethodGet, "/api/claude_cli/bootstrap", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if h.anthropic.path != "/api/claude_cli/bootstrap" {
		t.Fatalf("upstream saw %q", h.anthropic.path)
	}
	if rec.Body.String() != body {
		t.Fatalf("body = %q, want the upstream body unchanged", rec.Body.String())
	}
}

func TestPassthroughDropsProxyIssuedThinking(t *testing.T) {
	h := newHarness(t, nil, nil, true)

	body := `{"model":"claude-opus-5","messages":[{"role":"assistant","content":[` +
		`{"type":"thinking","thinking":"codex","signature":"` + SignatureMarker + `SIG"},` +
		`{"type":"text","text":"answer"}]}]}`
	h.do(t, http.MethodPost, "/v1/messages", body)

	if strings.Contains(h.anthropic.body, SignatureMarker) {
		t.Fatalf("proxy-issued reasoning state reached Anthropic: %s", h.anthropic.body)
	}
	blocks := jsontest.Get(h.anthropic.body, "messages.0.content").Array()
	if len(blocks) != 1 || blocks[0].Get("text").String() != "answer" {
		t.Fatalf("upstream body = %s", h.anthropic.body)
	}
}

func TestCodexBackendErrorIsMapped(t *testing.T) {
	h := newHarness(t, nil, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"usage limit reached"}}`))
	}, true)

	rec := h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","stream":true,"messages":[]}`)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want the upstream 429 preserved", rec.Code)
	}
	body := jsontest.Parse(rec.Body.String())
	if got := body.Get("error.type").String(); got != "rate_limit_error" {
		t.Fatalf("error.type = %q", got)
	}
	if got := body.Get("error.message").String(); got != "usage limit reached" {
		t.Fatalf("error.message = %q", got)
	}
}

func TestCountTokensForCodexModelIsAnsweredLocally(t *testing.T) {
	h := newHarness(t, nil, nil, true)

	rec := h.do(t, http.MethodPost, "/v1/messages/count_tokens", `{"model":"gpt-6-luna","messages":[{"role":"user","content":"hello there friend"}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if got := jsontest.Get(rec.Body.String(), "input_tokens").Int(); got < 1 {
		t.Fatalf("input_tokens = %d, want a positive estimate", got)
	}
	if h.anthropic.method != "" {
		t.Fatal("count_tokens for a Codex model must not reach Anthropic")
	}
}

func TestCountTokensForClaudeModelIsPassedThrough(t *testing.T) {
	h := newHarness(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"input_tokens":17}`))
	}, nil, true)

	rec := h.do(t, http.MethodPost, "/v1/messages/count_tokens", `{"model":"claude-opus-5","messages":[]}`)
	if got := jsontest.Get(rec.Body.String(), "input_tokens").Int(); got != 17 {
		t.Fatalf("input_tokens = %d, want the upstream answer", got)
	}
	if h.anthropic.path != "/v1/messages/count_tokens" {
		t.Fatalf("upstream path = %q", h.anthropic.path)
	}
}

func TestAdminEndpoints(t *testing.T) {
	h := newHarness(t, nil, nil, true)

	// The CA endpoint went with the local certificate authority.
	rec := h.do(t, http.MethodGet, "/__ccmproxy/ca", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("CA endpoint returned %d, want 404", rec.Code)
	}

	rec = h.do(t, http.MethodGet, "/__ccmproxy/status", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status endpoint returned %d", rec.Code)
	}
	if !jsontest.Get(rec.Body.String(), "codexLogin").Bool() {
		t.Fatalf("status = %s", rec.Body.String())
	}
	if h.anthropic.method != "" {
		t.Fatal("admin endpoints must not reach Anthropic")
	}
}

func (h *harness) codexUpstream(t *testing.T) jsontest.Result {
	t.Helper()
	if h.codex.body == "" {
		t.Fatal("the Codex backend received no request")
	}
	return jsontest.Parse(h.codex.body)
}

func TestClientEffortIsForwarded(t *testing.T) {
	// This is how Claude Code's /effort and --effort arrive, so a bare model
	// id is enough to control effort; per-effort ids are not needed.
	for _, effort := range []string{"low", "medium", "high", "xhigh"} {
		h := newHarness(t, nil, nil, true)
		h.do(t, http.MethodPost, "/v1/messages", `{
			"model":"gpt-6-luna",
			"max_tokens":100,
			"messages":[{"role":"user","content":"hi"}],
			"thinking":{"type":"adaptive"},
			"output_config":{"effort":"`+effort+`"}
		}`)
		if got := h.codexUpstream(t).Get("model").String(); got != "gpt-6-luna("+effort+")" {
			t.Fatalf("output_config.effort %q became reasoning.effort %q", effort, got)
		}
	}
}

func TestClientEffortIsClampedToWhatTheModelSupports(t *testing.T) {
	// Claude Code offers the effort levels of the model the picker row says
	// to behave as, which can exceed the real model's range.
	h := newHarness(t, nil, nil, true)
	h.do(t, http.MethodPost, "/v1/messages", `{
		"model":"gpt-6-luna",
		"messages":[],
		"output_config":{"effort":"ultra"}
	}`)
	// gpt-6-luna stops at max.
	if got := h.codexUpstream(t).Get("model").String(); got != "gpt-6-luna(max)" {
		t.Fatalf("reasoning.effort = %q, want it clamped to max", got)
	}

	// A model that does support ultra passes it through.
	h = newHarness(t, nil, nil, true)
	h.do(t, http.MethodPost, "/v1/messages", `{
		"model":"gpt-6-astra",
		"messages":[],
		"output_config":{"effort":"ultra"}
	}`)
	if got := h.codexUpstream(t).Get("model").String(); got != "gpt-6-astra(ultra)" {
		t.Fatalf("reasoning.effort = %q, want ultra", got)
	}
}

func TestUnknownClientEffortIsClamped(t *testing.T) {
	// "ultra" exists in Claude Code but not in every Codex model.
	h := newHarness(t, nil, nil, true)
	h.do(t, http.MethodPost, "/v1/messages", `{
		"model":"gpt-6-luna",
		"messages":[],
		"output_config":{"effort":"ultra"}
	}`)
	if got := h.codexUpstream(t).Get("model").String(); got != "gpt-6-luna(max)" {
		t.Fatalf("reasoning.effort = %q, want the highest supported level", got)
	}
}

func TestModelNameEffortOverridesTheClient(t *testing.T) {
	// A per-effort id is still honoured, and is an explicit override.
	h := newHarness(t, nil, nil, true)
	h.do(t, http.MethodPost, "/v1/messages", `{
		"model":"gpt-6-luna-low",
		"messages":[],
		"output_config":{"effort":"high"}
	}`)
	if got := h.codexUpstream(t).Get("model").String(); got != "gpt-6-luna(low)" {
		t.Fatalf("reasoning.effort = %q, want the model name to win", got)
	}
}

func TestEffortFallsBackWithoutAnyClientPreference(t *testing.T) {
	h := newHarness(t, nil, nil, true)
	h.do(t, http.MethodPost, "/v1/messages", `{"model":"gpt-6-luna","messages":[]}`)
	if got := h.codexUpstream(t).Get("model").String(); got != "gpt-6-luna(medium)" {
		t.Fatalf("reasoning.effort = %q, want the model default", got)
	}
}

func TestResolveEffortAlwaysReturnsAConcreteLevel(t *testing.T) {
	registry := codex.NewRegistry()
	resolve := func(model, body string) string {
		resolution, ok := registry.Resolve(model)
		if !ok {
			t.Fatalf("%q is not a Codex model", model)
		}
		return resolveEffort([]byte(body), resolution)
	}

	cases := []struct {
		name  string
		model string
		body  string
		want  string
	}{
		{"model default", "gpt-6-luna", `{}`, "medium"},
		{"client choice", "gpt-6-luna", `{"output_config":{"effort":"high"}}`, "high"},
		{"model name pin", "gpt-6-luna-low", `{"output_config":{"effort":"high"}}`, "low"},
		{"clamped client choice", "gpt-6-luna", `{"output_config":{"effort":"ultra"}}`, "max"},
		{"thinking budget", "gpt-6-luna", `{"thinking":{"type":"enabled","budget_tokens":40000}}`, "xhigh"},
		{"thinking disabled", "gpt-6-luna", `{"thinking":{"type":"disabled"}}`, "low"},
		{"adaptive with no effort", "gpt-6-luna", `{"thinking":{"type":"adaptive"}}`, "xhigh"},
		{"unparseable body", "gpt-6-luna", `not json`, "medium"},
	}
	for _, c := range cases {
		got := resolve(c.model, c.body)
		if got != c.want {
			t.Fatalf("%s: resolveEffort = %q, want %q", c.name, got, c.want)
		}
		// An empty result would silently hand the decision to a second
		// place, which is the bug this consolidation removes.
		if got == "" {
			t.Fatalf("%s: resolveEffort returned no level", c.name)
		}
	}
}

func TestTheEffortSentUpstreamIsTheOneResolved(t *testing.T) {
	registry := codex.NewRegistry()

	for _, body := range []string{
		`{"model":"gpt-6-luna","messages":[]}`,
		`{"model":"gpt-6-luna","messages":[],"output_config":{"effort":"high"}}`,
		`{"model":"gpt-6-luna","messages":[],"output_config":{"effort":"max"}}`,
		`{"model":"gpt-6-luna-low","messages":[],"output_config":{"effort":"high"}}`,
		`{"model":"gpt-6-astra","messages":[],"output_config":{"effort":"ultra"}}`,
		`{"model":"gpt-6-luna","messages":[],"thinking":{"type":"enabled","budget_tokens":2048}}`,
	} {
		model := jsontest.Get(body, "model").String()
		resolution, ok := registry.Resolve(model)
		if !ok {
			t.Fatalf("%q is not a Codex model", model)
		}
		want := resolveEffort([]byte(body), resolution)

		h := newHarness(t, nil, nil, true)
		h.do(t, http.MethodPost, "/v1/messages", body)
		if got := h.codexUpstream(t).Get("model").String(); got != resolution.Model.ID+"("+want+")" {
			t.Fatalf("%s: sent model %q but resolveEffort said %q", body, got, want)
		}
	}
}

func TestExcludedModelNeverReachesTheCodexRemote(t *testing.T) {
	for _, model := range []string{"gpt-5.6-luna", "gpt-5.6-sol:high", "gpt-5.6-terra", "codex/gpt-6-sol:medium[1m]"} {
		h := newHarness(t, nil, nil, true)
		h.do(t, http.MethodPost, "/v1/messages", `{"model":"`+model+`","messages":[]}`)
		if h.codex.method != "" {
			t.Fatalf("excluded model %s reached remote", model)
		}
	}
}
