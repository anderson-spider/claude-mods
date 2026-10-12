//go:build !contract

package netx

import "net/http"

// contractTrust leaves the transport's trusted roots alone.
func contractTrust(*http.Transport) {}
