package codex

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jclab-joseph/claude-code-model-proxy/internal/netx"
	"github.com/tidwall/gjson"
)

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
		HTTP: withoutRedirects(&http.Client{
			Transport: transport,
			Timeout:   0,
		}),
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
	var parts []string
	for _, field := range []string{"type", "code"} {
		if value := gjson.GetBytes(e.Body, "error."+field); value.Type == gjson.String && oauthCode.MatchString(value.String()) {
			parts = append(parts, field+" "+value.String())
		}
	}
	if len(parts) == 0 {
		return fmt.Sprintf("codex: backend returned %d", e.StatusCode)
	}
	return fmt.Sprintf("codex: backend returned %d (%s)", e.StatusCode, strings.Join(parts, ", "))
}

// Responses posts a Responses API request and returns the streaming
// response. The caller owns the body and must close it.
func (b *Backend) Responses(ctx context.Context, body []byte, sessionID string) (*http.Response, error) {
	accessToken, accountID, err := b.Store.Access(ctx)
	if err != nil {
		return nil, err
	}

	endpoint := b.BaseURL + "/responses"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("codex: build responses request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Connection", "Keep-Alive")
	req.Header.Set("User-Agent", b.UserAgent)
	// The subscription endpoint identifies its client by originator; requests
	// without it are rejected.
	req.Header.Set("Originator", b.Originator)
	if accountID != "" {
		req.Header.Set("Chatgpt-Account-Id", accountID)
	}
	if sessionID == "" {
		sessionID = NewSessionID()
	}
	req.Header.Set("Session_id", sessionID)

	// The request carries the ChatGPT access token: a redirect, even to the
	// same host or to http, is refused rather than followed.
	resp, err := withoutRedirects(b.HTTP).Do(req)
	if err != nil {
		return nil, fmt.Errorf("codex: responses request failed: %w", err)
	}
	if isRedirect(resp.StatusCode) {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("codex: backend answered %d, a redirect, which is not followed", resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
		return nil, &APIError{StatusCode: resp.StatusCode, Body: data}
	}
	return resp, nil
}

// NewSessionID returns a random RFC 4122 version 4 UUID.
func NewSessionID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		// A time-derived fallback keeps the header present; it is only an
		// opaque correlation id.
		return fmt.Sprintf("%016x-0000-4000-8000-%012x", time.Now().UnixNano(), time.Now().UnixNano()&0xffffffffffff)
	}
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80
	hexed := hex.EncodeToString(raw)
	return hexed[0:8] + "-" + hexed[8:12] + "-" + hexed[12:16] + "-" + hexed[16:20] + "-" + hexed[20:32]
}
