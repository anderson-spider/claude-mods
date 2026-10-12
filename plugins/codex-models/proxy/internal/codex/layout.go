package codex

import (
	"encoding/json"
	"fmt"
)

func decodeNative(data []byte) (*Token, error) {
	token := &Token{}
	if err := json.Unmarshal(data, token); err != nil {
		return nil, fmt.Errorf("codex: parse credentials: %w", err)
	}
	enrich(token)
	return token, nil
}
