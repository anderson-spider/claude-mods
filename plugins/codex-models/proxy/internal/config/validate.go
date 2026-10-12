package config

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// Validate checks the settings that decide where traffic and credentials go:
// the listener, the upstream, the Codex remote and the secrets' shape. An
// error names the key and never contains a secret.
func (c *Config) Validate() error {
	if err := ValidateListenAddr(c.ListenHTTP); err != nil {
		return fmt.Errorf("config: listen_http: %w", err)
	}
	if !upstreamAllowed(c.Upstream) {
		return fmt.Errorf("config: upstream %s is not allowed: requests to it carry the Claude Code login, "+
			"so only %s is accepted (delete the key)", safeURL(c.Upstream), DefaultUpstream)
	}
	if err := validateRemote(c.Codex.Remote); err != nil {
		return fmt.Errorf("config: codex.remote: %w", err)
	}
	secrets := []struct{ key, value string }{
		{"auth_token", c.AuthToken},
		{"session_salt", c.SessionSalt},
	}
	for _, s := range secrets {
		if s.value == "" {
			continue // absent is allowed here; serve refuses to start without them
		}
		if err := validateSecret(s.value); err != nil {
			return fmt.Errorf("config: %s: %w", s.key, err)
		}
	}
	if key := c.Codex.ManagementKey; key != "" {
		// This is a user-supplied bearer, not a generated proxy secret.
		if len(key) > 512 {
			return errors.New("config: codex.management_key: exceeds 512 characters")
		}
		for _, c := range []byte(key) {
			if c < '!' || c > '~' {
				return errors.New("config: codex.management_key: must be printable ASCII with no spaces")
			}
		}
	}
	return nil
}

// ValidateListenAddr accepts a literal loopback IP (127.0.0.0/8 or ::1, no
// zone, not IPv4-mapped) with an explicit port from 1 to 65535. A name is
// refused even when it resolves to loopback today: what it resolves to can
// change.
func ValidateListenAddr(addr string) error {
	host, port, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return fmt.Errorf("%q is not host:port: %w", addr, err)
	}
	if host == "" {
		return fmt.Errorf("%q names no host; use a loopback address such as 127.0.0.1", addr)
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return fmt.Errorf("%q: the host must be a literal loopback IP (127.0.0.0/8 or ::1), not a name", addr)
	}
	if ip.Zone() != "" || ip.Is4In6() || !ip.IsLoopback() {
		return fmt.Errorf("%q is not a loopback address; use one in 127.0.0.0/8 or ::1", addr)
	}
	if !validPort(port) {
		return fmt.Errorf("%q needs a numeric port from 1 to 65535", addr)
	}
	return nil
}

// validPort accepts decimal digits only (no sign, no space, no service name)
// naming a port from 1 to 65535.
func validPort(port string) bool {
	if port == "" || strings.Trim(port, "0123456789") != "" {
		return false
	}
	n, err := strconv.Atoi(port)
	return err == nil && n >= 1 && n <= 65535
}

// requireHTTPURL accepts an absolute HTTP or HTTPS URL with a host and no credentials,
// query or fragment.
func requireHTTPURL(raw string) error {
	u, err := url.Parse(raw)
	switch {
	case err != nil:
		// url.Error quotes the whole input, credentials included.
		return errors.New("is not a valid URL")
	case u.User != nil:
		return errors.New("credentials in the URL are not allowed; remove them")
	case (u.Scheme != "http" && u.Scheme != "https") || u.Host == "":
		return errors.New("must be an http:// or https:// URL")
	case u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#"):
		return errors.New("must not carry a query or fragment; remove them")
	}
	return nil
}

// safeURL shows a configured URL in an error message without what can hold a
// credential: only scheme, host and path, quoted, with a note when
// credentials or a query were left out. It shows "(not a valid URL)" instead
// when the value does not parse, lacks a scheme or a host (url.Parse then
// leaves everything, credentials included, in the path), or would still
// contain an "@".
func safeURL(raw string) string {
	const unshown = "(not a valid URL)"
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return unshown
	}
	kept := (&url.URL{Scheme: u.Scheme, Host: u.Host, Path: u.Path}).String()
	if strings.Contains(kept, "@") {
		return unshown
	}
	shown := strconv.Quote(kept)
	if u.User != nil {
		shown += " (credentials removed)"
	}
	if u.RawQuery != "" || u.Fragment != "" {
		shown += " (query removed)"
	}
	return shown
}

// validateSecret keeps a secret usable as a header value and hard to guess:
// 32 to 512 bytes of printable ASCII with no spaces.
func validateSecret(value string) error {
	if len(value) < 32 || len(value) > 512 {
		return errors.New("must be 32 to 512 characters; delete the key and run `ccmproxy config init` to generate one")
	}
	for i := range len(value) {
		if value[i] < '!' || value[i] > '~' {
			return errors.New("must be printable ASCII with no spaces")
		}
	}
	return nil
}

func requireRemote(raw string) error {
	if raw == "" {
		return nil
	}
	if err := requireHTTPURL(raw); err != nil {
		return err
	}
	u, _ := url.Parse(raw)
	if u.Opaque != "" || u.Hostname() == "" {
		return errors.New("must name a remote host")
	}
	if port := u.Port(); port != "" && !validPort(port) {
		return errors.New("invalid remote port")
	}
	if ip, err := netip.ParseAddr(u.Hostname()); err == nil && (ip.Unmap().IsLoopback() || ip.Unmap().IsUnspecified()) {
		return errors.New("must not use a loopback or unspecified address")
	}
	return nil
}
