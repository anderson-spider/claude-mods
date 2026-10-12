// Package httplog writes one access line per HTTP exchange, in both
// directions: Log wraps the proxy's handler (what Claude Code sends in) and
// Transport wraps a client's round tripper (what the proxy sends out to
// Anthropic or the Codex remote).
//
// A line holds the method, scheme, host and path, the status, the request and
// response sizes and the duration. It never holds a query string, userinfo,
// a header or a body, since any of those can carry a secret or a prompt.
package httplog

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/netx"
)

// Transport logs each request sent through Next.
//
// The line for a response is written when its body is closed rather than
// when RoundTrip returns. Codex streams its answers with no Content-Length,
// so only the reader knows how many bytes came and how long the stream
// stayed open. A body nobody closes is never logged; every caller in the
// proxy closes its bodies.
type Transport struct {
	// Next sends the request. Nil means netx.Shared(), never
	// http.DefaultTransport, which would honour HTTPS_PROXY.
	Next http.RoundTripper
	// Label names the client in each line ("codex", "management", ...); empty
	// leaves it out.
	Label string
}

// RoundTrip sends req through the next transport and arranges for the
// response to be logged once its body is closed. An error is returned as it
// came; only the logged copy of its text is scrubbed.
func (t *Transport) RoundTrip(req *http.Request) (*http.Response, error) {
	began := time.Now()
	prefix := "http " + t.labelPrefix() + "out " + req.Method + " " + outboundURL(req) + " -> "
	sent := req.ContentLength

	resp, err := t.next().RoundTrip(req)
	if err != nil {
		logx.Warnf("%serror after %s: %s", prefix, formatDuration(time.Since(began)), scrubError(err, req.URL))
		return nil, err
	}

	status := resp.StatusCode
	resp.Body = &countingBody{
		ReadCloser: resp.Body,
		onClose: func(received int64, bodyErr error) {
			line := prefix + strconv.Itoa(status) + " req=" + formatSize(sent) + " resp=" + formatSize(received) +
				" in " + formatDuration(time.Since(began))
			if bodyErr != nil {
				line += " (body: " + scrubError(bodyErr, req.URL) + ")"
			}
			logx.Infof("%s", line)
		},
	}
	return resp, nil
}

// next is the transport requests go through.
func (t *Transport) next() http.RoundTripper {
	if t.Next != nil {
		return t.Next
	}
	return netx.Shared()
}

func (t *Transport) labelPrefix() string {
	if t.Label == "" {
		return ""
	}
	return t.Label + " "
}

// outboundURL is the request's URL as it appears in a line: scheme, host
// and path, without userinfo, query or fragment. The request is not changed.
func outboundURL(req *http.Request) string {
	shown := url.URL{
		Scheme:  req.URL.Scheme,
		Opaque:  req.URL.Opaque,
		Host:    req.URL.Host,
		Path:    req.URL.Path,
		RawPath: req.URL.RawPath,
	}
	return shown.String()
}

// scrubError renders err for a line with u's query and userinfo cut out.
// The transport's own errors do not quote the URL today, but a wrapped
// *url.Error or a future transport could, and the line must stay clean
// whatever the error says.
func scrubError(err error, u *url.URL) string {
	text := err.Error()
	if u.RawQuery != "" {
		text = strings.ReplaceAll(text, "?"+u.RawQuery, "")
	}
	if u.User != nil {
		text = strings.ReplaceAll(text, u.User.String()+"@", "")
		// url.Error prints the URL with its password masked this way.
		masked := url.UserPassword(u.User.Username(), "xxxxx").String()
		text = strings.ReplaceAll(text, masked+"@", "")
	}
	return text
}

// countingBody counts what is read through it. On the first Close it calls
// onClose with that count and the first error worth reporting: a read error
// other than io.EOF, else the error from closing (io.EOF again excluded).
// Later Closes only close.
type countingBody struct {
	io.ReadCloser
	onClose func(n int64, err error)

	n        atomic.Int64
	mu       sync.Mutex
	readErr  error
	reported sync.Once
}

func (b *countingBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.n.Add(int64(n))
	if err != nil && !errors.Is(err, io.EOF) {
		b.mu.Lock()
		if b.readErr == nil {
			b.readErr = err
		}
		b.mu.Unlock()
	}
	return n, err
}

func (b *countingBody) Close() error {
	closeErr := b.ReadCloser.Close()
	b.reported.Do(func() {
		b.mu.Lock()
		err := b.readErr
		b.mu.Unlock()
		if err == nil && !errors.Is(closeErr, io.EOF) {
			err = closeErr
		}
		b.onClose(b.n.Load(), err)
	})
	return closeErr
}
