//go:build contract

package netx

import (
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestContractCAFileIsTheTrustedRoot(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer srv.Close()

	get := func() error {
		tr := DirectTransport()
		defer tr.CloseIdleConnections()
		resp, err := (&http.Client{Transport: tr}).Get(srv.URL)
		if err == nil {
			resp.Body.Close()
		}
		return err
	}
	if get() == nil {
		t.Fatal("the fake's certificate was trusted without the variable")
	}
	path := filepath.Join(t.TempDir(), "ca.pem")
	block := &pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CCMPROXY_CONTRACT_CA_FILE", path)
	if err := get(); err != nil {
		t.Fatalf("with the variable: %v", err)
	}
}
