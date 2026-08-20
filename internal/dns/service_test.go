package dns

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	_ "modernc.org/sqlite"
	"nexproxy/internal/cloudflare"
)

type fakeProvider struct {
	records map[string]cloudflare.Record
	deleted []string
	fail    error
}

func (f *fakeProvider) ListRecords(context.Context, string) ([]cloudflare.Record, error) {
	out := make([]cloudflare.Record, 0, len(f.records))
	for _, r := range f.records {
		out = append(out, r)
	}
	return out, f.fail
}
func (f *fakeProvider) CreateRecord(context.Context, string, cloudflare.RecordInput) (cloudflare.Record, error) {
	return cloudflare.Record{}, errors.New("unexpected create")
}
func (f *fakeProvider) UpdateRecord(context.Context, string, string, cloudflare.RecordInput) (cloudflare.Record, error) {
	return cloudflare.Record{}, errors.New("unexpected update")
}
func (f *fakeProvider) DeleteRecord(_ context.Context, _ string, id string) error {
	if f.fail != nil {
		return f.fail
	}
	f.deleted = append(f.deleted, id)
	delete(f.records, id)
	return nil
}
func (f *fakeProvider) GetRecord(_ context.Context, _ string, id string) (cloudflare.Record, error) {
	if f.fail != nil {
		return cloudflare.Record{}, f.fail
	}
	r, ok := f.records[id]
	if !ok {
		return cloudflare.Record{}, errors.New("missing")
	}
	return r, nil
}

func testService(t *testing.T, p *fakeProvider) (*Service, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE managed_dns_records(route_id TEXT,provider TEXT,zone_id TEXT,record_id TEXT,type TEXT,name TEXT,content TEXT,proxied INTEGER,created_at TEXT,updated_at TEXT,PRIMARY KEY(route_id,provider))`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO managed_dns_records VALUES('route-1','cloudflare','zone-1','managed-id','CNAME','app.example.com','target.example.com',1,'','')`)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return New(db, p), db
}

func TestDeleteManagedUsesExactPersistedIDAndLeavesExternal(t *testing.T) {
	p := &fakeProvider{records: map[string]cloudflare.Record{
		"managed-id":  {ID: "managed-id", Type: "CNAME", Name: "app.example.com", Content: "target.example.com", Proxied: true},
		"external-id": {ID: "external-id", Type: "CNAME", Name: "app.example.com", Content: "external.example.com"},
	}}
	s, db := testService(t, p)
	if err := s.DeleteManaged(context.Background(), "route-1"); err != nil {
		t.Fatal(err)
	}
	if len(p.deleted) != 1 || p.deleted[0] != "managed-id" {
		t.Fatalf("deleted %#v", p.deleted)
	}
	if _, ok := p.records["external-id"]; !ok {
		t.Fatal("external record was deleted")
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM managed_dns_records`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("mapping count=%d err=%v", n, err)
	}
}

func TestDeleteFailurePreservesMapping(t *testing.T) {
	p := &fakeProvider{records: map[string]cloudflare.Record{}, fail: errors.New("provider down")}
	s, db := testService(t, p)
	if err := s.DeleteManaged(context.Background(), "route-1"); err == nil {
		t.Fatal("expected error")
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM managed_dns_records`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("mapping count=%d err=%v", n, err)
	}
}

func TestCheckDetectsExactIDContentMismatch(t *testing.T) {
	p := &fakeProvider{records: map[string]cloudflare.Record{"managed-id": {ID: "managed-id", Type: "CNAME", Name: "app.example.com", Content: "wrong.example.com", Proxied: true}}}
	s, _ := testService(t, p)
	ok, err := s.Check(context.Background(), "route-1")
	if err != nil || ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
}
