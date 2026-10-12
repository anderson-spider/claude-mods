package router

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/codex"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/config"
	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// maxModelList caps what is read of the upstream model list.
const maxModelList = 8 << 20

// codexModelCreatedAt is the created_at stamp reported for the added models.
// The list endpoint's schema requires the field; the value carries no meaning
// for models that are not Anthropic's.
var codexModelCreatedAt = time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC).Format(time.RFC3339)

// emptyModelList stands in for an upstream list that is missing or unusable.
const emptyModelList = `{"data":[],"has_more":false,"first_id":null,"last_id":null}`

// serveModels answers the model list with the upstream catalog plus the
// models this proxy adds.
func (r *Router) serveModels(w http.ResponseWriter, req *http.Request) {
	list, err := r.fetchUpstream(req)
	if err == nil && list.status >= 200 && list.status < 300 {
		query := req.URL.Query()
		if query.Get("after_id") != "" || query.Get("before_id") != "" {
			// A cursor means a later page; extending it would list the
			// added models twice, so it goes back as it came.
			list.writeTo(w)
			return
		}
		r.writeModelList(w, list.body)
		return
	}

	if err != nil {
		logx.Warnf("models: upstream request failed: %s", withoutQuery(err))
	} else {
		logx.Warnf("models: upstream returned %d", list.status)
	}
	// Anthropic credentials may be absent or refused while Codex is
	// perfectly usable, so the added models are still listed rather than
	// leaving the picker empty.
	if r.codexLoggedIn() {
		r.writeModelList(w, nil)
		return
	}
	if err != nil {
		writeAnthropicError(w, http.StatusBadGateway, "api_error", "model list request failed: "+err.Error())
		return
	}
	list.writeTo(w)
}

// writeModelList writes the upstream list with the added models appended.
// upstream may be nil, in which case only the added models are listed.
func (r *Router) writeModelList(w http.ResponseWriter, upstream []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(mergeModelList(upstream, r.codexModelEntries()))
}

// mergeModelList appends entries to the data array of an Anthropic model
// list and points first_id and last_id at the ends of the result. Every
// other member, and each upstream entry, is kept as written. A list that is
// not a JSON object with a data array is replaced by an empty one.
func mergeModelList(upstream []byte, entries []json.RawMessage) []byte {
	members, ok := objectMembers(upstream)
	data := memberIndex(members, "data")
	if !ok || data < 0 || kindOf(members[data].value) != '[' {
		members, _ = objectMembers([]byte(emptyModelList))
		data = memberIndex(members, "data")
	}

	var items []json.RawMessage
	if json.Unmarshal(members[data].value, &items) != nil {
		items = nil
	}
	items = append(items, entries...)
	members[data].value = joinArray(items)

	if len(items) > 0 {
		members = setMember(members, "first_id", compactJSON(lookupText(items[0], "id")))
		members = setMember(members, "last_id", compactJSON(lookupText(items[len(items)-1], "id")))
	}
	return writeObject(members)
}

// memberIndex is the index of the first member named name, or -1.
func memberIndex(members []member, name string) int {
	for i, m := range members {
		if m.name == name {
			return i
		}
	}
	return -1
}

// setMember replaces the value of the first member named name, or appends
// the member when there is none.
func setMember(members []member, name string, value json.RawMessage) []member {
	if i := memberIndex(members, name); i >= 0 {
		members[i].value = value
		return members
	}
	return append(members, member{name: name, value: value})
}

// joinArray writes items as one JSON array, each as given.
func joinArray(items []json.RawMessage) json.RawMessage {
	out := []byte{'['}
	for i, item := range items {
		if i > 0 {
			out = append(out, ',')
		}
		out = append(out, item...)
	}
	return append(out, ']')
}

// modelEntry is an added model as an Anthropic model object.
type modelEntry struct {
	Type        string `json:"type"`
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	CreatedAt   string `json:"created_at"`
}

// codexModelEntries renders the added models, in the registry's order.
func (r *Router) codexModelEntries() []json.RawMessage {
	ids := r.registry.AdvertisedIDs()
	entries := make([]json.RawMessage, 0, len(ids))
	for _, id := range ids {
		entries = append(entries, compactJSON(modelEntry{
			Type:        "model",
			ID:          id,
			DisplayName: displayNameFor(r.registry, id),
			CreatedAt:   codexModelCreatedAt,
		}))
	}
	return entries
}

// displayNameFor labels a model id, adding the reasoning effort when the id
// is an effort variant.
func displayNameFor(registry *codex.Registry, id string) string {
	resolution, ok := registry.Resolve(id)
	if !ok {
		return id
	}
	if resolution.Effort == "" {
		return resolution.Model.DisplayName
	}
	return resolution.Model.DisplayName + " · " + resolution.Effort
}

// upstreamAnswer is a buffered upstream answer.
type upstreamAnswer struct {
	status int
	header http.Header
	body   []byte
}

// writeTo passes the answer on as it came, except for the headers
// copyResponseHeader leaves out.
func (a *upstreamAnswer) writeTo(w http.ResponseWriter) {
	copyResponseHeader(w.Header(), a.header)
	w.WriteHeader(a.status)
	_, _ = w.Write(a.body)
}

// fetchUpstream sends req, as a bodyless GET, to the upstream API and
// buffers the answer, so the list can be read and extended.
func (r *Router) fetchUpstream(req *http.Request) (*upstreamAnswer, error) {
	target := r.upstream.String() + req.URL.Path
	if req.URL.RawQuery != "" {
		target += "?" + req.URL.RawQuery
	}
	outbound, err := http.NewRequestWithContext(req.Context(), http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	for name, values := range req.Header {
		// The secret is never copied out; Guard removed it already.
		if isHopByHop(name) || strings.EqualFold(name, config.TokenHeader) {
			continue
		}
		for _, value := range values {
			outbound.Header.Add(name, value)
		}
	}
	// The answer is read here, so it is asked for uncompressed.
	outbound.Header.Del("Accept-Encoding")
	outbound.Host = r.upstream.Host

	resp, err := r.client.Do(outbound)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxModelList))
	if err != nil {
		return nil, err
	}
	return &upstreamAnswer{status: resp.StatusCode, header: resp.Header, body: body}, nil
}

// withoutQuery is err's text for the log. The client's error names the
// request URL, query included, and a query never goes in the log, so the
// URL is cut at its "?".
func withoutQuery(err error) string {
	text := err.Error()
	var u *url.Error
	if errors.As(err, &u) {
		if base, _, cut := strings.Cut(u.URL, "?"); cut {
			short := &url.Error{Op: u.Op, URL: base, Err: u.Err}
			text = strings.ReplaceAll(text, u.Error(), short.Error())
		}
	}
	return text
}
