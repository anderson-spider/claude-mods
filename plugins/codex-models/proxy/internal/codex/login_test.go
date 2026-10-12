package codex

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// A callback without this login's state (an `error=access_denied` sent by
// another page, a wrong state, another method) is answered and ignored: the
// login keeps waiting and completes on the real redirect.
func TestLoginCallbackNeedsItsOwnState(t *testing.T) {
	var gotCode string
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotCode = r.PostForm.Get("code")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"at","refresh_token":"rt","expires_in":3600}`))
	}))
	t.Cleanup(tokenServer.Close)
	client := &Client{HTTP: &http.Client{Transport: rewriteTo(tokenServer.URL)}}

	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()

	announced := make(chan string, 1)
	type outcome struct {
		result *LoginResult
		err    error
	}
	done := make(chan outcome, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	go func() {
		result, err := client.Login(ctx, port, false, func(u string) { announced <- u })
		done <- outcome{result, err}
	}()

	var authorize string
	select {
	case authorize = <-announced:
	case o := <-done:
		t.Fatalf("Login ended before announcing: %v", o.err)
	}
	parsed, _ := url.Parse(authorize)
	state := parsed.Query().Get("state")
	if state == "" {
		t.Fatalf("no state in %s", authorize)
	}

	callback := fmt.Sprintf("http://127.0.0.1:%d/auth/callback", port)
	plain := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for _, tc := range []struct {
		name   string
		method string
		query  string
		want   int
	}{
		{"error without state", http.MethodGet, "error=access_denied", http.StatusBadRequest},
		{"code without state", http.MethodGet, "code=forged", http.StatusBadRequest},
		{"wrong state", http.MethodGet, "state=" + url.QueryEscape(state+"x") + "&code=forged", http.StatusBadRequest},
		{"error with a wrong state", http.MethodGet, "state=nope&error=access_denied", http.StatusBadRequest},
		{"right state, wrong method", http.MethodPost, "state=" + url.QueryEscape(state) + "&code=forged", http.StatusMethodNotAllowed},
	} {
		req, _ := http.NewRequest(tc.method, callback+"?"+tc.query, nil)
		resp, err := plain.Do(req)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Fatalf("%s: status %d, want %d", tc.name, resp.StatusCode, tc.want)
		}
		select {
		case o := <-done:
			t.Fatalf("%s ended the login: %v", tc.name, o.err)
		case <-time.After(50 * time.Millisecond):
		}
	}

	resp, err := plain.Get(callback + "?state=" + url.QueryEscape(state) + "&code=real-code")
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("the real callback got %d", resp.StatusCode)
	}
	o := <-done
	if o.err != nil {
		t.Fatalf("Login: %v", o.err)
	}
	if o.result.Token.AccessToken != "at" || gotCode != "real-code" {
		t.Fatalf("Login exchanged %q and got %+v", gotCode, o.result.Token)
	}
}

// The provider's own error, with this login's state, still ends the login.
func TestLoginCallbackErrorWithItsStateEndsTheLogin(t *testing.T) {
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()

	announced := make(chan string, 1)
	done := make(chan error, 1)
	go func() {
		_, err := NewClient(nil).Login(context.Background(), port, false, func(u string) { announced <- u })
		done <- err
	}()
	parsed, _ := url.Parse(<-announced)
	state := parsed.Query().Get("state")
	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/auth/callback?state=%s&error=access_denied", port, url.QueryEscape(state)))
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	_ = resp.Body.Close()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "access_denied") {
			t.Fatalf("Login = %v, want the provider's access_denied", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the provider's error did not end the login")
	}
}
