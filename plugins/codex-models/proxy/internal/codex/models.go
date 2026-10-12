package codex

import (
	"regexp"
	"sort"
	"strings"
)

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

// contextWindowSuffix matches the [1m]/[2m] context-window hint Claude Code
// accepts on a model name.
var contextWindowSuffix = regexp.MustCompile(`\[[12]m\]$`)

// efforts lists every reasoning level the Responses API accepts, longest first
// so suffix matching prefers "xhigh" over "high".
var efforts = []string{"minimal", "xhigh", "medium", "ultra", "high", "max", "low", "none"}

// Resolution is the outcome of matching a client-supplied model name against
// the Codex catalog.
type Resolution struct {
	// Model is the catalog entry that matched.
	Model Model
	// Effort is the reasoning effort requested through the model name, empty
	// when the name carried none.
	Effort string
	// Requested is the name exactly as the client sent it.
	Requested string
}

// Registry resolves client model names to Codex models. It is immutable after
// construction and safe for concurrent use.
type Registry struct {
	prefix   string
	byID     map[string]Model
	ordered  []Model
	variants bool
}

// NewRegistry builds a registry over the catalog. allow, when non-empty,
// restricts the catalog to those ids. prefix is an optional namespace clients
// may use in front of an id (for example "codex/"). variants controls whether
// per-effort model ids are advertised.
func NewRegistry(allow []string, prefix string, variants bool) *Registry {
	filter := map[string]bool{}
	for _, id := range allow {
		id = strings.ToLower(strings.TrimSpace(id))
		if id != "" {
			filter[id] = true
		}
	}

	// A prefix is always stored with its separator so callers may pass
	// either "codex" or "codex/".
	prefix = strings.ToLower(strings.TrimSpace(prefix))
	if prefix != "" {
		prefix = strings.TrimSuffix(prefix, "/") + "/"
	}

	registry := &Registry{
		prefix:   prefix,
		byID:     map[string]Model{},
		variants: variants,
	}
	for _, model := range Catalog {
		listed := filter[strings.ToLower(model.ID)]
		if len(filter) > 0 && !listed {
			continue
		}
		if model.OptIn && !listed {
			continue
		}
		registry.byID[strings.ToLower(model.ID)] = model
		registry.ordered = append(registry.ordered, model)
	}
	return registry
}

// Prefix reports the configured model namespace, if any.
func (r *Registry) Prefix() string { return r.prefix }

// Models returns the catalog entries in advertised order.
func (r *Registry) Models() []Model {
	out := make([]Model, len(r.ordered))
	copy(out, r.ordered)
	return out
}

// AdvertisedIDs lists every model id the proxy adds to the Anthropic model
// list, including per-effort variants when enabled.
func (r *Registry) AdvertisedIDs() []string {
	ids := make([]string, 0, len(r.ordered)*3)
	for _, model := range r.ordered {
		ids = append(ids, r.prefix+model.ID)
		if !r.variants {
			continue
		}
		levels := append([]string(nil), model.ReasoningLevel...)
		sort.SliceStable(levels, func(i, j int) bool {
			return effortRank(levels[i]) < effortRank(levels[j])
		})
		for _, level := range levels {
			if level == model.DefaultEffort {
				continue
			}
			ids = append(ids, r.prefix+model.ID+"-"+level)
		}
	}
	return ids
}

// effortLevels are the reasoning levels in order. "ultra" is the top level
// (Claude Code's and some Codex models'); on a model without it, it clamps to
// the model's highest level.
var effortLevels = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}

// effortRank orders a level; unknown levels rank 99.
func effortRank(level string) int {
	rank, _ := knownEffortRank(level)
	return rank
}

func knownEffortRank(level string) (int, bool) {
	for i, candidate := range effortLevels {
		if candidate == level {
			return i, true
		}
	}
	return 99, false
}

