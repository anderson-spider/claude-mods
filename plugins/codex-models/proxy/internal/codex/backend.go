package codex

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/netx"
)

// Backend relays Anthropic Messages to a remote which owns Codex credentials.
// ManagementKey is used only by management requests, never by Messages.
type Backend struct {
	Remote        string
	ManagementKey string
	HTTP          *http.Client
	Limits        *Limits
	UsageTimeout  time.Duration

	mu          sync.Mutex
	authIndex   string
	generation  uint64
	authFlight  chan struct{}
	authAttempt time.Time
	flight      chan struct{}
	lastAttempt time.Time
}

// NewBackend uses a separate short-dial direct transport for the remote. There
// is no whole-call timeout: an inference response may stream for minutes.
func NewBackend(remote, managementKey string, transport http.RoundTripper) *Backend {
	if transport == nil {
		transport = netx.RemoteTransport(remote)
	}
	return &Backend{Remote: strings.TrimRight(remote, "/"), ManagementKey: managementKey,
		HTTP: &http.Client{Transport: transport, CheckRedirect: noRedirects}, Limits: NewLimits()}
}

func noRedirects(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }

func withoutRedirects(client *http.Client, remote string) *http.Client {
	if client == nil {
		client = &http.Client{}
	}
	copy := *client
	if copy.Transport == nil {
		copy.Transport = netx.RemoteTransport(remote)
	}
	copy.CheckRedirect = noRedirects
	return &copy
}

// APIError retains the body for the router's bounded client message, never logs.
type APIError struct {
	StatusCode int
	Body       []byte
}

func (e *APIError) Error() string { return fmt.Sprintf("codex: remote returned %d", e.StatusCode) }

var ErrUnreachable = errors.New("ccmproxy: Codex remote unreachable")

// Messages builds a fresh request with an explicit credential-free allowlist.
func (b *Backend) Messages(ctx context.Context, body []byte, headers http.Header) (*http.Response, error) {
	if b.Remote == "" {
		return nil, ErrUnreachable
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.Remote+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return nil, ErrUnreachable
	}
	for _, name := range []string{"Content-Type", "Accept", "Anthropic-Version", "Anthropic-Beta"} {
		if values := headers.Values(name); len(values) > 0 {
			req.Header[name] = append([]string(nil), values...)
		}
	}
	// net/http otherwise adds its own User-Agent; even that is outside the allowlist.
	req.Header["User-Agent"] = []string{""}
	resp, err := withoutRedirects(b.HTTP, b.Remote).Do(req)
	if err != nil {
		// A client that went away says nothing about the remote: keep the readings.
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		b.ClearLimits()
		return nil, ErrUnreachable
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		data, _ := io.ReadAll(io.LimitReader(resp.Body, maxManagementBody))
		return nil, &APIError{StatusCode: resp.StatusCode, Body: data}
	}
	return resp, nil
}

func (b *Backend) ClearLimits() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.Limits.Clear()
	b.generation++
}

// LoggedIn only reads cached management state; it never waits on the network.
func (b *Backend) LoggedIn() bool {
	if b == nil {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.authIndex != ""
}

// LimitSnapshot atomically associates readings with the single active account.
func (b *Backend) LimitSnapshot() []Window {
	if b == nil {
		return []Window{}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.authIndex == "" {
		return []Window{}
	}
	return b.Limits.Snapshot()
}
