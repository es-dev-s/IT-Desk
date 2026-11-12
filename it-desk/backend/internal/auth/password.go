// Package auth holds the security primitives: password hashing (argon2id),
// opaque session/CSRF tokens, the role/permission policy, login throttling and
// account-lockout backoff. It has no database or HTTP dependencies so every
// rule is unit-testable.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters (OWASP 2024 baseline: m=19 MiB, t=2, p=1).
type Params struct {
	Memory  uint32 // KiB
	Time    uint32
	Threads uint8
	SaltLen int
	KeyLen  uint32
}

var DefaultParams = Params{Memory: 19 * 1024, Time: 2, Threads: 1, SaltLen: 16, KeyLen: 32}

var ErrMalformedHash = errors.New("malformed password hash")

// HashPassword returns a PHC-formatted argon2id hash:
// $argon2id$v=19$m=19456,t=2,p=1$<salt>$<key>
func HashPassword(password string) (string, error) {
	return hashWith(password, DefaultParams)
}

func hashWith(password string, p Params) (string, error) {
	salt := make([]byte, p.SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, p.Time, p.Memory, p.Threads, p.KeyLen)
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, p.Memory, p.Time, p.Threads,
		b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// VerifyPassword checks password against a PHC hash in constant time.
// needsRehash reports whether the hash uses weaker parameters than today's.
func VerifyPassword(password, encoded string) (ok, needsRehash bool, err error) {
	p, salt, key, err := decodeHash(encoded)
	if err != nil {
		return false, false, err
	}
	got := argon2.IDKey([]byte(password), salt, p.Time, p.Memory, p.Threads, uint32(len(key)))
	ok = subtle.ConstantTimeCompare(got, key) == 1
	needsRehash = p.Memory < DefaultParams.Memory || p.Time < DefaultParams.Time
	return ok, needsRehash, nil
}

func decodeHash(encoded string) (Params, []byte, []byte, error) {
	var p Params
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return p, nil, nil, ErrMalformedHash
	}
	var v int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &v); err != nil || v != argon2.Version {
		return p, nil, nil, ErrMalformedHash
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.Memory, &p.Time, &p.Threads); err != nil {
		return p, nil, nil, ErrMalformedHash
	}
	if p.Memory == 0 || p.Memory > 1<<20 || p.Time == 0 || p.Time > 10 || p.Threads == 0 {
		return p, nil, nil, ErrMalformedHash
	}
	b64 := base64.RawStdEncoding
	salt, err := b64.DecodeString(parts[4])
	if err != nil || len(salt) < 8 {
		return p, nil, nil, ErrMalformedHash
	}
	key, err := b64.DecodeString(parts[5])
	if err != nil || len(key) < 16 {
		return p, nil, nil, ErrMalformedHash
	}
	return p, salt, key, nil
}

// dummyHash is verified against when the email is unknown (or the account has
// no password) so a failed login costs the same either way: no user
// enumeration via timing.
var dummyHash = func() string {
	h, err := HashPassword("itdesk-timing-equaliser-not-a-real-password")
	if err != nil {
		panic(err)
	}
	return h
}()

// BurnTime performs a full hash verification that always fails.
func BurnTime(password string) { _, _, _ = VerifyPassword(password, dummyHash) }

const (
	MinPasswordLen = 12
	MaxPasswordLen = 128
)

// ValidateNewPassword enforces the password policy (NIST 800-63B style: length
// over composition rules, plus a few obvious bad choices). It returns a
// user-facing message, or "" when the password is acceptable.
func ValidateNewPassword(password, email, name string) string {
	n := utf8.RuneCountInString(password)
	switch {
	case n < MinPasswordLen:
		return fmt.Sprintf("Use at least %d characters", MinPasswordLen)
	case n > MaxPasswordLen:
		return fmt.Sprintf("Use at most %d characters", MaxPasswordLen)
	case strings.TrimSpace(password) == "":
		return "Password can't be blank"
	}
	lower := strings.ToLower(password)
	if email != "" {
		local := strings.ToLower(strings.SplitN(email, "@", 2)[0])
		if lower == strings.ToLower(email) || (len(local) >= 4 && strings.Contains(lower, local)) {
			return "Password can't contain your email"
		}
	}
	if name != "" {
		for _, part := range strings.Fields(strings.ToLower(name)) {
			if len(part) >= 4 && strings.Contains(lower, part) {
				return "Password can't contain your name"
			}
		}
	}
	for _, bad := range commonPasswords {
		if strings.Contains(lower, bad) && n < len(bad)+8 {
			return "That password is too common"
		}
	}
	distinct := map[rune]bool{}
	classes := 0
	var hasL, hasU, hasD, hasS bool
	for _, r := range password {
		distinct[r] = true
		switch {
		case unicode.IsLower(r):
			hasL = true
		case unicode.IsUpper(r):
			hasU = true
		case unicode.IsDigit(r):
			hasD = true
		default:
			hasS = true
		}
	}
	for _, b := range []bool{hasL, hasU, hasD, hasS} {
		if b {
			classes++
		}
	}
	if len(distinct) < 6 {
		return "Use more varied characters"
	}
	if classes < 2 && n < 16 {
		return "Mix letters with numbers or symbols, or use a longer passphrase"
	}
	return ""
}

var commonPasswords = []string{"password", "123456", "qwerty", "letmein", "welcome", "admin", "itdesk", "iloveyou", "abc123", "changeme"}

// GeneratePassword returns a random password that satisfies the policy, using
// an alphabet without look-alike characters (for one-time temp passwords).
func GeneratePassword(n int) (string, error) {
	const (
		lowers  = "abcdefghjkmnpqrstuvwxyz"
		uppers  = "ABCDEFGHJKLMNPQRSTUVWXYZ"
		digits  = "23456789"
		symbols = "-_!@#%+="
	)
	if n < MinPasswordLen {
		n = MinPasswordLen
	}
	all := lowers + uppers + digits + symbols
	for {
		buf := make([]byte, n)
		idx := make([]byte, n)
		if _, err := rand.Read(idx); err != nil {
			return "", err
		}
		for i := range buf {
			// rejection-free mapping is fine here: 256 % 63 bias is negligible
			// for a temp password, but we still pick from a uniform reading.
			buf[i] = all[int(idx[i])%len(all)]
		}
		s := string(buf)
		if strings.ContainsAny(s, lowers) && strings.ContainsAny(s, uppers) && strings.ContainsAny(s, digits) &&
			strings.ContainsAny(s, symbols) && ValidateNewPassword(s, "", "") == "" {
			return s, nil
		}
	}
}
