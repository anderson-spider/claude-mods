package codex

import (
	"net/http"
	"reflect"
	"strconv"
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)

func fixedLimits(at time.Time) *Limits {
	l := NewLimits()
	l.now = func() time.Time { return at }
	return l
}

func headers(kv ...string) http.Header {
	h := http.Header{}
	for i := 0; i < len(kv); i += 2 {
		h.Set(kv[i], kv[i+1])
	}
	return h
}

func TestKindOfNamesWindowsByMinutes(t *testing.T) {
	for minutes, want := range map[int]string{300: "five_hour", 10080: "seven_day", 90: "window_90m", 43200: "window_43200m", 1: "window_1m"} {
		if got := KindOf(minutes); got != want {
			t.Errorf("KindOf(%d) = %q, want %q", minutes, got, want)
		}
	}
}

func TestObserveReadsBothWindows(t *testing.T) {
	l := fixedLimits(t0)
	reset5, reset7 := t0.Add(2*time.Hour).Unix(), t0.Add(72*time.Hour).Unix()
	l.Observe(headers(
		"x-codex-primary-used-percent", "36.5", "x-codex-primary-window-minutes", "300", "x-codex-primary-reset-at", itoa64(reset5),
		"x-codex-secondary-used-percent", "21", "x-codex-secondary-window-minutes", "10080", "x-codex-secondary-reset-at", itoa64(reset7),
	))
	want := []Window{
		{Kind: "five_hour", PercentUsed: 36.5, WindowMinutes: 300, ResetsAt: time.Unix(reset5, 0).UTC(), ObservedAt: t0},
		{Kind: "seven_day", PercentUsed: 21, WindowMinutes: 10080, ResetsAt: time.Unix(reset7, 0).UTC(), ObservedAt: t0},
	}
	if got := l.Snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Snapshot = %+v\nwant %+v", got, want)
	}
}

func TestObserveAnUnknownWindowIsNamedByItsMinutes(t *testing.T) {
	l := fixedLimits(t0)
	// A plan that reports only a weekly window, in the primary slot.
	l.Observe(headers("x-codex-primary-used-percent", "5", "x-codex-primary-window-minutes", "10080", "x-codex-primary-reset-at", "1790000000"))
	l.Observe(headers("x-codex-secondary-used-percent", "7", "x-codex-secondary-window-minutes", "90", "x-codex-secondary-reset-at", "1790000000"))
	got := l.Snapshot()
	if len(got) != 2 || got[0].Kind != "window_90m" || got[1].Kind != "seven_day" {
		t.Fatalf("Snapshot = %+v, want window_90m then seven_day", got)
	}
}

func TestObserveResetAfterSecondsIsAnAbsoluteTime(t *testing.T) {
	l := fixedLimits(t0)
	l.Observe(headers("x-codex-primary-used-percent", "1", "x-codex-primary-window-minutes", "300", "x-codex-primary-reset-after-seconds", "3600"))
	if got := l.Snapshot(); len(got) != 1 || !got[0].ResetsAt.Equal(t0.Add(time.Hour)) {
		t.Fatalf("Snapshot = %+v, want a reset an hour after the observation", got)
	}
	// reset-at wins when both are there.
	l = fixedLimits(t0)
	l.Observe(headers("x-codex-primary-used-percent", "1", "x-codex-primary-window-minutes", "300",
		"x-codex-primary-reset-at", "1790000000", "x-codex-primary-reset-after-seconds", "3600"))
	if got := l.Snapshot(); len(got) != 1 || got[0].ResetsAt.Unix() != 1790000000 {
		t.Fatalf("Snapshot = %+v, want reset-at to win", got)
	}
}

func TestObserveWithoutAResetKeepsTheWindow(t *testing.T) {
	l := fixedLimits(t0)
	l.Observe(headers("x-codex-primary-used-percent", "40", "x-codex-primary-window-minutes", "300"))
	if got := l.Snapshot(); len(got) != 1 || !got[0].ResetsAt.IsZero() || got[0].PercentUsed != 40 {
		t.Fatalf("Snapshot = %+v", got)
	}
}

