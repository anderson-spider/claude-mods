package router

import (
	"bufio"
	"bytes"
	"errors"
)

// sseReadLimit caps each line and complete event from the remote.
const sseReadLimit = 32 << 20

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
