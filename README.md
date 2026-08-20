# NexProxy Phase 1

## Deployment security boundary

Deploy exactly one NexProxy instance. Route mutation serialization is process-wide, not distributed. Current route operations write Traefik dynamic configuration and may call Cloudflare. Run as a dedicated least-privilege user with an owner-only data directory and a dedicated trusted bind-mounted configuration directory; grant Traefik read-only access to generated files. NexProxy requires no Docker socket, root account, or broad host filesystem access. Keep Cloudflare credentials in an owner-only regular file, never a symlink.

Local desired-state proxy-route manager. React/Vite retains the Phase 0 design and explicit development mock scenarios. Go provides a layered `handler → service → store` REST API and serves the embedded SPA. No infrastructure, Cloudflare, Traefik, Docker, systemctl, or ACME calls/writes occur.

## Build and run

```sh
npm ci
npm test
npm run build:embed       # builds and copies dist into cmd/nexproxy/dist
 go test ./...
 go vet ./...
 go build ./cmd/nexproxy
./nexproxy
```

The committed `cmd/nexproxy/dist` is the current production SPA. `build:embed` always rebuilds it before `go build`; Go's embed path remains inside the command package as required by `go:embed`.

Configuration: `NEXPROXY_LISTEN_ADDR` defaults to `127.0.0.1:8080`; `NEXPROXY_DATA_DIR` defaults to `./data`; `NEXPROXY_DATABASE` defaults to `$NEXPROXY_DATA_DIR/nexproxy.db` and overrides that path. Tests create databases only under `t.TempDir()`.

SQLite uses `modernc.org/sqlite`: maintained, pure Go, no CGO/toolchain runtime dependency. Migrations are ordered, transactional, version-recorded, and idempotent.

## API

- `GET/POST /api/routes`
- `GET/PATCH/DELETE /api/routes/{opaqueId}`
- `POST /api/routes/{opaqueId}/recheck` returns `501 NOT_IMPLEMENTED`
- `GET /api/activity`, `GET/PATCH /api/settings`, `GET /api/services`. Settings `PATCH` has partial update semantics: supplied keys are atomically upserted and omitted keys are unchanged.
- `GET /api/dns`, `GET /api/certificates` return honest empty integration results
- `GET /api/system/status`

Writes return an operation result with `result`, `resource` or `resourceId`, `message`, and per-step statuses. Integration steps are `skipped`. `removeDns` is accepted as deletion intent only and never invokes DNS. JSON is camelCase; timestamps are UTC RFC3339; random IDs are opaque. API creation always produces `managed`; `external` exists only for observed/imported store data and is read-only in service/API paths. Duplicate domains return `409`; authoritative validation returns `422`.

Schema: `schema_migrations(version)`; `routes(id, domain UNIQUE NOCASE, scheme, host, port, https, create_dns, ownership, created_at, updated_at)`; `activity(id, action, resource_id, message, created_at)`; `settings(key, value)`.

All Phase 1 route observations are `unknown`: persisted desired state is not evidence that route/backend/DNS/TLS works. Frontend health rules: backend `error` is `offline`; every required component healthy is `healthy`; warning, pending, or non-backend error is `degraded`; only unknown/unavailable/never-checked components with no known error is `unknown`; unknown plus warning is `degraded`.

Normal mode uses `/api` through `src/api.ts`; it has no fallback. Explicit non-normal `?scenario=loading|empty|error|partial|failure` scenarios are available only in development/test builds and cannot bypass authentication in production.

## Phase 2.5 — Authentication and security boundary

NexProxy uses one administrator, Argon2id password hashing, opaque server-side SQLite sessions, secure cookies, exact-origin mutation checks, bounded login throttling, strict JSON/body limits, and response security headers. All `/api/*` endpoints require authentication except auth status, first-run setup, and login. Static SPA assets remain public so the login/setup shell can load.

Production requires `NEXPROXY_PUBLIC_URL`. Session cookies are `Secure` by default; disabling that behavior is accepted only with an explicit loopback HTTP public URL. Forwarding headers are not trusted for origin validation or rate limiting.

Data and secret policy:

- Run NexProxy as a dedicated unprivileged service user.
- Keep the data directory owner-only (`0700`) and SQLite database owner-only (`0600`); never use `0777`.
- Mount future provider credentials through a Docker secret or owner-readable file such as `/run/secrets/nexproxy_cloudflare_token`.
- Never return secrets through APIs or store provider tokens as plaintext settings.
- Do not reuse or read existing ACME/Cloudflare credential files.
- Restrict future generated-config directories to the NexProxy and Traefik service identities.

Phase 2.5 does not write Traefik configuration, call DNS providers, provision certificates, or mutate infrastructure.

## Phase 2 — Traefik read-only discovery

Phase 2 adds actual-state visibility through Traefik's HTTP API without adding any Traefik mutation capability. Configure `traefik_api_url` from Settings; an empty value leaves the integration `not_configured` while the application and SQLite desired-state API continue to work.

The adapter reads only:

```text
GET /api/version
GET /api/http/routers
GET /api/http/services
GET /api/http/middlewares
```

Runtime observations are normalized and cached in memory for a short TTL. The last successful snapshot is returned as `stale` after a temporary read failure; the cache is intentionally lost on application restart. External routers remain ephemeral, read-only observations and are never inserted into SQLite.

Reconciliation is separate from health:

```text
desired_only  desired SQLite route with no observed owned counterpart
external      observed Traefik router without verified NexProxy ownership
conflict      desired hostname overlaps an unverified external router
unknown       Traefik has not been observed successfully
applied       verified deterministic NexProxy marker and exact desired match
drifted       verified marker exists but observed configuration differs
missing       reserved for future historical ownership tracking
```

Same-domain matching alone never proves ownership. Future-owned resources use a deterministic `nexproxy-<route-id>@file` marker plus exact host and target checks. Phase 2 does not generate that configuration.

Internal-provider resources are retained by the normalized snapshot but hidden from the normal route/service presentation. Complex or hostless rules are kept as external observations with their raw rule intact.

Authentication remains required before any future Traefik write capability.
