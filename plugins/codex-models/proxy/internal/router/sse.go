package router

import (
	"bufio"
	"bytes"
	"errors"
	"io"
)

// sseReadLimit caps one line of the backend's event stream.
const sseReadLimit = 32 << 20

// scanSSE reads a Server-Sent Events stream and calls onData once per event
// with its data lines joined by newlines. It stops early, with no error, when
// onData returns false, which it does once the client has gone away. The end
// of the stream dispatches a last event left without its blank line; a read
// error does not, and is returned.
//
// Only data lines are read: event, id and comment lines carry nothing the
// translator needs, since each payload names its own type. A "[DONE]" payload
// is skipped.
func scanSSE(upstream io.Reader, onData func(payload []byte) bool) error {
	reader := bufio.NewReaderSize(upstream, 64<<10)
	var data []byte

	dispatch := func() bool {
		payload := data
		data = nil
		if len(payload) == 0 || bytes.Equal(bytes.TrimSpace(payload), []byte("[DONE]")) {
			return true
		}
		return onData(payload)
	}

	for {
		line, err := readSSELine(reader)
		if len(line) > 0 || err == nil {
			line = bytes.TrimRight(line, "\r")
			if len(line) == 0 {
				if !dispatch() {
					return nil
				}
			} else if value, ok := bytes.CutPrefix(line, []byte("data:")); ok {
				value = bytes.TrimPrefix(value, []byte(" "))
				if len(data) > 0 {
					data = append(data, '\n')
				}
				data = append(data, value...)
			}
		}
		switch {
		case err == nil:
		case errors.Is(err, io.EOF):
			dispatch()
			return nil
		default:
			return err
		}
	}
}

// readSSELine reads one line without its newline, joining the pieces of a
// line longer than the reader's buffer, up to sseReadLimit.
func readSSELine(reader *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := reader.ReadSlice('\n')
		if len(line)+len(chunk) > sseReadLimit {
			return nil, errors.New("sse: event line exceeds limit")
		}
		line = append(line, chunk...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return bytes.TrimSuffix(line, []byte("\n")), err
	}
}
