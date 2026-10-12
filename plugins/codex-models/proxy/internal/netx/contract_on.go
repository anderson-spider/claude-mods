//go:build contract

package netx

import (
	"crypto/tls"
	"crypto/x509"
	"os"

	"net/http"
)

// Contract build only: CCMPROXY_CONTRACT_CA_FILE names a PEM file whose
// certificates are trusted instead of the system roots (for TLS fakes).
// An unreadable or empty file panics: a contract run must not fall back.
func contractTrust(t *http.Transport) {
	path := os.Getenv("CCMPROXY_CONTRACT_CA_FILE")
	if path == "" {
		return
	}
	pem, err := os.ReadFile(path)
	if err != nil {
		panic("CCMPROXY_CONTRACT_CA_FILE: " + err.Error())
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		panic("CCMPROXY_CONTRACT_CA_FILE: no certificate in " + path)
	}
	t.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
}
