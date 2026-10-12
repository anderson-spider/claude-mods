//go:build contract

// Package contract is a black-box suite for the ccmproxy binary: it builds
// the binary with -tags contract, starts it against httptest fakes of the
// Anthropic API and of the remote translating proxy (inference and management), and checks
// what a client sees and what the fakes received. It imports no package of
// the proxy, so it outlives any rewrite of them.
//
// Run: go test -race -count=1 -tags contract ./contract/...
// Re-record the golden files with: go test -tags contract ./contract/... -update
package contract

import (
	"bufio"
	"bytes"
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

// fake records every request it receives and answers from a scripted
// handler. Several fakes can share one server (the remote's inference and
// management sides), each owning its paths.
type fake struct {
	*httptest.Server
	mu      sync.Mutex
	recs    []rec
	handler handlerFunc
}

func newHandlerFake() *fake {
	f := &fake{}
	f.handler = func(w http.ResponseWriter, _ *http.Request, _ rec) {
		http.Error(w, "unscripted fake", http.StatusInternalServerError)
	}
	return f
}

func (f *fake) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	got := rec{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Host: r.Host, Header: r.Header.Clone(), Body: body}
	f.mu.Lock()
	f.recs = append(f.recs, got)
	handler := f.handler
	f.mu.Unlock()
	handler(w, r, got)
}

func newFake(t *testing.T, tlsServer bool) *fake {
	t.Helper()
	f := newHandlerFake()
	h := http.HandlerFunc(f.serve)
	if tlsServer {
		f.Server = httptest.NewTLSServer(h)
	} else {
		f.Server = httptest.NewServer(h)
	}
	t.Cleanup(f.Server.Close)
	return f
}

// newRemote is a TLS fake of the remote translating proxy: /v8/management/
// goes to mgmt, everything else (inference) to cdx. Both report the same URL.
func newRemote(t *testing.T) (cdx, mgmt *fake) {
	t.Helper()
	cdx, mgmt = newHandlerFake(), newHandlerFake()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v8/management/") {
			mgmt.serve(w, r)
			return
		}
		cdx.serve(w, r)
	}))
	t.Cleanup(srv.Close)
	cdx.Server, mgmt.Server = srv, srv
	return cdx, mgmt
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

// countPath counts the requests to one path.
func (f *fake) countPath(path string) int {
	n := 0
	for _, r := range f.all() {
		if r.Path == path {
			n++
		}
	}
	return n
}

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
	ping       string // CCMPROXY_CONTRACT_PING_INTERVAL
	noRemote   bool   // configure no codex.remote at all
	noAccount  bool   // the remote's credentials list holds no Codex account
	noStart    bool
	extraEnv   []string
	rawConfig  func(cfg map[string]any) // last edit of the config before it is written
	skipConfig bool
	race       bool // run the race-instrumented binary when the suite has one
}

