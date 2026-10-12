package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/codex"
)

// runModels lists the models the proxy adds: a table by default, the picker
// rows with --json (what install.sh merges) or a settings.json block with
// --settings-json.
func runModels(args []string) error {
	var settingsJSON, rowsJSON bool
	cfg, err := loadConfig("models", args, func(fs *flag.FlagSet) {
		fs.BoolVar(&settingsJSON, "settings-json", false,
			"print a modelPicker block to merge into Claude Code's settings.json")
		fs.BoolVar(&rowsJSON, "json", false,
			`print the picker rows as [{"id","label","description","behavesAs"}]`)
	})
	if err != nil {
		return err
	}
	if settingsJSON && rowsJSON {
		return errors.New("--settings-json and --json cannot be combined")
	}
	registry := codex.NewRegistry(cfg.Codex.Models, cfg.Codex.ModelPrefix, cfg.Codex.EffortVariants)

	switch {
	case settingsJSON:
		return printSettingsJSON(os.Stdout, os.Stderr, registry)
	case rowsJSON:
		return printJSON(os.Stdout, modelRows(registry))
	}
	printModelTable(os.Stdout, registry)
	return nil
}

// printModelTable writes one line per advertised id: the real model behind
// it, its context length, its effort (the model's default when the id names
// none) and the Claude model it behaves as.
func printModelTable(out io.Writer, registry *codex.Registry) {
	for _, row := range registry.PickerOptions() {
		resolved, ok := registry.Resolve(row.Model)
		if !ok {
			continue
		}
		effort := resolved.Effort
		if effort == "" {
			effort = resolved.Model.DefaultEffort + " (default)"
		}
		fmt.Fprintf(out, "%-28s %-24s context %7d  effort %-16s behaves as %s\n",
			row.Model, resolved.Model.ID, resolved.Model.ContextLength, effort, row.BehavesAs)
	}
}

// modelRow is one row of `ccmproxy models --json`: the id to put in a picker
// row or an agent's `model`, its label and description, and the Claude model
// it behaves as, which a picker row for a model Claude Code does not know
// needs. The installer reads exactly these four keys.
type modelRow struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
	BehavesAs   string `json:"behavesAs"`
}

func modelRows(registry *codex.Registry) []modelRow {
	options := registry.PickerOptions()
	rows := make([]modelRow, len(options))
	for i, option := range options {
		rows[i] = modelRow{ID: option.Model, Label: option.Label, Description: option.Description, BehavesAs: option.BehavesAs}
	}
	return rows
}

// settingsHint follows the --settings-json block on standard error, so the
// block itself can be redirected to a file. %[1]s is the settings path.
const settingsHint = `
# Merge the block above into %[1]s, for example:
#   ccmproxy models --settings-json > /tmp/picker.json
#   jq -s '.[0] * .[1]' %[1]s /tmp/picker.json > /tmp/merged.json
#   mv /tmp/merged.json %[1]s
# Restart Claude Code, then open /model.
# Reasoning effort is Claude Code's own control: /effort or --effort.
`

// printSettingsJSON writes the settings.json fragment that puts the added
// models in Claude Code's /model picker, and how to merge it.
//
// Claude Code builds the picker from its own catalog plus
// `modelPicker.options`, never from /v1/models, so this half of the
// integration needs nothing from a running proxy.
func printSettingsJSON(out, hint io.Writer, registry *codex.Registry) error {
	block := map[string]any{
		"modelPicker": map[string]any{"options": registry.PickerOptions()},
	}
	if err := printJSON(out, block); err != nil {
		return err
	}
	fmt.Fprintf(hint, settingsHint, "~/.claude/settings.json")
	return nil
}

// printJSON writes value as two-space indented JSON with <, > and & as they
// are.
func printJSON(out io.Writer, value any) error {
	encoder := json.NewEncoder(out)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return fmt.Errorf("encode JSON: %w", err)
	}
	return nil
}
