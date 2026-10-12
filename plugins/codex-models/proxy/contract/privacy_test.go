//go:build contract

package contract

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// At debug level, with sentinel values in every place a client or a backend
// puts something private, none may reach the log.
func TestLogCarriesNoPrivateValues(t *testing.T) {
	e := newEnv(t, opts{noStart: true, race: true}) // harness default log level: debug
	past := time.Now().Add(-time.Hour)
	oldAccess := accessToken("SENTINEL_ACCESS", past)
	newAccess := accessToken("SENTINEL_ACCESS_NEW", time.Now().Add(time.Hour))
	e.writeLogin(login{expires: past, access: oldAccess, refresh: "SENTINEL_REFRESH"})
	e.oauth.set(refreshing(newAccess, "SENTINEL_REFRESH_NEW", false))
	e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) { _, _ = w.Write([]byte(`{"data":[]}`)) })
	e.start()

	secrets := []string{
		"SENTINEL_Q", "SENTINEL_BEARER", "SENTINEL_APIKEY", "SENTINEL_PROMPT", "SENTINEL_ERRMSG", "SENTINEL_ARGS",
		"SENTINEL_REFRESH", "SENTINEL_REFRESH_NEW", "SENTINEL_OAUTHDESC", "SENTINEL_USER",
		oldAccess, newAccess, e.token, e.salt,
	}
	auth := map[string]string{"Authorization": "Bearer SENTINEL_BEARER", "X-Api-Key": "SENTINEL_APIKEY"}

	// Passthrough: a query string, a bearer and a prompt.
	e.do(http.MethodGet, "/v1/organizations/o?q=SENTINEL_Q", nil, auth)
	e.do(http.MethodGet, "/v1/models?limit=3&q=SENTINEL_Q", nil, auth)
	e.do(http.MethodPost, "/v1/messages?beta=SENTINEL_Q", claudeReq("claude-sonnet-5", false, map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "SENTINEL_PROMPT"}},
	}), auth)

	// Codex: the first request refreshes the login; the prompt, the user id
	// and an error body follow.
	prompt := map[string]any{
		"messages": []any{map[string]any{"role": "user", "content": "SENTINEL_PROMPT"}},
		"metadata": map[string]any{"user_id": "SENTINEL_USER"},
	}
	e.cdx.set(answerWith(evCreated, evText("SENTINEL_PROMPT answer"), evCompleted))
	if r := e.do(http.MethodPost, "/v1/messages?x=SENTINEL_Q", claudeReq("gpt-6-astra", true, prompt), auth); r.Status != 200 {
		t.Fatalf("status = %d: %s", r.Status, r.Body)
	}
	e.cdx.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"SENTINEL_ERRMSG","type":"bad_thing","code":"bad_code"}}`))
	})
	if r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, prompt)); r.Status != 400 {
		t.Fatalf("status = %d", r.Status)
	}

	// A tool call whose arguments are not an object is dropped with a warning
	// that names the tool and the size, never the arguments.
	args := `["SENTINEL_ARGS"]`
	e.cdx.set(answerWith(evCreated, evCallAdded(0, "fc_1", "call_1", "SentinelTool"),
		evCallDone(0, "fc_1", "call_1", "SentinelTool", args), evCompleted))
	e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil))

	// A refresh the token endpoint refuses, with text of its own.
	e.writeLogin(login{expires: past, access: oldAccess, refresh: "SENTINEL_REFRESH"})
	e.oauth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"SENTINEL_OAUTHDESC SENTINEL_REFRESH"}`))
	})
	if r := e.post("/v1/messages", claudeReq("gpt-6-astra", true, nil)); r.Status != http.StatusForbidden {
		t.Fatalf("status = %d: %s", r.Status, r.Body)
	}

	if err := e.stop(); err != nil { // flush: the access line of the last request is written after it ends
		t.Fatalf("serve ended with %v", err)
	}
	log := e.stderr.String()
	for _, s := range secrets {
		if strings.Contains(log, s) {
			t.Errorf("the log carries %q", s)
		}
	}
	if !strings.Contains(log, "SentinelTool") || !strings.Contains(log, fmt.Sprintf("(%d bytes)", len(args))) {
		t.Errorf("the dropped-call warning should name the tool and the argument size:\n%s", log)
	}
	if !strings.Contains(log, "http in") || !strings.Contains(log, "/v1/messages") {
		t.Errorf("no access line for /v1/messages:\n%s", log)
	}
	if t.Failed() {
		t.Logf("log:\n%s", log)
	}
}
