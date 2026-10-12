package router

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/anderson-spider/claude-mods/plugins/codex-models/proxy/internal/logx"
)

// maxRequestBody bounds a request body the proxy buffers, before and after
// its content coding is undone. Anthropic's own limit is well below this.
const maxRequestBody = 64 << 20

// requestBody is a buffered request body, both as the client sent it and in
// the form the router can read.
//
// Claude Code gzips a request body once it grows, which is most real
// sessions. Undecoded, the model could not be read and every such request
// would go to Anthropic.
type requestBody struct {
	// Raw is exactly what the client sent, still under its content coding.
	Raw []byte
	// JSON is Raw with the content coding undone; Raw itself when there is
	// none, and nil when the coding is one the proxy cannot undo.
	JSON []byte
	// Encoding is the Content-Encoding the client declared, lowercased.
	Encoding string
}

// Readable reports whether the body could be decoded and inspected.
func (b *requestBody) Readable() bool { return b.JSON != nil }

// Compressed reports whether Raw is under a content coding.
func (b *requestBody) Compressed() bool { return b.Encoding != "" && b.Encoding != "identity" }

// readBody buffers the request body and undoes its content coding. A coding
// that cannot be undone is not an error: the body can still go upstream as
// it came, it just cannot be routed by the model it names.
func readBody(req *http.Request) (*requestBody, error) {
	if req.Body == nil {
		return nil, errors.New("request has no body")
	}
	raw, err := readCapped(req.Body)
	_ = req.Body.Close()
	if err != nil {
		if errors.Is(err, errTooLarge) {
			return nil, fmt.Errorf("request body exceeds %d bytes", maxRequestBody)
		}
		return nil, fmt.Errorf("read request body: %w", err)
	}

	body := &requestBody{
		Raw:      raw,
		Encoding: strings.ToLower(strings.TrimSpace(req.Header.Get("Content-Encoding"))),
	}
	if !body.Compressed() {
		body.JSON = raw
		return body, nil
	}
	if body.JSON, err = decodeBody(raw, body.Encoding); err != nil {
		logx.Warnf("request body is %s encoded and could not be read (%v); passing it through", body.Encoding, err)
	}
	return body, nil
}

// decodeBody undoes a content coding. Only the codings a client applies to a
// request body are known; a response coding such as brotli or zstd is
// reported as unsupported rather than guessed at.
func decodeBody(raw []byte, encoding string) ([]byte, error) {
	var reader io.Reader
	switch encoding {
	case "gzip", "x-gzip":
		gz, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, fmt.Errorf("gzip: %w", err)
		}
		defer func() { _ = gz.Close() }()
		reader = gz
	case "deflate":
		// "deflate" is zlib on the wire, but raw deflate is common enough
		// in the field to be worth the fallback.
		if z, err := zlib.NewReader(bytes.NewReader(raw)); err == nil {
			defer func() { _ = z.Close() }()
			reader = z
		} else {
			reader = flate.NewReader(bytes.NewReader(raw))
		}
	default:
		return nil, fmt.Errorf("unsupported content coding %q", encoding)
	}

	decoded, err := readCapped(reader)
	if errors.Is(err, errTooLarge) {
		return nil, fmt.Errorf("decoded body exceeds %d bytes", maxRequestBody)
	}
	return decoded, err
}

var errTooLarge = errors.New("body too large")

// readCapped reads r to its end, or fails with errTooLarge past
// maxRequestBody bytes without buffering more than one byte beyond it.
func readCapped(r io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxRequestBody+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxRequestBody {
		return nil, errTooLarge
	}
	return data, nil
}

// forward puts the body back on the request exactly as the client sent it,
// content coding included, so a pass-through request reaches Anthropic as
// it was made.
func (b *requestBody) forward(req *http.Request) {
	setBody(req, b.Raw)
}

// forwardModified puts a rewritten body on the request. The new bytes are
// not under the client's content coding, so its header goes.
func (b *requestBody) forwardModified(req *http.Request, body []byte) {
	req.Header.Del("Content-Encoding")
	setBody(req, body)
}

func setBody(req *http.Request, body []byte) {
	req.Body = io.NopCloser(bytes.NewReader(body))
	req.ContentLength = int64(len(body))
	req.Header.Set("Content-Length", strconv.Itoa(len(body)))
	// A buffered body is no longer chunked.
	req.TransferEncoding = nil
}
