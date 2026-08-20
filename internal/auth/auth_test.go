package auth

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestArgon2HashAndVerify(t *testing.T) {
	password := "correct horse battery staple"
	h, err := Hash(password)
	if err != nil {
		t.Fatal(err)
	}
	if h == password || !strings.HasPrefix(h, "$argon2id$") {
		t.Fatalf("not encoded: %q", h)
	}
	if !Verify(h, password) {
		t.Fatal("correct password rejected")
	}
	if Verify(h, "wrong password") {
		t.Fatal("wrong password accepted")
	}
	for _, malformed := range []string{"", "plaintext", "$argon2id$v=19$m=x,t=2,p=1$a$b", "$argon2id$v=19$m=999999999,t=2,p=1$YQ$Yg", "$argon2id$v=19$m=1,t=1,p=1$%%%$Yg"} {
		if Verify(malformed, password) {
			t.Fatalf("malformed accepted: %q", malformed)
		}
	}
}

func TestVerifyRejectsMalformedArgon2Encoding(t *testing.T) {
	password := "correct horse battery staple"
	h, err := Hash(password)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(h, "$")
	salt16, hash32 := parts[4], parts[5]
	b64 := func(n int) string { return base64.RawStdEncoding.EncodeToString(make([]byte, n)) }
	tests := map[string]string{
		"duplicate parameter": "$argon2id$v=19$m=32768,t=2,p=1,m=32768$" + salt16 + "$" + hash32,
		"unknown parameter":   "$argon2id$v=19$m=32768,t=2,p=1,x=1$" + salt16 + "$" + hash32,
		"missing parameter":   "$argon2id$v=19$m=32768,t=2$" + salt16 + "$" + hash32,
		"giant base64":        "$argon2id$v=19$m=32768,t=2,p=1$" + strings.Repeat("A", 4096) + "$" + hash32,
		"short salt":          "$argon2id$v=19$m=32768,t=2,p=1$" + b64(15) + "$" + hash32,
		"long salt":           "$argon2id$v=19$m=32768,t=2,p=1$" + b64(17) + "$" + hash32,
		"short hash":          "$argon2id$v=19$m=32768,t=2,p=1$" + salt16 + "$" + b64(31),
		"long hash":           "$argon2id$v=19$m=32768,t=2,p=1$" + salt16 + "$" + b64(33),
		"malformed version":   "$argon2id$v=019$m=32768,t=2,p=1$" + salt16 + "$" + hash32,
	}
	for name, encoded := range tests {
		t.Run(name, func(t *testing.T) {
			if Verify(encoded, password) {
				t.Fatal("malformed encoding accepted")
			}
		})
	}
}

func TestLimiterThresholdExpiryAndBound(t *testing.T) {
	now := time.Unix(1000, 0)
	l := NewLimiter(func() time.Time { return now }, 3)
	for i := 0; i < 4; i++ {
		l.Failure("one")
	}
	if l.Blocked("one") {
		t.Fatal("blocked before threshold")
	}
	l.Failure("one")
	if !l.Blocked("one") {
		t.Fatal("not blocked at threshold")
	}
	now = now.Add(15*time.Minute + time.Nanosecond)
	if l.Blocked("one") {
		t.Fatal("block did not expire")
	}
	for _, ip := range []string{"a", "b", "c", "d"} {
		l.Failure(ip)
	}
	if len(l.entries) > 3 {
		t.Fatalf("unbounded entries: %d", len(l.entries))
	}
	now = now.Add(31 * time.Minute)
	l.Failure("fresh")
	if len(l.entries) != 1 {
		t.Fatalf("stale entries not cleaned: %d", len(l.entries))
	}
}

func TestRemoteIP(t *testing.T) {
	if got := RemoteIP("[2001:db8::1]:1234"); got != "2001:db8::1" {
		t.Fatalf("IPv6: %q", got)
	}
}
