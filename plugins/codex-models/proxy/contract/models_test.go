//go:build contract

package contract

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const upstreamModels = `{"data":[{"type":"model","id":"claude-sonnet-5","display_name":"Claude Sonnet 5","created_at":"2026-02-01T00:00:00Z"}],"has_more":false,"first_id":"claude-sonnet-5","last_id":"claude-sonnet-5"}`

func TestModelsListMergesTheAddedModels(t *testing.T) {
	e := newEnv(t, opts{})
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		_, _ = w.Write([]byte(upstreamModels))
	})
	r := e.do(http.MethodGet, "/v1/models?limit=5", nil, map[string]string{
		"Accept-Encoding": "gzip", "Authorization": "Bearer oauth", "Anthropic-Version": "2023-06-01",
	})
	if r.Status != 200 || !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		t.Fatalf("response = %d %q", r.Status, r.Header.Get("Content-Type"))
	}
	noCORS(t, r)
	got := e.anth.last(t)
	if got.Path != "/v1/models" || got.Query != "limit=5" || got.Header.Get("Authorization") != "Bearer oauth" ||
		got.Header.Get("Anthropic-Version") != "2023-06-01" {
		t.Fatalf("upstream saw %s?%s %v", got.Path, got.Query, got.Header)
	}
	var list struct {
		Data    []map[string]any `json:"data"`
		FirstID string           `json:"first_id"`
		LastID  string           `json:"last_id"`
	}
	must(t, json.Unmarshal(r.Body, &list))
	if list.Data[0]["id"] != "claude-sonnet-5" || list.FirstID != "claude-sonnet-5" || list.LastID != list.Data[len(list.Data)-1]["id"] {
		t.Fatalf("list = %s", r.Body)
	}
	golden(t, "models_merged.golden.json", canonical(t, r.Body))
}

