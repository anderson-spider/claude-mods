package codex

import (
	"slices"
	"strings"
)

// effortLevels are the reasoning levels the Responses API accepts, lowest
// first. "ultra" is the top level (Claude Code's and some Codex models'); on
// a model without it, it clamps to the model's highest level.
var effortLevels = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}

// unknownEffortRank is the rank of a level not in effortLevels: above all.
const unknownEffortRank = 99

// effortRank orders a level; unknown levels rank unknownEffortRank.
func effortRank(level string) int {
	if i := slices.Index(effortLevels, level); i >= 0 {
		return i
	}
	return unknownEffortRank
}

// contextWindowHints are the suffixes Claude Code accepts on a model name to
// ask for a larger context window. They are a client-side hint and are not
// part of any upstream model id.
var contextWindowHints = []string{"[1m]", "[2m]"}

// defaultNamespace is the input spelling tolerated, so a user
// who types codex/gpt-6-luna is not silently proxied upstream.
const defaultNamespace = "codex/"

// OfferDaybreakBlue controls the unlisted model at build time, not through config.
const OfferDaybreakBlue = false

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
	byID    map[string]Model
	ordered []Model
}

// NewRegistry offers the fixed catalog, excluding the gated unlisted model.
func NewRegistry() *Registry {
	r := &Registry{byID: map[string]Model{}}
	for _, model := range Catalog {
		if model.OptIn && !OfferDaybreakBlue {
			continue
		}
		r.byID[strings.ToLower(model.ID)] = model
		r.ordered = append(r.ordered, model)
	}
	return r
}

// AdvertisedIDs lists the bare model ids in catalog order. Effort suffixes
// remain accepted on requests but are never advertised as separate rows.
func (r *Registry) AdvertisedIDs() []string {
	ids := make([]string, 0, len(r.ordered))
	for _, model := range r.ordered {
		ids = append(ids, model.ID)
	}
	return ids
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
//	codex/gpt-6-luna-high   with the tolerated input namespace
func (r *Registry) Resolve(name string) (Resolution, bool) {
	requested := strings.TrimSpace(name)
	if requested == "" {
		return Resolution{}, false
	}
	candidate := strings.ToLower(requested)
	for _, hint := range contextWindowHints {
		if trimmed, ok := strings.CutSuffix(candidate, hint); ok {
			candidate = trimmed
			break
		}
	}
	candidate = strings.TrimPrefix(candidate, defaultNamespace)
	found := func(model Model, effort string) (Resolution, bool) {
		return Resolution{Model: model, Effort: normalizeEffort(model, effort), Requested: requested}, true
	}

	// An explicit separator wins over suffix guessing.
	if base, effort, ok := strings.Cut(candidate, ":"); ok {
		if model, known := r.byID[base]; known {
			return found(model, effort)
		}
	}
	if model, known := r.byID[candidate]; known {
		return found(model, "")
	}
	for _, level := range effortLevels {
		if base, ok := strings.CutSuffix(candidate, "-"+level); ok {
			if model, known := r.byID[base]; known {
				return found(model, level)
			}
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

// normalizeEffort keeps a requested level the model supports. Otherwise it
// takes the model's highest level at or below the request ("ultra" on a
// model that stops at max is max), or its lowest when the request is below
// them all ("minimal", "none"). A level this code does not know says nothing
// about how hard to think, so it gets the model's default rather than a
// guess.
func normalizeEffort(model Model, effort string) string {
	effort = strings.ToLower(strings.TrimSpace(effort))
	if effort == "" || slices.Contains(model.ReasoningLevel, effort) {
		return effort
	}
	requested := effortRank(effort)
	if requested == unknownEffortRank {
		return model.DefaultEffort
	}
	below, lowest := "", ""
	for _, level := range model.ReasoningLevel {
		rank := effortRank(level)
		if rank <= requested && (below == "" || rank > effortRank(below)) {
			below = level
		}
		if lowest == "" || rank < effortRank(lowest) {
			lowest = level
		}
	}
	switch {
	case below != "":
		return below
	case lowest != "":
		return lowest
	default:
		return model.DefaultEffort
	}
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
	rows := make([]PickerRow, 0, len(r.ordered))
	for _, model := range r.ordered {
		rows = append(rows, PickerRow{Model: model.ID, Label: model.DisplayName, Description: model.Description, BehavesAs: model.BehavesAs})
	}
	return rows
}

// Lookup returns the catalog entry for an exact id.
func (r *Registry) Lookup(id string) (Model, bool) {
	model, ok := r.byID[strings.ToLower(strings.TrimSpace(id))]
	return model, ok
}
