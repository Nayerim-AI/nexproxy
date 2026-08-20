package traefik

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestReadOnlyAdapterAndNormalization(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("unsafe method %s", r.Method)
		}
		switch r.URL.Path {
		case "/api/version":
			w.Write([]byte(`{"Version":"3.2"}`))
		case "/api/http/routers":
			w.Write([]byte("[{\"name\":\"web@docker\",\"rule\":\"Host(`A.example`) && PathPrefix(`/x`)\",\"service\":\"svc@docker\",\"middlewares\":[\"auth@file\"]},{\"name\":\"odd@file\",\"rule\":\"HostRegexp(`{sub:.+}.example`)\"}]"))
		case "/api/http/services":
			w.Write([]byte(`[{"name":"api@internal","loadBalancer":{"servers":[{"url":"http://internal"}]}},{"name":"svc@docker","loadBalancer":{"servers":[{"url":"http://10.0.0.1:80"}]}}]`))
		case "/api/http/middlewares":
			w.Write([]byte(`[{"name":"auth@file","basicAuth":{}}]`))
		}
	}))
	defer s.Close()
	c, _ := New(s.URL, time.Second, 4096)
	st, e := c.Status(context.Background())
	if e != nil || st.Version != "3.2" {
		t.Fatal(st, e)
	}
	r, e := c.Routers(context.Background())
	if e != nil || r[0].Provider != "docker" || r[0].Hosts[0] != "a.example" || len(r) != 2 {
		t.Fatal(r, e)
	}
	if v, e := c.Services(context.Background()); e != nil || len(v) != 1 || v[0].Provider != "docker" || v[0].Servers[0].URL == "" {
		t.Fatal(v, e)
	}
	if v, e := c.Middlewares(context.Background()); e != nil || v[0].Provider != "file" {
		t.Fatal(v, e)
	}
}
func TestFailuresAreSanitized(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		code       int
	}{{"http", "secret", 500}, {"json", "{", 200}, {"empty", "", 200}} {
		t.Run(tc.name, func(t *testing.T) {
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.code); w.Write([]byte(tc.body)) }))
			defer s.Close()
			c, _ := New(s.URL, time.Second, 100)
			_, e := c.Routers(context.Background())
			if e == nil || strings.Contains(e.Error(), "secret") {
				t.Fatal(e)
			}
		})
	}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(50 * time.Millisecond) }))
	defer s.Close()
	c, _ := New(s.URL, 5*time.Millisecond, 100)
	if _, e := c.Status(context.Background()); e == nil {
		t.Fatal("expected timeout")
	}
}

func TestNewRejectsUnsafeURLs(t *testing.T) {
	bad := []string{"traefik:8080", "ftp://traefik", "http://", "http://user:***@traefik", "http://traefik?x=1", "http://traefik#x", "http://traefik\n.example", " http://traefik", "http://bad_host", "http://traefik:bad"}
	for _, port := range []int{-1, 0, 1 << 16, 100000 - 1} {
		bad = append(bad, "http://traefik:"+strconv.Itoa(port))
	}
	for _, raw := range bad {
		t.Run(raw, func(t *testing.T) {
			if _, err := New(raw, time.Second, 100); err == nil {
				t.Fatalf("accepted %q", raw)
			}
		})
	}
	for _, raw := range []string{"http://localhost:8080", "https://traefik.example/api", "http://127.0.0.1", "http://[::1]:8080", "http://traefik:1", "http://traefik:65535"} {
		if _, err := New(raw, time.Second, 100); err != nil {
			t.Errorf("rejected %q: %v", raw, err)
		}
	}
}

func TestClientDoesNotFollowRedirects(t *testing.T) {
	destinationHit := false
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { destinationHit = true }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, http.StatusFound) }))
	defer source.Close()
	c, err := New(source.URL, time.Second, 100)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.Status(context.Background()); err == nil || destinationHit {
		t.Fatalf("redirect followed: err=%v hit=%v", err, destinationHit)
	}
}
