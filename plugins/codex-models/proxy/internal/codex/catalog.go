package codex

// Model describes one Codex model as advertised to Claude Code.
type Model struct {
	ID             string
	DisplayName    string
	Description    string
	ContextLength  int
	ReasoningLevel []string
	DefaultEffort  string
	SupportsImages bool
	// BehavesAs names the Claude model whose client-side handling Claude
	// Code should apply to this one. It is required for a `modelPicker` row:
	// a row naming a model the installed version does not know is not
	// offered without it. The value only affects the client's own prompt
	// profile and effort defaults; the model id sent upstream is unchanged.
	// Frontier models behave as Opus, workhorses as Sonnet and the fast
	// tier as Haiku. Use full ids known to Claude Code, not aliases:
	// https://code.claude.com/docs/en/settings-reference#modelpicker
	BehavesAs string
}

// Catalog contains exactly the three crew twin models enabled on the remote.
// Effort levels and client-side BehavesAs profiles remain local; availability
// still depends on the remote's Codex account.
var Catalog = []Model{
	{
		ID:             "gpt-6.1-sol",
		DisplayName:    "GPT-6.1 Sol (Codex)",
		Description:    "Latest workhorse model for coding and everyday work.",
		ContextLength:  373000,
		ReasoningLevel: []string{"low", "medium", "high", "xhigh", "max", "ultra"},
		DefaultEffort:  "low",
		SupportsImages: true,
		BehavesAs:      "claude-sonnet-5-5",
	},
	{
		ID:             "gpt-6-astra",
		DisplayName:    "GPT-6 Astra (Codex)",
		Description:    "Frontier intelligence for the most demanding work.",
		ContextLength:  272000,
		ReasoningLevel: []string{"low", "medium", "high", "xhigh", "max", "ultra"},
		DefaultEffort:  "medium",
		SupportsImages: true,
		BehavesAs:      "claude-opus-5-5",
	},
	{
		ID:             "gpt-6-luna",
		DisplayName:    "GPT-6 Luna (Codex)",
		Description:    "Fast and affordable model for easier tasks.",
		ContextLength:  272000,
		ReasoningLevel: []string{"low", "medium", "high", "xhigh", "max"},
		DefaultEffort:  "medium",
		SupportsImages: true,
		BehavesAs:      "claude-haiku-5-5",
	},
}
