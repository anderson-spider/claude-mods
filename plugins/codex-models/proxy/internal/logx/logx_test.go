package logx

import (
	"bytes"
	"regexp"
	"strings"
	"sync"
	"testing"
)

// capture points the log at a buffer at the given level for one test.
func capture(t *testing.T, level string) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	restore := SetOutput(&buf)
	before := threshold.Load()
	SetLevel(level)
	t.Cleanup(func() {
		restore()
		threshold.Store(before)
	})
	return &buf
}

func TestLineShape(t *testing.T) {
	buf := capture(t, "debug")
	Debugf("a %d", 1)
	Infof("b %s", "two")
	Warnf("c")
	Errorf("d %v", []int{4})

	want := regexp.MustCompile(`^\d{2}:\d{2}:\d{2}\.\d{3} (DBG a 1|INF b two|WRN c|ERR d \[4\])$`)
	lines := strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n")
	if len(lines) != 4 {
		t.Fatalf("got %d lines, want 4:\n%s", len(lines), buf.String())
	}
	for _, line := range lines {
		if !want.MatchString(line) {
			t.Errorf("line %q has the wrong shape", line)
		}
	}
}

func TestLevelFiltersLines(t *testing.T) {
	buf := capture(t, " WARNING ")
	Debugf("hidden")
	Infof("hidden")
	Warnf("shown")
	Errorf("shown")
	if got := strings.Count(buf.String(), "shown"); got != 2 || strings.Contains(buf.String(), "hidden") {
		t.Fatalf("log at warn:\n%s", buf.String())
	}
	if Enabled(LevelInfo) || !Enabled(LevelWarn) || !Enabled(LevelError) {
		t.Fatal("Enabled disagrees with the warn level")
	}
}

func TestSetLevelNames(t *testing.T) {
	capture(t, "debug")
	for name, want := range map[string]Level{"info": LevelInfo, "warn": LevelWarn, "Error": LevelError, "DEBUG": LevelDebug} {
		SetLevel(name)
		if Level(threshold.Load()) != want {
			t.Errorf("SetLevel(%q) = %d, want %d", name, threshold.Load(), want)
		}
	}
	SetLevel("info")
	SetLevel("verbose")
	SetLevel("")
	if Level(threshold.Load()) != LevelInfo {
		t.Fatal("an unknown name changed the level")
	}
}

func TestSetOutputRestores(t *testing.T) {
	capture(t, "debug")
	var first, second bytes.Buffer
	restoreFirst := SetOutput(&first)
	restoreSecond := SetOutput(&second)
	Infof("to second")
	restoreSecond()
	Infof("to first")
	restoreFirst()
	if !strings.Contains(second.String(), "to second") || strings.Contains(second.String(), "to first") {
		t.Fatalf("second writer: %q", second.String())
	}
	if !strings.Contains(first.String(), "to first") || strings.Contains(first.String(), "to second") {
		t.Fatalf("first writer: %q", first.String())
	}
}

func TestConcurrentLinesStayWhole(t *testing.T) {
	buf := capture(t, "debug")
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				Infof("%s", strings.Repeat("x", 200))
			}
		}()
	}
	wg.Wait()
	whole := regexp.MustCompile(`^\S+ INF x{200}$`)
	for _, line := range strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n") {
		if !whole.MatchString(line) {
			t.Fatalf("broken line %q", line)
		}
	}
}
