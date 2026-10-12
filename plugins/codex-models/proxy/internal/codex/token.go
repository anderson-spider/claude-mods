package codex

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Token is the credential set persisted for a Codex account.
//
// Its JSON form, with these tags, is the layout of this proxy's own
// credential file.
type Token struct {
	IDToken      string    `json:"id_token"`
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	AccountID    string    `json:"account_id"`
	Email        string    `json:"email"`
	PlanType     string    `json:"plan_type,omitempty"`
	ExpiresAt    time.Time `json:"expires_at"`
	LastRefresh  time.Time `json:"last_refresh"`
	Type         string    `json:"type"`
}

// tokenType is the Type every credential this package builds or writes has.
const tokenType = "codex"

// Expired reports whether the access token is past its lifetime, treating the
// final lead window as already expired so refreshes happen ahead of failures.
// A token without an access token is expired; one without a known expiry is
// not.
func (t *Token) Expired(lead time.Duration) bool {
	switch {
	case t == nil || t.AccessToken == "":
		return true
	case t.ExpiresAt.IsZero():
		return false
	default:
		return time.Now().Add(lead).After(t.ExpiresAt)
	}
}

// expiryLabel is the token's expiry for a log line.
func expiryLabel(t *Token) string {
	if t == nil || t.ExpiresAt.IsZero() {
		return "unknown"
	}
	return t.ExpiresAt.Format(time.RFC3339)
}

// Claims is the subset of the ID token payload the proxy needs.
type Claims struct {
	Email string   `json:"email"`
	Exp   int64    `json:"exp"`
	Auth  AuthInfo `json:"https://api.openai.com/auth"`
}

// AuthInfo carries the ChatGPT account details embedded in the ID token.
type AuthInfo struct {
	ChatGPTAccountID string `json:"chatgpt_account_id"`
	ChatGPTPlanType  string `json:"chatgpt_plan_type"`
	ChatGPTUserID    string `json:"chatgpt_user_id"`
	UserID           string `json:"user_id"`
}

// ParseIDToken decodes the claims of a JWT without verifying its signature.
// The token arrives over TLS straight from the issuer's token endpoint, so it
// is only being read for the account id and plan, never trusted as proof.
func ParseIDToken(token string) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("codex: malformed JWT: expected 3 parts, got %d", len(parts))
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil, fmt.Errorf("codex: decode JWT payload: %w", err)
	}
	claims := &Claims{}
	if err := json.Unmarshal(payload, claims); err != nil {
		return nil, fmt.Errorf("codex: parse JWT payload: %w", err)
	}
	return claims, nil
}

// enrich fills in what the file did not record from the tokens' own claims.
// The access token comes first: it is the credential whose lifetime matters,
// and it carries the account and plan, whereas the ID token expires within
// the hour and goes stale in a stored file. The email is only in the ID
// token.
func enrich(t *Token) {
	if t == nil {
		return
	}
	if claims, err := ParseIDToken(t.AccessToken); err == nil {
		if t.ExpiresAt.IsZero() && claims.Exp > 0 {
			t.ExpiresAt = time.Unix(claims.Exp, 0)
		}
		fillAccount(t, claims)
	}
	if t.Email == "" || t.AccountID == "" || t.PlanType == "" {
		if claims, err := ParseIDToken(t.IDToken); err == nil {
			if t.Email == "" {
				t.Email = claims.Email
			}
			fillAccount(t, claims)
		}
	}
	if t.Type == "" {
		t.Type = tokenType
	}
}

// fillAccount sets the account id and plan from claims where t has none.
func fillAccount(t *Token, claims *Claims) {
	if t.AccountID == "" {
		t.AccountID = claims.Auth.ChatGPTAccountID
	}
	if t.PlanType == "" {
		t.PlanType = claims.Auth.ChatGPTPlanType
	}
}
