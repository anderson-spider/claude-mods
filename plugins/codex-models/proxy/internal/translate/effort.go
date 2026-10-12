package translate

import (
	"encoding/json"
	"strings"
)

// preferences are the parts of a Messages request that say how hard to
// think, and in what shape to answer.
type preferences struct {
	Thinking     json.RawMessage `json:"thinking"`
	OutputConfig json.RawMessage `json:"output_config"`
}

type claudeThinking struct {
	Type         text  `json:"type"`
	BudgetTokens count `json:"budget_tokens"`
}

type claudeOutputConfig struct {
	Effort json.RawMessage `json:"effort"`
	Format json.RawMessage `json:"format"`
}

type claudeFormat struct {
	Type   text            `json:"type"`
	Name   text            `json:"name"`
	Strict json.RawMessage `json:"strict"`
	Schema json.RawMessage `json:"schema"`
}

type jsonSchemaFormat struct {
	Type   string          `json:"type"`
	Name   string          `json:"name"`
	Strict bool            `json:"strict"`
	Schema json.RawMessage `json:"schema"`
}

// EffortFrom reads the reasoning effort a Messages request asks for, as a
// Responses effort, or fallback (medium when empty) when it asks for none.
//
// output_config.effort comes first: it is what Claude Code's /effort and
// --effort send, and it names the level outright. Without it the thinking
// setting is read: a token budget by size, adaptive thinking as xhigh,
// disabled thinking as low. A model-name suffix, which outranks both, and the
// clamp to the model's levels are the caller's.
func EffortFrom(raw []byte, fallback string) string {
	var p preferences
	readJSON(raw, &p)
	return p.effort(fallback)
}

func (p preferences) effort(fallback string) string {
	if fallback == "" {
		fallback = "medium"
	}

	var config claudeOutputConfig
	if kindOf(p.OutputConfig) == '{' {
		readJSON(p.OutputConfig, &config)
	}
	if kindOf(config.Effort) == '"' {
		if stated := strings.ToLower(strings.TrimSpace(textOf(config.Effort))); stated != "" {
			return stated
		}
	}

	if kindOf(p.Thinking) != '{' {
		return fallback
	}
	var thinking claudeThinking
	readJSON(p.Thinking, &thinking)
	switch thinking.Type {
	case "enabled":
		switch budget := int64(thinking.BudgetTokens); {
		case budget <= 4096:
			return "low"
		case budget <= 16384:
			return "medium"
		case budget <= 32768:
			return "high"
		default:
			return "xhigh"
		}
	case "adaptive", "auto":
		// Thinking as needed, with no level stated: the most the model has.
		return "xhigh"
	case "disabled":
		return "low"
	}
	return fallback
}

// structuredOutput converts output_config.format when it asks for a JSON
// schema.
func (p preferences) structuredOutput() (json.RawMessage, bool) {
	if kindOf(p.OutputConfig) != '{' {
		return nil, false
	}
	var config claudeOutputConfig
	readJSON(p.OutputConfig, &config)
	if kindOf(config.Format) != '{' {
		return nil, false
	}
	var format claudeFormat
	readJSON(config.Format, &format)
	if format.Type != "json_schema" || kindOf(format.Schema) != '{' {
		return nil, false
	}

	name := string(format.Name)
	if name == "" {
		name = "structured_output"
	}
	// Strict unless the client said false; and strict mode needs every
	// property listed as required, so a schema that does not do that goes
	// non-strict instead of drawing a 400.
	strict := strings.TrimSpace(string(format.Strict)) != "false" && !missesRequired(format.Schema)
	return encode(jsonSchemaFormat{Type: "json_schema", Name: name, Strict: strict, Schema: format.Schema}), true
}

// missesRequired reports whether any object schema inside schema has a
// property its required list leaves out (or has properties and no required
// list at all).
func missesRequired(schema json.RawMessage) bool {
	if kindOf(schema) == '[' {
		for _, child := range elements(schema) {
			if missesRequired(child) {
				return true
			}
		}
		return false
	}
	members := fields(schema)
	if members == nil {
		return false
	}

	if properties := fields(members["properties"]); properties != nil {
		required := members["required"]
		if kindOf(required) != '[' {
			return len(properties) > 0
		}
		names := map[string]bool{}
		for _, name := range elements(required) {
			names[textOf(name)] = true
		}
		for name := range properties {
			if !names[name] {
				return true
			}
		}
	}

	for _, keyword := range []string{"properties", "$defs", "definitions", "patternProperties"} {
		for _, child := range fields(members[keyword]) {
			if missesRequired(child) {
				return true
			}
		}
	}
	for _, keyword := range []string{"items", "prefixItems", "anyOf", "oneOf", "allOf", "not", "if", "then", "else", "contains"} {
		if child, ok := members[keyword]; ok && missesRequired(child) {
			return true
		}
	}
	return false
}
