package codex

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/netx"
)

const (
	// AuthURL and TokenURL are the OpenAI OAuth endpoints.
	AuthURL  = "https://auth.openai.com/oauth/authorize"
	TokenURL = "https://auth.openai.com/oauth/token"
	// ClientID is the public client id of the Codex CLI.
	ClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
	// Scopes requests an ID token plus a refresh token.
	Scopes = "openid email profile offline_access"
)

// exchangeTimeout bounds a token call made with NewClient's own client.
const exchangeTimeout = 30 * time.Second

// refreshScope is what a refresh asks for; the Codex CLI asks the same.
const refreshScope = "openid profile email"

// maxTokenBody caps what is read of a token endpoint answer.
const maxTokenBody = 1 << 20

// RedirectURI builds the loopback redirect URI for the given callback port.
// The registered client only accepts the Codex CLI's port, so callers should
// stay on the default unless they know better.
func RedirectURI(port int) string {
	return fmt.Sprintf("http://localhost:%d/auth/callback", port)
}

// PKCE holds a verifier and its derived S256 challenge.
type PKCE struct {
	Verifier  string `json:"code_verifier"`
	Challenge string `json:"code_challenge"`
}

// NewPKCE generates a fresh verifier/challenge pair. The verifier is 96
// random bytes in base64url, 128 characters: the most RFC 7636 allows.
func NewPKCE() (*PKCE, error) {
	verifier, err := randomText(96)
	if err != nil {
		return nil, fmt.Errorf("codex: generate code verifier: %w", err)
	}
	sum := sha256.Sum256([]byte(verifier))
	return &PKCE{Verifier: verifier, Challenge: base64.RawURLEncoding.EncodeToString(sum[:])}, nil
}

// RandomState returns an opaque value for the OAuth state parameter.
func RandomState() (string, error) {
	state, err := randomText(32)
	if err != nil {
		return "", fmt.Errorf("codex: generate state: %w", err)
	}
	return state, nil
}

// randomText is n random bytes in unpadded base64url.
func randomText(n int) (string, error) {
	raw := make([]byte, n)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// AuthorizeURL builds the URL the user opens to grant access.
func AuthorizeURL(state string, pkce *PKCE, callbackPort int) (string, error) {
	if pkce == nil {
		return "", fmt.Errorf("codex: PKCE codes are required")
	}
	query := url.Values{}
	query.Set("client_id", ClientID)
	query.Set("response_type", "code")
	query.Set("redirect_uri", RedirectURI(callbackPort))
	query.Set("scope", Scopes)
	query.Set("state", state)
	query.Set("code_challenge", pkce.Challenge)
	query.Set("code_challenge_method", "S256")
	query.Set("prompt", "login")
	// The two below are the Codex CLI's own; the subscription endpoint
	// expects them.
	query.Set("id_token_add_organizations", "true")
	query.Set("codex_cli_simplified_flow", "true")
	return authURL() + "?" + query.Encode(), nil
}

// Client performs the OAuth token calls.
type Client struct {
	HTTP *http.Client
}

// NewClient returns a Client with a sane timeout. A given http.Client is
// copied, never changed; either way the copy follows no redirect.
func NewClient(httpClient *http.Client) *Client {
	if httpClient == nil {
		// Never http.DefaultTransport: it honours HTTPS_PROXY.
		httpClient = &http.Client{Transport: netx.Shared(), Timeout: exchangeTimeout}
	}
	return &Client{HTTP: withoutRedirects(httpClient)}
}

// Exchange trades an authorization code for tokens.
func (c *Client) Exchange(ctx context.Context, code string, pkce *PKCE, callbackPort int) (*Token, error) {
	if pkce == nil {
		return nil, fmt.Errorf("codex: PKCE codes are required for token exchange")
	}
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("client_id", ClientID)
	form.Set("code", code)
	form.Set("redirect_uri", RedirectURI(callbackPort))
	form.Set("code_verifier", pkce.Verifier)
	return c.post(ctx, form)
}

// Refresh exchanges a refresh token for a new access token. A refusal of the
// grant itself is ErrLoginExpired, wrapping the TokenError.
func (c *Client) Refresh(ctx context.Context, refreshToken string) (*Token, error) {
	if strings.TrimSpace(refreshToken) == "" {
		return nil, fmt.Errorf("codex: refresh token is required")
	}
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("client_id", ClientID)
	form.Set("refresh_token", refreshToken)
	form.Set("scope", refreshScope)

	token, err := c.post(ctx, form)
	var tokenErr *TokenError
	switch {
	case errors.As(err, &tokenErr) && tokenErr.Rejected():
		// invalid_grant, a reused or revoked refresh token: the login is
		// gone and only a new one helps. A 5xx, a 429 or a network failure
		// may pass, so they stay as they are.
		return nil, fmt.Errorf("%w (%w)", ErrLoginExpired, tokenErr)
	case err != nil:
		return nil, err
	}
	// The answer may leave the refresh token out; the one sent stays valid.
	if token.RefreshToken == "" {
		token.RefreshToken = refreshToken
	}
	return token, nil
}

// tokenAnswer is the token endpoint's success body.
type tokenAnswer struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
}

