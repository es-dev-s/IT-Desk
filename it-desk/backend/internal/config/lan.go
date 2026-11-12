package config

import (
	"fmt"
	"net"
	"net/netip"
	"regexp"
	"strings"
)

// virtualIface matches interfaces another PC can't reach us through
// (loopback, Docker/libvirt/k8s bridges, veth pairs, VM host-only nets).
var virtualIface = regexp.MustCompile(`^(lo|docker|br-|virbr|veth|vmnet|vboxnet|cni|flannel|cali|podman|kube)`)

// LANAddresses returns this machine's IPv4 addresses on up, non-virtual interfaces.
func LANAddresses() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []string
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 || virtualIface.MatchString(ifc.Name) {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok {
				if ip4 := ipn.IP.To4(); ip4 != nil && !ip4.IsLoopback() && !ip4.IsLinkLocalUnicast() {
					out = append(out, ip4.String())
				}
			}
		}
	}
	return out
}

// LANOrigins is http://<ip>:<port> for every LAN address (what a browser on
// another PC sends as Origin when it opens the web app by IP).
func LANOrigins(port string) []string {
	var out []string
	for _, ip := range LANAddresses() {
		out = append(out, "http://"+net.JoinHostPort(ip, port))
	}
	return out
}

// parsePrefixes accepts CIDRs or bare IPs ("10.0.0.5" = a /32).
func parsePrefixes(items []string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, s := range items {
		s = strings.TrimSpace(s)
		if !strings.Contains(s, "/") {
			a, err := netip.ParseAddr(s)
			if err != nil {
				return nil, fmt.Errorf("TRUSTED_PROXIES: %q is not an IP or CIDR", s)
			}
			out = append(out, netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()))
			continue
		}
		p, err := netip.ParsePrefix(s)
		if err != nil {
			return nil, fmt.Errorf("TRUSTED_PROXIES: %q is not an IP or CIDR", s)
		}
		out = append(out, p.Masked())
	}
	return out, nil
}

// Trusted reports whether ip (any textual form, IPv4-mapped allowed) is inside one of prefixes.
func Trusted(prefixes []netip.Prefix, ip string) bool {
	a, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil {
		return false
	}
	a = a.Unmap()
	for _, p := range prefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}
