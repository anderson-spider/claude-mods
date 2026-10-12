package router

import (
	"context"
	"net/http"
	"slices"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/codex"
)

// refreshParamLimits is the value of the status request's refresh parameter that
// asks for fresh Codex limits.
const refreshParamLimits = "limits"

const (
	// limitsMaxAge is how old the newest Codex rate-limit reading may be
	// before a status request asks the usage endpoint.
	limitsMaxAge = 5 * time.Minute
	// defaultUsageWait is how long a status request waits for that usage
	// request. It is under a caller's own deadline (the crew plugin gives
	// the status 1.5 s); the request goes on after it and the next status
	// reads its result.
	defaultUsageWait = time.Second
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
	// CodexLimits is the latest reading of each Codex rate-limit window,
	// shortest first. It is always present, [] when nothing has been read.
	CodexLimits []Limit `json:"codexLimits"`
}

// Limit is one rate-limit window of the Codex plan. Times are RFC 3339 in
// UTC; ResetsAt is left out when the backend did not say.
type Limit struct {
	// Kind is "five_hour" (300 minutes), "seven_day" (10080) or
	// "window_<n>m".
	Kind          string  `json:"kind"`
	PercentUsed   float64 `json:"percentUsed"`
	ResetsAt      string  `json:"resetsAt,omitempty"`
	WindowMinutes int     `json:"windowMinutes"`
	ObservedAt    string  `json:"observedAt"`
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
	// Only a request that asks for it (?refresh=limits) may start, or wait
	// for, the usage request to OpenAI: the installer, the session-start
	// probe and /codex-models:status send a plain status and cost nothing
	// beyond the proxy. Any other value is ignored.
	refresh := slices.Contains(req.URL.Query()["refresh"], refreshParamLimits)
	writeJSON(w, http.StatusOK, r.status(req.Context(), refresh))
}

func (r *Router) status(ctx context.Context, refresh bool) Status {
	if refresh {
		r.refreshLimits(ctx)
	}
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

		CodexLimits: r.codexLimits(),
	}
}

// refreshLimits lets a status request ask the Codex usage endpoint when the
// readings are absent or old (see codex.Backend.RefreshLimits). It waits for
// the answer for at most usageWait and never reports a failure: the status
// is built from whatever is held afterwards.
func (r *Router) refreshLimits(ctx context.Context) {
	if r.backend == nil {
		return
	}
	done := r.backend.RefreshLimits(limitsMaxAge)
	if done == nil {
		return
	}
	timer := time.NewTimer(r.usageWait)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
	case <-ctx.Done():
	}
}

func (r *Router) codexLimits() []Limit {
	out := []Limit{}
	if r.backend == nil {
		return out
	}
	for _, w := range r.backend.Limits.Snapshot() {
		out = append(out, limitOf(w))
	}
	return out
}

func limitOf(w codex.Window) Limit {
	l := Limit{
		Kind:          w.Kind,
		PercentUsed:   w.PercentUsed,
		WindowMinutes: w.WindowMinutes,
		ObservedAt:    w.ObservedAt.UTC().Format(time.RFC3339),
	}
	if !w.ResetsAt.IsZero() {
		l.ResetsAt = w.ResetsAt.UTC().Format(time.RFC3339)
	}
	return l
}

// codexLoggedIn reports whether a Codex login is stored.
func (r *Router) codexLoggedIn() bool {
	return r.backend != nil && r.backend.Store.Authenticated()
}