// post sends form to the token endpoint and reads the credential it answers.
func (c *Client) post(ctx context.Context, form url.Values) (*Token, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL(), strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("codex: build token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	// The form carries the refresh token or the code, and a redirect would
	// replay it to wherever Location points: whatever client the caller
	// built, none is followed.
	resp, err := withoutRedirects(c.HTTP).Do(req)
	if err != nil {
		return nil, fmt.Errorf("codex: token request failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if isRedirect(resp.StatusCode) {
		return nil, fmt.Errorf("codex: token endpoint answered %d, a redirect, which is not followed", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxTokenBody))
	if err != nil {
		return nil, fmt.Errorf("codex: read token response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, newTokenError(resp.StatusCode, body)
	}
	var answer tokenAnswer
	if err := json.Unmarshal(body, &answer); err != nil {
		return nil, fmt.Errorf("codex: parse token response: %w", err)
	}
	return answer.token(time.Now()), nil
}

// token is the credential the answer describes, as of now.
func (a tokenAnswer) token(now time.Time) *Token {
	token := &Token{
		IDToken:      a.IDToken,
		AccessToken:  a.AccessToken,
		RefreshToken: a.RefreshToken,
		LastRefresh:  now,
		Type:         tokenType,
	}
	if a.ExpiresIn > 0 {
		token.ExpiresAt = now.Add(time.Duration(a.ExpiresIn) * time.Second)
	}
	if claims, err := ParseIDToken(a.IDToken); err == nil {
		token.AccountID = claims.Auth.ChatGPTAccountID
		token.Email = claims.Email
		token.PlanType = claims.Auth.ChatGPTPlanType
	}
	return token
}

// TokenError is a non-200 answer from the token endpoint. It keeps the status
// and the OAuth `error` code only: the body may echo what was sent.
type TokenError struct {
	StatusCode int
	// Code is the OAuth error code (`invalid_grant`, ...), kept only when it
	// is a short token.
	Code string
}

// shortCode is what an OAuth error code, or a Codex error type or code, looks
// like; anything else in those fields is not repeated.
var shortCode = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

func newTokenError(status int, body []byte) *TokenError {
	e := &TokenError{StatusCode: status}
	if code, ok := peekString(body, "error"); ok && shortCode.MatchString(code) {
		e.Code = code
	}
	return e
}

func (e *TokenError) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("codex: token endpoint returned %d", e.StatusCode)
	}
	return fmt.Sprintf("codex: token endpoint returned %d (%s)", e.StatusCode, e.Code)
}

// Rejected reports a refusal of the grant itself (400, 401, 403), as opposed
// to a failure that may pass.
func (e *TokenError) Rejected() bool {
	return e.StatusCode == http.StatusBadRequest ||
		e.StatusCode == http.StatusUnauthorized ||
		e.StatusCode == http.StatusForbidden
}

// withoutRedirects returns a copy of client that never follows a redirect:
// the 3xx itself comes back as the response. A nil client is the shared
// direct transport, without a timeout.
func withoutRedirects(client *http.Client) *http.Client {
	copied := http.Client{Transport: netx.Shared()}
	if client != nil {
		copied = *client
	}
	copied.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &copied
}

func isRedirect(status int) bool { return status >= 300 && status < 400 }
