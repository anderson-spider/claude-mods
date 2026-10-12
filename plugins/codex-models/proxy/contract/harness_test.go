//go:build contract

// Package contract is a black-box suite for the ccmproxy binary: it builds
// the binary with -tags contract, starts it against httptest fakes of the
// Anthropic API, the Codex backend and the OAuth token endpoint, and checks
// what a client sees and what the fakes received. It imports no package of
// the proxy, so it outlives any rewrite of them.
//
// Run: go test -race -count=1 -tags contract ./contract/...
// Re-record the golden files with: go test -tags contract ./contract/... -update
package contract

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite the golden files in testdata/")

var binPath, raceBinPath string

func TestMain(m *testing.M) {
	flag.Parse()
	dir, err := os.MkdirTemp("", "ccmproxy-contract-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	binPath = filepath.Join(dir, "ccmproxy")
	build := func(out string, extra ...string) {
		args := append([]string{"build"}, extra...)
		args = append(args, "-tags", "contract", "-ldflags", "-X main.version=contract", "-o", out, "../cmd/ccmproxy")
		if b, err := exec.Command("go", args...).CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "building ccmproxy: %v\n%s", err, b)
			os.Exit(2)
		}
	}
	build(binPath)
	if raceBuild {
		// A second, race-instrumented binary for the tests that exercise
		// concurrency (opts.race). It costs about a second to start, so the
		// other tests keep the plain one. A DATA RACE in either one's stderr
		// fails the test that ran it.
		raceBinPath = filepath.Join(dir, "ccmproxy-race")
		build(raceBinPath, "-race")
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

// ---- fakes -----------------------------------------------------------------

// rec is one request a fake received, exactly as it arrived.
type rec struct {
	Method string
	Path   string
	Query  string
	Host   string
	Header http.Header
	Body   []byte
}

type handlerFunc func(w http.ResponseWriter, r *http.Request, got rec)

// fake is an httptest server that records every request and answers from a
// scripted handler.
type fake struct {
	*httptest.Server
	mu      sync.Mutex
	recs    []rec
	handler handlerFunc
}

func newFake(t *testing.T, tlsServer bool) *fake {
	t.Helper()
	f := &fake{}
	f.handler = func(w http.ResponseWriter, _ *http.Request, _ rec) {
		http.Error(w, "unscripted fake", http.StatusInternalServerError)
	}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got := rec{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Host: r.Host, Header: r.Header.Clone(), Body: body}
		f.mu.Lock()
		f.recs = append(f.recs, got)
		handler := f.handler
		f.mu.Unlock()
		handler(w, r, got)
	})
	if tlsServer {
		f.Server = httptest.NewTLSServer(h)
	} else {
		f.Server = httptest.NewServer(h)
	}
	t.Cleanup(f.Server.Close)
	return f
}

func (f *fake) set(h handlerFunc) {
	f.mu.Lock()
	f.handler = h
	f.mu.Unlock()
}

func (f *fake) all() []rec {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]rec(nil), f.recs...)
}

func (f *fake) count() int { return len(f.all()) }

func (f *fake) last(t *testing.T) rec {
	t.Helper()
	all := f.all()
	if len(all) == 0 {
		t.Fatal("the fake received no request")
	}
	return all[len(all)-1]
}

// ---- environment -----------------------------------------------------------

type opts struct {
	ping       string         // CCMPROXY_CONTRACT_PING_INTERVAL
	codexCfg   map[string]any // merged into the config's codex block
	tlsOAuth   bool           // serve the OAuth fake over TLS, trusted through CCMPROXY_CONTRACT_CA_FILE
	noStart    bool
	extraEnv   []string
	rawConfig  func(cfg map[string]any) // last edit of the config before it is written
	skipConfig bool
	race       bool   // run the race-instrumented binary when the suite has one
	authDir    string // share this auth_dir (another env's) instead of the home's own
	oauthFake  *fake  // share this token endpoint instead of a new one
}

type env struct {
	t         *testing.T
	home      string
	codexHome string
	authDir   string
	cfgPath   string
	addr      string
	token     string
	salt      string
	anth      *fake
	cdx       *fake
	oauth     *fake
	opts      opts
	cmd       *exec.Cmd
	exited    chan struct{}
	waitErr   error
	killed    bool
	stopOnce  sync.Once
	stderr    *syncBuf
	client    *http.Client
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	return addr
}

