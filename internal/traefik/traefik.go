// Package traefik is an isolated, read-only adapter for Traefik's HTTP API.
package traefik

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var ErrNotConfigured = errors.New("traefik is not configured")

type Status struct {
	Version string `json:"version"`
}
type Router struct {
	Name        string   `json:"name"`
	Provider    string   `json:"provider"`
	Rule        string   `json:"rule"`
	Hosts       []string `json:"hosts"`
	Service     string   `json:"service"`
	Middlewares []string `json:"middlewares"`
	EntryPoints []string `json:"entryPoints,omitempty"`
	TLS         bool     `json:"tls,omitempty"`
	Status      string   `json:"status,omitempty"`
}
type Server struct {
	URL    string `json:"url"`
	Status string `json:"status,omitempty"`
}
type Service struct {
	Name     string   `json:"name"`
	Provider string   `json:"provider"`
	Servers  []Server `json:"servers"`
	Status   string   `json:"status,omitempty"`
}
type Middleware struct {
	Name     string `json:"name"`
	Provider string `json:"provider"`
	Type     string `json:"type,omitempty"`
}

type Reader interface {
	Status(context.Context) (Status, error)
	Routers(context.Context) ([]Router, error)
	Services(context.Context) ([]Service, error)
	Middlewares(context.Context) ([]Middleware, error)
}

type Client struct {
	base *url.URL
	http *http.Client
	max  int64
}

func New(raw string, timeout time.Duration, maxResponseBytes int64) (*Client, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, ErrNotConfigured
	}
	u, e := ValidateAPIURL(raw)
	if e != nil {
		return nil, e
	}
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	if maxResponseBytes <= 0 {
		maxResponseBytes = 2 << 20
	}
	return &Client{u, &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, maxResponseBytes}, nil
}

// ValidateAPIURL applies the shared settings/client URL security contract.
func ValidateAPIURL(raw string) (*url.URL, error) {
	invalid := func() (*url.URL, error) { return nil, errors.New("invalid Traefik API URL") }
	if raw == "" || raw != strings.TrimSpace(raw) || strings.Contains(raw, "\\") || strings.IndexFunc(raw, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return invalid()
	}
	lower := strings.ToLower(raw)
	for i := 0; i+2 < len(lower); i++ {
		if lower[i] != '%' {
			continue
		}
		var decoded byte
		if _, err := fmt.Sscanf(lower[i+1:i+3], "%02x", &decoded); err == nil && (decoded < 0x20 || decoded == 0x7f) {
			return invalid()
		}
	}
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return invalid()
	}
	host := u.Hostname()
	if host == "" {
		return invalid()
	}
	if p := u.Port(); p != "" {
		port, err := strconv.Atoi(p)
		if err != nil || port < 1 || port > 65535 {
			return invalid()
		}
	}
	if net.ParseIP(host) == nil {
		if len(host) > 253 || strings.Contains(host, "_") {
			return invalid()
		}
		for _, label := range strings.Split(strings.TrimSuffix(host, "."), ".") {
			if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return invalid()
			}
			for _, r := range label {
				if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-') {
					return invalid()
				}
			}
		}
	}
	return u, nil
}
func (c *Client) get(ctx context.Context, path string, out any) error {
	u := *c.base
	u.Path = strings.TrimRight(u.Path, "/") + path
	u.RawQuery = ""
	u.User = nil
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if e != nil {
		return errors.New("Traefik request failed")
	}
	res, e := c.http.Do(req)
	if e != nil {
		return errors.New("Traefik request failed")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("Traefik returned HTTP %d", res.StatusCode)
	}
	b, e := io.ReadAll(io.LimitReader(res.Body, c.max+1))
	if e != nil {
		return errors.New("Traefik response read failed")
	}
	if int64(len(b)) > c.max {
		return errors.New("Traefik response too large")
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return errors.New("Traefik returned empty response")
	}
	if e = json.Unmarshal(b, out); e != nil {
		return errors.New("Traefik returned invalid JSON")
	}
	return nil
}
func qualified(name string) (string, string) {
	i := strings.LastIndex(name, "@")
	if i < 0 {
		return name, ""
	}
	return name, name[i+1:]
}

var hostRE = regexp.MustCompile(`Host\(\s*([^)]+)\s*\)`)
var quoteRE = regexp.MustCompile("[`\"]([^`\"]+)[`\"]")

func hosts(rule string) []string {
	ms := hostRE.FindAllStringSubmatch(rule, -1)
	out := []string{}
	for _, m := range ms {
		for _, q := range quoteRE.FindAllStringSubmatch(m[1], -1) {
			h := strings.ToLower(strings.TrimSpace(q[1]))
			if h != "" && !strings.ContainsAny(h, "{}* ") {
				out = append(out, h)
			}
		}
	}
	return out
}
func (c *Client) Status(ctx context.Context) (Status, error) {
	var x struct {
		Version string `json:"Version"`
	}
	e := c.get(ctx, "/api/version", &x)
	return Status{Version: x.Version}, e
}
func (c *Client) Routers(ctx context.Context) ([]Router, error) {
	var raw []struct {
		Name, Provider, Rule, Service, Status string
		Middlewares                           []string
		EntryPoints                           []string
		TLS                                   any
	}
	if e := c.get(ctx, "/api/http/routers", &raw); e != nil {
		return nil, e
	}
	out := make([]Router, 0, len(raw))
	for _, x := range raw {
		n, p := qualified(x.Name)
		if x.Provider != "" {
			p = x.Provider
		}
		out = append(out, Router{Name: n, Provider: p, Rule: x.Rule, Hosts: hosts(x.Rule), Service: x.Service, Middlewares: x.Middlewares, EntryPoints: x.EntryPoints, TLS: x.TLS != nil, Status: x.Status})
	}
	return out, nil
}
func (c *Client) Services(ctx context.Context) ([]Service, error) {
	var raw []struct {
		Name, Provider, Status string
		LoadBalancer           *struct {
			Servers []Server `json:"servers"`
		} `json:"loadBalancer"`
	}
	if e := c.get(ctx, "/api/http/services", &raw); e != nil {
		return nil, e
	}
	out := make([]Service, 0, len(raw))
	for _, x := range raw {
		n, p := qualified(x.Name)
		if x.Provider != "" {
			p = x.Provider
		}
		if p == "internal" || strings.HasSuffix(n, "@internal") {
			continue
		}
		var ss []Server
		if x.LoadBalancer != nil {
			ss = x.LoadBalancer.Servers
		}
		out = append(out, Service{n, p, ss, x.Status})
	}
	return out, nil
}
func (c *Client) Middlewares(ctx context.Context) ([]Middleware, error) {
	var raw []map[string]any
	if e := c.get(ctx, "/api/http/middlewares", &raw); e != nil {
		return nil, e
	}
	out := make([]Middleware, 0, len(raw))
	for _, x := range raw {
		n, _ := x["name"].(string)
		p, _ := x["provider"].(string)
		n, p2 := qualified(n)
		if p == "" {
			p = p2
		}
		typ := ""
		for k := range x {
			if k != "name" && k != "provider" && k != "status" {
				typ = k
				break
			}
		}
		out = append(out, Middleware{n, p, typ})
	}
	return out, nil
}

// Compile-time prevention: Client exposes no upstream write operation.
var _ Reader = (*Client)(nil)
