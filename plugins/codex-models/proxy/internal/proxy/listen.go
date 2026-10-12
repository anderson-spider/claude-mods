package proxy

import (
	"fmt"
	"net"
)

// Listen opens a TCP listener on addr and keeps it only if the socket it got
// is bound to a loopback address. The config already refuses anything but a
// literal loopback IP; this second check holds whatever the system made of
// the address, and refuses a wildcard bind such as 0.0.0.0.
func Listen(addr string) (net.Listener, error) {
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", addr, err)
	}
	if err := boundToLoopback(listener.Addr()); err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("listen on %s: %w", addr, err)
	}
	return listener, nil
}

// boundToLoopback refuses an address that is not a TCP address on a
// loopback IP.
func boundToLoopback(bound net.Addr) error {
	if tcp, ok := bound.(*net.TCPAddr); ok && tcp.IP.IsLoopback() {
		return nil
	}
	return fmt.Errorf("bound to %s, which is not a loopback address", bound)
}
