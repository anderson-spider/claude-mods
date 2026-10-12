package main

import (
	"runtime"
	"runtime/debug"
	"strings"
	"testing"
)

func TestVersionPrintsTheBuildInfo(t *testing.T) {
	saved := version
	version = "9.8.7"
	t.Cleanup(func() { version = saved })

	var out strings.Builder
	printVersion(&out, &debug.BuildInfo{Settings: []debug.BuildSetting{
		{Key: "vcs", Value: "git"},
		{Key: "vcs.revision", Value: "0123abc"},
		{Key: "vcs.time", Value: "2026-10-12T00:00:00Z"},
		{Key: "vcs.modified", Value: "true"},
	}})
	want := "ccmproxy 9.8.7\n" +
		"  go       " + runtime.Version() + "\n" +
		"  platform " + runtime.GOOS + "/" + runtime.GOARCH + "\n"
	if contractBuild {
		want += "  build    " + contractBuildNote + "\n"
	}
	want += "  revision 0123abc\n" +
		"  built    2026-10-12T00:00:00Z\n"
	if out.String() != want {
		t.Fatalf("version output:\n%q\nwant:\n%q", out.String(), want)
	}

	out.Reset()
	printVersion(&out, nil)
	if strings.Contains(out.String(), "revision") || strings.Contains(out.String(), "built") {
		t.Fatalf("no build info, yet %q", out.String())
	}
}

// A lone --help, -help or -h prints the usage, as `help` does, instead of
// reaching serve's flag set as an unknown flag.
func TestHelpFlagsPrintTheUsage(t *testing.T) {
	want := captureStdout(t, func() error { return run([]string{"help"}) })
	if !strings.HasPrefix(want, "ccmproxy - add models to Claude Code") {
		t.Fatalf("help = %q", want)
	}
	for _, flag := range []string{"--help", "-help", "-h"} {
		got := captureStdout(t, func() error { return run([]string{flag}) })
		if got != want {
			t.Fatalf("%s printed %q", flag, got)
		}
	}
}
