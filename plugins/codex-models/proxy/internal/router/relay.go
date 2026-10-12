package router

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

// scanFrames emits only complete SSE events; partial bytes never reach the
// writer, so a keepalive cannot split a JSON payload. CRLF is accepted too.
func scanFrames(upstream io.Reader, onFrame func([]byte) bool) error {
	reader := bufio.NewReaderSize(upstream, 64<<10)
	var frame []byte
	for {
		line, err := readSSELine(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		line = bytes.TrimSuffix(line, []byte("\r"))
		if len(frame)+len(line)+1 > sseReadLimit {
			return errors.New("sse: event exceeds limit")
		}
		frame = append(frame, line...)
		frame = append(frame, '\n')
		if len(line) == 0 {
			if !onFrame(frame) {
				return nil
			}
			frame = nil
		}
	}
}

func relayFrame(frame []byte) ([]byte, string, error) {
	var payload []byte
	var event string
	lines := bytes.Split(bytes.TrimSuffix(frame, []byte("\n\n")), []byte("\n"))
	for _, line := range lines {
		if value, ok := bytes.CutPrefix(line, []byte("event:")); ok {
			event = strings.TrimSpace(string(value))
		}
		if value, ok := bytes.CutPrefix(line, []byte("data:")); ok {
			if len(payload) > 0 {
				payload = append(payload, '\n')
			}
			payload = append(payload, bytes.TrimPrefix(value, []byte(" "))...)
		}
	}
	if len(payload) == 0 {
		return frame, "", nil
	} // comments/keepalives carry no protocol state
	if bytes.Equal(bytes.TrimSpace(payload), []byte("[DONE]")) {
		return nil, "", nil
	}
	data, typ, err := markAnswer(payload)
	if err != nil {
		return nil, "", err
	}
	// Conflicting event/data types must never fake a terminal message_stop.
	if event != "" && typ != "" && event != typ {
		return nil, "", errors.New("sse: conflicting event type")
	}
	if typ == "" {
		return nil, "", errors.New("sse: missing event type")
	}
	// RawMessage values can retain JSON formatting; an SSE data line cannot.
	var compact bytes.Buffer
	if err := json.Compact(&compact, data); err != nil {
		return nil, "", err
	}
	data = compact.Bytes()
	var out bytes.Buffer
	wrote := false
	for _, line := range lines {
		if bytes.HasPrefix(line, []byte("data:")) {
			if !wrote {
				out.WriteString("data: ")
				out.Write(data)
				out.WriteByte('\n')
				wrote = true
			}
		} else {
			out.Write(line)
			out.WriteByte('\n')
		}
	}
	out.WriteByte('\n')
	return out.Bytes(), typ, nil
}

func (r *Router) streamCodex(w http.ResponseWriter, req *http.Request, upstream io.Reader) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	controller := http.NewResponseController(w)
	w.WriteHeader(http.StatusOK)
	_ = controller.Flush()
	out := newSSEWriter(req.Context(), w, controller.Flush, r.pingInterval)
	defer out.close()
	started, terminal, clientGone := false, false, false
	err := scanFrames(upstream, func(frame []byte) bool {
		rewritten, typ, err := relayFrame(frame)
		if err != nil {
			return false
		}
		if typ == "message_start" {
			started = true
		}
		if typ == "message_stop" || typ == "error" {
			terminal = true
		}
		if !out.write(rewritten, started && !terminal) {
			clientGone = true
			return false
		}
		return !terminal
	})
	if err != nil && r.backend != nil {
		r.backend.ClearLimits()
	}
	if !terminal && !clientGone && req.Context().Err() == nil {
		if r.backend != nil {
			r.backend.ClearLimits()
		}
		payload := compactJSON(anthropicError{Type: "error", Error: errorDetail{Type: "api_error", Message: "ccmproxy: Codex remote stream ended early"}})
		frame := append([]byte("event: error\ndata: "), payload...)
		frame = append(frame, '\n', '\n')
		out.write(frame, false)
	}
}
