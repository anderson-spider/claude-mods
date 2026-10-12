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

// ErrCodexCLILoginExpired is returned when the borrowed Codex CLI login has an
// expired access token. The proxy never refreshes that login: OpenAI rotates
// refresh tokens, so a refresh here would sign the Codex CLI (and the crew's
// `codex exec`) out.
var ErrCodexCLILoginExpired = errors.New("codex: the Codex CLI login has expired and this proxy never refreshes it; " +
	"run `codex login` to renew it, or `ccmproxy login codex` to give the proxy its own login")

// ErrAuthFileIsCodexCLI is returned when codex.auth_file names the Codex CLI's
// own credential file, which this proxy only ever reads.
var ErrAuthFileIsCodexCLI = errors.New("codex: auth_file is the Codex CLI's login file, which this proxy never writes; " +
	"leave auth_file empty (and set use_codex_cli_auth to borrow that login read-only) or point it at another file")

// ErrInsideCodexHome is returned when this proxy's own files (auth_dir, or the
// directory of auth_file) would go in the Codex CLI's directory, CODEX_HOME.
var ErrInsideCodexHome = errors.New("codex: the proxy's credential files would go in the Codex CLI's directory, " +
	"which this proxy never writes; point auth_dir (and auth_file, if set) at a directory of its own")