// Resolve matches name against the catalog. The second return value is false
// when the name is not a Codex model, in which case the request must be passed
// through to Anthropic untouched.
//
// Accepted spellings, all case-insensitive:
//
//	gpt-6-luna              the model at its default effort
//	gpt-6-luna-high         an effort variant
//	gpt-6-luna:high         the same, colon separated
//	codex/gpt-6-luna-high   with the configured prefix
func (r *Registry) Resolve(name string) (Resolution, bool) {
	requested := strings.TrimSpace(name)
	if requested == "" {
		return Resolution{}, false
	}
	candidate := strings.ToLower(requested)
	// Claude Code lets a user append [1m] or [2m] to ask for a larger
	// context window. The suffix is a client-side hint and is not part of
	// any upstream model id, so it is stripped before matching.
	candidate = contextWindowSuffix.ReplaceAllString(candidate, "")

	if r.prefix != "" {
		candidate = strings.TrimPrefix(candidate, r.prefix)
	} else {
		// Tolerate the conventional namespace even when unconfigured, so a
		// user who types codex/gpt-6-luna is not silently proxied upstream.
		candidate = strings.TrimPrefix(candidate, "codex/")
	}

	// An explicit separator wins over suffix guessing.
	if base, effort, ok := strings.Cut(candidate, ":"); ok {
		if model, found := r.byID[base]; found {
			return Resolution{Model: model, Effort: normalizeEffort(model, effort), Requested: requested}, true
		}
	}

	if model, found := r.byID[candidate]; found {
		return Resolution{Model: model, Requested: requested}, true
	}

	for _, effort := range efforts {
		suffix := "-" + effort
		if !strings.HasSuffix(candidate, suffix) {
			continue
		}
		base := strings.TrimSuffix(candidate, suffix)
		if model, found := r.byID[base]; found {
			return Resolution{Model: model, Effort: normalizeEffort(model, effort), Requested: requested}, true
		}
	}

	return Resolution{}, false
}

// ClampEffort keeps a requested reasoning level only when this model supports
// it, otherwise returning the closest level it does. An empty effort stays
// empty, meaning "no preference".
//
// Claude Code offers effort levels based on the model its picker row says to
// behave as, which can be a level the real model does not have.
func (m Model) ClampEffort(effort string) string {
	return normalizeEffort(m, effort)
}

// normalizeEffort keeps a requested level only when the model supports it,
// falling back to the closest supported level.
func normalizeEffort(model Model, effort string) string {
	effort = strings.ToLower(strings.TrimSpace(effort))
	if effort == "" {
		return ""
	}
	for _, level := range model.ReasoningLevel {
		if level == effort {
			return effort
		}
	}
	// A level this code does not know says nothing about how hard to
	// think, so it gets the model's default rather than a guess.
	requested, known := knownEffortRank(effort)
	if !known {
		return model.DefaultEffort
	}
	// Clamp to the closest supported level at or below the request (for
	// instance "ultra" on a model that stops at max); a request below the
	// model's lowest level ("minimal", "none") gets that lowest level.
	best, bestRank := "", -1
	lowest, lowestRank := "", 1<<30
	for _, level := range model.ReasoningLevel {
		rank := effortRank(level)
		if rank <= requested && rank > bestRank {
			best, bestRank = level, rank
		}
		if rank < lowestRank {
			lowest, lowestRank = level, rank
		}
	}
	if best != "" {
		return best
	}
	if lowest != "" {
		return lowest
	}
	return model.DefaultEffort
}

// PickerRow is one entry of the `modelPicker.options` array in Claude Code's
// settings.json. The field names and semantics are Claude Code's, not this
// proxy's.
type PickerRow struct {
	// Model is the id to send, taken verbatim; the same value --model takes.
	Model string `json:"model"`
	// Label is the row title, Description its subtitle.
	Label       string `json:"label,omitempty"`
	Description string `json:"description,omitempty"`
	// BehavesAs names a model the installed Claude Code knows, whose
	// client-side handling applies. Without it a row for an unknown model
	// is not offered at all.
	BehavesAs string `json:"behavesAs,omitempty"`
}

// PickerOptions renders one settings.json picker row per advertised model.
func (r *Registry) PickerOptions() []PickerRow {
	ids := r.AdvertisedIDs()
	rows := make([]PickerRow, 0, len(ids))
	for _, id := range ids {
		resolution, ok := r.Resolve(id)
		if !ok {
			continue
		}
		label := resolution.Model.DisplayName
		description := resolution.Model.Description
		if resolution.Effort != "" {
			// The effort is part of the id, so it belongs in the label the
			// user picks from.
			label = label + " · " + resolution.Effort
			description = strings.TrimSuffix(description, ".") + ". Reasoning effort: " + resolution.Effort + "."
		}
		rows = append(rows, PickerRow{
			Model:       id,
			Label:       label,
			Description: description,
			BehavesAs:   resolution.Model.BehavesAs,
		})
	}
	return rows
}

// Lookup returns the catalog entry for an exact id.
func (r *Registry) Lookup(id string) (Model, bool) {
	model, ok := r.byID[strings.ToLower(strings.TrimSpace(id))]
	return model, ok
}