func TestObserveClampsPercentOverAHundred(t *testing.T) {
	l := fixedLimits(t0)
	l.Observe(headers("x-codex-primary-used-percent", "104.2", "x-codex-primary-window-minutes", "300"))
	if got := l.Snapshot(); len(got) != 1 || got[0].PercentUsed != 100 {
		t.Fatalf("Snapshot = %+v, want 100", got)
	}
}

func TestObserveIgnoresWhatIsMalformed(t *testing.T) {
	good := []string{"x-codex-primary-used-percent", "10", "x-codex-primary-window-minutes", "300"}
	cases := map[string][]string{
		"no headers":             {},
		"no percent":             {"x-codex-primary-window-minutes", "300"},
		"no minutes":             {"x-codex-primary-used-percent", "10"},
		"percent NaN":            {"x-codex-primary-used-percent", "NaN", "x-codex-primary-window-minutes", "300"},
		"percent Inf":            {"x-codex-primary-used-percent", "Inf", "x-codex-primary-window-minutes", "300"},
		"percent negative":       {"x-codex-primary-used-percent", "-3", "x-codex-primary-window-minutes", "300"},
		"percent exponent":       {"x-codex-primary-used-percent", "1e2", "x-codex-primary-window-minutes", "300"},
		"percent hex":            {"x-codex-primary-used-percent", "0x10", "x-codex-primary-window-minutes", "300"},
		"percent text":           {"x-codex-primary-used-percent", "lots", "x-codex-primary-window-minutes", "300"},
		"percent two dots":       {"x-codex-primary-used-percent", "1.2.3", "x-codex-primary-window-minutes", "300"},
		"minutes zero":           {"x-codex-primary-used-percent", "10", "x-codex-primary-window-minutes", "0"},
		"minutes negative":       {"x-codex-primary-used-percent", "10", "x-codex-primary-window-minutes", "-300"},
		"minutes fractional":     {"x-codex-primary-used-percent", "10", "x-codex-primary-window-minutes", "300.5"},
		"minutes huge":           {"x-codex-primary-used-percent", "10", "x-codex-primary-window-minutes", "99999999999999999999"},
		"reset-at text":          append([]string{"x-codex-primary-reset-at", "soon"}, good...),
		"reset-at negative":      append([]string{"x-codex-primary-reset-at", "-5"}, good...),
		"reset-at out of range":  append([]string{"x-codex-primary-reset-at", "99999999999999"}, good...),
		"reset-after text":       append([]string{"x-codex-primary-reset-after-seconds", "later"}, good...),
		"reset-after negative":   append([]string{"x-codex-primary-reset-after-seconds", "-1"}, good...),
		"secondary slot is junk": {"x-codex-secondary-used-percent", "?", "x-codex-secondary-window-minutes", "10080"},
	}
	for name, kv := range cases {
		t.Run(name, func(t *testing.T) {
			l := fixedLimits(t0)
			l.Observe(headers(kv...))
			if got := l.Snapshot(); len(got) != 0 {
				t.Fatalf("Snapshot = %+v, want nothing", got)
			}
		})
	}

	t.Run("a good slot survives a bad one", func(t *testing.T) {
		l := fixedLimits(t0)
		l.Observe(headers("x-codex-primary-used-percent", "nope", "x-codex-primary-window-minutes", "300",
			"x-codex-secondary-used-percent", "20", "x-codex-secondary-window-minutes", "10080"))
		if got := l.Snapshot(); len(got) != 1 || got[0].Kind != "seven_day" {
			t.Fatalf("Snapshot = %+v", got)
		}
	})
	t.Run("a bad answer keeps the earlier reading", func(t *testing.T) {
		l := fixedLimits(t0)
		l.Observe(headers(good...))
		l.Observe(headers("x-codex-primary-used-percent", "NaN", "x-codex-primary-window-minutes", "300"))
		if got := l.Snapshot(); len(got) != 1 || got[0].PercentUsed != 10 {
			t.Fatalf("Snapshot = %+v", got)
		}
	})
	t.Run("nil header and nil store", func(t *testing.T) {
		fixedLimits(t0).Observe(nil)
		var none *Limits
		none.Observe(headers(good...))
		if got := none.Snapshot(); got == nil || len(got) != 0 {
			t.Fatalf("nil Limits Snapshot = %#v, want an empty non-nil slice", got)
		}
		if _, ok := none.Newest(); ok || !none.Stale(time.Minute) {
			t.Fatal("a nil Limits holds a reading")
		}
	})
}