func newEnv(t *testing.T, o opts) *env {
	t.Helper()
	e := &env{t: t, opts: o, token: "tok-" + randHex(t, 16), salt: "salt-" + randHex(t, 16)}
	e.anth = newFake(t, false)
	e.cdx = newFake(t, false)
	if o.oauthFake != nil {
		e.oauth = o.oauthFake
	} else {
		e.oauth = newFake(t, o.tlsOAuth)
	}
	e.home = t.TempDir()
	must(t, os.Chmod(e.home, 0o700))
	e.codexHome = filepath.Join(e.home, "codex-cli")
	e.authDir = filepath.Join(e.home, "auth")
	if o.authDir != "" {
		e.authDir = o.authDir
	}
	e.cfgPath = filepath.Join(e.home, "config.json")
	e.addr = freeAddr(t)
	e.stderr = &syncBuf{}
	e.client = &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			Proxy:              nil,
			DisableCompression: true,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	t.Cleanup(e.client.CloseIdleConnections)

	if !o.skipConfig {
		cdxCfg := map[string]any{"base_url": e.cdxBase()}
		for k, v := range o.codexCfg {
			cdxCfg[k] = v
		}
		cfg := map[string]any{
			"listen_http":  e.addr,
			"upstream":     e.anth.URL,
			"auth_token":   e.token,
			"session_salt": e.salt,
			"auth_dir":     e.authDir,
			"log_level":    "debug",
			"codex":        cdxCfg,
		}
		if o.rawConfig != nil {
			o.rawConfig(cfg)
		}
		writeJSON(t, e.cfgPath, cfg, 0o600)
	}
	if !o.noStart {
		e.start()
	}
	return e
}

func (e *env) cdxBase() string { return e.cdx.URL + "/backend-api/codex" }

func (e *env) environ() []string {
	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + e.home,
		"TMPDIR=" + e.home,
		"CCMPROXY_HOME=" + e.home,
		"CODEX_HOME=" + e.codexHome,
		"CCMPROXY_CONTRACT_UPSTREAM=" + e.anth.URL,
		"CCMPROXY_CONTRACT_CODEX_BASE_URL=" + e.cdxBase(),
		"CCMPROXY_CONTRACT_OAUTH_TOKEN_URL=" + e.oauth.URL + "/token",
		"CCMPROXY_CONTRACT_OAUTH_AUTH_URL=" + e.oauth.URL + "/authorize",
	}
	if e.opts.ping != "" {
		env = append(env, "CCMPROXY_CONTRACT_PING_INTERVAL="+e.opts.ping)
	}
	if e.opts.tlsOAuth {
		ca := filepath.Join(e.home, "oauth-ca.pem")
		block := &pem.Block{Type: "CERTIFICATE", Bytes: e.oauth.Certificate().Raw}
		must(e.t, os.WriteFile(ca, pem.EncodeToMemory(block), 0o600))
		env = append(env, "CCMPROXY_CONTRACT_CA_FILE="+ca)
	}
	return append(env, e.opts.extraEnv...)
}

func (e *env) start() {
	t := e.t
	t.Helper()
	bin := binPath
	if e.opts.race && raceBinPath != "" {
		bin = raceBinPath
	}
	e.cmd = exec.Command(bin, "serve")
	e.cmd.Env = e.environ()
	e.cmd.Stderr = e.stderr
	e.cmd.Stdout = e.stderr
	must(t, e.cmd.Start())
	e.exited = make(chan struct{})
	go func() { e.waitErr = e.cmd.Wait(); close(e.exited) }()
	t.Cleanup(func() {
		e.stop()
		if t.Failed() {
			t.Logf("ccmproxy log:\n%s", e.stderr.String())
		}
	})
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-e.exited:
			t.Fatalf("ccmproxy exited at start:\n%s", e.stderr.String())
		default:
		}
		req, _ := http.NewRequest(http.MethodHead, e.url("/api/hello"), nil)
		if resp, err := e.client.Do(req); err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("ccmproxy did not answer HEAD /api/hello:\n%s", e.stderr.String())
}

