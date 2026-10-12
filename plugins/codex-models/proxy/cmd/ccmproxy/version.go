package main

import (
	"fmt"
	"io"
	"runtime"
	"runtime/debug"
)

// runVersion reports the build, which matters when a released binary is
// compared with a local one. install.sh stamps the version with
// -X main.version; the Go toolchain stamps the commit when it builds from a
// git checkout.
func runVersion(out io.Writer) error {
	info, _ := debug.ReadBuildInfo()
	printVersion(out, info)
	return nil
}

// printVersion writes the version lines from info, which may be nil. A
// contract build (go build -tags contract) says so on a line of its own, so
// one installed by mistake shows at once.
func printVersion(out io.Writer, info *debug.BuildInfo) {
	fmt.Fprintf(out, "ccmproxy %s\n", version)
	fmt.Fprintf(out, "  go       %s\n", runtime.Version())
	fmt.Fprintf(out, "  platform %s/%s\n", runtime.GOOS, runtime.GOARCH)
	if contractBuild {
		fmt.Fprintf(out, "  build    %s\n", contractBuildNote)
	}
	if info == nil {
		return
	}
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			fmt.Fprintf(out, "  revision %s\n", setting.Value)
		case "vcs.time":
			fmt.Fprintf(out, "  built    %s\n", setting.Value)
		}
	}
}