func TestTheLatestReadingOfAWindowWins(t *testing.T) {
	now := t0
	l := NewLimits()
	l.now = func() time.Time { return now }
	l.Observe(headers("x-codex-primary-used-percent", "10", "x-codex-primary-window-minutes", "300"))
	now = t0.Add(time.Minute)
	l.Observe(headers("x-codex-primary-used-percent", "12", "x-codex-primary-window-minutes", "300"))
	// A reading observed earlier (a slow usage answer) does not replace it.
	l.put(Window{Kind: "five_hour", PercentUsed: 99, WindowMinutes: 300, ObservedAt: t0})
	got := l.Snapshot()
	if len(got) != 1 || got[0].PercentUsed != 12 || !got[0].ObservedAt.Equal(t0.Add(time.Minute)) {
		t.Fatalf("Snapshot = %+v, want the 12%% reading", got)
	}
}

func TestStaleAndNewest(t *testing.T) {
	now := t0
	l := NewLimits()
	l.now = func() time.Time { return now }
	if !l.Stale(5 * time.Minute) {
		t.Fatal("no reading must be stale")
	}
	l.Observe(headers("x-codex-primary-used-percent", "10", "x-codex-primary-window-minutes", "300"))
	now = t0.Add(5 * time.Minute)
	if l.Stale(5 * time.Minute) {
		t.Fatal("a reading exactly 5 minutes old is not older than 5 minutes")
	}
	now = t0.Add(5*time.Minute + time.Second)
	if !l.Stale(5 * time.Minute) {
		t.Fatal("a reading over 5 minutes old must be stale")
	}
	if newest, ok := l.Newest(); !ok || !newest.Equal(t0) {
		t.Fatalf("Newest = %v, %v", newest, ok)
	}
}

func TestApplyUsageDropsWindowsThePlanNoLongerHas(t *testing.T) {
	l := fixedLimits(t0)
	l.put(Window{Kind: "five_hour", PercentUsed: 50, WindowMinutes: 300, ObservedAt: t0.Add(-time.Hour)})
	l.put(Window{Kind: "seven_day", PercentUsed: 10, WindowMinutes: 10080, ObservedAt: t0.Add(-time.Hour)})
	// A window read after the request began is kept even if the answer
	// does not list it.
	l.put(Window{Kind: "window_90m", PercentUsed: 3, WindowMinutes: 90, ObservedAt: t0.Add(time.Second)})

	l.applyUsage([]Window{{Kind: "seven_day", PercentUsed: 11, WindowMinutes: 10080, ObservedAt: t0}}, t0)
	got := l.Snapshot()
	if len(got) != 2 || got[0].Kind != "window_90m" || got[1].Kind != "seven_day" || got[1].PercentUsed != 11 {
		t.Fatalf("Snapshot = %+v", got)
	}

	// An answer with no readable window changes nothing.
	l.applyUsage(nil, t0.Add(time.Hour))
	if len(l.Snapshot()) != 2 {
		t.Fatalf("an empty answer dropped windows: %+v", l.Snapshot())
	}
}

