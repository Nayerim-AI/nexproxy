// Package auth contains password hashing and login throttling primitives.
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
)

// Parameters use 32 MiB and two passes: deliberately conservative for low-RAM servers.
const (
	Memory            uint32 = 32 * 1024
	Iterations        uint32 = 2
	Parallelism       uint8  = 1
	SaltLength               = 16
	KeyLength         uint32 = 32
	MinPasswordLength        = 12
)

func Hash(password string) (string, error) {
	if len(password) < MinPasswordLength {
		return "", errors.New("password must contain at least 12 characters")
	}
	salt := make([]byte, SaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, Iterations, Memory, Parallelism, KeyLength)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", Memory, Iterations, Parallelism, base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}
func Verify(encoded, password string) bool {
	// A canonical encoding produced by Hash is under 100 bytes. Keep modest
	// headroom for parameter digits while rejecting oversized input before any
	// splitting, numeric parsing, or base64 decoding.
	const maxEncodedLength = 256
	if len(encoded) > maxEncodedLength {
		return false
	}

	p := strings.Split(encoded, "$")
	if len(p) != 6 || p[0] != "" || p[1] != "argon2id" || p[2] != "v=19" {
		return false
	}

	params := strings.Split(p[3], ",")
	if len(params) != 3 {
		return false
	}
	values := make(map[string]uint64, 3)
	for _, param := range params {
		kv := strings.SplitN(param, "=", 2)
		if len(kv) != 2 || (kv[0] != "m" && kv[0] != "t" && kv[0] != "p") {
			return false
		}
		if _, duplicate := values[kv[0]]; duplicate {
			return false
		}
		n, err := strconv.ParseUint(kv[1], 10, 32)
		if err != nil {
			return false
		}
		values[kv[0]] = n
	}
	m, mOK := values["m"]
	t, tOK := values["t"]
	par, pOK := values["p"]
	const minMemory = 8 * 1024
	if !mOK || !tOK || !pOK || m < minMemory || m > uint64(Memory)*4 || t < 1 || t > 10 || par < 1 || par > 8 {
		return false
	}

	salt, err := base64.RawStdEncoding.DecodeString(p[4])
	if err != nil || len(salt) != SaltLength {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(p[5])
	if err != nil || len(want) != int(KeyLength) {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, uint32(t), uint32(m), uint8(par), KeyLength)
	return subtle.ConstantTimeCompare(got, want) == 1
}

type entry struct {
	failures       int
	first, blocked time.Time
}
type Limiter struct {
	mu      sync.Mutex
	entries map[string]entry
	now     func() time.Time
	max     int
}

func NewLimiter(now func() time.Time, max int) *Limiter {
	if now == nil {
		now = time.Now
	}
	if max <= 0 {
		max = 1024
	}
	return &Limiter{entries: map[string]entry{}, now: now, max: max}
}
func (l *Limiter) Blocked(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[ip]
	if !ok {
		return false
	}
	if !e.blocked.IsZero() && l.now().Before(e.blocked) {
		return true
	}
	if l.now().Sub(e.first) > 15*time.Minute {
		delete(l.entries, ip)
	}
	return false
}
func (l *Limiter) Failure(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	e := l.entries[ip]
	if e.first.IsZero() || now.Sub(e.first) > 15*time.Minute {
		e = entry{first: now}
	}
	e.failures++
	if e.failures >= 5 {
		e.blocked = now.Add(15 * time.Minute)
	}
	if len(l.entries) >= l.max {
		for k, v := range l.entries {
			if now.Sub(v.first) > 30*time.Minute {
				delete(l.entries, k)
			}
		}
		if len(l.entries) >= l.max {
			return
		}
	}
	l.entries[ip] = e
}
func (l *Limiter) Success(ip string) { l.mu.Lock(); delete(l.entries, ip); l.mu.Unlock() }
func RemoteIP(remote string) string {
	h, _, e := net.SplitHostPort(remote)
	if e == nil {
		return h
	}
	return remote
}
