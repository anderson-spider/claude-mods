package codex

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// DefaultUsageTimeout bounds one usage request.
const DefaultUsageTimeout = 5 * time.Second

// maxUsageBody caps what is read of a usage answer.
const maxUsageBody = 1 << 20

// usageURL is the plan's usage endpoint beside the Codex one:
// https://chatgpt.com/backend-api/codex becomes
// https://chatgpt.com/backend-api/wham/usage. It is the same host as the
// Responses requests. The endpoint is not documented by OpenAI.
func usageURL(baseURL string) string {
	base := strings.TrimSuffix(strings.TrimSuffix(baseURL, "/"), "/codex")
	return base + "/wham/usage"
}

// RefreshLimits starts a usage request when a held reading is absent or
// older than maxAge, and returns a channel closed when it ends. A request
// already in flight is shared, not repeated. It returns nil, and asks
// nothing, when the readings are fresh, when the last request began less than
// maxAge ago (it succeeded or not, so a failing endpoint is asked at most
// once per maxAge), when there is no Codex login, or when the access token is
// due for refresh: the request never refreshes a token, and never waits for
// one, so only a Responses call does.
//
// The request runs on its own deadline (UsageTimeout), not the caller's, so
// a caller that stops waiting leaves it running for the next one. A failure
// of any kind only means the readings stay as they were; it is logged as a
// reason, never with a header, a token or a body.
func (b *Backend) RefreshLimits(maxAge time.Duration) <-chan struct{} {
	if b == nil || b.Limits == nil || b.Store == nil {
		return nil
	}
	b.flightMu.Lock()
	defer b.flightMu.Unlock()
	if b.flight != nil {
		return b.flight
	}
	now := b.Limits.clock()
	if !b.lastAttempt.IsZero() && now.Sub(b.lastAttempt) < maxAge {
		return nil
	}
	if !b.Limits.Stale(maxAge) {
		return nil
	}
	accessToken, accountID, err := b.Store.Held()
	if err != nil {
		if !errors.Is(err, ErrNotAuthenticated) {
			logx.Debugf("codex usage: skipped: %v", err)
		}
		return nil
	}
	done := make(chan struct{})
	b.flight = done
	b.lastAttempt = now
	go func() {
		defer func() {
			b.flightMu.Lock()
			b.flight = nil
			b.flightMu.Unlock()
			close(done)
		}()
		b.refreshLimits(accessToken, accountID)
	}()
	return done
}

func (b *Backend) refreshLimits(accessToken, accountID string) {
	timeout := b.UsageTimeout
	if timeout <= 0 {
		timeout = DefaultUsageTimeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	requestedAt := b.Limits.clock()
	windows, err := b.fetchUsage(ctx, accessToken, accountID)
	if err != nil {
		logx.Debugf("codex usage: %v", reasonOf(err))
		return
	}
	b.Limits.applyUsage(windows, requestedAt)
	logx.Debugf("codex usage: %d window(s) read", len(windows))
}

// fetchUsage makes one GET to the usage endpoint with the Responses
// client's credentials, over its transport, and never follows a redirect.
func (b *Backend) fetchUsage(ctx context.Context, accessToken, accountID string) ([]Window, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, usageURL(b.BaseURL), nil)
	if err != nil {
		return nil, errors.New("codex: build usage request failed")
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", b.UserAgent)
	req.Header.Set("Originator", b.Originator)
	if accountID != "" {
		req.Header.Set("Chatgpt-Account-Id", accountID)
	}

	resp, err := withoutRedirects(b.HTTP).Do(req)
	if err != nil {
		return nil, fmt.Errorf("codex: usage request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	switch {
	case isRedirect(resp.StatusCode):
		return nil, fmt.Errorf("codex: usage endpoint answered %d, a redirect, which is not followed", resp.StatusCode)
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		return nil, fmt.Errorf("codex: usage endpoint answered %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxUsageBody))
	if err != nil {
		return nil, errors.New("codex: usage answer could not be read")
	}
	return parseUsage(body, b.Limits.clock()), nil
}

// reasonOf is an error as a log line: a transport error without the URL it
// quotes.
func reasonOf(err error) string {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return "request failed: " + urlErr.Err.Error()
	}
	return err.Error()
}