func TestParseUsage(t *testing.T) {
	at := t0
	cases := []struct {
		name string
		body string
		want []Window
	}{
		{"weekly only, as live", `{"plan_type":"pro","rate_limit":{"allowed":true,"primary_window":{"used_percent":12,"limit_window_seconds":604800,"reset_after_seconds":3600,"reset_at":1790000000},"secondary_window":null},"credits":{"balance":"0"}}`,
			[]Window{{Kind: "seven_day", PercentUsed: 12, WindowMinutes: 10080, ResetsAt: time.Unix(1790000000, 0).UTC(), ObservedAt: at}}},
		{"both windows, reset after seconds", `{"rate_limit":{"primary_window":{"used_percent":3.5,"limit_window_seconds":18000,"reset_after_seconds":60},"secondary_window":{"used_percent":9,"limit_window_seconds":604800,"reset_at":1790000000}}}`,
			[]Window{
				{Kind: "five_hour", PercentUsed: 3.5, WindowMinutes: 300, ResetsAt: at.Add(time.Minute), ObservedAt: at},
				{Kind: "seven_day", PercentUsed: 9, WindowMinutes: 10080, ResetsAt: time.Unix(1790000000, 0).UTC(), ObservedAt: at},
			}},
		{"windows at the top level", `{"primary_window":{"used_percent":1,"limit_window_seconds":18000}}`,
			[]Window{{Kind: "five_hour", PercentUsed: 1, WindowMinutes: 300, ObservedAt: at}}},
		{"an unusual window", `{"rate_limit":{"primary_window":{"used_percent":1,"limit_window_seconds":5400}}}`,
			[]Window{{Kind: "window_90m", PercentUsed: 1, WindowMinutes: 90, ObservedAt: at}}},
		{"percent over a hundred is clamped", `{"rate_limit":{"primary_window":{"used_percent":140,"limit_window_seconds":18000}}}`,
			[]Window{{Kind: "five_hour", PercentUsed: 100, WindowMinutes: 300, ObservedAt: at}}},
		{"additional limits are not read", `{"additional_rate_limits":[{"primary_window":{"used_percent":1,"limit_window_seconds":18000}}]}`, nil},
		{"percent as text", `{"rate_limit":{"primary_window":{"used_percent":"12","limit_window_seconds":18000}}}`, nil},
		{"seconds not a whole minute", `{"rate_limit":{"primary_window":{"used_percent":1,"limit_window_seconds":18001}}}`, nil},
		{"no length", `{"rate_limit":{"primary_window":{"used_percent":1}}}`, nil},
		{"negative percent", `{"rate_limit":{"primary_window":{"used_percent":-1,"limit_window_seconds":18000}}}`, nil},
		{"window is not an object", `{"rate_limit":{"primary_window":[1,2]}}`, nil},
		{"not json", `<html>`, nil},
		{"an array", `[1]`, nil},
		{"empty", ``, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseUsage([]byte(tc.body), at)
			for i := range got {
				got[i].ResetsAt = got[i].ResetsAt.UTC()
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("parseUsage = %+v\nwant %+v", got, tc.want)
			}
		})
	}
}

func TestUsageURLSitsBesideTheCodexEndpoint(t *testing.T) {
	for base, want := range map[string]string{
		"https://chatgpt.com/backend-api/codex":  "https://chatgpt.com/backend-api/wham/usage",
		"https://chatgpt.com/backend-api/codex/": "https://chatgpt.com/backend-api/wham/usage",
		"http://127.0.0.1:9":                     "http://127.0.0.1:9/wham/usage",
		"http://127.0.0.1:9/x/codex":             "http://127.0.0.1:9/x/wham/usage",
	} {
		if got := usageURL(base); got != want {
			t.Errorf("usageURL(%q) = %q, want %q", base, got, want)
		}
	}
}

func itoa64(n int64) string { return strconv.FormatInt(n, 10) }
