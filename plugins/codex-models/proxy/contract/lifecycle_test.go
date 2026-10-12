//go:build contract

package contract

import (
	"bufio"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A client that goes away cancels the request to the Codex backend.
func TestClientGoneCancelsTheCodexRequest(t *testing.T) {
	e := loggedIn(t, opts{race: true})
	cancelled := make(chan struct{})
	e.cdx.set(func(w http.ResponseWriter, r *http.Request, _ rec) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl := w.(http.Flusher)
		sseChunk(w, fl, evCreated)
		sseChunk(w, fl, evText("first"))
		select {
		case <-r.Context().Done():
			close(cancelled)
		case <-time.After(10 * time.Second):
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.url("/v1/messages"), strings.NewReader(string(claudeReq("gpt-6-astra", true, nil))))
	must(t, err)
	req.Header.Set("X-Ccmproxy-Token", e.token)
	req.Header.Set("Content-Type", "application/json")
	res, err := e.client.Do(req)
	must(t, err)
	sc := bufio.NewScanner(res.Body)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "event: content_block_delta") {
			break
		}
	}
	cancel() // the client hangs up mid-stream
	_ = res.Body.Close()

	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("the Codex request kept running after the client went away")
	}
}

// The /v1/models client does not follow a redirect either.
func TestModelsRequestDoesNotFollowRedirects(t *testing.T) {
	for _, withLogin := range []bool{false, true} {
		name := map[bool]string{false: "without a login", true: "with a login"}[withLogin]
		t.Run(name, func(t *testing.T) {
			e := newEnv(t, opts{noStart: true})
			if withLogin {
				e.writeLogin(login{})
			}
			target := newFake(t, false)
			e.anth.set(func(w http.ResponseWriter, _ *http.Request, _ rec) {
				w.Header().Set("Location", target.URL+"/models")
				w.WriteHeader(http.StatusFound)
			})
			e.start()
			r := e.do(http.MethodGet, "/v1/models", nil, map[string]string{"Authorization": "Bearer oauth"})
			if withLogin && r.Status != 200 {
				t.Fatalf("status = %d", r.Status)
			}
			if !withLogin && r.Status != http.StatusFound {
				t.Fatalf("status = %d, want the 302 as it came", r.Status)
			}
			if target.count() != 0 {
				t.Fatalf("the redirect was followed, carrying %v", target.last(t).Header)
			}
			if e.anth.count() != 1 {
				t.Fatalf("upstream requests = %d", e.anth.count())
			}
		})
	}
}

// auth_file may not lead to the Codex CLI's file, by a link or a `..` path.
func TestAuthFileLeadingToTheCodexCLIFileIsRefused(t *testing.T) {
	for name, build := range map[string]func(e *env, cli string) string{
		"symlink": func(e *env, cli string) string {
			link := filepath.Join(e.home, "link.json")
			must(t, os.Symlink(cli, link))
			return link
		},
		"dot dot": func(e *env, cli string) string {
			return filepath.Join(e.codexHome, "..", filepath.Base(e.codexHome), "auth.json")
		},
		"symlink to a symlink": func(e *env, cli string) string {
			first := filepath.Join(e.home, "first.json")
			must(t, os.Symlink(cli, first))
			second := filepath.Join(e.home, "second.json")
			must(t, os.Symlink(first, second))
			return second
		},
	} {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t, opts{noStart: true})
			cli, data, mtime := writeCLILogin(t, e, accessToken("x", time.Now().Add(time.Hour)))
			cfg := readLogin(t, e.cfgPath)
			cfg["codex"].(map[string]any)["auth_file"] = build(e, cli)
			writeJSON(t, e.cfgPath, cfg, 0o600)
			out, code := runCLI(t, e.home, e.environ(), "serve")
			if code == 0 || !strings.Contains(out.stderr, "never writes") {
				t.Fatalf("exit %d, stderr %s", code, out.stderr)
			}
			unchanged(t, cli, data, mtime)
		})
	}
}

// The LaunchAgent restarts the proxy unless it exited cleanly.
func TestServeExitsCleanlyOnSIGTERM(t *testing.T) {
	e := loggedIn(t, opts{})
	if err := e.stop(); err != nil {
		t.Fatalf("serve ended with %v after SIGTERM:\n%s", err, e.stderr.String())
	}
	if _, err := e.client.Head(e.url("/api/hello")); err == nil {
		t.Fatal("the listener is still open")
	}
}
