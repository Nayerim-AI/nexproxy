// Package cloudflare implements the small, exact subset of Cloudflare DNS API used by nexproxy.
package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const defaultBaseURL = "https://api.cloudflare.com/client/v4"

var ErrSecret = errors.New("cloudflare credential unavailable")

type Config struct {
	SecretPath string
	BaseURL    string
	Timeout    time.Duration
	MaxBody    int64
}

type Client struct {
	secretPath string
	base       *url.URL
	http       *http.Client
	maxBody    int64
}

type Record struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Proxied bool   `json:"proxied"`
}

type RecordInput struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Proxied bool   `json:"proxied"`
}

type apiError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}
type envelope[T any] struct {
	Success    bool       `json:"success"`
	Errors     []apiError `json:"errors"`
	Result     T          `json:"result"`
	ResultInfo struct {
		Page       int `json:"page"`
		TotalPages int `json:"total_pages"`
	} `json:"result_info"`
}

func New(cfg Config) (*Client, error) {
	if cfg.SecretPath == "" {
		return nil, fmt.Errorf("%w: secret path is not configured", ErrSecret)
	}
	base := cfg.BaseURL
	if base == "" {
		base = defaultBaseURL
	}
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("invalid cloudflare API URL")
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 10 * time.Second
	}
	if cfg.MaxBody <= 0 {
		cfg.MaxBody = 1 << 20
	}
	return &Client{cfg.SecretPath, u, &http.Client{Timeout: cfg.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, cfg.MaxBody}, nil
}

func TokenConfigured(secretPath string) bool { _, err := readToken(secretPath); return err == nil }

func readToken(name string) (string, error) {
	fd, err := unix.Open(name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return "", fmt.Errorf("%w: cannot securely read secret", ErrSecret)
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 || st.Size() > 64<<10 {
		return "", fmt.Errorf("%w: cannot securely read secret", ErrSecret)
	}
	b, err := io.ReadAll(io.LimitReader(f, (64<<10)+1))
	if err != nil || len(b) > 64<<10 {
		return "", fmt.Errorf("%w: cannot securely read secret", ErrSecret)
	}
	t := strings.TrimSpace(string(b))
	if t == "" {
		return "", fmt.Errorf("%w: empty secret", ErrSecret)
	}
	return t, nil
}

func (c *Client) do(ctx context.Context, method, endpoint string, in, out any) error {
	token, err := readToken(c.secretPath)
	if err != nil {
		return err
	}
	u := *c.base
	ep, err := url.Parse(endpoint)
	if err != nil {
		return errors.New("cloudflare request could not be created")
	}
	u.Path = path.Join(c.base.Path, ep.Path)
	u.RawQuery = ep.RawQuery
	var body io.Reader
	if in != nil {
		b, e := json.Marshal(in)
		if e != nil {
			return e
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return errors.New("cloudflare request could not be created")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return errors.New("cloudflare request failed")
	}
	defer resp.Body.Close()
	limited := io.LimitReader(resp.Body, c.maxBody+1)
	b, err := io.ReadAll(limited)
	if err != nil {
		return errors.New("cloudflare response could not be read")
	}
	if int64(len(b)) > c.maxBody {
		return errors.New("cloudflare response too large")
	}
	var raw envelope[json.RawMessage]
	if json.Unmarshal(b, &raw) != nil {
		return errors.New("cloudflare returned an invalid response")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !raw.Success {
		code := resp.StatusCode
		if len(raw.Errors) > 0 && raw.Errors[0].Code != 0 {
			code = raw.Errors[0].Code
		}
		return fmt.Errorf("cloudflare API error (%d)", code)
	}
	if out != nil && json.Unmarshal(raw.Result, out) != nil {
		return errors.New("cloudflare returned an invalid result")
	}
	return nil
}

func (c *Client) ResolveZone(ctx context.Context, name string) (string, error) {
	var zones []struct{ ID, Name string }
	endpoint := "/zones?name=" + url.QueryEscape(strings.TrimSuffix(strings.ToLower(name), "."))
	if err := c.do(ctx, http.MethodGet, endpoint, nil, &zones); err != nil {
		return "", err
	}
	if len(zones) != 1 || !strings.EqualFold(zones[0].Name, strings.TrimSuffix(name, ".")) {
		return "", errors.New("cloudflare zone not found")
	}
	return zones[0].ID, nil
}

func (c *Client) ListRecords(ctx context.Context, zoneID string) ([]Record, error) {
	var all []Record
	for page := 1; ; page++ {
		var records []Record
		if err := c.do(ctx, http.MethodGet, fmt.Sprintf("/zones/%s/dns_records?page=%d&per_page=100", url.PathEscape(zoneID), page), nil, &records); err != nil {
			return nil, err
		}
		all = append(all, records...)
		if len(records) < 100 {
			return all, nil
		}
	}
}
func validType(t string) bool { return t == "A" || t == "AAAA" || t == "CNAME" }
func (c *Client) CreateRecord(ctx context.Context, zone string, in RecordInput) (Record, error) {
	if !validType(in.Type) {
		return Record{}, errors.New("unsupported DNS record type")
	}
	var out Record
	err := c.do(ctx, http.MethodPost, "/zones/"+url.PathEscape(zone)+"/dns_records", in, &out)
	return out, err
}
func (c *Client) UpdateRecord(ctx context.Context, zone, id string, in RecordInput) (Record, error) {
	if !validType(in.Type) {
		return Record{}, errors.New("unsupported DNS record type")
	}
	var out Record
	err := c.do(ctx, http.MethodPut, "/zones/"+url.PathEscape(zone)+"/dns_records/"+url.PathEscape(id), in, &out)
	return out, err
}
func (c *Client) DeleteRecord(ctx context.Context, zone, id string) error {
	return c.do(ctx, http.MethodDelete, "/zones/"+url.PathEscape(zone)+"/dns_records/"+url.PathEscape(id), nil, nil)
}
func (c *Client) GetRecord(ctx context.Context, zone, id string) (Record, error) {
	var out Record
	err := c.do(ctx, http.MethodGet, "/zones/"+url.PathEscape(zone)+"/dns_records/"+url.PathEscape(id), nil, &out)
	return out, err
}

// RedactedConfig is safe for API serialization. SecretPath is deliberately absent.
type RedactedConfig struct {
	Provider, Zone, PublicTarget    string
	ProxiedDefault, TokenConfigured bool
}

func (c *Client) Redacted(zone, target string, proxied bool) RedactedConfig {
	return RedactedConfig{"cloudflare", zone, target, proxied, TokenConfigured(c.secretPath)}
}
