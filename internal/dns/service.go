// Package dns owns DNS record lifecycle independently from route orchestration.
package dns

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"nexproxy/internal/cloudflare"
)

var ErrConflict = errors.New("external DNS record collision")
var ErrNotManaged = errors.New("DNS record is not managed")

type Provider interface {
	ListRecords(context.Context, string) ([]cloudflare.Record, error)
	CreateRecord(context.Context, string, cloudflare.RecordInput) (cloudflare.Record, error)
	UpdateRecord(context.Context, string, string, cloudflare.RecordInput) (cloudflare.Record, error)
	DeleteRecord(context.Context, string, string) error
	GetRecord(context.Context, string, string) (cloudflare.Record, error)
}

type ManagedRecord struct {
	RouteID, Provider, ZoneID, RecordID, Type, Name, Content string
	Proxied                                                  bool
	CreatedAt, UpdatedAt                                     time.Time
}
type ListedRecord struct {
	cloudflare.Record
	Managed bool   `json:"managed"`
	RouteID string `json:"routeId,omitempty"`
}
type Service struct {
	db       *sql.DB
	provider Provider
}

func New(db *sql.DB, provider Provider) *Service { return &Service{db, provider} }

// HasManaged reports whether a route has a persisted provider record mapping.
func (s *Service) HasManaged(ctx context.Context, route string) (bool, error) {
	_, err := s.managed(ctx, route)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Service) managed(ctx context.Context, route string) (ManagedRecord, error) {
	var m ManagedRecord
	var p int
	var c, u string
	err := s.db.QueryRowContext(ctx, `SELECT route_id,provider,zone_id,record_id,type,name,content,proxied,created_at,updated_at FROM managed_dns_records WHERE route_id=? AND provider='cloudflare'`, route).Scan(&m.RouteID, &m.Provider, &m.ZoneID, &m.RecordID, &m.Type, &m.Name, &m.Content, &p, &c, &u)
	if err != nil {
		return m, err
	}
	m.Proxied = p != 0
	m.CreatedAt, _ = time.Parse(time.RFC3339Nano, c)
	m.UpdatedAt, _ = time.Parse(time.RFC3339Nano, u)
	return m, nil
}
func (s *Service) List(ctx context.Context, zone string) ([]ListedRecord, error) {
	recs, err := s.provider.ListRecords(ctx, zone)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT route_id,record_id FROM managed_dns_records WHERE provider='cloudflare' AND zone_id=?`, zone)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	owned := map[string]string{}
	for rows.Next() {
		var route, id string
		if err = rows.Scan(&route, &id); err != nil {
			return nil, err
		}
		owned[id] = route
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	out := make([]ListedRecord, 0, len(recs))
	for _, r := range recs {
		route, ok := owned[r.ID]
		out = append(out, ListedRecord{r, ok, route})
	}
	return out, nil
}
func same(a, b string) bool {
	return strings.EqualFold(strings.TrimSuffix(a, "."), strings.TrimSuffix(b, "."))
}
func matches(r cloudflare.Record, m ManagedRecord) bool {
	return r.ID == m.RecordID && r.Type == m.Type && same(r.Name, m.Name) && r.Content == m.Content && r.Proxied == m.Proxied
}

// Ensure creates when unowned and updates only the exact persisted provider ID.
func (s *Service) Ensure(ctx context.Context, route, zone string, desired cloudflare.RecordInput) (cloudflare.Record, error) {
	m, err := s.managed(ctx, route)
	if err == nil {
		if m.ZoneID != zone {
			return cloudflare.Record{}, ErrConflict
		}
		old, err := s.provider.GetRecord(ctx, zone, m.RecordID)
		if err != nil {
			return cloudflare.Record{}, err
		}
		if !matches(old, m) {
			return cloudflare.Record{}, ErrNotManaged
		}
		r, err := s.provider.UpdateRecord(ctx, zone, m.RecordID, desired)
		if err != nil {
			return r, err
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		_, err = s.db.ExecContext(ctx, `UPDATE managed_dns_records SET type=?,name=?,content=?,proxied=?,updated_at=? WHERE route_id=? AND provider='cloudflare' AND record_id=?`, desired.Type, desired.Name, desired.Content, desired.Proxied, now, route, m.RecordID)
		if err != nil {
			_, compensationErr := s.provider.UpdateRecord(ctx, zone, m.RecordID, cloudflare.RecordInput{Type: old.Type, Name: old.Name, Content: old.Content, Proxied: old.Proxied})
			if compensationErr != nil {
				return r, errors.Join(err, errors.New("DNS mapping update and provider compensation failed"), compensationErr)
			}
		}
		return r, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return cloudflare.Record{}, err
	}
	recs, err := s.provider.ListRecords(ctx, zone)
	if err != nil {
		return cloudflare.Record{}, err
	}
	for _, r := range recs {
		if same(r.Name, desired.Name) && r.Type == desired.Type {
			return cloudflare.Record{}, ErrConflict
		}
	}
	r, err := s.provider.CreateRecord(ctx, zone, desired)
	if err != nil {
		return r, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = s.db.ExecContext(ctx, `INSERT INTO managed_dns_records(route_id,provider,zone_id,record_id,type,name,content,proxied,created_at,updated_at) VALUES(?,'cloudflare',?,?,?,?,?,?,?,?)`, route, zone, r.ID, desired.Type, desired.Name, desired.Content, desired.Proxied, now, now)
	if err != nil {
		// The provider object did not exist before this operation. Compensate by
		// exact ID so a local persistence failure cannot orphan a DNS record.
		if cleanupErr := s.provider.DeleteRecord(ctx, zone, r.ID); cleanupErr != nil {
			return r, errors.Join(err, errors.New("DNS provider record created but mapping and compensation failed"), cleanupErr)
		}
	}
	return r, err
}
func (s *Service) DeleteManaged(ctx context.Context, route string) error {
	m, err := s.managed(ctx, route)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotManaged
	}
	if err != nil {
		return err
	}
	actual, err := s.provider.GetRecord(ctx, m.ZoneID, m.RecordID)
	if err != nil {
		return err
	}
	if !matches(actual, m) {
		return ErrNotManaged
	}
	if err = s.provider.DeleteRecord(ctx, m.ZoneID, m.RecordID); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM managed_dns_records WHERE route_id=? AND provider='cloudflare' AND record_id=?`, route, m.RecordID)
	return err
}

// Check validates the actual provider object selected by persisted exact ID.
func (s *Service) Check(ctx context.Context, route string) (bool, error) {
	m, err := s.managed(ctx, route)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrNotManaged
	}
	if err != nil {
		return false, err
	}
	r, err := s.provider.GetRecord(ctx, m.ZoneID, m.RecordID)
	if err != nil {
		return false, err
	}
	return matches(r, m), nil
}