func TestModelsListWhenTheUpstreamFails(t *testing.T) {
	t.Run("with a remote account only the added models", func(t *testing.T) {
		e := withAccount(t, opts{})
		e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { w.WriteHeader(http.StatusUnauthorized) })
		r := e.do(http.MethodGet, "/v1/models", nil, nil)
		if r.Status != 200 {
			t.Fatalf("status = %d: %s", r.Status, r.Body)
		}
		golden(t, "models_upstream_failed.golden.json", canonical(t, r.Body))
	})
	t.Run("without a remote account the upstream answer passes", func(t *testing.T) {
		e := newEnv(t, opts{noAccount: true})
		e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"type":"error","error":{"type":"authentication_error","message":"bad key"}}`))
		})
		r := e.do(http.MethodGet, "/v1/models", nil, nil)
		if r.Status != 401 || !strings.Contains(string(r.Body), "bad key") {
			t.Fatalf("response = %d %s", r.Status, r.Body)
		}
	})
	t.Run("unreachable upstream without a remote account", func(t *testing.T) {
		e := newEnv(t, opts{noAccount: true})
		e.anth.Close()
		if r := e.do(http.MethodGet, "/v1/models", nil, nil); r.Status != http.StatusBadGateway {
			t.Fatalf("status = %d", r.Status)
		}
	})
}

func TestModelsListPaginatedPagesPassThrough(t *testing.T) {
	e := withAccount(t, opts{})
	page := `{"data":[{"type":"model","id":"claude-old"}],"has_more":false}`
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte(page)) })
	for _, q := range []string{"after_id=a", "before_id=b"} {
		r := e.do(http.MethodGet, "/v1/models?"+q, nil, nil)
		if r.Status != 200 || string(r.Body) != page {
			t.Fatalf("%s: %d %s", q, r.Status, r.Body)
		}
	}
}

func TestPrefixedAndSuffixedModelNamesRouteToCodex(t *testing.T) {
	e := withAccount(t, opts{rawConfig: func(cfg map[string]any) { cfg["codex"].(map[string]any)["model_prefix"] = "codex" }})
	e.cdx.set(answerWith(textAnswer("a")...))
	for model, want := range map[string]string{
		"codex/gpt-6-luna":      "gpt-6-luna(",
		"codex/gpt-6-luna-high": "gpt-6-luna(high)",
		"GPT-6-LUNA":            "gpt-6-luna(", // the unconfigured namespace and case are tolerated
		"gpt-6-luna[1m]":        "gpt-6-luna(",
	} {
		r := e.post("/v1/messages", claudeReq(model, true, nil))
		if r.Status != 200 {
			t.Fatalf("%s: status = %d: %s", model, r.Status, r.Body)
		}
		var sent struct {
			Model string `json:"model"`
		}
		must(t, json.Unmarshal(e.cdx.last(t).Body, &sent))
		if !strings.HasPrefix(sent.Model, want) || !strings.HasSuffix(sent.Model, ")") {
			t.Fatalf("%s: the remote got model %q, want %q...)", model, sent.Model, want)
		}
	}
	if e.anth.count() != 0 {
		t.Fatal("a Codex model name went to Anthropic")
	}
	// A name that is not a Codex model goes upstream.
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte(`{}`)) })
	e.post("/v1/messages", claudeReq("gpt-4o", false, nil))
	if e.anth.count() != 1 {
		t.Fatal("an unknown model name did not go upstream")
	}
}

func TestCountTokens(t *testing.T) {
	e := withAccount(t, opts{})
	req := map[string]any{
		"model":  "gpt-6-astra",
		"system": "You are a careful assistant. " + strings.Repeat("Follow the rules. ", 40),
		"messages": []any{
			map[string]any{"role": "user", "content": strings.Repeat("Please review this change. ", 60)},
			map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "text", "text": "Looking."},
				map[string]any{"type": "tool_use", "id": "toolu_1", "name": "Read", "input": map[string]any{"path": "/repo/main.go"}},
			}},
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "tool_result", "tool_use_id": "toolu_1", "content": strings.Repeat("package main\n", 50)},
			}},
		},
		"tools": []any{map[string]any{"name": "Read", "description": "Reads a file", "input_schema": map[string]any{
			"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string"}}}}},
	}
	body, _ := json.Marshal(req)
	count := func(b []byte) int64 {
		r := e.post("/v1/messages/count_tokens", b)
		if r.Status != 200 {
			t.Fatalf("status = %d: %s", r.Status, r.Body)
		}
		var out map[string]int64
		must(t, json.Unmarshal(r.Body, &out))
		if len(out) != 1 || out["input_tokens"] < 1 {
			t.Fatalf("body = %s", r.Body)
		}
		return out["input_tokens"]
	}
	got := count(body)
	if e.anth.count() != 0 || e.cdx.count() != 0 {
		t.Fatal("a Codex count_tokens request left the proxy (the local estimate answers it)")
	}

	// The estimate must stay conservative (not below the floor recorded from
	// today's build) without being absurd (not above twice it). The floor is
	// written only when the file is missing: -update never lowers it. To move
	// it on purpose, edit testdata/count_tokens_reference.json by hand and say
	// why in the change.
	refPath := filepath.Join("testdata", "count_tokens_reference.json")
	if _, err := os.Stat(refPath); err != nil && *update {
		must(t, os.WriteFile(refPath, []byte(mustMarshal(t, map[string]int64{"input_tokens": got})+"\n"), 0o644))
	}
	data, err := os.ReadFile(refPath)
	must(t, err)
	var ref map[string]int64
	must(t, json.Unmarshal(data, &ref))
	if got < ref["input_tokens"] {
		t.Fatalf("estimate %d is below the recorded floor %d", got, ref["input_tokens"])
	}
	if got > 2*ref["input_tokens"] {
		t.Fatalf("estimate %d is above twice the recorded floor %d", got, ref["input_tokens"])
	}

	// More text never counts less.
	req["system"] = req["system"].(string) + strings.Repeat(" extra words", 200)
	bigger, _ := json.Marshal(req)
	if more := count(bigger); more <= got {
		t.Fatalf("a longer request counted %d, not above %d", more, got)
	}

	// A Claude model's count comes from Anthropic.
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"input_tokens":4242}`))
	})
	req["model"] = "claude-sonnet-5"
	claude, _ := json.Marshal(req)
	r := e.post("/v1/messages/count_tokens", claude)
	if r.Status != 200 || string(r.Body) != `{"input_tokens":4242}` {
		t.Fatalf("response = %d %s", r.Status, r.Body)
	}
}

func TestObsoleteCatalogKnobsCannotOverrideFixedCatalog(t *testing.T) {
	e := newEnv(t, opts{rawConfig: func(cfg map[string]any) {
		for k, v := range map[string]any{"models": []string{"gpt-daybreak-blue-latest"}, "model_prefix": "other", "effort_variants": true} {
			cfg["codex"].(map[string]any)[k] = v
		}
	}})
	models := e.do(http.MethodGet, "/__ccmproxy/status", nil, nil).json(t)["models"].([]any)
	if len(models) != 3 {
		t.Fatalf("catalog = %v", models)
	}
	for _, value := range models {
		id := value.(string)
		if strings.Contains(id, "daybreak") || strings.Contains(id, "/") || strings.HasSuffix(id, "-high") {
			t.Fatalf("obsolete knob changed catalog: %s", id)
		}
	}
}
