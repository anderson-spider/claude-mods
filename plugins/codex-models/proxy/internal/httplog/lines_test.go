package httplog

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// logged runs fn with the log captured at info level and returns it.
func logged(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	restore := logx.SetOutput(&buf)
	logx.SetLevel("info")
	defer func() {
		restore()
		logx.SetLevel("debug")
	}()
	fn()
	return buf.String()
}

func TestOutboundLineShape(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("hello, world"))
	}))
	defer upstream.Close()

	log := logged(t, func() {
		transport := &Transport{Next: http.DefaultTransport, Label: "codex"}
		req := mustRequest(t, http.MethodPost, upstream.URL+"/v1/x?key=QUERY_SECRET", strings.NewReader("12345"))
		resp, err := transport.RoundTrip(req)
		if err != nil {
			t.Fatalf("RoundTrip: %v", err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	})
	want := regexp.MustCompile(`INF http codex out POST http://127\.0\.0\.1:\d+/v1/x -> 202 req=5b resp=12b in \S+\n$`)
	if !want.MatchString(log) || strings.Contains(log, "QUERY_SECRET") {
		t.Fatalf("log = %q", log)
	}
}

func TestOutboundErrorLineCarriesNoQueryOrUserinfo(t *testing.T) {
	// A transport whose error quotes the URL, as *url.Error does.
	failing := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return nil, &url.Error{Op: "Get", URL: req.URL.String(), Err: errors.New("connection refused")}
	})
	req := mustRequest(t, http.MethodGet, "https://user:PASS_SECRET@api.example.test/v1/m?q=QUERY_SECRET", nil)
	var returned error
	log := logged(t, func() {
		_, returned = (&Transport{Next: failing}).RoundTrip(req)
	})
	if returned == nil || !strings.Contains(returned.Error(), "QUERY_SECRET") {
		t.Fatalf("the caller's error was changed: %v", returned)
	}
	for _, s := range []string{"QUERY_SECRET", "PASS_SECRET", "user:", "xxxxx"} {
		if strings.Contains(log, s) {
			t.Fatalf("log carries %q: %q", s, log)
		}
	}
	if !strings.Contains(log, "WRN http out GET https://api.example.test/v1/m -> error after ") || !strings.Contains(log, "connection refused") {
		t.Fatalf("log = %q", log)
	}

	// The masked form url.Error prints for a client request.
	masked := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New(`Get "` + req.URL.Redacted() + `": refused`)
	})
	log = logged(t, func() { _, _ = (&Transport{Next: masked}).RoundTrip(req) })
	if strings.Contains(log, "QUERY_SECRET") || strings.Contains(log, "user:") {
		t.Fatalf("log = %q", log)
	}
}

func TestOutboundBodyErrorIsLogged(t *testing.T) {
	broken := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(io.MultiReader(strings.NewReader("abc"), iotestErr{}))}, nil
	})
	log := logged(t, func() {
		resp, err := (&Transport{Next: broken}).RoundTrip(mustRequest(t, http.MethodGet, "http://h.test/p", nil))
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.ReadAll(resp.Body)
		_ = resp.Body.Close()
	})
	if !strings.Contains(log, "-> 200 req=0b resp=3b in ") || !strings.Contains(log, "(body: stream broke)") {
		t.Fatalf("log = %q", log)
	}
}

type iotestErr struct{}

func (iotestErr) Read([]byte) (int, error) { return 0, errors.New("stream broke") }

func TestCountingBodyIgnoresEOFFromClose(t *testing.T) {
	var reported error = errors.New("not called")
	body := &countingBody{ReadCloser: eofCloser{strings.NewReader("ab")}, onClose: func(_ int64, err error) { reported = err }}
	_, _ = io.ReadAll(body)
	_ = body.Close()
	if reported != nil {
		t.Fatalf("reported %v, want nil for an EOF from Close", reported)
	}
}

type eofCloser struct{ io.Reader }

func (eofCloser) Close() error { return io.EOF }

func TestInboundLineShape(t *testing.T) {
	handler := Log(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("0123456789"))
	}))
	req := httptest.NewRequest(http.MethodPost, "/v1/messages?beta=QUERY_SECRET", strings.NewReader("request body"))
	req.Host = "127.0.0.1:8081"
	log := logged(t, func() { handler.ServeHTTP(httptest.NewRecorder(), req) })
	want := regexp.MustCompile(`INF http in  POST http://127\.0\.0\.1:8081/v1/messages -> 201 req=12b resp=10b in \S+\n$`)
	if !want.MatchString(log) || strings.Contains(log, "QUERY_SECRET") {
		t.Fatalf("log = %q", log)
	}
}

// An informational status passes through and is not the one logged: the
// reverse proxy forwards an upstream's 103 this way before the real status.
func TestInformationalStatusIsNotTheFinalOne(t *testing.T) {
	handler := Log(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Link", "</a>; rel=preload")
		w.WriteHeader(http.StatusEarlyHints)
		w.WriteHeader(http.StatusBadRequest)
		w.WriteHeader(http.StatusTeapot) // a second final status is dropped
		_, _ = w.Write([]byte("no"))
	}))
	// A real server: httptest.ResponseRecorder keeps a 1xx as its Code.
	srv := httptest.NewServer(handler)
	defer srv.Close()
	var status int
	log := logged(t, func() {
		resp, err := http.Get(srv.URL)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		status = resp.StatusCode
		srv.Close() // the access line is written once the handler returns
	})
	if status != http.StatusBadRequest {
		t.Fatalf("client got %d, want 400", status)
	}
	if !strings.Contains(log, "-> 400 req=0b resp=2b") {
		t.Fatalf("log = %q", log)
	}
}

func TestFormatSizeEdges(t *testing.T) {
	cases := map[int64]string{
		1024*1024 - 1:         "1Mb", // rounds up into the next unit, not "1024Kb"
		1024 * 1024 * 3 / 2:   "1.5Mb",
		1 << 40:               "1Tb",
		1 << 50:               "1024Tb", // Tb is the largest unit
		9223372036854775807:   "8388608Tb",
		1024*1024*1024*10 + 1: "10Gb",
	}
	for n, want := range cases {
		if got := formatSize(n); got != want {
			t.Errorf("formatSize(%d) = %q, want %q", n, got, want)
		}
	}
}