// stop sends SIGTERM, waits up to 5 s (then kills) and reports how the
// process ended: nil is a clean exit 0. It is safe to call twice, and it
// fails the test when the race-built binary reported a data race.
func (e *env) stop() error {
	if e.cmd == nil {
		return nil
	}
	e.stopOnce.Do(func() {
		_ = e.cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-e.exited:
		case <-time.After(5 * time.Second):
			e.killed = true
			_ = e.cmd.Process.Kill()
			<-e.exited
		}
		if strings.Contains(e.stderr.String(), "DATA RACE") {
			e.t.Errorf("ccmproxy reported a data race:\n%s", e.stderr.String())
		}
	})
	if e.killed {
		return fmt.Errorf("did not exit within 5 s of SIGTERM")
	}
	return e.waitErr
}

// waitLog waits for the asynchronous subprocess pipe copy, not just the HTTP
// response. Later log lines may still be pending; stop drains them all.
func (e *env) waitLog(substring string) {
	e.t.Helper()
	waitUntil(e.t, fmt.Sprintf("ccmproxy log containing %q", substring), 5*time.Second, func() bool {
		return strings.Contains(e.stderr.String(), substring)
	})
}

func (e *env) url(path string) string { return "http://" + e.addr + path }

// ---- requests --------------------------------------------------------------

type resp struct {
	Status int
	Header http.Header
	Body   []byte
}

func (r resp) json(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.Body, &m); err != nil {
		t.Fatalf("body is not a JSON object: %v\n%s", err, r.Body)
	}
	return m
}

// errType returns error.type and error.message of an Anthropic error body.
func (r resp) errInfo(t *testing.T) (kind, message string) {
	t.Helper()
	m := r.json(t)
	if m["type"] != "error" {
		t.Fatalf("not an error body: %s", r.Body)
	}
	inner, _ := m["error"].(map[string]any)
	kind, _ = inner["type"].(string)
	message, _ = inner["message"].(string)
	return
}

// do sends a request with the secret (unless header "-" removes it).
func (e *env) do(method, path string, body []byte, headers map[string]string) resp {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, e.url(path), rd)
	must(e.t, err)
	req.Header.Set("X-Ccmproxy-Token", e.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		switch {
		case k == "Host":
			req.Host = v
		case v == "-":
			req.Header.Del(k)
		default:
			req.Header.Set(k, v)
		}
	}
	res, err := e.client.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		e.t.Fatalf("%s %s: reading the body: %v", method, path, err)
	}
	return resp{Status: res.StatusCode, Header: res.Header, Body: data}
}

func (e *env) post(path string, body []byte) resp {
	e.t.Helper()
	return e.do(http.MethodPost, path, body, nil)
}

// rawRequest writes a request line by hand (for CONNECT) and reads one reply.
func (e *env) rawRequest(method, target string, withSecret bool) resp {
	e.t.Helper()
	conn, err := net.DialTimeout("tcp", e.addr, 5*time.Second)
	must(e.t, err)
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s HTTP/1.1\r\nHost: %s\r\n", method, target, e.addr)
	if withSecret {
		fmt.Fprintf(&b, "X-Ccmproxy-Token: %s\r\n", e.token)
	}
	b.WriteString("Connection: close\r\n\r\n")
	_, err = conn.Write([]byte(b.String()))
	must(e.t, err)
	res, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: method})
	must(e.t, err)
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return resp{Status: res.StatusCode, Header: res.Header, Body: data}
}

// ---- credentials -----------------------------------------------------------

func jwt(claims map[string]any) string {
	enc := func(v any) string {
		b, _ := json.Marshal(v)
		return base64.RawURLEncoding.EncodeToString(b)
	}
	return enc(map[string]any{"alg": "none", "typ": "JWT"}) + "." + enc(claims) + ".c2ln"
}

// accessToken is a JWT shaped like the ones the Codex login issues: the proxy
// reads exp and the account claims from it.
func accessToken(tag string, exp time.Time) string {
	return jwt(map[string]any{
		"exp": exp.Unix(),
		"sub": tag,
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "acct-1",
			"chatgpt_plan_type":  "plus",
		},
	})
}

func idToken(tag string) string {
	return jwt(map[string]any{
		"email": "user@example.test",
		"sub":   tag,
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "acct-1",
			"chatgpt_plan_type":  "plus",
		},
	})
}

type login struct {
	access  string
	refresh string
	expires time.Time
	mode    os.FileMode
}

