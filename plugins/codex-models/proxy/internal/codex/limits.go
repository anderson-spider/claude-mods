package codex

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Window kinds the status endpoint names. Any other length is
// "window_<n>m".
const (
	KindFiveHour = "five_hour"
	KindSevenDay = "seven_day"
)

// Bounds on what a header or a usage field may say before it is taken for
// garbage. They only keep a malformed value from becoming a window or a
// timestamp nobody can print.
const (
	maxWindowMinutes = 527040       // 366 days
	maxResetUnix     = 253402300799 // 9999-12-31T23:59:59Z
	maxResetAfterSec = 1_000_000_000
)

// Window is one rate-limit window of the Codex plan: how much of it is used
// and when it resets.
type Window struct {
	// Kind is KindFiveHour (300 minutes), KindSevenDay (10080) or
	// "window_<n>m".
	Kind          string
	PercentUsed   float64
	WindowMinutes int
	// ResetsAt is the zero time when the backend did not say.
	ResetsAt time.Time
	// ObservedAt is when this proxy saw the reading, not when the backend
	// computed it.
	ObservedAt time.Time
}

// KindOf names a window by its length: the backend's "primary" and
// "secondary" say nothing about it (a plan may report only a weekly window,
// as primary).
func KindOf(minutes int) string {
	switch minutes {
	case 300:
		return KindFiveHour
	case 10080:
		return KindSevenDay
	default:
		return "window_" + strconv.Itoa(minutes) + "m"
	}
}

// Limits keeps the latest reading of each Codex rate-limit window, in
// memory. It fills from the headers of the answers the proxy already
// relays and from one lazy usage request; it never asks the backend by
// itself. A nil *Limits ignores every call and holds nothing.
type Limits struct {
	mu        sync.Mutex
	byMinutes map[int]Window
	now       func() time.Time
}

// NewLimits returns an empty store.
func NewLimits() *Limits {
	return &Limits{byMinutes: map[int]Window{}, now: time.Now}
}

func (l *Limits) clock() time.Time {
	if l.now != nil {
		return l.now()
	}
	return time.Now()
}

// Observe reads the primary and secondary windows of the
// x-codex-<slot>-{used-percent,window-minutes,reset-at,reset-after-seconds}
// headers of one answer. A slot with no percent or no length is skipped, and
// so is a slot with any value that is present but malformed: a reading that
// cannot be trusted is no reading. It never fails and logs nothing.
func (l *Limits) Observe(h http.Header) {
	if l == nil || h == nil {
		return
	}
	at := l.clock()
	for _, slot := range []string{"Primary", "Secondary"} {
		if w, ok := headerWindow(h, slot, at); ok {
			l.put(w)
		}
	}
}

func headerWindow(h http.Header, slot string, at time.Time) (Window, bool) {
	get := func(name string) string { return strings.TrimSpace(h.Get("X-Codex-" + slot + "-" + name)) }
	rawPercent, rawMinutes := get("Used-Percent"), get("Window-Minutes")
	if rawPercent == "" || rawMinutes == "" {
		return Window{}, false
	}
	percent, ok := parsePercent(rawPercent)
	if !ok {
		return Window{}, false
	}
	minutes, ok := parseWhole(rawMinutes, 1, maxWindowMinutes)
	if !ok {
		return Window{}, false
	}
	w := Window{Kind: KindOf(int(minutes)), PercentUsed: percent, WindowMinutes: int(minutes), ObservedAt: at}
	if raw := get("Reset-At"); raw != "" {
		sec, ok := parseWhole(raw, 1, maxResetUnix)
		if !ok {
			return Window{}, false
		}
		w.ResetsAt = time.Unix(sec, 0).UTC()
	} else if raw := get("Reset-After-Seconds"); raw != "" {
		sec, ok := parseWhole(raw, 0, maxResetAfterSec)
		if !ok {
			return Window{}, false
		}
		w.ResetsAt = at.Add(time.Duration(sec) * time.Second).UTC()
	}
	return w, true
}

