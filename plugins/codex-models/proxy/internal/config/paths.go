package config

import (
	"os"
	"path/filepath"
	"strings"
)

// Root is the directory that holds config.json and, by default, the login:
// $CCMPROXY_HOME when set, else $XDG_CONFIG_HOME/ccmproxy, else
// ~/.config/ccmproxy, and ".ccmproxy" when there is no home at all. A leading
// "~" in either variable is expanded.
func Root() string {
	if dir := strings.TrimSpace(os.Getenv("CCMPROXY_HOME")); dir != "" {
		return ExpandUser(dir)
	}
	if dir := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); dir != "" {
		return filepath.Join(ExpandUser(dir), "ccmproxy")
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".config", "ccmproxy")
	}
	return ".ccmproxy"
}

// DefaultPath is the config file used when no --config is given.
func DefaultPath() string { return filepath.Join(Root(), "config.json") }

// ExpandUser trims path and replaces a leading "~" or "~/" with the current
// user's home directory.
//
// Only a shell expands "~", and paths from config.json, an environment
// variable or a quoted --config never pass through one: used as written,
// "~/x" is a relative path that creates a directory named "~" wherever the
// proxy runs. "~name/x" stays as written (another user's home needs the
// password database), and so does every path when the home is unknown.
func ExpandUser(path string) string {
	path = strings.TrimSpace(path)
	rest, tilde := strings.CutPrefix(path, "~")
	if !tilde || (rest != "" && rest[0] != '/' && rest[0] != filepath.Separator) {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return path
	}
	if rest == "" {
		return home
	}
	return filepath.Join(home, rest)
}