// writeLogin writes the proxy's own credential file (auth_dir/codex.json).
func (e *env) writeLogin(l login) string {
	e.t.Helper()
	if l.expires.IsZero() {
		l.expires = time.Now().Add(time.Hour)
	}
	if l.access == "" {
		l.access = accessToken("access-1", l.expires)
	}
	if l.refresh == "" {
		l.refresh = "refresh-1"
	}
	if l.mode == 0 {
		l.mode = 0o600
	}
	must(e.t, os.MkdirAll(e.authDir, 0o700))
	path := filepath.Join(e.authDir, "codex.json")
	writeJSON(e.t, path, map[string]any{
		"id_token":      idToken("id-1"),
		"access_token":  l.access,
		"refresh_token": l.refresh,
		"account_id":    "acct-1",
		"email":         "user@example.test",
		"plan_type":     "plus",
		"expires_at":    l.expires.UTC().Format(time.RFC3339),
		"last_refresh":  time.Now().UTC().Format(time.RFC3339),
		"type":          "codex",
	}, l.mode)
	return path
}

// loggedIn is the common case: a valid login.
func loggedIn(t *testing.T, o opts) *env {
	t.Helper()
	o.noStart = true
	e := newEnv(t, o)
	e.writeLogin(login{})
	e.start()
	return e
}

// ---- files and golden data -------------------------------------------------

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func randHex(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	f, err := os.Open("/dev/urandom")
	must(t, err)
	defer f.Close()
	_, err = io.ReadFull(f, b)
	must(t, err)
	return fmt.Sprintf("%x", b)
}

func writeJSON(t *testing.T, path string, v any, mode os.FileMode) {
	t.Helper()
	data, err := json.MarshalIndent(v, "", "  ")
	must(t, err)
	must(t, os.WriteFile(path, append(data, '\n'), mode))
	must(t, os.Chmod(path, mode))
}

// canonical renders JSON with sorted keys and fixed indentation.
func canonical(t *testing.T, raw []byte) []byte {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, raw)
	}
	out, err := json.MarshalIndent(mask(v), "", "  ")
	must(t, err)
	return append(out, '\n')
}

