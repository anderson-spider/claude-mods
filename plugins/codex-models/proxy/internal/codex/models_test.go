package codex

import (
	"strings"
	"testing"
)

func TestResolveBareModel(t *testing.T) {
	registry := NewRegistry()

	resolution, ok := registry.Resolve("gpt-6-luna")
	if !ok {
		t.Fatal("gpt-6-luna was not recognised as a Codex model")
	}
	if resolution.Model.ID != "gpt-6-luna" {
		t.Fatalf("model = %q, want gpt-6-luna", resolution.Model.ID)
	}
	if resolution.Effort != "" {
		t.Fatalf("effort = %q, want empty for a bare model name", resolution.Effort)
	}
	if resolution.Requested != "gpt-6-luna" {
		t.Fatalf("requested = %q, want the name as sent", resolution.Requested)
	}
}

func TestResolveEffortSpellings(t *testing.T) {
	registry := NewRegistry()

	for _, name := range []string{"gpt-6-luna-high", "gpt-6-luna:high", "codex/gpt-6-luna-high", "GPT-6-Luna-High"} {
		resolution, ok := registry.Resolve(name)
		if !ok {
			t.Fatalf("%q was not recognised", name)
		}
		if resolution.Model.ID != "gpt-6-luna" || resolution.Effort != "high" {
			t.Fatalf("%q resolved to %q effort %q, want gpt-6-luna/high", name, resolution.Model.ID, resolution.Effort)
		}
	}
}

func TestResolvePrefersLongerEffortSuffix(t *testing.T) {
	registry := NewRegistry()

	resolution, ok := registry.Resolve("gpt-6-luna-xhigh")
	if !ok {
		t.Fatal("gpt-6-luna-xhigh was not recognised")
	}
	if resolution.Effort != "xhigh" {
		t.Fatalf("effort = %q, want xhigh (not a partial match on high)", resolution.Effort)
	}
}

func TestResolveClampsUnsupportedEffort(t *testing.T) {
	registry := NewRegistry()

	// gpt-6-luna stops at max, so "ultra" must clamp rather than be forwarded.
	resolution, ok := registry.Resolve("gpt-6-luna-ultra")
	if !ok {
		t.Fatal("gpt-6-luna-ultra was not recognised")
	}
	if resolution.Effort != "max" {
		t.Fatalf("effort = %q, want it clamped to max", resolution.Effort)
	}

	// gpt-6-astra supports max, so it passes through.
	resolution, ok = registry.Resolve("gpt-6-astra-max")
	if !ok {
		t.Fatal("gpt-6-astra-max was not recognised")
	}
	if resolution.Effort != "max" {
		t.Fatalf("effort = %q, want max", resolution.Effort)
	}
}

func TestResolveIgnoresClaudeModels(t *testing.T) {
	registry := NewRegistry()

	for _, name := range []string{"claude-opus-5", "claude-sonnet-5", "", "gpt-4o"} {
		if _, ok := registry.Resolve(name); ok {
			t.Fatalf("%q must not be treated as a Codex model", name)
		}
	}
}

func TestCatalogBehavesAsPreservesTiersWithKnownFullIDs(t *testing.T) {
	want := map[string]string{
		"gpt-6.1-sol":              "claude-sonnet-5-5",
		"gpt-6-astra":              "claude-opus-5-5",
		"gpt-6-sol":                "claude-sonnet-5-5",
		"gpt-6-luna":               "claude-haiku-5-5",
		"gpt-5.6-sol":              "claude-sonnet-5-5",
		"gpt-5.6-terra":            "claude-sonnet-5-5",
		"gpt-5.6-luna":             "claude-haiku-5-5",
		"gpt-daybreak-blue-latest": "claude-opus-5-5",
	}
	if len(Catalog) != len(want) {
		t.Fatalf("catalog has %d models, want %d", len(Catalog), len(want))
	}
	for _, model := range Catalog {
		if model.BehavesAs != want[model.ID] {
			t.Errorf("%s behaves as %q, want %q", model.ID, model.BehavesAs, want[model.ID])
		}
	}
}

func TestEveryCatalogEntryCanBeOfferedToClaudeCode(t *testing.T) {
	for _, model := range Catalog {
		// Without behavesAs, Claude Code does not offer a picker row for a
		// model its own catalog does not know, so the field is mandatory.
		if model.BehavesAs == "" {
			t.Errorf("%s has no BehavesAs; its picker row would not be offered", model.ID)
		}
		if !strings.HasPrefix(model.BehavesAs, "claude-") {
			t.Errorf("%s behaves as %q, which is not a Claude model id", model.ID, model.BehavesAs)
		}
		// A picker row needs a non-empty description.
		if strings.TrimSpace(model.Description) == "" {
			t.Errorf("%s has no Description", model.ID)
		}
		if strings.TrimSpace(model.DisplayName) == "" {
			t.Errorf("%s has no DisplayName", model.ID)
		}
	}
}

func TestPickerOptionsCoverEveryAdvertisedModel(t *testing.T) {
	registry := NewRegistry()

	ids := registry.AdvertisedIDs()
	rows := registry.PickerOptions()
	if len(rows) != len(ids) {
		t.Fatalf("%d picker rows for %d advertised models", len(rows), len(ids))
	}

	for i, row := range rows {
		if row.Model != ids[i] {
			t.Fatalf("row %d is %q, want %q: the order must match", i, row.Model, ids[i])
		}
		if row.Label == "" || row.Description == "" || row.BehavesAs == "" {
			t.Fatalf("row %q has an empty field: %+v", row.Model, row)
		}
	}
}

