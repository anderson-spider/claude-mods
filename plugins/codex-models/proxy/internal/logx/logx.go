// Package logx is a tiny leveled logger so the proxy stays dependency-free for
// something as small as printing lines.
package logx

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Level orders the supported verbosities.
type Level int32

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

var current atomic.Int32

var (
	outputMu sync.Mutex
	// output nil means os.Stderr, read at each line so a test that swaps
	// os.Stderr still sees the log.
	output io.Writer
)

// SetOutput sends log lines to w until the returned function restores the
// previous writer. Tests use it to read what was logged.
func SetOutput(w io.Writer) (restore func()) {
	outputMu.Lock()
	previous := output
	output = w
	outputMu.Unlock()
	return func() {
		outputMu.Lock()
		output = previous
		outputMu.Unlock()
	}
}

// SetLevel parses name and installs it as the active level. Unknown names
// leave the level untouched.
func SetLevel(name string) {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "debug":
		current.Store(int32(LevelDebug))
	case "info":
		current.Store(int32(LevelInfo))
	case "warn", "warning":
		current.Store(int32(LevelWarn))
	case "error":
		current.Store(int32(LevelError))
	}
}

// Enabled reports whether level would be printed.
func Enabled(level Level) bool { return int32(level) >= current.Load() }

func emit(level Level, tag, format string, args ...any) {
	if !Enabled(level) {
		return
	}
	msg := fmt.Sprintf(format, args...)
	outputMu.Lock()
	defer outputMu.Unlock()
	w := output
	if w == nil {
		w = os.Stderr
	}
	fmt.Fprintf(w, "%s %s %s\n", time.Now().Format("15:04:05.000"), tag, msg)
}

// Debugf logs at debug level.
func Debugf(format string, args ...any) { emit(LevelDebug, "DBG", format, args...) }

// Infof logs at info level.
func Infof(format string, args ...any) { emit(LevelInfo, "INF", format, args...) }

// Warnf logs at warn level.
func Warnf(format string, args ...any) { emit(LevelWarn, "WRN", format, args...) }

// Errorf logs at error level.
func Errorf(format string, args ...any) { emit(LevelError, "ERR", format, args...) }