var (
	uuidRE  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	uuid4RE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	tsRE    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}`)
)

// mask replaces values that change from run to run: UUIDs and timestamps.
func mask(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			x[k] = mask(val)
		}
	case []any:
		for i, val := range x {
			x[i] = mask(val)
		}
	case string:
		switch {
		case uuidRE.MatchString(x):
			return "<uuid>"
		case tsRE.MatchString(x):
			return "<time>"
		}
	}
	return v
}

// golden compares got with testdata/name, or records it under -update.
func golden(t *testing.T, name string, got []byte) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if *update {
		must(t, os.MkdirAll("testdata", 0o755))
		must(t, os.WriteFile(path, got, 0o644))
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden %s (record with -update): %v", name, err)
	}
	if !bytes.Equal(want, got) {
		t.Fatalf("%s differs from the golden file\n--- want\n%s\n--- got\n%s", name, want, got)
	}
}

// ---- SSE -------------------------------------------------------------------

type sseEvent struct {
	Name string
	Data map[string]any
}

func parseSSE(t *testing.T, body []byte) []sseEvent {
	t.Helper()
	var out []sseEvent
	for _, frame := range strings.Split(strings.ReplaceAll(string(body), "\r\n", "\n"), "\n\n") {
		if strings.TrimSpace(frame) == "" {
			continue
		}
		var ev sseEvent
		var data []string
		for _, line := range strings.Split(frame, "\n") {
			switch {
			case strings.HasPrefix(line, "event:"):
				ev.Name = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			case strings.HasPrefix(line, "data:"):
				data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			}
		}
		if err := json.Unmarshal([]byte(strings.Join(data, "\n")), &ev.Data); err != nil {
			t.Fatalf("SSE data is not a JSON object: %v\n%s", err, frame)
		}
		out = append(out, ev)
	}
	return out
}

// renderEvents prints events in order with volatile values masked.
func renderEvents(t *testing.T, evs []sseEvent) []byte {
	t.Helper()
	var b bytes.Buffer
	for _, ev := range evs {
		data, err := json.Marshal(mask(ev.Data))
		must(t, err)
		fmt.Fprintf(&b, "event: %s\ndata: %s\n\n", ev.Name, data)
	}
	return b.Bytes()
}

func names(evs []sseEvent) []string {
	out := make([]string, len(evs))
	for i, ev := range evs {
		out[i] = ev.Name
	}
	return out
}

func indexOf(evs []sseEvent, name string) int {
	for i, ev := range evs {
		if ev.Name == name {
			return i
		}
	}
	return -1
}

// wellFormed checks the Messages stream grammar: message_start first, blocks
// numbered from 0 and never overlapping, deltas only inside their block, and
// message_delta then message_stop last (or one error event at the end).
func wellFormed(t *testing.T, evs []sseEvent) {
	t.Helper()
	if len(evs) == 0 {
		t.Fatal("empty stream")
	}
	if evs[0].Name != "message_start" {
		t.Fatalf("first event = %s", evs[0].Name)
	}
	open, next := -1, 0
	for i, ev := range evs {
		idx := -1
		if f, ok := ev.Data["index"].(float64); ok {
			idx = int(f)
		}
		switch ev.Name {
		case "content_block_start":
			if open != -1 {
				t.Fatalf("event %d: block %d starts while %d is open", i, idx, open)
			}
			if idx != next {
				t.Fatalf("event %d: block index %d, want %d", i, idx, next)
			}
			open = idx
		case "content_block_delta":
			if idx != open {
				t.Fatalf("event %d: delta for block %d while %d is open", i, idx, open)
			}
		case "content_block_stop":
			if idx != open {
				t.Fatalf("event %d: stop for block %d while %d is open", i, idx, open)
			}
			open = -1
			next++
		case "message_delta", "message_stop":
			if open != -1 {
				t.Fatalf("event %d: %s with block %d open", i, ev.Name, open)
			}
		case "error":
			if i != len(evs)-1 {
				t.Fatalf("event %d: events after an error", i)
			}
			return
		}
	}
	n := len(evs)
	if n < 2 || evs[n-2].Name != "message_delta" || evs[n-1].Name != "message_stop" {
		t.Fatalf("stream does not end with message_delta, message_stop: %v", names(evs))
	}
}

func stopReason(t *testing.T, evs []sseEvent) string {
	t.Helper()
	i := indexOf(evs, "message_delta")
	if i < 0 {
		t.Fatalf("no message_delta in %v", names(evs))
	}
	d, _ := evs[i].Data["delta"].(map[string]any)
	s, _ := d["stop_reason"].(string)
	return s
}

// blocksOf returns the content_block of each content_block_start.
func blocksOf(evs []sseEvent) []map[string]any {
	var out []map[string]any
	for _, ev := range evs {
		if ev.Name == "content_block_start" {
			b, _ := ev.Data["content_block"].(map[string]any)
			out = append(out, b)
		}
	}
	return out
}

// ---- scripted Codex answers ------------------------------------------------

// sseAnswerBody writes one event frame without touching headers.
func sseAnswerBody(w io.Writer, ev string) {
	var head struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal([]byte(ev), &head)
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", head.Type, ev)
}

// sseAnswer writes events as a Codex Responses stream and flushes after each.
func sseAnswer(w http.ResponseWriter, events ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	fl, _ := w.(http.Flusher)
	for _, ev := range events {
		var head struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal([]byte(ev), &head)
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", head.Type, ev)
		if fl != nil {
			fl.Flush()
		}
	}
}

func answerWith(events ...string) handlerFunc {
	return func(w http.ResponseWriter, _ *http.Request, _ rec) { sseAnswer(w, events...) }
}

func jsonStr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

const (
	evCreated   = `{"type":"response.created","response":{"id":"resp_1","model":"gpt-6-astra-2026-01-01"}}`
	evCompleted = `{"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":12,"output_tokens":5,"input_tokens_details":{"cached_tokens":2}}}}`
)

func evText(s string) string {
	return `{"type":"response.output_text.delta","delta":` + jsonStr(s) + `}`
}

// claudeReq builds a Messages request; extra keys replace the defaults.
func claudeReq(model string, stream bool, extra map[string]any) []byte {
	m := map[string]any{
		"model":      model,
		"max_tokens": 1024,
		"stream":     stream,
		"messages":   []any{map[string]any{"role": "user", "content": "hello"}},
	}
	for k, v := range extra {
		m[k] = v
	}
	b, _ := json.Marshal(m)
	return b
}
