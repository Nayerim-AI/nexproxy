package traefik

import (
	"context"
	"sync"
	"time"
)

type Snapshot struct {
	Status      Status       `json:"status"`
	Routers     []Router     `json:"routers"`
	Services    []Service    `json:"services"`
	Middlewares []Middleware `json:"middlewares"`
	ObservedAt  time.Time    `json:"observedAt"`
}
type Result struct {
	Snapshot      Snapshot
	Stale         bool
	Err           error
	CheckedAt     time.Time
	LastSuccessAt *time.Time
}
type Cache struct {
	mu    sync.Mutex
	ttl   time.Duration
	now   func() time.Time
	value *Snapshot
}

func NewCache(ttl time.Duration) *Cache {
	if ttl <= 0 {
		ttl = 15 * time.Second
	}
	return &Cache{ttl: ttl, now: time.Now}
}
func (c *Cache) Get(ctx context.Context, r Reader) Result {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now().UTC()
	if c.value != nil && now.Sub(c.value.ObservedAt) < c.ttl {
		t := c.value.ObservedAt
		return Result{*c.value, false, nil, now, &t}
	}
	s := Snapshot{ObservedAt: now}
	var e error
	if s.Status, e = r.Status(ctx); e == nil {
		s.Routers, e = r.Routers(ctx)
	}
	if e == nil {
		s.Services, e = r.Services(ctx)
	}
	if e == nil {
		s.Middlewares, e = r.Middlewares(ctx)
	}
	if e == nil {
		c.value = &s
		t := now
		return Result{s, false, nil, now, &t}
	}
	if c.value != nil {
		t := c.value.ObservedAt
		return Result{*c.value, true, e, now, &t}
	}
	return Result{Snapshot: Snapshot{}, Stale: false, Err: e, CheckedAt: now}
}
