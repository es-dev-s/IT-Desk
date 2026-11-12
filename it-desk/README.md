# IT-Desk

Monorepo for the IT-Desk team-lead workspace (seat moves, IT transfer tracking, exits).

```
.
├── Frontend/   Next.js 16 app (UI) — talks to the API, no bundled demo data
├── backend/    Go 1.25+ API (net/http + pgx) backed by PostgreSQL
└── Makefile    dev / run / seed / migrate / test
```

## Quick start

```bash
cp backend/.env.example backend/.env      # set DATABASE_URL (file is gitignored)
cp Frontend/.env.example Frontend/.env.local
make install
make seed-reset    # creates schema "itdesk", applies migrations, loads demo data + sign-in accounts
                   # passwords → backend/.seed-credentials.txt (0600, gitignored, never printed)
make dev           # API on 127.0.0.1:8080, web on 0.0.0.0:3000 (Ctrl-C stops both)
```

`make run` starts both in the background (logs in `.run/`) and prints the LAN URL,
`make stop` stops them.

### Using it from another PC (LAN)

`make run` / `make dev` print something like `LAN -> http://10.110.110.69:3000`; open that
URL on any PC on the same network.

* The browser only talks to the web server (port 3000). `Frontend/server.mjs` serves the
  Next.js app and streams `/api/*` — including the live-update SSE stream — to the Go API,
  which listens on `127.0.0.1:8080` only. Nothing but port 3000 needs to be reachable.
* The API accepts the machine's LAN origins automatically (`LAN_ORIGINS=auto`); add other
  host names (e.g. `http://itdesk.local:3000`) to `ALLOWED_ORIGINS` in `backend/.env`, and to
  `ALLOWED_DEV_HOSTS` (comma-separated host names) for `make dev`.
* Cookies are `HttpOnly; SameSite=Lax`, and `Secure` only with `COOKIE_SECURE=true` /
  `APP_ENV=production` (i.e. behind https) — so plain-http LAN access works.
* Rate limiting and lockout see the real browser IP: the proxy overwrites
  `X-Forwarded-For`, and the API only trusts it from `TRUSTED_PROXIES` (loopback).
* `HOST=127.0.0.1 make run` keeps everything local; `WEB_PORT=…` changes the port.
* If a firewall is on, allow the web port from your subnet, e.g.
  `sudo ufw allow from 10.110.110.0/24 to any port 3000 proto tcp`.
`make test` runs `go vet`, Go unit + integration tests (integration tests use a
throw-away schema and are skipped when `DATABASE_URL` is unset), and frontend lint + typecheck.

## Backend

* All tables live in the dedicated schema `itdesk` (`DB_SCHEMA`); migrations are embedded and
  run on start (`MIGRATE_ON_START=true`) or via `make migrate`.
* Demo data lives **only in PostgreSQL**. `make seed` is idempotent (no-op if data exists);
  `make seed-reset` drops and recreates the `itdesk` schema (refuses to drop a schema it didn't create).
  Seed dates are shifted relative to "now" so the demo always looks current.

### Authentication & roles

There is **no sign-up**. Accounts are created by an admin (Users screen or
`POST /admin/users`), who receives a one-time temporary password; the user must
replace it at first sign-in. The first admin comes from the seed, from
`make seed-admin EMAIL=… NAME=…`, or from `ADMIN_EMAIL`/`ADMIN_PASSWORD` at API start
(created once, never overwritten).

| Capability | Admin | Team Lead | IT |
| --- | :-: | :-: | :-: |
| Dashboard, people, devices, transfers (read) | all teams | own team | all teams |
| Seat map | all (team switcher) | own + anonymised others | – |
| Create transfers / mark exits | – | own team | – |
| Undo transfer / exit batch | – | own actions only | – |
| Advance IT status (transfer queue) | – | – | ✓ |
| Exits, analytics | ✓ | own team | – |
| Audit log, user management | ✓ | – | – |

* Every route declares a permission; anything not allowed is `403 forbidden`. Team
  scoping is enforced in SQL, so another team's records answer `404`.
* Passwords: argon2id (19 MiB, t=2), 12–128 chars, no name/email parts, common-password
  check; transparent re-hash when parameters change.
* Sessions: 256-bit opaque token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` +
  `__Host-` prefix in production); only its SHA-256 is stored. 7-day lifetime, 12-hour idle
  timeout, rotated on login, revoked on logout, password change/reset, role change and disable.
* CSRF: per-session token (`X-CSRF-Token`, returned by login and `/auth/me`) required on
  every write, plus an `Origin` allow-list check.
* Brute force: 5 failures lock the account for 1 min, doubling up to 1 h; in-memory
  throttles per IP and per IP+email; constant-time checks and identical errors for unknown
  emails, wrong passwords and disabled accounts. All auth events go to the audit log.

### Endpoints (`/api/v1`, JSON, success = `{"data":…}`, error = `{"error":{code,message,fields,requestId}}`)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/healthz` | liveness (no DB) |
| GET | `/readyz` | live DB ping + pool stats, 503 when down |
| GET | `/workspace?teamId=` | full snapshot for the UI (+ `serverTime`, `undoWindowSeconds`) |
| POST | `/auth/login` | `{email,password}` → session cookie + `csrfToken` (429 + `Retry-After` when throttled) |
| GET | `/auth/me` | user, role, permissions, `csrfToken`, `mustChangePassword` |
| POST | `/auth/logout` · `/auth/change-password` | |
| GET/POST | `/admin/users` | list / create (returns one-time `temporaryPassword`) — admin only |
| GET/PATCH/DELETE | `/admin/users/{id}` | view / edit role, team, name, email (`expectedVersion`) / delete |
| POST | `/admin/users/{id}/reset-password` · `/disable` · `/enable` · `/revoke-sessions` | admin only |
| GET | `/me` · PUT `/me/profile` | current user (name/title; email changes go through an admin) |
| GET/PUT | `/settings` | notification preferences |
| GET | `/teams` · `/teams/{id}/floor` | teams, seat map |
| GET | `/members?teamId=&status=&q=` · `/members/{id}` | roster |
| GET | `/transfers?direction=&status=&q=&limit=&offset=` · `/transfers/{id}` | |
| POST | `/transfers` | internal seat moves / swaps, or move-out to another team |
| POST | `/transfers/{id}/advance` | `{"from":"requested"}` → next IT status |
| DELETE | `/transfers/{id}` | undo (within `UNDO_WINDOW`, only while `requested`) |
| GET/POST | `/exits` · DELETE `/exits/batches/{batchId}` | mark exits / undo batch |
| GET | `/overview` · `/activity?limit=` | KPIs, audit log |

### Resilience

* Server starts even when the DB is down; it connects in the background with exponential
  backoff. API routes answer `503 database_unavailable` + `Retry-After` until ready, and again
  if the DB drops mid-flight; `/readyz` reflects live state.
* Seat integrity is enforced by the database (deferrable `EXCLUDE` constraint) plus row locks,
  so concurrent double-booking yields exactly one success and a `409 seat_taken` for the rest.
  Serialization failures / deadlocks are retried automatically.
* Optimistic concurrency: `expectedVersion` per member, `from` status on advance (`409 stale_*`).
* Every mutation accepts an `Idempotency-Key`; retries replay the original response
  (`Idempotent-Replayed: true`), a reused key with a different body is rejected (422).
* Request IDs, structured logs, panic recovery, CORS allow-list, 1 MB body limit, per-request
  and per-statement timeouts (504), graceful shutdown.
