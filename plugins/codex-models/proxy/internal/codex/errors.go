package codex

import "errors"

// The texts below are read by people and matched by callers; keep them as
// they are.

// ErrNotAuthenticated is returned when no Codex credentials can be found.
var ErrNotAuthenticated = errors.New("codex: not authenticated, run `ccmproxy login codex`")

// ErrLoginExpired is returned when the token endpoint refuses to refresh this
// proxy's own login (expired, revoked, or its refresh token already spent):
// only signing in again helps.
var ErrLoginExpired = errors.New("codex: the proxy's Codex login has expired or was revoked; " +
	"run `ccmproxy login codex` to sign in again")
