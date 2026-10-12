package codex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

const (
	DefaultUsageTimeout = 5 * time.Second
	authMaxAge          = time.Minute
	maxManagementBody   = 1 << 20
	usageTarget         = "https://chatgpt.com/backend-api/wham/usage"
)

// RefreshAuth starts at most one credentials check per minute, without waiting.
// This endpoint is local to the remote and does not read OpenAI usage.
func (b *Backend) RefreshAuth() <-chan struct{} {
	if b == nil || b.Remote == "" || b.ManagementKey == "" {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.authFlight != nil {
		return b.authFlight
	}
	now := b.Limits.clock()
	if !b.authAttempt.IsZero() && now.Sub(b.authAttempt) < authMaxAge {
		return nil
	}
	done := make(chan struct{})
	b.authFlight, b.authAttempt = done, now
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), b.timeout())
		defer cancel()
		index, err := b.fetchAuth(ctx)
		b.mu.Lock()
		// Account changes invalidate held quota and an old account's in-flight reading.
		if err != nil || index != b.authIndex {
			b.Limits.Clear()
			b.generation++
		}
		b.authIndex = index
		b.authFlight = nil
		b.mu.Unlock()
		if err != nil {
			logx.Warnf("codex remote: account check failed")
		}
		close(done)
	}()
	return done
}

func (b *Backend) fetchAuth(ctx context.Context) (string, error) {
	body, err := b.management(ctx, "/v8/management/credentials", nil)
	if err != nil {
		return "", err
	}
	var envelope struct {
		Files []struct {
			Type        string `json:"type"`
			Provider    string `json:"provider"`
			Status      string `json:"status"`
			Unavailable bool   `json:"unavailable"`
			Disabled    bool   `json:"disabled"`
			AuthIndex   string `json:"auth_index"`
		} `json:"files"`
	}
	if json.Unmarshal(body, &envelope) != nil {
		return "", errors.New("codex: invalid account envelope")
	}
	count, index := 0, ""
	for _, file := range envelope.Files {
		if (file.Type == "codex" || file.Provider == "codex") && file.Status == "active" && !file.Disabled && !file.Unavailable {
			count++
			index = file.AuthIndex
		}
	}
	if count > 1 {
		logx.Warnf("codex remote: multiple active Codex accounts; quota is unavailable")
	}
	if count != 1 || index == "" {
		return "", nil
	}
	return index, nil
}

// RefreshLimits retains single flight and failure backoff. Only an explicit
// status refresh calls it; credentials never starts an OpenAI usage call.
func (b *Backend) RefreshLimits(maxAge time.Duration) <-chan struct{} {
	if b == nil || b.Limits == nil || b.ManagementKey == "" {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.authIndex == "" {
		return nil
	}
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
	done, index, generation := make(chan struct{}), b.authIndex, b.generation
	b.flight, b.lastAttempt = done, now
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), b.timeout())
		defer cancel()
		windows, err := b.fetchUsage(ctx, index)
		b.mu.Lock()
		if b.authIndex == index && b.generation == generation {
			if errors.Is(err, ErrUnreachable) {
				b.Limits.Clear()
			}
			if err == nil {
				b.Limits.applyUsage(windows, now)
			}
		}
		b.flight = nil
		b.mu.Unlock()
		if err != nil {
			logx.Debugf("codex usage: request failed")
		}
		close(done)
	}()
	return done
}

func (b *Backend) timeout() time.Duration {
	if b.UsageTimeout > 0 {
		return b.UsageTimeout
	}
	return DefaultUsageTimeout
}

// management is the only place that attaches the management credential. The
// paths are fixed by callers and redirects are never followed.
func (b *Backend) management(ctx context.Context, path string, payload []byte) ([]byte, error) {
	method := http.MethodGet
	if payload != nil {
		method = http.MethodPost
	}
	req, err := http.NewRequestWithContext(ctx, method, b.Remote+path, bytes.NewReader(payload))
	if err != nil {
		return nil, ErrUnreachable
	}
	req.Header.Set("Authorization", "Bearer "+b.ManagementKey)
	req.Header.Set("Accept", "application/json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := withoutRedirects(b.HTTP, b.Remote).Do(req)
	if err != nil {
		return nil, ErrUnreachable
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		return nil, ErrUnreachable
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("codex: management returned %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxManagementBody+1))
	if err != nil {
		return nil, ErrUnreachable
	}
	if len(data) > maxManagementBody {
		return nil, errors.New("codex: management answer too large")
	}
	return data, nil
}

func (b *Backend) fetchUsage(ctx context.Context, index string) ([]Window, error) {
	payload, _ := json.Marshal(struct {
		AuthIndex string            `json:"auth_index"`
		Method    string            `json:"method"`
		URL       string            `json:"url"`
		Header    map[string]string `json:"header"`
	}{index, http.MethodGet, usageTarget, map[string]string{"Authorization": "Bearer $TOKEN$"}})
	body, err := b.management(ctx, "/v8/management/requests/api-call", payload)
	if err != nil {
		return nil, err
	}
	var envelope struct {
		StatusCode int     `json:"status_code"`
		Body       *string `json:"body"`
	}
	if json.Unmarshal(body, &envelope) != nil || envelope.Body == nil {
		return nil, errors.New("codex: invalid usage envelope")
	}
	if envelope.StatusCode < 200 || envelope.StatusCode >= 300 {
		return nil, fmt.Errorf("codex: usage returned %d", envelope.StatusCode)
	}
	if !json.Valid([]byte(*envelope.Body)) {
		return nil, errors.New("codex: invalid usage body")
	}
	return parseUsage([]byte(*envelope.Body), b.Limits.clock()), nil
}
