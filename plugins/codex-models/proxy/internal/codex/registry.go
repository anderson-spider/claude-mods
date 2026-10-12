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

// defaultNamespace is the prefix tolerated when none is configured, so a user
// who types codex/gpt-6-luna is not silently proxied upstream.
const defaultNamespace = "codex/"

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
	allowed := map[string]bool{}
	for _, id := range allow {
		if id = strings.ToLower(strings.TrimSpace(id)); id != "" {
			allowed[id] = true
		}
	}
	r := &Registry{prefix: namespace(prefix), byID: map[string]Model{}, variants: variants}
	for _, model := range Catalog {
		id := strings.ToLower(model.ID)
		named := allowed[id]
		// A list keeps only what it names; an opt-in model needs naming.
		if (len(allowed) > 0 || model.OptIn) && !named {
			continue
		}
		r.byID[id] = model
		r.ordered = append(r.ordered, model)
	}
	return r
}

// namespace is prefix lower-cased and ending in its separator, so "codex"
// and "codex/" are one namespace; empty stays empty.
func namespace(prefix string) string {
	prefix = strings.ToLower(strings.TrimSpace(prefix))
	if prefix == "" {
		return ""
	}
	return strings.TrimSuffix(prefix, "/") + "/"
}

// Prefix reports the configured model namespace, if any.
func (r *Registry) Prefix() string { return r.prefix }

// Models returns the catalog entries in advertised order.
func (r *Registry) Models() []Model {
	return append(make([]Model, 0, len(r.ordered)), r.ordered...)
}

// AdvertisedIDs lists every model id the proxy adds to the Anthropic model
// list, including per-effort variants when enabled: each model, then its
// other levels, lowest first.
func (r *Registry) AdvertisedIDs() []string {
	ids := make([]string, 0, len(r.ordered)*3)
	for _, model := range r.ordered {
		ids = append(ids, r.prefix+model.ID)
		if !r.variants {
			continue
		}
		levels := slices.Clone(model.ReasoningLevel)
		slices.SortStableFunc(levels, func(a, b string) int { return effortRank(a) - effortRank(b) })
		for _, level := range levels {
			if level != model.DefaultEffort {
				ids = append(ids, r.prefix+model.ID+"-"+level)
			}
		}
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
//	codex/gpt-6-luna-high   with the configured prefix
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
	if r.prefix != "" {
		candidate = strings.TrimPrefix(candidate, r.prefix)
	} else {
		candidate = strings.TrimPrefix(candidate, defaultNamespace)
	}
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
// A row for an effort variant names its effort in the label and description.
func (r *Registry) PickerOptions() []PickerRow {
	ids := r.AdvertisedIDs()
	rows := make([]PickerRow, 0, len(ids))
	for _, id := range ids {
		resolution, ok := r.Resolve(id)
		if !ok {
			continue
		}
		model := resolution.Model
		row := PickerRow{Model: id, Label: model.DisplayName, Description: model.Description, BehavesAs: model.BehavesAs}
		if effort := resolution.Effort; effort != "" {
			row.Label += " · " + effort
			row.Description = strings.TrimSuffix(row.Description, ".") + ". Reasoning effort: " + effort + "."
		}
		rows = append(rows, row)
	}
	return rows
}

// Lookup returns the catalog entry for an exact id.
func (r *Registry) Lookup(id string) (Model, bool) {
	model, ok := r.byID[strings.ToLower(strings.TrimSpace(id))]
	return model, ok
}
