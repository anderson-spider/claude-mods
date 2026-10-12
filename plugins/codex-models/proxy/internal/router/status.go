package router

import (
	"net/http"
)

// statusPath answers whether this proxy is the one reached, which build it
// is, and whether Codex is usable. The installer and the plugin's hooks read
// it.
const statusPath = adminPrefix + "status"

// Status is the body of GET /__ccmproxy/status. It names the service so a
// caller knows it reached this proxy, and carries no paths, emails or tokens.
type Status struct {
	Service    string   `json:"service"`
	Version    string   `json:"version"`
	CodexLogin bool     `json:"codexLogin"`
	Models     []string `json:"models"`
}

func (r *Router) serveAdmin(w http.ResponseWriter, req *http.Request) {
	if req.URL.Path != statusPath {
		http.NotFound(w, req)
		return
	}
	if req.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeAnthropicError(w, http.StatusMethodNotAllowed, "invalid_request_error", "ccmproxy: status is GET only")
		return
	}
	writeJSON(w, http.StatusOK, r.status())
}

func (r *Router) status() Status {
	version := r.Version
	if version == "" {
		version = "dev"
	}
	models := r.registry.AdvertisedIDs()
	if models == nil {
		models = []string{}
	}
	return Status{
		Service:    "ccmproxy",
		Version:    version,
		CodexLogin: r.codexLoggedIn(),
		Models:     models,
	}
}

// codexLoggedIn reports whether a Codex login is stored.
func (r *Router) codexLoggedIn() bool {
	return r.backend != nil && r.backend.Store.Authenticated()
}
