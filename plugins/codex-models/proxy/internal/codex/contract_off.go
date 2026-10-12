//go:build !contract

package codex

import "github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"

// authURL and tokenURL are the OAuth endpoints in use: the real ones.
func authURL() string  { return AuthURL }
func tokenURL() string { return TokenURL }

// CallbackPort is fixed by the OAuth client registration.
func CallbackPort() int { return config.CallbackPort }