// parsePercent reads a plain decimal such as "36" or "36.5", clamped to 100.
// Signs, exponents, hex, "NaN" and "Inf" are malformed.
func parsePercent(s string) (float64, bool) {
	dots := 0
	for _, c := range s {
		switch {
		case c == '.':
			dots++
		case c < '0' || c > '9':
			return 0, false
		}
	}
	if dots > 1 || strings.HasPrefix(s, ".") || strings.HasSuffix(s, ".") {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return math.Min(f, 100), true
}

// parseWhole reads a run of digits within [lo, hi].
func parseWhole(s string, lo, hi int64) (int64, bool) {
	if s == "" || strings.Trim(s, "0123456789") != "" {
		return 0, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n < lo || n > hi {
		return 0, false
	}
	return n, true
}

// put keeps w unless a newer reading of the same window is already held.
func (l *Limits) put(w Window) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.byMinutes == nil {
		l.byMinutes = map[int]Window{}
	}
	if old, ok := l.byMinutes[w.WindowMinutes]; ok && w.ObservedAt.Before(old.ObservedAt) {
		return
	}
	l.byMinutes[w.WindowMinutes] = w
}

// Snapshot returns the held readings, shortest window first. It is never
// nil.
func (l *Limits) Snapshot() []Window {
	out := []Window{}
	if l == nil {
		return out
	}
	l.mu.Lock()
	for _, w := range l.byMinutes {
		out = append(out, w)
	}
	l.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].WindowMinutes < out[j].WindowMinutes })
	return out
}

// Newest is when the most recent held reading was observed.
func (l *Limits) Newest() (time.Time, bool) {
	if l == nil {
		return time.Time{}, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	var newest time.Time
	for _, w := range l.byMinutes {
		if w.ObservedAt.After(newest) {
			newest = w.ObservedAt
		}
	}
	return newest, !newest.IsZero()
}

// Oldest is when the least recently observed held reading was observed.
func (l *Limits) Oldest() (time.Time, bool) {
	if l == nil {
		return time.Time{}, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	var oldest time.Time
	for _, w := range l.byMinutes {
		if oldest.IsZero() || w.ObservedAt.Before(oldest) {
			oldest = w.ObservedAt
		}
	}
	return oldest, !oldest.IsZero()
}

// Stale reports whether there is no reading, or any held window was observed
// more than maxAge ago. The oldest window decides, as the status's reader
// judges each window on its own: a window the answers' headers stopped
// carrying would otherwise stay as an old row beside fresh ones, and the
// usage request that drops it would never run.
func (l *Limits) Stale(maxAge time.Duration) bool {
	oldest, ok := l.Oldest()
	return !ok || l.clock().Sub(oldest) > maxAge
}

// applyUsage stores the windows of a usage answer. The answer lists every
// window the plan has now, so a held window it does not list and that was
// observed before the request began is dropped: after a plan change it would
// otherwise stay as an old reading beside the fresh ones.
func (l *Limits) applyUsage(windows []Window, requestedAt time.Time) {
	if l == nil || len(windows) == 0 {
		return
	}
	listed := map[int]bool{}
	for _, w := range windows {
		listed[w.WindowMinutes] = true
		l.put(w)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for minutes, w := range l.byMinutes {
		if !listed[minutes] && w.ObservedAt.Before(requestedAt) {
			delete(l.byMinutes, minutes)
		}
	}
}

// parseUsage reads the windows of a usage answer:
// {"rate_limit":{"primary_window":{...},"secondary_window":{...}}}, each
// window with used_percent, limit_window_seconds and reset_at (Unix seconds)
// or reset_after_seconds. It is lenient: a window it cannot read is skipped,
// a body of another shape gives none, and only the default family is read.
func parseUsage(body []byte, at time.Time) []Window {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var root map[string]any
	if dec.Decode(&root) != nil {
		return nil
	}
	holder, _ := root["rate_limit"].(map[string]any)
	if holder == nil {
		holder = root
	}
	var out []Window
	for _, key := range []string{"primary_window", "secondary_window"} {
		if raw, ok := holder[key].(map[string]any); ok {
			if w, ok := usageWindow(raw, at); ok {
				out = append(out, w)
			}
		}
	}
	return out
}

func usageWindow(raw map[string]any, at time.Time) (Window, bool) {
	percent, ok := numberOf(raw["used_percent"])
	if !ok || percent < 0 {
		return Window{}, false
	}
	seconds, ok := numberOf(raw["limit_window_seconds"])
	if !ok || seconds <= 0 || math.Mod(seconds, 60) != 0 || seconds/60 > maxWindowMinutes {
		return Window{}, false
	}
	minutes := int(seconds / 60)
	w := Window{Kind: KindOf(minutes), PercentUsed: math.Min(percent, 100), WindowMinutes: minutes, ObservedAt: at}
	if sec, ok := numberOf(raw["reset_at"]); ok && sec >= 1 && sec <= maxResetUnix && sec == math.Trunc(sec) {
		w.ResetsAt = time.Unix(int64(sec), 0).UTC()
	} else if after, ok := numberOf(raw["reset_after_seconds"]); ok && after >= 0 && after <= maxResetAfterSec {
		w.ResetsAt = at.Add(time.Duration(after) * time.Second).UTC()
	}
	return w, true
}

// numberOf reads a JSON number; a string, null or anything else is not one.
func numberOf(v any) (float64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := n.Float64()
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}