func TestPickerOptionLabelsAreDistinct(t *testing.T) {
	registry := NewRegistry()

	seen := map[string]string{}
	for _, row := range registry.PickerOptions() {
		// Two rows with the same title are indistinguishable in the picker.
		if other, clash := seen[row.Label]; clash {
			t.Fatalf("%q and %q share the label %q", other, row.Model, row.Label)
		}
		seen[row.Label] = row.Model
	}
}

func TestResolveStripsTheContextWindowSuffix(t *testing.T) {
	registry := NewRegistry()

	// Claude Code appends [1m]/[2m] to ask for a larger context window; the
	// suffix is a client-side hint and no upstream model id carries it.
	for _, name := range []string{"gpt-6-luna[1m]", "gpt-6-luna-high[1m]", "gpt-5.6-sol[2m]"} {
		resolution, ok := registry.Resolve(name)
		if !ok {
			t.Fatalf("%q was not recognised", name)
		}
		if strings.Contains(resolution.Model.ID, "[") {
			t.Fatalf("%q resolved to model id %q, want the suffix stripped", name, resolution.Model.ID)
		}
		if resolution.Requested != name {
			t.Fatalf("requested = %q, want the name as sent", resolution.Requested)
		}
	}

	if resolution, _ := registry.Resolve("gpt-6-luna-high[1m]"); resolution.Effort != "high" {
		t.Fatalf("effort = %q, want high", resolution.Effort)
	}
	// A bracket that is not the window hint must not be silently accepted.
	if _, ok := registry.Resolve("gpt-6-luna[9m]"); ok {
		t.Fatal("gpt-6-luna[9m] must not resolve")
	}
}

func TestClampEffort(t *testing.T) {
	luna, ok := NewRegistry().Lookup("gpt-6-luna")
	if !ok {
		t.Fatal("gpt-6-luna is not in the catalog")
	}
	astra, ok := NewRegistry().Lookup("gpt-6-astra")
	if !ok {
		t.Fatal("gpt-6-astra is not in the catalog")
	}

	cases := []struct {
		model  Model
		effort string
		want   string
	}{
		{luna, "", ""}, // no preference stays no preference
		{luna, "low", "low"},
		{luna, "xhigh", "xhigh"},
		{luna, "max", "max"},
		{luna, "ultra", "max"}, // gpt-6-luna stops at max
		{astra, "max", "max"},
		{astra, "ultra", "ultra"},
		{astra, "HIGH", "high"},
	}
	for _, c := range cases {
		if got := c.model.ClampEffort(c.effort); got != c.want {
			t.Fatalf("%s.ClampEffort(%q) = %q, want %q", c.model.ID, c.effort, got, c.want)
		}
	}
}

// TestCatalogMatchesTheCodexListing pins the catalog to what `codex debug
// models` listed (visibility "list") when it was last taken. A change here is
// a catalog update, made on purpose.
func TestCatalogMatchesTheCodexListing(t *testing.T) {
	want := []struct {
		id, effort string
		levels     string
		context    int
	}{
		{"gpt-6.1-sol", "low", "low,medium,high,xhigh,max,ultra", 373000},
		{"gpt-6-astra", "medium", "low,medium,high,xhigh,max,ultra", 272000},
		{"gpt-6-sol", "medium", "low,medium,high,xhigh,max,ultra", 272000},
		{"gpt-6-luna", "medium", "low,medium,high,xhigh,max", 272000},
		{"gpt-5.6-sol", "low", "low,medium,high,xhigh,max,ultra", 272000},
		{"gpt-5.6-terra", "medium", "low,medium,high,xhigh,max,ultra", 272000},
		{"gpt-5.6-luna", "medium", "low,medium,high,xhigh,max", 272000},
		{"gpt-daybreak-blue-latest", "low", "low,medium,high,xhigh,max,ultra", 272000},
	}
	optIn := map[string]bool{"gpt-daybreak-blue-latest": true}
	if len(Catalog) != len(want) {
		t.Fatalf("catalog has %d models, want %d", len(Catalog), len(want))
	}
	for i, w := range want {
		m := Catalog[i]
		if m.ID != w.id || m.DefaultEffort != w.effort || strings.Join(m.ReasoningLevel, ",") != w.levels || m.ContextLength != w.context || !m.SupportsImages {
			t.Fatalf("catalog[%d] = %+v, want %+v", i, m, w)
		}
		if m.OptIn != optIn[m.ID] {
			t.Fatalf("%s OptIn = %v", m.ID, m.OptIn)
		}
		if effortRank(m.DefaultEffort) == 99 {
			t.Fatalf("%s default effort %q is not a known level", m.ID, m.DefaultEffort)
		}
	}
	for _, retired := range []string{"gpt-5.5", "gpt-5.3-codex-spark", "gpt-reserve", "codex-auto-review"} {
		if _, ok := NewRegistry().Resolve(retired); ok {
			t.Fatalf("%s is still in the catalog", retired)
		}
	}
}

func TestFixedCatalogDoesNotAdvertiseVariantsOrDaybreak(t *testing.T) {
	r := NewRegistry()
	if len(r.AdvertisedIDs()) != len(Catalog)-1 {
		t.Fatal("unexpected advertised catalog")
	}
	for _, id := range r.AdvertisedIDs() {
		if strings.Contains(id, "daybreak") || strings.Contains(id, "/") {
			t.Fatalf("unexpected id: %s", id)
		}
		resolved, ok := r.Resolve(id)
		if !ok || resolved.Effort != "" {
			t.Fatalf("advertised variant: %s", id)
		}
	}
	if _, ok := r.Resolve("gpt-daybreak-blue-latest"); ok {
		t.Fatal("unlisted model enabled")
	}
	if resolved, ok := r.Resolve("gpt-6-luna:high"); !ok || resolved.Effort != "high" {
		t.Fatal("effort suffix lost")
	}
}
