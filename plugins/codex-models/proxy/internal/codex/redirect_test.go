package codex

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// hostTransport sends requests for host to base and every other request
// where it points, so a followed redirect would really reach its Location.
type hostTransport struct {
	host string
	base *url.URL
	next http.RoundTripper
}

func (h *hostTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Host == h.host {
		req = req.Clone(req.Context())
		req.URL.Scheme, req.URL.Host = h.base.Scheme, h.base.Host
	}
	return h.next.RoundTrip(req)
}

// redirectPair starts an https server that answers every request with status
// and a Location on a plain-http elsewhere server, which counts its hits.
func redirectPair(t *testing.T, status int, locationHost string) (origin *httptest.Server, elsewhere string, hits *atomic.Int32) {
	t.Helper()
	hits = &atomic.Int32{}
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"stolen","refresh_token":"stolen","expires_in":3600}`))
	}))
	t.Cleanup(target.Close)
	parsed, _ := url.Parse(target.URL)
	elsewhere = "http://" + locationHost + ":" + parsed.Port() + "/collect"
	origin = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", elsewhere)
		w.WriteHeader(status)
	}))
	t.Cleanup(origin.Close)
	return origin, elsewhere, hits
}

func assertRedirectRefused(t *testing.T, err error, status int, elsewhere string, hits *atomic.Int32) {
	t.Helper()
	if err == nil {
		t.Fatalf("a %d was followed or accepted", status)
	}
	if message := err.Error(); !strings.Contains(message, fmt.Sprint(status)) || !strings.Contains(message, "redirect") {
		t.Fatalf("error %q does not name the %d redirect", message, status)
	}
	parsed, _ := url.Parse(elsewhere)
	if strings.Contains(err.Error(), parsed.Port()) || strings.Contains(err.Error(), "collect") {
		t.Fatalf("error %q echoes the Location", err)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("the redirect target was reached %d times", n)
	}
}

var redirectCases = []struct {
	status int
	host   string
}{
	{http.StatusTemporaryRedirect, "localhost"}, // another origin, over http
	{http.StatusPermanentRedirect, "localhost"}, // the same, permanent
	{http.StatusTemporaryRedirect, "127.0.0.1"}, // the same host, https to http
	{http.StatusPermanentRedirect, "127.0.0.1"}, // the same, permanent
	{http.StatusFound, "localhost"},             // a 302 turns the POST into a GET
}

// The token endpoint's form carries the refresh token: no redirect is
// followed, whichever client the caller built.
func TestTokenEndpointRedirectIsNotFollowed(t *testing.T) {
	for _, tc := range redirectCases {
		t.Run(fmt.Sprintf("%d to %s", tc.status, tc.host), func(t *testing.T) {
			origin, elsewhere, hits := redirectPair(t, tc.status, tc.host)
			base, _ := url.Parse(origin.URL)
			transport := &hostTransport{host: "auth.openai.com", base: base, next: origin.Client().Transport}

			for name, client := range map[string]*Client{
				"bare Client": {HTTP: &http.Client{Transport: transport}},
				"NewClient":   NewClient(&http.Client{Transport: transport}),
			} {
				_, err := client.Refresh(context.Background(), "rt-secret")
				assertRedirectRefused(t, err, tc.status, elsewhere, hits)
				if errors.Is(err, ErrLoginExpired) {
					t.Fatalf("%s: a redirect is not a lost login: %v", name, err)
				}
				if strings.Contains(err.Error(), "rt-secret") {
					t.Fatalf("%s: error %q repeats the refresh token", name, err)
				}
			}
		})
	}
}

func TestNewClientLeavesTheCallersClientAlone(t *testing.T) {
	mine := &http.Client{Timeout: time.Second}
	client := NewClient(mine)
	if mine.CheckRedirect != nil {
		t.Fatal("NewClient changed the caller's http.Client")
	}
	if client.HTTP.CheckRedirect == nil || client.HTTP.Timeout != time.Second {
		t.Fatalf("NewClient's client = %+v, want the caller's settings without redirects", client.HTTP)
	}
}

// The Codex backend request carries the access token: no redirect is
// followed, even to the same host or to http.
func TestBackendRedirectIsNotFollowed(t *testing.T) {
	for _, tc := range redirectCases {
		t.Run(fmt.Sprintf("%d to %s", tc.status, tc.host), func(t *testing.T) {
			origin, elsewhere, hits := redirectPair(t, tc.status, tc.host)
			store := NewStore(nil, StoreOptions{Dir: t.TempDir()})
			if err := store.Save(&Token{AccessToken: "secret-access", AccountID: "acct", ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
				t.Fatalf("Save: %v", err)
			}

			for name, backend := range map[string]*Backend{
				"NewBackend":   NewBackend(origin.URL, store, origin.Client().Transport),
				"bare Backend": {BaseURL: origin.URL, Store: store, HTTP: origin.Client()},
			} {
				resp, err := backend.Responses(context.Background(), []byte(`{}`), "")
				if resp != nil {
					_ = resp.Body.Close()
				}
				assertRedirectRefused(t, err, tc.status, elsewhere, hits)
				var apiErr *APIError
				if errors.As(err, &apiErr) {
					t.Fatalf("%s: a redirect became an APIError carrying its body", name)
				}
				if strings.Contains(err.Error(), "secret-access") {
					t.Fatalf("%s: error %q repeats the access token", name, err)
				}
			}
		})
	}
}
