package httplog

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// Log wraps handler so every request it serves gets one line once the
// handler returns: method, URL, final status, request and response sizes,
// duration. Requests the guard refuses are logged too, since Log sits outside
// it. No header is read.
func Log(handler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		began := time.Now()
		m := &responseMeter{ResponseWriter: w}
		handler.ServeHTTP(m, req)
		logx.Infof("http in  %s %s -> %s req=%s resp=%s in %s",
			req.Method, requestURL(req), strconv.Itoa(m.finalStatus()),
			formatSize(req.ContentLength), formatSize(m.body), formatDuration(time.Since(began)))
	})
}

// requestURL is an inbound request's URL as it appears in a line. The
// request line carries only the path, so the host comes from Host. The query
// is left out. A target that is not a path (`OPTIONS *`) is set apart from
// the host by a space, so it cannot read as part of the host name.
func requestURL(req *http.Request) string {
	path := req.URL.EscapedPath()
	host := req.Host
	if host == "" {
		host = req.URL.Host
	}
	if host == "" {
		return path
	}
	scheme := req.URL.Scheme
	if scheme == "" {
		scheme = "http"
		if req.TLS != nil {
			scheme = "https"
		}
	}
	origin := scheme + "://" + host
	if path == "" || strings.HasPrefix(path, "/") {
		return origin + path
	}
	return origin + " " + path
}

// responseMeter passes a response through untouched while noting its final
// status and how many body bytes were written.
//
// Informational statuses (1xx other than 101) are passed on as they come and
// are not the final status: the reverse proxy forwards an upstream's 103
// Early Hints this way, and the real status follows. A second final status is
// dropped here, as net/http would drop it.
//
// Unwrap lets http.ResponseController reach the Flusher and Hijacker of the
// writer underneath; the streaming paths flush through it.
type responseMeter struct {
	http.ResponseWriter
	status int // final status; 0 until one is sent
	body   int64
}

func (m *responseMeter) WriteHeader(status int) {
	if m.status != 0 {
		return
	}
	if status >= 100 && status < 200 && status != http.StatusSwitchingProtocols {
		m.ResponseWriter.WriteHeader(status)
		return
	}
	m.status = status
	m.ResponseWriter.WriteHeader(status)
}

func (m *responseMeter) Write(p []byte) (int, error) {
	if m.status == 0 {
		m.WriteHeader(http.StatusOK)
	}
	n, err := m.ResponseWriter.Write(p)
	m.body += int64(n)
	return n, err
}

func (m *responseMeter) Unwrap() http.ResponseWriter { return m.ResponseWriter }

// finalStatus is what the client got: a handler that never sent a status
// gets net/http's implicit 200.
func (m *responseMeter) finalStatus() int {
	if m.status == 0 {
		return http.StatusOK
	}
	return m.status
}
