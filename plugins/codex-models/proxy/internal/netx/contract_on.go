//go:build contract

package netx

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"os"
)

// contractCAFile names a PEM file whose certificates replace the system
// roots, so the contract suite can stand up TLS fakes. Contract build only.
const contractCAFile = "CCMPROXY_CONTRACT_CA_FILE"

// contractTrust makes t trust only the certificates in contractCAFile when
// it is set. A file that cannot be read or holds no certificate panics: a
// contract run must fail loudly rather than fall back to the system roots.
func contractTrust(t *http.Transport) {
	path := os.Getenv(contractCAFile)
	if path == "" {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		panic(contractCAFile + ": " + err.Error())
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(data) {
		panic(contractCAFile + ": no certificate in " + path)
	}
	t.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
}
