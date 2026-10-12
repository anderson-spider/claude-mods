package codex

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// loginTimeout bounds how long the callback server waits for the browser.
const loginTimeout = 5 * time.Minute

// callbackPath is where the provider redirects the browser back to.
const callbackPath = "/auth/callback"

// callback is what ended the wait: the provider's redirect for this login
// (a code, or an error it reported) or the callback server failing.
type callback struct {
	code string
	err  string
}

// LoginResult reports the outcome of an interactive login.
type LoginResult struct {
	Token *Token
	// AuthorizeURL is exposed so callers can print it when no browser opened.
	AuthorizeURL string
}

// Login runs the authorization code + PKCE flow end to end: it starts a
// loopback callback server, opens the browser, waits for the redirect and
// exchanges the code for tokens. openBrowser can be disabled for headless
// machines, where the URL is printed by the caller instead.
func (c *Client) Login(ctx context.Context, callbackPort int, openBrowser bool, announce func(string)) (*LoginResult, error) {
	pkce, err := NewPKCE()
	if err != nil {
		return nil, err
	}
	state, err := RandomState()
	if err != nil {
		return nil, err
	}
	authorizeURL, err := AuthorizeURL(state, pkce, callbackPort)
	if err != nil {
		return nil, err
	}

	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", callbackPort))
	if err != nil {
		return nil, fmt.Errorf("codex: cannot listen on the OAuth callback port %d (is the Codex CLI mid-login?): %w", callbackPort, err)
	}
	results := make(chan callback, 1)
	deliver := func(result callback) {
		select {
		case results <- result:
		default: // the first one already ended the wait
		}
	}
	mux := http.NewServeMux()
	mux.Handle(callbackPath, callbackHandler(state, deliver))
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			deliver(callback{err: err.Error()})
		}
	}()
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	if announce != nil {
		announce(authorizeURL)
	}
	if openBrowser {
		if err := openURL(authorizeURL); err != nil {
			return nil, fmt.Errorf("codex: open browser: %w", err)
		}
	}

	waitCtx, cancel := context.WithTimeout(ctx, loginTimeout)
	defer cancel()
	var result callback
	select {
	case result = <-results:
	case <-waitCtx.Done():
		return nil, fmt.Errorf("codex: timed out waiting for the OAuth callback")
	}
	switch {
	case result.err != "":
		return nil, fmt.Errorf("codex: authorization failed: %s", result.err)
	case result.code == "":
		return nil, fmt.Errorf("codex: authorization callback carried no code")
	}

	token, err := c.Exchange(ctx, result.code, pkce, callbackPort)
	if err != nil {
		return nil, err
	}
	return &LoginResult{Token: token, AuthorizeURL: authorizeURL}, nil
}

// callbackHandler answers the provider's redirect. Only a GET carrying this
// login's state (compared in constant time) reaches deliver; another method
// is a 405 and another state a 400, and neither ends the login, so a page
// that guesses the port cannot cut a sign-in short or slip in its own code.
func callbackHandler(state string, deliver func(callback)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		query := r.URL.Query()
		if subtle.ConstantTimeCompare([]byte(query.Get("state")), []byte(state)) != 1 {
			writePage(w, http.StatusBadRequest, failurePage("this callback does not belong to the sign-in in progress"))
			return
		}

		result := callback{code: query.Get("code"), err: query.Get("error")}
		if description := query.Get("error_description"); result.err != "" && description != "" {
			result.err += ": " + description
		}
		if result.err != "" || result.code == "" {
			writePage(w, http.StatusBadRequest, failurePage(result.err))
		} else {
			writePage(w, http.StatusOK, successPage)
		}
		deliver(result)
	})
}

func writePage(w http.ResponseWriter, status int, page string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(page))
}

// openURL hands target to the desktop's browser without waiting for it.
func openURL(target string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", target)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	return cmd.Start()
}

const pageStyle = `<style>body{font:16px/1.6 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#111}
main{text-align:center}h1{font-size:20px}p{color:#`

const successPage = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
` + pageStyle + `555}</style>
<main><h1>Codex account connected</h1><p>You can close this tab and return to the terminal.</p></main>`

func failurePage(reason string) string {
	if strings.TrimSpace(reason) == "" {
		reason = "the authorization server did not return a code"
	}
	return `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
` + pageStyle + `a00}</style>
<main><h1>Sign-in failed</h1><p>` + htmlEscape(reason) + `</p></main>`
}

// htmlEscape escapes the four characters that matter inside an element.
var htmlEscape = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace
