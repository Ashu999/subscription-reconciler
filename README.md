# Subscription Reconciler

A small Fastify service that reconciles premium entitlements from three sources:
Store webhooks, carrier polling, and marketplace revokes. The service keeps each
source's state separately, then derives one canonical entitlement row for reads.

## How to Run

```bash
docker compose up --build
```

The Compose stack starts three services:

| Service | URL | Purpose |
| --- | --- | --- |
| `db` | `localhost:5432` | PostgreSQL 18.4 database. |
| `mock-carrier` | `http://localhost:3001` | Randomized carrier plan API used by the poller. |
| `app` | `http://localhost:3000` | Runs migrations, serves the API, and starts cron jobs. |

The app starts these background jobs:

| Job | Schedule | Purpose |
| --- | --- | --- |
| Carrier poller | Every 5 minutes | Polls active CARRIER source rows, including rows hidden behind STORE canonical state. |
| Expiry reconciler | Every 60 seconds | Refreshes canonical rows whose expiry has passed. |
| Notification scheduler | Every 60 seconds | Creates expiring-soon notification rows when expiry is inside 24 hours. |
| Notification worker | Every 60 seconds | Claims due notification rows and stamps `sent_at` when still current. |

### Environment Variables

`src/config.ts`, `.env.example`, and `docker-compose.yml` use the same contract:

| Variable | Used by | Example |
| --- | --- | --- |
| `NODE_ENV` | app, mock | `development` |
| `DATABASE_URL` | app | `postgres://app:app@localhost:5432/subscription_reconciler` |
| `APP_HOST` | app | `0.0.0.0` |
| `APP_PORT` | app | `3000` |
| `CARRIER_BASE_URL` | app | `http://localhost:3001` |
| `MOCK_CARRIER_HOST` | mock | `0.0.0.0` |
| `MOCK_CARRIER_PORT` | mock | `3001` |
| `CARRIER_HTTP_TIMEOUT_MS` | app | `3000` |

`config.ts` validates these at startup before the app or mock carrier begins
listening. Migrations run automatically on app startup; `npm run migrate` is
also available for a one-off migration run.

## API Examples

### Health

```bash
curl http://localhost:3000/health
```

```json
{ "status": "ok" }
```

### Store Webhook

`POST /webhooks/store` accepts `INITIAL_PURCHASE`, `RENEWAL`,
`CANCELLATION`, `BILLING_ISSUE`, `EXPIRATION`, and `UN_CANCELLATION` events.
The only supported `productId` is `premium_monthly`.

```bash
curl -X POST http://localhost:3000/webhooks/store \
  -H 'content-type: application/json' \
  -d '{
    "eventId": "evt_store_001",
    "userId": "user_store_001",
    "type": "INITIAL_PURCHASE",
    "eventTimeMs": 1781049600000,
    "productId": "premium_monthly"
  }'
```

```json
{
  "status": "applied",
  "entitlement": {
    "active": true,
    "source": "STORE",
    "expiresAt": "2026-07-10T00:00:00.000Z",
    "lastChangedAt": "2026-06-10T00:00:00.000Z",
    "reason": "INITIAL_PURCHASE"
  }
}
```

Sending the same `eventId` again is idempotent:

```json
{ "status": "duplicate" }
```

### Marketplace Revoke

`POST /webhooks/marketplace/revoke` accepts at most 10,000 `userIds` per
request. IDs are deduplicated and processed in chunks of 50.

```bash
curl -X POST http://localhost:3000/webhooks/marketplace/revoke \
  -H 'content-type: application/json' \
  -d '{
    "userIds": [
      "u_marketplace_active",
      "u_dual_source",
      "u_carrier_active",
      "u_marketplace_active"
    ]
  }'
```

```json
{
  "status": "ok",
  "requestedCount": 4,
  "uniqueUserCount": 3,
  "revokedCount": 2
}
```

If a later chunk fails after earlier chunks commit, the route returns a
retryable partial-failure body:

```json
{
  "status": "partial_failure",
  "revokedCount": 50,
  "retryable": true
}
```

Retry the full request after a partial failure. Marketplace revokes are
idempotent, so already-committed chunks are counted as no-ops on retry.

### Read Entitlement

`GET /users/:id/entitlement` returns the canonical entitlement. If an active
row is expired, the read path refreshes canonical state before returning.

```bash
curl http://localhost:3000/users/user_store_001/entitlement
```

```json
{
  "active": true,
  "source": "STORE",
  "expiresAt": "2026-07-10T00:00:00.000Z",
  "lastChangedAt": "2026-06-10T00:00:00.000Z",
  "reason": "INITIAL_PURCHASE"
}
```

Unknown users return an inactive `NONE` state:

```bash
curl http://localhost:3000/users/unknown_user/entitlement
```

```json
{
  "active": false,
  "source": "NONE",
  "expiresAt": null,
  "lastChangedAt": null,
  "reason": "NO_ENTITLEMENT"
}
```

### Seeded CARRIER and MARKETPLACE Grants

The assignment does not define public grant endpoints for CARRIER or
MARKETPLACE. Use the internal seed command for local/demo fixtures:

```bash
docker compose exec app npm run seed
```

Example output:

```text
Seeded CARRIER grant for u_carrier_active; canonical source=CARRIER
Seeded MARKETPLACE grant for u_marketplace_active; canonical source=MARKETPLACE
Seeded MARKETPLACE grant for u_dual_source; canonical source=MARKETPLACE
Seeded CARRIER grant for u_dual_source; canonical source=CARRIER
```

Inspect the seeded CARRIER grant:

```bash
curl http://localhost:3000/users/u_carrier_active/entitlement
```

```json
{
  "active": true,
  "source": "CARRIER",
  "expiresAt": null,
  "lastChangedAt": "2026-06-01T00:00:00.000Z",
  "reason": "CARRIER_ACTIVE"
}
```

Inspect the seeded MARKETPLACE grant:

```bash
curl http://localhost:3000/users/u_marketplace_active/entitlement
```

```json
{
  "active": true,
  "source": "MARKETPLACE",
  "expiresAt": null,
  "lastChangedAt": "2026-06-01T00:00:00.000Z",
  "reason": "MARKETPLACE_GRANT"
}
```

The `lastChangedAt` values above are illustrative; the seed command uses the
transaction timestamp from the database.

### Mock Carrier

The mock carrier is a separate Fastify process:

```bash
curl 'http://localhost:3001/mock/carrier/plan?userId=u_carrier_active'
```

```json
{ "status": "active" }
```

The mock always returns HTTP 200 for body statuses `active`, `inactive`, and
`api_error`, matching the assignment contract. The production HTTP carrier
client still treats non-2xx responses, malformed bodies, thrown fetch errors,
and timeouts as defensive `api_error` results.

## Development

The runtime target is Node.js `24.16.0`.

```bash
npm run build
npm test
npm run check
```

Useful one-off commands:

```bash
npm run migrate
npm run seed
```

## Design Decisions

- **Source and canonical split.** `source_entitlements` stores independent
  STORE, CARRIER, and MARKETPLACE truth. `canonical_entitlements` is derived
  from those rows and can always be recomputed.
- **Fixed precedence.** Active, unexpired sources resolve as
  `STORE > CARRIER > MARKETPLACE`. Precedence chooses the canonical explanation;
  any active source can still keep access active.
- **Per-user advisory locks.** Entitlement mutations run under a PostgreSQL
  transaction advisory lock keyed with `hashtextextended($1::text, 0)`, so
  source updates, canonical recompute, and notification sync serialize per user
  without blocking unrelated users.
- **Advisory-first worker ordering.** Per-user workers acquire advisory locks
  before row locks or recomputation. This keeps lock ordering consistent with
  webhook writes.
- **Raw store replay.** Store webhooks are inserted once into `store_events`,
  then the STORE projection is rebuilt from all user events ordered by
  `(eventTimeMs, eventId)`.
- **`FOR UPDATE SKIP LOCKED`.** Carrier lease claims use it to split work across
  pollers. Notification row claims use it after the advisory lock to avoid
  double-sending.
- **Database idempotency.** Duplicate store events, notification dedupe, source
  rows, and carrier poll lock ownership are guarded with database constraints
  and conflict handling rather than application-only checks.
