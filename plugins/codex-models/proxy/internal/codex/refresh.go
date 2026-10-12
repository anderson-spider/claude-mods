package codex

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// refreshLead refreshes an access token this far before it expires.
const refreshLead = 5 * time.Minute

// Access returns a usable access token together with the account id,
// refreshing this proxy's own credential when it is close to expiry.
func (s *Store) Access(ctx context.Context) (accessToken, accountID string, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	token, err := s.loadLocked()
	switch {
	case err != nil:
		return "", "", err
	case s.active.readOnly:
		return s.borrowedLocked(token)
	case !token.Expired(refreshLead):
		return serve(token)
	}
	if err := s.rejectedLocked(token); err != nil {
		return afterRejection(token, err)
	}

	// Another proxy process may be refreshing the same file: hold the locks,
	// then read the file again, so only one of them spends the refresh token.
	unlock, err := s.lock(ctx)
	if err != nil {
		if !token.Expired(0) {
			logx.Warnf("codex: %v; using the current token", err)
			return serve(token)
		}
		return "", "", err
	}
	defer unlock()
	return s.refreshLocked(ctx)
}

// refreshLocked reads the credential again under the file locks and refreshes
// it if it still needs it.
func (s *Store) refreshLocked(ctx context.Context) (string, string, error) {
	// Read the file even when its stamp looks unchanged: another process may
	// have refreshed it with a token of the same size within the file
	// system's mtime granularity, and the cached refresh token is then spent.
	s.token = nil
	token, err := s.loadLocked()
	switch {
	case err != nil:
		return "", "", err
	case s.active.readOnly:
		return s.borrowedLocked(token)
	case !token.Expired(refreshLead):
		// Another process refreshed it while this one waited.
		return serve(token)
	case token.RefreshToken == "":
		if !token.Expired(0) {
			return serve(token)
		}
		return "", "", ErrNotAuthenticated
	}
	if err := s.rejectedLocked(token); err != nil {
		return afterRejection(token, err)
	}

	logx.Infof("codex: refreshing access token (expires %s)", expiryLabel(token))
	// The refresh outlives a caller that goes away: a refresh token the
	// endpoint has rotated must reach the file.
	refreshed, err := s.client.Refresh(context.WithoutCancel(ctx), token.RefreshToken)
	if errors.Is(err, ErrLoginExpired) {
		s.latchLocked(token, err)
		return afterRejection(token, err)
	}
	if err != nil {
		// A still-valid token is worth trying even if the refresh failed;
		// only a genuinely expired one is a hard error.
		if !token.Expired(0) {
			logx.Warnf("codex: token refresh failed, using the current token: %v", err)
			return serve(token)
		}
		return "", "", err
	}

	carryOver(refreshed, token)
	if err := s.writeLocked(refreshed, s.active); err != nil {
		logx.Warnf("codex: could not persist the refreshed token: %v", err)
		s.token = refreshed
	}
	return serve(refreshed)
}

// carryOver fills what a refresh answer left out from the token it replaces:
// the answer repeats little about the account.
func carryOver(refreshed, previous *Token) {
	if refreshed.AccountID == "" {
		refreshed.AccountID = previous.AccountID
	}
	if refreshed.Email == "" {
		refreshed.Email = previous.Email
	}
	if refreshed.PlanType == "" {
		refreshed.PlanType = previous.PlanType
	}
	if refreshed.IDToken == "" {
		refreshed.IDToken = previous.IDToken
	}
}

func serve(token *Token) (string, string, error) {
	return token.AccessToken, token.AccountID, nil
}

// The rejected-refresh latch. A refresh token the endpoint refused is spent
// or revoked; sending it again only repeats the refusal (and, for a rotated
// token, can look like reuse to the server). So the refusal is remembered
// against the file it came from, that file's stamp and a hash of the refresh
// token, answered without a request while all three hold, and dropped once
// the file changes or a new login is written.

// latchLocked records the refusal of token's refresh and logs it once, with
// the status and the OAuth code only.
func (s *Store) latchLocked(token *Token, err error) {
	s.rejected = &rejection{
		path:    s.active.path,
		stamp:   s.stamp,
		refresh: sha256.Sum256([]byte(token.RefreshToken)),
		err:     err,
	}
	status, code := 0, "none"
	var tokenErr *TokenError
	if errors.As(err, &tokenErr) {
		status = tokenErr.StatusCode
		if tokenErr.Code != "" {
			code = tokenErr.Code
		}
	}
	logx.Warnf("codex: the token endpoint rejected the refresh of %s (status %d, error %s); "+
		"no refresh is retried until the file changes: run `ccmproxy login codex`", s.active.path, status, code)
}

// rejectedLocked returns the latched refusal when token is the credential the
// token endpoint already rejected, unchanged on disk since; otherwise it
// drops the latch.
func (s *Store) rejectedLocked(token *Token) error {
	r := s.rejected
	if r == nil {
		return nil
	}
	if r.path != s.active.path || r.stamp != s.stamp || r.refresh != sha256.Sum256([]byte(token.RefreshToken)) {
		s.rejected = nil
		return nil
	}
	return r.err
}

// afterRejection keeps serving a still-valid access token after its refresh
// was refused; an expired one answers the refusal.
func afterRejection(token *Token, err error) (string, string, error) {
	if !token.Expired(0) {
		return serve(token)
	}
	return "", "", err
}

// borrowedLocked serves the Codex CLI's login while its access token is valid.
func (s *Store) borrowedLocked(token *Token) (string, string, error) {
	if token.Expired(0) {
		return "", "", fmt.Errorf("%w (%s)", ErrCodexCLILoginExpired, s.active.path)
	}
	return serve(token)
}
