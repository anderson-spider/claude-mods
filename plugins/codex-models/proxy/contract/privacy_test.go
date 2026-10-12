//go:build contract

package contract

import (
	"net/http"
	"strings"
	"testing"
)

// At debug level, with sentinel values in every place a client or a backend
// puts something private, none may reach the log.
func TestLogCarriesNoPrivateValues(t *testing.T) {
	e := newEnv(t, opts{noStart: true, race: true}) // harness default log level: debug
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte(`{"data":[]}`)) })
	e.start()
	e.waitLoggedIn()

	secrets := []string{
		"SENTINEL_Q", "SENTINEL_BEARER", "SENTINEL_APIKEY", "SENTINEL_PROMPT", "SENTINEL_ERRMSG", "SENTINEL_USER",
		"SENTINEL_SIGNATURE", e.token, e.salt, e.mgmtKey, accountIndex,
	}
	auth := map[string]string{"Authorization": "Bearer SENTINEL_BEARER", "X-Api-Key": "SENTINEL_APIKEY"}

	// Passthrough: a query string, a bearer and a prompt.
	e.do(http.MethodGet, "/v1/organizations/o?q=SENTINEL_Q", nil, auth)
	e.do(http.MethodGet, "/v1/models?limit=3&q=SENTINEL_Q", nil, auth)
	e.do(http.MethodPost, "/v1/messages?beta=SENTINEL_Q", claudeReq("claude-sonnet-5", false, map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "SENTINEL_PROMPT"}},
	}), auth)

	// Codex: the prompt, the user id, a thinking signature and an error body.
	prompt := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "SENTINEL_PROMPT"}},
		"metadata": map[string]any{"user_id": "SENTINEL_USER"},
	}
	e.cdx.set(answerWith(evStart,
		`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SENTINEL_SIGNATURE"}}`,
		evStop0, evMsgDelta, evMsgStop))
	if r := e.do(http.MethodPost, "/v1/messages?x=SENTINEL_Q", claudeReq("gpt-6-astra", true, prompt), auth); r.Status != 200 {
		t.Fatalf("status = %d: %s", r.Status, r.Body)
	}
	e.cdx.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"type":"error","error":{"message":"SENTINEL_ERRMSG","type":"bad_thing"}}`))
	})
	if r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, prompt)); r.Status != 400 {
		t.Fatalf("status = %d", r.Status)
	}
	// A quota reading goes through the management side.
	e.do(http.MethodGet, "/__ccmproxy/status?refresh=limits", nil, nil)

	if err := e.stop(); err != nil { // flush: the access line of the last request is written after it ends
		t.Fatalf("serve ended with %v", err)
	}
	log := e.stderr.String()
	for _, s := range secrets {
		if strings.Contains(log, s) {
			t.Errorf("the log carries %q", s)
		}
	}
	if !strings.Contains(log, "http in") || !strings.Contains(log, "/v1/messages") {
		t.Errorf("no access line for /v1/messages:\n%s", log)
	}
	if t.Failed() {
		t.Logf("log:\n%s", log)
	}
}
