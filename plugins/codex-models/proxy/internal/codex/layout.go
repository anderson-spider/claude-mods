package codex

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

// format identifies the on-disk credential layout.
type format int

const (
	// formatUnknown asks for the layout to be detected from the contents.
	formatUnknown format = iota
	// formatNative is this proxy's own file: a flat Token object.
	formatNative
	// formatCodexCLI is the Codex CLI's ~/.codex/auth.json, whose tokens sit
	// under a "tokens" object alongside fields this proxy does not own.
	formatCodexCLI
)

// The Codex CLI layout's keys.
const (
	cliTokens       = "tokens"
	cliIDToken      = "id_token"
	cliAccessToken  = "access_token"
	cliRefreshToken = "refresh_token"
	cliAccountID    = "account_id"
	cliLastRefresh  = "last_refresh"
	cliAuthMode     = "auth_mode"
)

// cliChatGPTMode is the only auth_mode that can drive the subscription
// endpoint; an API-key login cannot.
const cliChatGPTMode = "chatgpt"

// cliSkeleton is what a Codex CLI layout file starts from when the file
// holds nothing usable.
const cliSkeleton = `{"auth_mode":"chatgpt","OPENAI_API_KEY":null}`

// detectFormat picks the layout a credential file is written in: the Codex
// CLI's when its top level has a "tokens" object.
func detectFormat(data []byte) format {
	if tok, ok := peek(data, cliTokens); ok && tok == json.Delim('{') {
		return formatCodexCLI
	}
	return formatNative
}

// detectFormatOfFile is detectFormat on path's contents; a file that cannot
// be read is taken as native.
func detectFormatOfFile(path string) format {
	data, err := os.ReadFile(path)
	if err != nil {
		return formatNative
	}
	return detectFormat(data)
}

// decodeCredentials parses either supported layout.
func decodeCredentials(data []byte, kind format) (*Token, error) {
	if kind == formatCodexCLI {
		return decodeCodexCLI(data)
	}
	return decodeNative(data)
}

func decodeNative(data []byte) (*Token, error) {
	token := &Token{}
	if err := json.Unmarshal(data, token); err != nil {
		return nil, fmt.Errorf("codex: parse credentials: %w", err)
	}
	enrich(token)
	return token, nil
}

// decodeCodexCLI reads the Codex CLI's auth.json. The file records no expiry,
// so it is derived from the access token's own claims.
func decodeCodexCLI(data []byte) (*Token, error) {
	if !json.Valid(data) {
		return nil, fmt.Errorf("codex: %s is not valid JSON", codexCLIFileName)
	}
	// A valid document that is not an object has no members.
	root, _ := parseObject(data)
	tokens, err := parseObject(root.get(cliTokens))
	if err != nil {
		return nil, fmt.Errorf("codex: %s has no \"tokens\" object", codexCLIFileName)
	}

	token := &Token{
		IDToken:      textOf(tokens.get(cliIDToken)),
		AccessToken:  textOf(tokens.get(cliAccessToken)),
		RefreshToken: textOf(tokens.get(cliRefreshToken)),
		AccountID:    textOf(tokens.get(cliAccountID)),
		Type:         tokenType,
	}
	if stamp := strings.TrimSpace(textOf(root.get(cliLastRefresh))); stamp != "" {
		if parsed, err := time.Parse(time.RFC3339, stamp); err == nil {
			token.LastRefresh = parsed
		}
	}
	enrich(token)

	if token.AccessToken == "" && token.RefreshToken == "" {
		return nil, ErrNotAuthenticated
	}
	if mode := textOf(root.get(cliAuthMode)); mode != "" && mode != cliChatGPTMode {
		return nil, fmt.Errorf("codex: %s uses auth_mode %q; a ChatGPT subscription login is required", codexCLIFileName, mode)
	}
	return token, nil
}

// encodeCredentials renders token in the given layout and sets its Type. For
// the Codex CLI layout, previous holds the file's current contents so fields
// this proxy does not own (auth_mode, OPENAI_API_KEY, anything added later)
// survive the write, in their place.
func encodeCredentials(token *Token, kind format, previous []byte) ([]byte, error) {
	if token == nil {
		return nil, fmt.Errorf("codex: nothing to encode")
	}
	token.Type = tokenType
	if kind == formatNative {
		data, err := json.MarshalIndent(token, "", "  ")
		if err != nil {
			return nil, fmt.Errorf("codex: encode credentials: %w", err)
		}
		return append(data, '\n'), nil
	}
	return encodeCodexCLI(token, previous)
}

// encodeCodexCLI writes token's four tokens under "tokens" and its refresh
// time as last_refresh into previous (or a fresh ChatGPT-mode file when
// previous is not a JSON object), keeping every other member as written.
func encodeCodexCLI(token *Token, previous []byte) ([]byte, error) {
	root, err := parseObject(previous)
	if err != nil {
		root, _ = parseObject([]byte(cliSkeleton))
	}
	tokens, err := parseObject(root.get(cliTokens))
	if err != nil {
		tokens = object{}
	}
	refreshed := token.LastRefresh
	if refreshed.IsZero() {
		refreshed = time.Now()
	}

	for _, field := range []struct{ key, value string }{
		{cliIDToken, token.IDToken},
		{cliAccessToken, token.AccessToken},
		{cliRefreshToken, token.RefreshToken},
		{cliAccountID, token.AccountID},
	} {
		value, err := jsonString(field.value)
		if err != nil {
			return nil, fmt.Errorf("codex: update tokens.%s: %w", field.key, err)
		}
		tokens = tokens.set(field.key, value)
	}
	encodedTokens, err := tokens.encode()
	if err != nil {
		return nil, fmt.Errorf("codex: update tokens: %w", err)
	}
	root = root.set(cliTokens, encodedTokens)
	stamp, err := jsonString(refreshed.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return nil, fmt.Errorf("codex: update last_refresh: %w", err)
	}
	root = root.set(cliLastRefresh, stamp)

	out, err := root.encode()
	if err != nil {
		return nil, fmt.Errorf("codex: encode credentials: %w", err)
	}
	return append(out, '\n'), nil
}
