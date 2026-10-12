//go:build !contract

package codex

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// recordingTransport answers every request with a token and records its URL.
type recordingTransport struct {
	mu   sync.Mutex
	urls []string
}

func (r *recordingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r.mu.Lock()
	r.urls = append(r.urls, req.URL.String())
	r.mu.Unlock()
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"application/json"}},
		Body:       io.NopCloser(strings.NewReader(`{"access_token":"at","refresh_token":"rt","expires_in":3600}`)),
		Request:    req,
	}, nil
}

// Without the contract tag, the CCMPROXY_CONTRACT_* variables change nothing
// a caller can see: the authorize URL and the token requests (Exchange and
// Refresh, both through Client.post) go to the real endpoints.
func TestContractVariablesDoNotReachThePublicAPI(t *testing.T) {
	t.Setenv("CCMPROXY_CONTRACT_OAUTH_AUTH_URL", "http://127.0.0.1:9/authorize")
	t.Setenv("CCMPROXY_CONTRACT_OAUTH_TOKEN_URL", "http://127.0.0.1:9/token")
	t.Setenv("CCMPROXY_CONTRACT_CODEX_BASE_URL", "http://127.0.0.1:9")
	t.Setenv("CCMPROXY_CONTRACT_UPSTREAM", "http://127.0.0.1:9")

	authorize, err := AuthorizeURL("state", &PKCE{Verifier: "v", Challenge: "c"}, 1455)
	if err != nil {
		t.Fatalf("AuthorizeURL: %v", err)
	}
	if !strings.HasPrefix(authorize, AuthURL+"?") {
		t.Fatalf("AuthorizeURL = %s, want the real endpoint %s", authorize, AuthURL)
	}

	recorder := &recordingTransport{}
	client := NewClient(&http.Client{Transport: recorder})
	if _, err := client.Refresh(context.Background(), "rt-old"); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if _, err := client.Exchange(context.Background(), "code", &PKCE{Verifier: "v", Challenge: "c"}, 1455); err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if len(recorder.urls) != 2 {
		t.Fatalf("token requests = %v, want two", recorder.urls)
	}
	for _, got := range recorder.urls {
		if got != TokenURL {
			t.Fatalf("token request went to %s, want the real endpoint %s", got, TokenURL)
		}
	}
}
