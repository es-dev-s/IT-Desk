package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
)

// NewToken returns a 256-bit random URL-safe token and its SHA-256 (hex).
// Only the hash is ever stored.
func NewToken() (token, hash string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	return token, HashToken(token), nil
}

func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// TokenMatches compares a presented token with a stored hash in constant time.
func TokenMatches(token, storedHash string) bool {
	if token == "" || storedHash == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(HashToken(token)), []byte(storedHash)) == 1
}

// PlausibleToken rejects obviously malformed tokens before touching the DB.
func PlausibleToken(token string) bool {
	if len(token) != 43 {
		return false
	}
	_, err := base64.RawURLEncoding.DecodeString(token)
	return err == nil
}