type env struct {
	t        *testing.T
	home     string
	cfgPath  string
	addr     string
	token    string
	salt     string
	mgmtKey  string
	anth     *fake
	cdx      *fake // the remote's inference side
	mgmt     *fake // the remote's management side
	opts     opts
	cmd      *exec.Cmd
	exited   chan struct{}
	waitErr  error
	killed   bool
	stopOnce sync.Once
	stderr   *syncBuf
	client   *http.Client
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

// accountIndex is the auth_index of the fake remote's one Codex account.
const accountIndex = "idx-codex-1"

func newEnv(t *testing.T, o opts) *env {
	t.Helper()
	e := &env{t: t, opts: o, token: "tok-" + randHex(t, 16), salt: "salt-" + randHex(t, 16), mgmtKey: "mgmt-" + randHex(t, 16)}
	e.anth = newFake(t, false)
	e.cdx, e.mgmt = newRemote(t)
	e.mgmt.set(e.management(o.noAccount, usageBody(12, false)))
	e.home = t.TempDir()
	must(t, os.Chmod(e.home, 0o700))
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
		cfg := map[string]any{
			"listen_http":  e.addr,
			"upstream":     e.anth.URL,
			"auth_token":   e.token,
			"session_salt": e.salt,
			"log_level":    "debug",
		}
		if !o.noRemote {
			cfg["codex"] = map[string]any{"remote": e.cdx.URL, "management_key": e.mgmtKey}
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

func (e *env) environ() []string {
	ca := filepath.Join(e.home, "remote-ca.pem")
	block := &pem.Block{Type: "CERTIFICATE", Bytes: e.cdx.Certificate().Raw}
	must(e.t, os.WriteFile(ca, pem.EncodeToMemory(block), 0o600))
	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + e.home,
		"TMPDIR=" + e.home,
		"CCMPROXY_HOME=" + e.home,
		"CCMPROXY_CONTRACT_UPSTREAM=" + e.anth.URL,
		"CCMPROXY_CONTRACT_REMOTE=" + e.cdx.URL,
		"CCMPROXY_CONTRACT_CA_FILE=" + ca,
	}
	if e.opts.ping != "" {
		env = append(env, "CCMPROXY_CONTRACT_PING_INTERVAL="+e.opts.ping)
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

// withAccount starts a proxy whose remote has one active Codex account and
// waits until the proxy has read it (the start-up check is asynchronous).
func withAccount(t *testing.T, o opts) *env {
	t.Helper()
	e := newEnv(t, o)
	e.waitLoggedIn()
	return e
}

// waitLoggedIn waits for status to report the remote's account.
func (e *env) waitLoggedIn() {
	e.t.Helper()
	waitUntil(e.t, "codexLogin true", 5*time.Second, func() bool {
		r := e.do(http.MethodGet, "/__ccmproxy/status", nil, nil)
		var s struct {
			CodexLogin bool `json:"codexLogin"`
		}
		return r.Status == 200 && json.Unmarshal(r.Body, &s) == nil && s.CodexLogin
	})
}

func waitUntil(t *testing.T, what string, within time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// ---- the remote's management side ------------------------------------------

// usageBody is a wham/usage answer: a weekly window at percent used.
func usageBody(percent int, limitReached bool) string {
	return fmt.Sprintf(`{"plan_type":"pro","rate_limit":{"allowed":true,"limit_reached":%t,`+
		`"primary_window":{"used_percent":%d,"limit_window_seconds":604800,"reset_after_seconds":3600,"reset_at":%d},`+
		`"secondary_window":null}}`, limitReached, percent, time.Now().Add(time.Hour).Unix())
}

// management answers the credentials list and the usage api-call when the
// management key is right; usage is the wham/usage body to wrap.
func (e *env) management(noAccount bool, usage string) handlerFunc {
	return func(w http.ResponseWriter, r *http.Request, got rec) {
		if got.Header.Get("Authorization") != "Bearer "+e.mgmtKey {
			http.Error(w, `{"error":"invalid management key"}`, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch got.Path {
		case "/v8/management/credentials":
			if noAccount {
				_, _ = w.Write([]byte(`{"files":[],"observed_at":"2026-10-12T00:00:00Z"}`))
				return
			}
			_, _ = w.Write([]byte(`{"files":[{"auth_index":"` + accountIndex + `","provider":"codex","type":"codex","status":"active","disabled":false,"unavailable":false}],"observed_at":"2026-10-12T00:00:00Z"}`))
		case "/v8/management/requests/api-call":
			_, _ = w.Write([]byte(`{"status_code":200,"header":{},"body":` + jsonStr(usage) + `}`))
		default:
			http.NotFound(w, r)
		}
	}
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

// ---- scripted remote answers -------------------------------------------------

// sseAnswerBody writes one Messages event frame without touching headers;
// the event name is the payload's type.
func sseAnswerBody(w io.Writer, ev string) {
	var head struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal([]byte(ev), &head)
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", head.Type, ev)
}

// sseAnswer writes events as a Messages stream and flushes after each.
func sseAnswer(w http.ResponseWriter, events ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	fl, _ := w.(http.Flusher)
	for _, ev := range events {
		sseAnswerBody(w, ev)
		if fl != nil {
			fl.Flush()
		}
	}
}

func answerWith(events ...string) handlerFunc {
	return func(w http.ResponseWriter, _ *http.Request, _ rec) { sseAnswer(w, events...) }
}

func sseChunk(w http.ResponseWriter, fl http.Flusher, ev string) {
	sseAnswerBody(w, ev)
	fl.Flush()
}

func jsonStr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// The events of a Messages stream as the remote sends them.
const (
	evStart     = `{"type":"message_start","message":{"id":"msg_r1","type":"message","role":"assistant","model":"gpt-6-astra","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":0}}}`
	evTextStart = `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`
	evStop0     = `{"type":"content_block_stop","index":0}`
	evMsgDelta  = `{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}`
	evMsgStop   = `{"type":"message_stop"}`
)

func evText(s string) string {
	return `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":` + jsonStr(s) + `}}`
}

// textAnswer is a whole streamed answer of one text block.
func textAnswer(s string) []string {
	return []string{evStart, evTextStart, evText(s), evStop0, evMsgDelta, evMsgStop}
}

// jsonAnswer is a non-streamed Messages answer.
func jsonAnswer(content string) handlerFunc {
	return func(w http.ResponseWriter, _ *http.Request, _ rec) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"msg_r1","type":"message","role":"assistant","model":"gpt-6-astra","content":` + content +
			`,"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":5}}`))
	}
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
