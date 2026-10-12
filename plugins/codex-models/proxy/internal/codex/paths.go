package codex

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// codexCLIFileName is the credential file the Codex CLI writes.
const codexCLIFileName = "auth.json"

// maxLinkHops bounds how many dangling links resolvePath follows by hand.
const maxLinkHops = 16

// CodexCLIHome reports the Codex CLI's configuration directory, honouring the
// CODEX_HOME override the CLI itself uses.
func CodexCLIHome() string {
	if dir := strings.TrimSpace(os.Getenv("CODEX_HOME")); dir != "" {
		return dir
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".codex")
}

// CodexCLIAuthPath reports the Codex CLI credential file, or "" when the home
// directory cannot be determined.
func CodexCLIAuthPath() string {
	if home := CodexCLIHome(); home != "" {
		return filepath.Join(home, codexCLIFileName)
	}
	return ""
}

// refersToCodexCLI reports whether path is, or leads to, the Codex CLI's
// credential file, which this proxy never writes or removes.
func refersToCodexCLI(path string) bool {
	cli := CodexCLIAuthPath()
	return strings.TrimSpace(path) != "" && cli != "" && sameFile(path, cli)
}

// insideCodexHome reports whether dir is the Codex CLI's directory or lies
// inside it, after symlinks (a dangling one included), `..` and, on macOS,
// case.
func insideCodexHome(dir string) bool {
	home := CodexCLIHome()
	if strings.TrimSpace(dir) == "" || home == "" {
		return false
	}
	for current := resolvePath(dir, 0); ; current = filepath.Dir(current) {
		if sameFile(current, home) {
			return true
		}
		if filepath.Dir(current) == current {
			return false
		}
	}
}

// sameFile reports whether a and b name one file, after symlinks and `..`.
// When either does not exist yet, the same name in the same directory counts,
// case-insensitively on macOS, whose default volume ignores case.
func sameFile(a, b string) bool {
	ra, rb := resolvePath(a, 0), resolvePath(b, 0)
	if ra == rb {
		return true
	}
	infoA, errA := os.Stat(ra)
	infoB, errB := os.Stat(rb)
	if errA == nil && errB == nil {
		return os.SameFile(infoA, infoB)
	}
	dirA, errA := os.Stat(filepath.Dir(ra))
	dirB, errB := os.Stat(filepath.Dir(rb))
	if errA != nil || errB != nil || !os.SameFile(dirA, dirB) {
		return false
	}
	if runtime.GOOS == "darwin" {
		return strings.EqualFold(filepath.Base(ra), filepath.Base(rb))
	}
	return filepath.Base(ra) == filepath.Base(rb)
}

// resolvePath follows path's symlinks to an absolute path. Where
// filepath.EvalSymlinks gives up (the last link dangles), the links are
// followed by hand, hops counting how many so far, and what is left is joined
// to its resolved directory; what cannot be resolved at all is cleaned as
// written.
func resolvePath(path string, hops int) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		if abs, err := filepath.Abs(resolved); err == nil {
			return abs
		}
		return resolved
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	if hops < maxLinkHops {
		if target, ok := readLink(abs); ok {
			if !filepath.IsAbs(target) {
				target = filepath.Join(filepath.Dir(abs), target)
			}
			return resolvePath(target, hops+1)
		}
	}
	if dir, err := filepath.EvalSymlinks(filepath.Dir(abs)); err == nil {
		return filepath.Join(dir, filepath.Base(abs))
	}
	return abs
}

// readLink returns the target of path when path itself is a symlink.
func readLink(path string) (string, bool) {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return "", false
	}
	target, err := os.Readlink(path)
	return target, err == nil
}

// writeTarget is the file a write to path replaces: a symlink's target when
// it resolves; for a file not there yet (or a dangling link, which the write
// replaces), path with its directory resolved, so it names what a later
// store resolves once the file exists. Always absolute.
func writeTarget(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	} else if dir, err := filepath.EvalSymlinks(filepath.Dir(path)); err == nil {
		path = filepath.Join(dir, filepath.Base(path))
	}
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return filepath.Clean(path)
}
