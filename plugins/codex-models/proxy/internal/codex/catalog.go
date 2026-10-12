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
	// tier as Haiku.
	BehavesAs string
	// OptIn marks a model gated by an access program the account may not
	// have. It is neither advertised nor resolved unless codex.models names
	// it.
	OptIn bool
}

// Catalog is the set of Codex models reachable with a ChatGPT subscription,
// in the Codex CLI's own order. It mirrors the models `codex debug models`
// lists (visibility "list") for the account it was taken from (Codex CLI
// 0.162.1, October 2026): slug, description, context_window,
// supported_reasoning_levels, default_reasoning_level and input_modalities.
// Hidden entries (gpt-5.5, retiring on 2026-10-14; gpt-reserve;
// codex-auto-review) are left out. gpt-daybreak-blue-latest is listed only
// for the "daybreak_blue" access program, so it is OptIn: available only when
// codex.models names it. The ids are the slugs the ChatGPT backend
// expects verbatim in the request body; availability still depends on the
// signed-in account's plan, so a model listed here can legitimately be
// rejected upstream.
var Catalog = []Model{
	{
		ID:             "gpt-6.1-sol",
		DisplayName:    "GPT-6.1 Sol (Codex)",
		Description:    "Latest workhorse model for coding and everyday work.",
		ContextLength:  373000,
		ReasoningLevel: []string{"low", "medium", "high", "xhigh", "max", "ultra"},
		DefaultEffort:  "low",
		SupportsImages: true,
		BehavesAs:      "claude-sonnet-5",
	},
	{
		ID:             "gpt-6-astra",
		DisplayName:    "GPT-6 Astra (Codex)",
		Description:    "Frontier intelligence for the most demanding work.",
		ContextLength:  272000,
		ReasoningLevel: []string{"low", "medium", "high", "xhigh", "max", "ultra"},
		DefaultEffort:  "medium",
		SupportsImages: true,
		BehavesAs:      "claude-opus-5",
	},
	{
		ID:             "gpt-6-sol",
		DisplayName:    "GPT-6 Sol (Codex)",
		Description:    "Previous generation workhorse model.",
		ContextLength:  272000,
		ReasoningLevel: []string{"low", "medium", "high", "xhigh", "max", "ultra"},
		DefaultEffort:  "medium",
		SupportsImages: true,
		BehavesAs:      "claude-sonnet-5",
	},
	{
		ID:             "gpt-6-luna",
		DisplayName:    "GPT-6 Luna (Codex)",
		Description:    "Fast and affordable model for easier tasks.",
		ContextLength:  272000,
		ReasoningLevel: []string{"low", "medium", "high", "xhigh", "max"},
		DefaultEffort:  "medium",
		SupportsImages: true,
		BehavesAs:      "claude-haiku-4-5",
	},
	{
		ID:             "gpt-5.6-sol",
		DisplayName:    "GPT-5.6 Sol (Codex)",
		Description:    "Older generation workhorse model.",
		ContextLength:  272000,
		ReasoningLevel: []string{"low", "medium", "high", "xhigh", "max", "ultra"},
		DefaultEffort:  "low",
		SupportsImages: true,
		BehavesAs:      "claude-sonnet-5",
	},
	{
		ID:             "gpt-5.6-terra",
		DisplayName:    "GPT-5.6 Terra (Codex)",
		Description:    "Older balanced model for straightforward work.",
		ContextLength:  272000,
		ReasoningLevel: []string{"low", "medium", "high", "xhigh", "max", "ultra"},
		DefaultEffort:  "medium",
		SupportsImages: true,
		BehavesAs:      "claude-sonnet-5",
	},
	{
		ID:             "gpt-5.6-luna",
		DisplayName:    "GPT-5.6 Luna (Codex)",
		Description:    "Older fast and efficient model.",
		ContextLength:  272000,
		ReasoningLevel: []string{"low", "medium", "high", "xhigh", "max"},
		DefaultEffort:  "medium",
		SupportsImages: true,
		BehavesAs:      "claude-haiku-4-5",
	},
	{
		ID:             "gpt-daybreak-blue-latest",
		DisplayName:    "Daybreak Blue (Codex)",
		Description:    "Latest frontier agentic coding model for broad defensive cybersecurity work.",
		ContextLength:  272000,
		ReasoningLevel: []string{"low", "medium", "high", "xhigh", "max", "ultra"},
		DefaultEffort:  "low",
		SupportsImages: true,
		BehavesAs:      "claude-opus-5",
		OptIn:          true,
	},
}
