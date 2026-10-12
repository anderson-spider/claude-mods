//go:build contract && race

package contract

// raceBuild makes TestMain build the binary under test with -race.
const raceBuild = true
