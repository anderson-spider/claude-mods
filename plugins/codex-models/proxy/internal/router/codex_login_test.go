package router

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/codex"
	"github.com/tidwall/gjson"
)

// A refresh the token endpoint refused is a lost Codex login: a 403 naming
// `ccmproxy login`, never a 401 (Claude Code would take it for its own login).
func TestExpiredProxyLoginIsAPermissionError(t *testing.T) {
	err := fmt.Errorf("%w (%w)", codex.ErrLoginExpired, &codex.TokenError{StatusCode: http.StatusBadRequest, Code: "invalid_grant"})
	rec := httptest.NewRecorder()
	writeCodexError(rec, err)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if got := gjson.Get(rec.Body.String(), "error.type").String(); got != "permission_error" {
		t.Fatalf("error.type = %q, want permission_error", got)
	}
	if got := gjson.Get(rec.Body.String(), "error.message").String(); !strings.Contains(got, "ccmproxy login codex") {
		t.Fatalf("error.message = %q, want it to name `ccmproxy login codex`", got)
	}
}

// A token endpoint failure that may pass stays a 502 api_error.
func TestTransientTokenFailureIsABadGateway(t *testing.T) {
	rec := httptest.NewRecorder()
	writeCodexError(rec, &codex.TokenError{StatusCode: http.StatusServiceUnavailable})

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if got := gjson.Get(rec.Body.String(), "error.type").String(); got != "api_error" {
		t.Fatalf("error.type = %q, want api_error", got)
	}
	if got := gjson.Get(rec.Body.String(), "error.message").String(); strings.Contains(got, "ccmproxy login") {
		t.Fatalf("error.message = %q: a transient failure must not ask for a new login", got)
	}
}
