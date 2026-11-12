package config

import (
	"strings"
	"testing"
)

func TestParsePrefixesAndTrusted(t *testing.T) {
	ps, err := parsePrefixes([]string{"127.0.0.1/32", "::1/128", "10.0.0.5"})
	if err != nil {
		t.Fatal(err)
	}
	for ip, want := range map[string]bool{
		"127.0.0.1": true, "::1": true, "::ffff:127.0.0.1": true, "10.0.0.5": true,
		"10.0.0.6": false, "192.168.1.9": false, "garbage": false,
	} {
		if got := Trusted(ps, ip); got != want {
			t.Errorf("Trusted(%q)=%v want %v", ip, got, want)
		}
	}
	if _, err := parsePrefixes([]string{"nope"}); err == nil {
		t.Error("expected error for invalid entry")
	}
}

func TestLANOriginsShape(t *testing.T) {
	for _, o := range LANOrigins("3000") {
		if !strings.HasPrefix(o, "http://") || !strings.HasSuffix(o, ":3000") {
			t.Errorf("bad origin %q", o)
		}
		for _, bad := range []string{"127.", "172.17.", "192.168.122."} {
			if strings.HasPrefix(o, "http://"+bad) {
				t.Errorf("virtual/loopback address leaked: %q", o)
			}
		}
	}
}

func TestLoadAllowedOrigins(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://x@localhost/x")
	t.Setenv("ALLOWED_ORIGINS", "http://a.test:3000")
	t.Setenv("LAN_ORIGINS", "off")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.AllowedOrigins) != 1 || c.AllowedOrigins[0] != "http://a.test:3000" {
		t.Fatalf("origins = %v", c.AllowedOrigins)
	}
	if !Trusted(c.TrustedProxies, "127.0.0.1") || Trusted(c.TrustedProxies, "10.1.1.1") {
		t.Fatalf("default trusted proxies wrong: %v", c.TrustedProxies)
	}
	t.Setenv("LAN_ORIGINS", "auto")
	c, _ = Load()
	if len(c.AllowedOrigins) != 1+len(LANOrigins("3000")) {
		t.Fatalf("auto LAN origins not appended: %v", c.AllowedOrigins)
	}
}
