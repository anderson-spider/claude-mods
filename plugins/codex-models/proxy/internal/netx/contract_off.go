//go:build !contract

package netx

import "net/http"

// contractTrust does nothing in a normal build: the transport trusts the
// system roots and no environment variable can change that.
func contractTrust(*http.Transport) {}