- **Business-time expiry.** Store expiry is derived from the event's
  `eventTimeMs`; replaying the same event later produces the same `expiresAt`.
- **Database transaction time.** Recompute paths read `now()` from PostgreSQL so
  expiry checks, row timestamps, and notification scheduling share one clock
  inside a transaction.
- **Expiry refresh.** The expiry reconciler refreshes stale canonical rows in
  the background, and the read endpoint has a guard that recomputes expired
  canonical rows before returning.
- **Hidden carrier truth.** The carrier poller scans all active CARRIER source
  rows, not only users whose current canonical source is CARRIER. This prevents
  stale fallback after a higher-precedence STORE entitlement ends.
- **`lastChangedAt`.** Active canonical rows expose the winning source row's
  business timestamp, not the moment canonical switched. Inactive rows use the
  latest relevant source change or expiry timestamp.
- **Audit timestamps.** Mutable entitlement tables also have `created_at` and
  `updated_at` lifecycle columns maintained by a PostgreSQL trigger, separate
  from business timestamps such as `lastChangedAt`.
- **Store assumptions.** `UN_CANCELLATION` without a paid-through expiry is an
  inactive/no-op event. `BILLING_ISSUE` uses
  `max(previousExpiresAt, eventTimeMs + 7 days)`, so it never shortens paid-through
  access. A brand-new `BILLING_ISSUE` is inactive/no-op because there is no prior
  subscription to grant grace for.
- **Seed fixtures.** `npm run seed` uses internal locked upsert, canonical
  recompute, carrier poll lock creation, and notification sync helpers. It does
  not add public grant endpoints.
- **Notification dedupe metadata.** `notifications.expires_at` is internal
  metadata for at-most-once delivery per expiry instant.

## Tradeoffs Considered

- **Single entitlement table vs source split.** A single row is simpler, but it
  loses the independent source truth needed for fallback after revokes or
  carrier churn.
- **Kysely vs ORM.** Kysely keeps SQL explicit and strongly typed without hiding
  Postgres features like advisory locks and `SKIP LOCKED`.
- **Marketplace chunking.** Chunks of 50 users keep transactions and advisory
  lock windows bounded while still supporting 10,000-user requests.
- **Conservative `api_error`.** Carrier API errors do not change entitlements.
  This avoids removing access because of a transient dependency failure.
- **Polling all CARRIER rows vs only canonical CARRIER.** Polling all active
  CARRIER rows costs extra work, but keeps fallback truth fresh.
- **Fixed precedence vs most-recent-source wins.** Fixed precedence is easier to
  reason about and matches product ownership of source truth.

## What I Would Change With Another Week

1. **Broader event sourcing.** STORE already has a raw event log. I would extend
   that pattern to marketplace revokes, carrier observations, and canonical
   transitions so every state change can be derived from immutable inputs.
2. **STORE projection compaction.** Store webhooks currently replay a user's full
   event log on each accepted webhook. Assignment histories are short; production
   should materialize or compact old replay state so processing does not grow
   without bound.
3. **Dead-letter table.** Failed events would be written to `failed_events` with
   an admin replay path instead of depending only on logs and retries.
4. **Carrier error backoff.** After repeated `api_error` responses, the poller
   would back off exponentially and surface alerts or metrics.
5. **Webhook authentication and signature verification.** Store and marketplace
   webhooks should verify signed payloads or shared-secret headers, reject stale
   timestamps, and record request provenance before mutating entitlement state.
6. **Admin override endpoint.** Support teams usually need a controlled manual
   correction path when external channels disagree.
7. **Kysely code generation.** Generating types from the live database after
   migrations would reduce schema/type drift.
8. **Structured logging.** State transitions should emit structured records with
   `userId`, `source`, prior state, next state, and event IDs when available.
9. **Observability & monitoring.** Add metrics, dashboards, traces, and alerts
   for webhook failures, carrier API health, poller lag, notification delivery,
   entitlement recompute latency, and canonical state churn.
10. **Outbox notifications.** The DB already stores notification intent in the
   entitlement transaction. An outbox worker would make delivery to external
   email or push systems independently retryable.
