package handlers

import (
	"net/http/httptest"
	"net/netip"
	"testing"

	"itdesk/backend/internal/config"
)

func TestClientIP(t *testing.T) {
	loop := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32"), netip.MustParsePrefix("::1/128")}
	cases := []struct {
		name, peer, xff string
		trustAll        bool
		want            string
	}{
		{"direct LAN client", "10.110.110.20:5000", "", false, "10.110.110.20"},
		{"direct client spoofing XFF is ignored", "10.110.110.20:5000", "1.2.3.4", false, "10.110.110.20"},
		{"via local web proxy", "127.0.0.1:5000", "10.110.110.20", false, "10.110.110.20"},
		{"via ipv6 loopback proxy", "[::1]:5000", "10.110.110.20", false, "10.110.110.20"},
		{"proxy chain: right-most untrusted wins", "127.0.0.1:5000", "1.2.3.4, 10.110.110.20", false, "10.110.110.20"},
		{"local proxy without XFF", "127.0.0.1:5000", "", false, "127.0.0.1"},
		{"garbage XFF falls back to peer", "127.0.0.1:5000", "not-an-ip", false, "127.0.0.1"},
		{"TRUST_PROXY legacy: left-most", "10.0.0.1:5000", "1.2.3.4, 10.0.0.9", true, "1.2.3.4"},
	}
	for _, c := range cases {
		s := &Server{cfg: config.Config{TrustedProxies: loop, TrustProxy: c.trustAll}}
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.peer
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := s.clientIP(r); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}
