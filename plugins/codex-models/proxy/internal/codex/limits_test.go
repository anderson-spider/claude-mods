package codex

import (
	"reflect"
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)

func fixedLimits(at time.Time) *Limits {
	l := NewLimits()
	l.now = func() time.Time { return at }
	return l
}

func TestKindOfNamesWindowsByMinutes(t *testing.T) {
	for minutes, want := range map[int]string{300: "five_hour", 10080: "seven_day", 90: "window_90m", 43200: "window_43200m", 1: "window_1m"} {
		if got := KindOf(minutes); got != want {
			t.Errorf("KindOf(%d) = %q, want %q", minutes, got, want)
		}
	}
}

func TestTheLatestReadingOfAWindowWins(t *testing.T) {
	now := t0
	l := NewLimits()
	l.now = func() time.Time { return now }
	l.put(Window{Kind: KindFiveHour, PercentUsed: 10, WindowMinutes: 300, ObservedAt: now})
	now = t0.Add(time.Minute)
	l.put(Window{Kind: KindFiveHour, PercentUsed: 12, WindowMinutes: 300, ObservedAt: now})
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
	l.put(Window{Kind: KindFiveHour, PercentUsed: 10, WindowMinutes: 300, ObservedAt: now})
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
