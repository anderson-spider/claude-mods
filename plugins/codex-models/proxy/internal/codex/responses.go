package codex

import (
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/netx"
)

// maxErrorBody caps what is read of a non-2xx backend answer.
const maxErrorBody = 1 << 20

// Backend calls the Codex Responses endpoint on behalf of a signed-in
// ChatGPT account.
type Backend struct {
	BaseURL    string
	UserAgent  string
	Originator string
	Store      *Store
	HTTP       *http.Client
}

// NewBackend wires a backend with a streaming-friendly HTTP client. There is
// no overall request timeout because a single response can stream for
// minutes; the caller's context bounds the call instead.
func NewBackend(baseURL, userAgent, originator string, store *Store, transport http.RoundTripper) *Backend {
	// Never http.DefaultTransport: it honours HTTPS_PROXY, and this
	// transport carries the ChatGPT access token.
	if transport == nil {
		transport = netx.Shared()
	}
	return &Backend{
		BaseURL:    strings.TrimSuffix(baseURL, "/"),
		UserAgent:  userAgent,
		Originator: originator,
		Store:      store,
		HTTP:       withoutRedirects(&http.Client{Transport: transport}),
	}
}

// APIError describes a non-2xx response from the Codex backend.
type APIError struct {
	StatusCode int
	Body       []byte
}

// Error carries the status and the body's error type and code when they are
// short tokens, never the body itself: it can echo the prompt or a token.
// Body stays on the struct for the router's cleaned client message.
func (e *APIError) Error() string {
	var named []string
	for _, field := range []string{"type", "code"} {
		if value, ok := peekString(e.Body, "error", field); ok && shortCode.MatchString(value) {
			named = append(named, field+" "+value)
		}
	}
	if len(named) == 0 {
		return fmt.Sprintf("codex: backend returned %d", e.StatusCode)
	}
	return fmt.Sprintf("codex: backend returned %d (%s)", e.StatusCode, strings.Join(named, ", "))
}

// Responses posts a Responses API request and returns the streaming
// response. The caller owns the body and must close it.
func (b *Backend) Responses(ctx context.Context, body []byte, sessionID string) (*http.Response, error) {
	accessToken, accountID, err := b.Store.Access(ctx)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.BaseURL+"/responses", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("codex: build responses request: %w", err)
	}
	if sessionID == "" {
		sessionID = NewSessionID()
	}
	b.setHeaders(req.Header, accessToken, accountID, sessionID)

	// The request carries the ChatGPT access token: a redirect, even to the
	// same host or to http, is refused rather than followed.
	resp, err := withoutRedirects(b.HTTP).Do(req)
	if err != nil {
		return nil, fmt.Errorf("codex: responses request failed: %w", err)
	}
	switch {
	case isRedirect(resp.StatusCode):
		_ = resp.Body.Close()
		return nil, fmt.Errorf("codex: backend answered %d, a redirect, which is not followed", resp.StatusCode)
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		data, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		_ = resp.Body.Close()
		return nil, &APIError{StatusCode: resp.StatusCode, Body: data}
	}
	return resp, nil
}

// setHeaders writes the headers the subscription endpoint expects, the ones
// the Codex CLI sends.
func (b *Backend) setHeaders(h http.Header, accessToken, accountID, sessionID string) {
	h.Set("Content-Type", "application/json")
	h.Set("Authorization", "Bearer "+accessToken)
	h.Set("Accept", "text/event-stream")
	h.Set("Connection", "Keep-Alive")
	h.Set("User-Agent", b.UserAgent)
	// The endpoint identifies its client by originator; requests without it
	// are rejected.
	h.Set("Originator", b.Originator)
	if accountID != "" {
		h.Set("Chatgpt-Account-Id", accountID)
	}
	h.Set("Session_id", sessionID)
}

// NewSessionID returns a random RFC 4122 version 4 UUID.
func NewSessionID() string {
	var raw [16]byte
	// crypto/rand.Read never fails: it aborts the program instead.
	_, _ = rand.Read(raw[:])
	raw[6] = raw[6]&0x0f | 0x40 // version 4
	raw[8] = raw[8]&0x3f | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}
