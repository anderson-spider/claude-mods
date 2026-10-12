package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/codex"
)

// TestModelRowsBehavesAsMatchesTheCatalog checks every advertised id, opt-in
// models, a prefix and effort variants included, against the catalog entry it
// resolves to, and the JSON keys a row carries.
func TestModelRowsBehavesAsMatchesTheCatalog(t *testing.T) {
	var all []string
	catalog := map[string]codex.Model{}
	for _, m := range codex.Catalog {
		all = append(all, m.ID)
		catalog[strings.ToLower(m.ID)] = m
	}
	for _, setup := range []struct {
		filter   []string
		prefix   string
		variants bool
	}{{nil, "", true}, {all, "", true}, {all, "codex", true}, {all, "codex/", false}} {
		registry := codex.NewRegistry(setup.filter, setup.prefix, setup.variants)
		rows := modelRows(registry)
		if len(rows) != len(registry.AdvertisedIDs()) {
			t.Fatalf("%+v: %d rows for %d ids", setup, len(rows), len(registry.AdvertisedIDs()))
		}
		for _, row := range rows {
			resolution, ok := registry.Resolve(row.ID)
			if !ok {
				t.Fatalf("row %q does not resolve", row.ID)
			}
			entry, ok := catalog[strings.ToLower(resolution.Model.ID)]
			if !ok || row.BehavesAs != entry.BehavesAs || !strings.HasPrefix(row.BehavesAs, "claude-") {
				t.Fatalf("row %q behavesAs %q, catalog %q", row.ID, row.BehavesAs, entry.BehavesAs)
			}
			raw, _ := json.Marshal(row)
			var keys map[string]any
			_ = json.Unmarshal(raw, &keys)
			if len(keys) != 4 || keys["id"] == nil || keys["label"] == nil || keys["description"] == nil || keys["behavesAs"] == nil {
				t.Fatalf("row keys = %v", keys)
			}
		}
	}
}

// installerRowsScript feeds `models --json` output to the installer's
// pickerRows and prints its rows, or the error, as JSON.
const installerRowsScript = `
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const [settingsPath, rowsPath] = process.argv.slice(-2)
const { pickerRows } = await import(pathToFileURL(settingsPath).href)
console.log(JSON.stringify(pickerRows(JSON.parse(readFileSync(rowsPath, 'utf8')))))
`

// TestModelsJSONFeedsTheInstallerPickerRows runs `models --json` through the
// installer's pickerRows (install/settings.mjs): every row is taken, with
// its id, label and behavesAs unchanged.
func TestModelsJSONFeedsTheInstallerPickerRows(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not on PATH")
	}
	settings, err := filepath.Abs(filepath.Join("..", "..", "..", "install", "settings.mjs"))
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	if _, err := os.Stat(settings); err != nil {
		t.Fatalf("installer module: %v", err)
	}

	dir := t.TempDir()
	out := captureStdout(t, func() error {
		return run([]string{"models", "--json", "--config", filepath.Join(dir, "absent.json")})
	})
	rowsPath := filepath.Join(dir, "rows.json")
	if err := os.WriteFile(rowsPath, []byte(out), 0o600); err != nil {
		t.Fatalf("write rows: %v", err)
	}

	cmd := exec.Command(node, "--input-type=module", "-e", installerRowsScript, settings, rowsPath)
	cmd.Dir = dir
	result, err := cmd.Output()
	if err != nil {
		t.Fatalf("node: %v", err)
	}

	var models []struct{ ID, Label, Description, BehavesAs string }
	if err := json.Unmarshal([]byte(out), &models); err != nil {
		t.Fatalf("models --json: %v", err)
	}
	var picked struct {
		Rows []struct {
			Model, Label, Description, BehavesAs string
		}
		Error string
	}
	if err := json.Unmarshal(result, &picked); err != nil {
		t.Fatalf("pickerRows output %q: %v", result, err)
	}
	if picked.Error != "" || len(picked.Rows) == 0 || len(picked.Rows) != len(models) {
		t.Fatalf("pickerRows = %s for %d models", result, len(models))
	}
	for i, row := range picked.Rows {
		m := models[i]
		if row.Model != m.ID || row.Label != m.Label || row.BehavesAs != m.BehavesAs ||
			!strings.HasPrefix(row.BehavesAs, "claude-") || !strings.HasPrefix(row.Description, m.Description) {
			t.Fatalf("row %d = %+v, from %+v", i, row, m)
		}
	}
}
