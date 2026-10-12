//go:build !contract

package main

// contractSkipsUpstreamCheck is false: the upstream is always checked.
func contractSkipsUpstreamCheck(string) bool { return false }
