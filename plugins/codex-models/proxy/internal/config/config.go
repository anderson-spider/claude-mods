// Package config reads, checks and writes ccmproxy's config.json.
//
// The file is optional: every setting has a default except the two secrets,
// auth_token and session_salt, which only `ccmproxy config init` creates. The
// settings that decide where traffic and credentials go are checked on every
// load, so no file can send them anywhere this package does not allow.
//
// The package is split by job: paths.go finds the file, load.go reads it,
// validate.go checks it, write.go writes it, init.go is `config init`, and
// contract_off.go/contract_on.go hold the two checks the contract build
// relaxes.
package config

const (
	// DefaultUpstream is where every request that is not for a Codex model
	// goes, unchanged. It is also the only upstream accepted, because those
	// requests carry the person's Claude Code login.
	DefaultUpstream = "https://api.anthropic.com"

	// DefaultListenHTTP is the listener when the file names none; `config
	// init` writes a random free port instead.
	DefaultListenHTTP = "127.0.0.1:8081"

	// TokenHeader is the request header that must carry auth_token. Claude
	// Code sends it through ANTHROPIC_CUSTOM_HEADERS. It is deliberately not
	// Authorization or x-api-key: those carry the Claude Code login.
	TokenHeader = "X-Ccmproxy-Token"
)

const defaultLogLevel = "info"

// Config is everything config.json can set. The field order is the key order
// Save writes.
type Config struct {
	// ListenHTTP is the proxy's only listener: plain HTTP on a literal
	// loopback IP with an explicit port (see ValidateListenAddr). Claude Code
	// reaches it through ANTHROPIC_BASE_URL.
	ListenHTTP string `json:"listen_http"`

	// Upstream receives the requests that are not for a Codex model. Only
	// DefaultUpstream passes Validate.
	Upstream string `json:"upstream"`

	// AuthToken is the secret every request must carry in TokenHeader.
	// `serve` will not start without it.
	AuthToken string `json:"auth_token,omitempty"`

	// SessionSalt keys the hash that turns Claude Code's metadata.user_id
	// into the metadata.user_id sent to the Codex remote.
	SessionSalt string `json:"session_salt,omitempty"`

	// LogLevel is debug, info, warn or error.
	LogLevel string `json:"log_level"`

	Codex Codex `json:"codex"`

	// path is the file this value was loaded from, and where Save writes.
	path string
}

// Codex configures the credential-owning remote. An empty remote disables inference.
type Codex struct {
	Remote        string `json:"remote,omitempty"`
	ManagementKey string `json:"management_key,omitempty"`
}

// Default returns the configuration used for every setting a file leaves
// out. It has no secrets: those come only from `config init`.
func Default() *Config {
	return &Config{
		ListenHTTP: DefaultListenHTTP,
		Upstream:   DefaultUpstream,
		LogLevel:   defaultLogLevel,
	}
}

// Path is the file the configuration was loaded from, or DefaultPath for a
// value that was not loaded.
func (c *Config) Path() string {
	if c.path != "" {
		return c.path
	}
	return DefaultPath()
}
