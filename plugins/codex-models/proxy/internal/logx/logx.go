// Package logx writes the proxy's log: one timestamped line per call, tagged
// with its level, on standard error unless a test points it elsewhere.
//
// Nothing here decides what is safe to log. Callers pass only method, path,
// status, sizes, durations and identifiers; a prompt, a token or a query
// string never reaches a format argument.
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

// Level is a verbosity. A line is written when its level is at or above the
// threshold set with SetLevel.
type Level int32

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

// tags are the three letters each line carries after its timestamp.
var tags = [...]string{LevelDebug: "DBG", LevelInfo: "INF", LevelWarn: "WRN", LevelError: "ERR"}

// byName maps the config's log_level values to levels.
var byName = map[string]Level{
	"debug":   LevelDebug,
	"info":    LevelInfo,
	"warn":    LevelWarn,
	"warning": LevelWarn,
	"error":   LevelError,
}

// threshold starts at LevelDebug (its zero value): everything is written
// until the config's level is applied.
var threshold atomic.Int32

// sink is where lines go. A nil writer means os.Stderr, looked up for every
// line so a test that replaces os.Stderr still captures the log. The lock
// keeps lines whole when several goroutines log at once.
var sink struct {
	sync.Mutex
	w io.Writer
}

// SetLevel applies a log_level name (case and surrounding space ignored).
// A name it does not know leaves the current level as it is.
func SetLevel(name string) {
	if level, ok := byName[strings.ToLower(strings.TrimSpace(name))]; ok {
		threshold.Store(int32(level))
	}
}

// Enabled reports whether a line at level would be written. Callers use it
// to skip building an expensive debug line.
func Enabled(level Level) bool { return int32(level) >= threshold.Load() }

// SetOutput sends every line to w until restore is called, which puts back
// the writer that was there before. Tests use it to read the log.
func SetOutput(w io.Writer) (restore func()) {
	sink.Lock()
	before := sink.w
	sink.w = w
	sink.Unlock()
	return func() {
		sink.Lock()
		sink.w = before
		sink.Unlock()
	}
}

// Debugf writes a debug line.
func Debugf(format string, args ...any) { write(LevelDebug, format, args...) }

// Infof writes an info line.
func Infof(format string, args ...any) { write(LevelInfo, format, args...) }

// Warnf writes a warning line.
func Warnf(format string, args ...any) { write(LevelWarn, format, args...) }

// Errorf writes an error line.
func Errorf(format string, args ...any) { write(LevelError, format, args...) }

// write formats the line in full first, then hands it to the writer in a
// single Write under the lock.
//
// args stays variadic and is passed on with args...: that is how go vet's
// printf check sees write, and through it the four functions above, as
// printf wrappers, so a wrong verb or a missing argument at any call site is
// flagged. A []any parameter would hide every log format string from vet.
func write(level Level, format string, args ...any) {
	if !Enabled(level) {
		return
	}
	var line strings.Builder
	line.WriteString(time.Now().Format("15:04:05.000"))
	line.WriteByte(' ')
	line.WriteString(tags[level])
	line.WriteByte(' ')
	fmt.Fprintf(&line, format, args...)
	line.WriteByte('\n')

	sink.Lock()
	defer sink.Unlock()
	w := sink.w
	if w == nil {
		w = os.Stderr
	}
	_, _ = io.WriteString(w, line.String())
}
