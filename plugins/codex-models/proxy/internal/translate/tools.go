package translate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

// nameLimit is the longest function name, and call id, the Responses API
// takes.
const nameLimit = 64

type claudeTool struct {
	Type           text            `json:"type"`
	Name           text            `json:"name"`
	Description    json.RawMessage `json:"description"`
	InputSchema    json.RawMessage `json:"input_schema"`
	AllowedDomains json.RawMessage `json:"allowed_domains"`
	UserLocation   json.RawMessage `json:"user_location"`
}

type claudeToolChoice struct {
	Type text `json:"type"`
	Name text `json:"name"`
}

type functionTool struct {
	Type        string          `json:"type"`
	Name        string          `json:"name"`
	Strict      bool            `json:"strict"`
	Description *string         `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters"`
}

type webSearchTool struct {
	Type         string           `json:"type"`
	Filters      *webSearchFilter `json:"filters,omitempty"`
	UserLocation json.RawMessage  `json:"user_location,omitempty"`
}

type webSearchFilter struct {
	AllowedDomains json.RawMessage `json:"allowed_domains"`
}

type namedFunction struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

// emptyObjectSchema stands in for a tool that declares no usable schema.
var emptyObjectSchema = json.RawMessage(`{"type":"object","properties":{}}`)

// codexTools converts the request's tools: Anthropic's server-side web search
// becomes Codex's, every named tool a function. A tool with no name is
// dropped.
func codexTools(raw json.RawMessage, shortNames map[string]string) []any {
	out := []any{}
	for _, entry := range elements(raw) {
		var tool claudeTool
		readJSON(entry, &tool)
		if strings.HasPrefix(string(tool.Type), "web_search_") {
			out = append(out, webSearch(tool))
			continue
		}
		if tool.Name == "" {
			continue
		}
		function := functionTool{
			Type:       "function",
			Name:       shortToolName(string(tool.Name), shortNames),
			Strict:     false,
			Parameters: functionParameters(tool.InputSchema),
		}
		if len(tool.Description) > 0 {
			description := textOf(tool.Description)
			function.Description = &description
		}
		out = append(out, function)
	}
	return out
}

func webSearch(tool claudeTool) webSearchTool {
	out := webSearchTool{Type: "web_search"}
	if kindOf(tool.AllowedDomains) == '[' {
		out.Filters = &webSearchFilter{AllowedDomains: tool.AllowedDomains}
	}
	if kindOf(tool.UserLocation) == '{' {
		out.UserLocation = tool.UserLocation
	}
	return out
}

// functionParameters adapts an input_schema to what the Responses API takes
// as function parameters: an object schema needs a properties map, and the
// $schema keyword is refused. Everything else in the schema stays as written,
// in its order.
func functionParameters(schema json.RawMessage) json.RawMessage {
	switch kindOf(schema) {
	case 0, 'n':
		return emptyObjectSchema
	case '[':
		// Not a schema at all; passed on for the backend to judge.
		return schema
	case '{':
	default:
		// A bare string, number or boolean says nothing usable.
		return emptyObjectSchema
	}

	members, ok := orderedMembers(schema)
	if !ok {
		return emptyObjectSchema
	}
	find := func(name string) int {
		for i, m := range members {
			if m.name == name {
				return i
			}
		}
		return -1
	}

	edited := false
	kind := ""
	if i := find("type"); i >= 0 {
		kind = textOf(members[i].value)
	}
	if kind == "" {
		kind = "object"
		if i := find("type"); i >= 0 {
			members[i].value = json.RawMessage(`"object"`)
		} else {
			members = append(members, member{name: "type", value: json.RawMessage(`"object"`)})
		}
		edited = true
	}
	if kind == "object" && find("properties") < 0 {
		members = append(members, member{name: "properties", value: json.RawMessage(`{}`)})
		edited = true
	}
	if i := find("$schema"); i >= 0 {
		members = append(members[:i], members[i+1:]...)
		edited = true
	}
	if !edited {
		return schema
	}
	return writeMembers(members)
}

// codexToolChoice maps tool_choice: any is required, none is none, a named
// tool is that function, and anything else is auto.
func codexToolChoice(raw json.RawMessage, shortNames map[string]string) any {
	var choice claudeToolChoice
	kind := ""
	switch kindOf(raw) {
	case '{':
		readJSON(raw, &choice)
		kind = string(choice.Type)
	case '"':
		kind = textOf(raw)
	}
	switch kind {
	case "any":
		return "required"
	case "none":
		return "none"
	case "tool":
		if name := shortToolName(string(choice.Name), shortNames); name != "" {
			return namedFunction{Type: "function", Name: name}
		}
	}
	return "auto"
}

// parallelToolCalls follows tool_choice.disable_parallel_tool_use; parallel
// calls are on unless the client turned them off.
func parallelToolCalls(raw json.RawMessage) bool {
	if kindOf(raw) != '{' {
		return true
	}
	disable, present := fields(raw)["disable_parallel_tool_use"]
	if !present {
		return true
	}
	return !flag(disable)
}

// Tool names.
//
// Function names longer than nameLimit are cut, and a cut that collides with
// another name gets a numeric suffix. The exact names are frozen: they are
// what Codex has seen (and cached prompts on) for every earlier request.

// toolNameMaps returns client name -> name sent and name sent -> client name
// for the request's tools.
func toolNameMaps(raw json.RawMessage) (map[string]string, map[string]string) {
	short := map[string]string{}
	original := map[string]string{}

	var names []string
	for _, entry := range elements(raw) {
		var tool claudeTool
		readJSON(entry, &tool)
		if tool.Name != "" {
			names = append(names, string(tool.Name))
		}
	}
	// Sorted, so the same tools get the same names whatever their order.
	sort.Strings(names)

	taken := map[string]bool{}
	for _, name := range names {
		candidate := cutToolName(name)
		for n := 1; taken[candidate]; n++ {
			suffix := "_" + strconv.Itoa(n)
			candidate = cutToolName(name)
			if len(candidate) > nameLimit-len(suffix) {
				candidate = candidate[:nameLimit-len(suffix)]
			}
			candidate += suffix
		}
		taken[candidate] = true
		short[name] = candidate
		original[candidate] = name
	}
	return short, original
}

// cutToolName fits one name within nameLimit. An MCP tool,
// mcp__<server>__<tool>, keeps its tool part, which says far more than the
// start of the server name.
func cutToolName(name string) string {
	if len(name) <= nameLimit {
		return name
	}
	if strings.HasPrefix(name, "mcp__") {
		if i := strings.LastIndex(name, "__"); i > 0 {
			name = "mcp__" + name[i+2:]
			if len(name) <= nameLimit {
				return name
			}
		}
	}
	return name[:nameLimit]
}

// shortToolName is the name sent for a client tool name: its mapped name, or
// a plain cut for a name the request's tools do not list.
func shortToolName(name string, shortNames map[string]string) string {
	if name == "" {
		return ""
	}
	if short, ok := shortNames[name]; ok {
		return short
	}
	return cutToolName(name)
}

// fitCallID keeps a tool_use id within the call_id limit: a longer id keeps
// its start and ends in a hash of the whole, so it stays stable and distinct.
func fitCallID(id string) string {
	if len(id) <= nameLimit {
		return id
	}
	sum := sha256.Sum256([]byte(id))
	suffix := "_" + hex.EncodeToString(sum[:8])
	return id[:nameLimit-len(suffix)] + suffix
}
