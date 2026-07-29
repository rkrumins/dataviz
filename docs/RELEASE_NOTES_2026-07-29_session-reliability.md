# Session reliability — 2026-07-29

Users were being signed out at random, saw "You don't have access" flash before pages
loaded, and were sometimes signed back in without entering credentials. This documents
what caused each of those, what changed, and what an operator needs to configure.

Nothing here requires configuration to take effect. Every new setting defaults to the
behaviour you already have, except `JWT_EXPIRY_MINUTES`, which is now 15 in all four
shipped config files — see [Upgrading](#upgrading).

---

## 1. What was broken

### Random logouts after sitting on a page

Three separate causes, all of which land as the same symptom.

**The rate limit was one bucket for the whole tenant.** `/auth/refresh` was capped at
30/minute keyed on the client address. Gunicorn ran without `--forwarded-allow-ips`, so
its `127.0.0.1` default discarded the `X-Forwarded-For` the ingress sets and recorded
every caller as the ingress pod. With 4 workers × N replicas that was 12+ independent
in-memory buckets all keyed on one address. Rotations cluster — everyone who signs in at
09:00 rotates together at 09:15 — so a synchronised herd hit a shared window, got a 429,
and the SPA treated any non-OK refresh as "session gone".

**Two tabs killed each other.** Rotation revoked the whole token family whenever a
consumed `jti` came back. Two tabs refreshing milliseconds apart, a retried POST, or a
rotation whose `Set-Cookie` never arrived was enough. The winner kept working until its
access token expired, so the logout surfaced minutes later with nothing to connect it to.

**Any failed refresh meant sign-out.** A 429, a 503 or a dropped connection was
indistinguishable from "your session is gone".

### "You don't have access", then the content appears

Route guards derived their answer from the permission claims alone, and an un-hydrated
claim set is byte-for-byte a claim set that grants nothing. The session flips to
authenticated from the cached user before any claim is fetched, so every gated route
rendered a denial for one network round trip.

On the admin page this was worse than a flash: it issued a redirect off those empty
claims, so a delegated admin was committed to `/admin/overview` and stayed there.

### Signed back in without entering credentials

Only `/auth/refresh` was exempt from silent refresh, so the boot call on `/login` 401'd,
refreshed, succeeded, and dropped you into the app. Switching accounts was impossible.

### Revocation that did not revoke

Every path that rejected a refresh revoked the token family and then raised. The
request-scoped database session is rolled back on the way out, so **none of those
revocations ever reached the database** — a stolen refresh family stayed live. The test
suite could not see this: its session fixture never commits or rolls back, and its
in-memory engine puts every session on one connection.

### Revocation that expired too early

The Redis tombstone that makes a forced sign-out take effect was fixed at 360 seconds
while the shipped access-token lifetime was 60 minutes. Revoking someone's access
silently stopped working 54 minutes before each token expired.

---

## 2. What changed

| Area | Change |
|---|---|
| Rotation | Atomic claim on the primary key; a re-presented token within `REFRESH_ROTATION_GRACE_SECONDS` gets the successor the winner already minted instead of killing the family |
| Revocation | Rejections carry their side effects out of the request session and commit separately, so they survive the rollback |
| Rate limits | Generous per-address flood guard **plus** a strict per-account control; `/refresh` keyed per browser session; counters shared across replicas |
| Client | `tryRefresh` classifies its outcome — only a definitive 401 signs you out; 429/5xx/network get one bounded retry |
| Guards | A real `permissionsStatus` tri-state; no denial rendered until the answer is known |
| Login page | Shows the form, with an explicit "Continue as \<name\>" for a still-valid session |
| Config | Revocation TTL derived from the access TTL; startup refuses an incoherent pair |
| Storage | `revoked_refresh_jti` is swept hourly; nothing pruned it before |
| Environments | `AUTH_ENVIRONMENT_ID` scopes cookie names and the JWT issuer |
| Key rotation | `JWT_SECRET_KEY_PREVIOUS` key ring with `kid` headers |

---

## 3. Configuring it

### If you run one environment and one replica

Nothing to do. Every default matches previous behaviour.

### If you run behind an ingress or load balancer

**Set `FORWARDED_ALLOW_IPS`.** Without it gunicorn keeps its `127.0.0.1` default,
discards `X-Forwarded-For`, and records every user as the proxy — so all rate limiting
collapses onto one bucket and the access log cannot identify a caller.

```yaml
FORWARDED_ALLOW_IPS: "*"   # only when nothing but a trusted proxy can reach the port
```

Already set in `deploy/k8s/base/configmaps/common-config.yaml` and `docker-compose.yml`.

**Verify it worked:** the access log should show real client addresses, not the ingress.
That is the single observable that proves the whole chain.

### If you run more than one replica

Rate-limit counters must be shared, or each worker counts separately. They resolve
through the central Redis resolver on the STREAMS role automatically — the same endpoint
revocation uses — so if Redis is configured, this already works. Confirm at startup:

```
Rate-limit storage: redis://10.1.2.3:6379/0
```

If it says `in-memory (PER WORKER — limits are not shared across replicas)`, no Redis
endpoint resolved. Set `RATELIMIT_STORAGE_URI` explicitly to override.

An unreachable store degrades to per-worker counting rather than failing requests.

### If two environments can be open in the same browser

Set `AUTH_ENVIRONMENT_ID` per environment:

```yaml
AUTH_ENVIRONMENT_ID: "uat"   # → cookies become nx_access_uat, issuer nexus-lineage:uat
```

Cookie jars key on domain, not cluster, so without this two deployments overwrite each
other's session and the receiving side can only report an opaque signature failure. See
[Multi-Environment Sessions](/docs/multi-environment-sessions).

### If you need to rotate the signing key

Never replace `JWT_SECRET_KEY` on its own — every live session dies the instant it lands,
and during a rolling update pods on the old and new key flip the same user between
authenticated and 401.

1. Move the current key to `JWT_SECRET_KEY_PREVIOUS`.
2. Set the new key as `JWT_SECRET_KEY`.
3. Deploy. New tokens sign with the new key; old ones still verify.
4. After `JWT_REFRESH_EXPIRY_DAYS` (7), drop `JWT_SECRET_KEY_PREVIOUS`.

### Sizing the rate limits

Defaults suit roughly 2000 seats behind one egress address. Two dials, different jobs:

- **Per-address** (`RATELIMIT_LOGIN_PER_IP` 1000/min, `RATELIMIT_SENSITIVE_PER_IP`
  200/min) is a flood guard. Raise it if a bigger tenant shares one egress. It is *not*
  brute-force protection — behind a NAT it stops the office, not the attacker.
- **Per-account** (`RATELIMIT_LOGIN_PER_ACCOUNT` 10 per 15 min,
  `RATELIMIT_PASSWORD_RESET_PER_ACCOUNT` 3/hour) is the security control. Leave it tight.
  Login counts failures only and clears on a successful sign-in, so raising it protects
  nobody and lowering it will not inconvenience legitimate users.

### The rotation grace window

`REFRESH_ROTATION_GRACE_SECONDS` (default 30) decides how long a re-presented refresh
token reads as a concurrent refresh rather than a stolen chain. **This is a real tradeoff
in both directions:**

- At `0`, rotation is strict — a thief is caught on first use, and a legitimate user is
  signed out of every tab whenever two of them rotate at once.
- At `30`, an attacker who **already holds the stolen cookie** and uses it within 30
  seconds of a legitimate rotation gets the same successor instead of tripping detection.

Widening it much beyond 30s buys nothing; the races it absorbs resolve in well under a
second.

---

## 4. What to expect operationally

**Two new startup lines.** Both are worth checking after a deploy:

```
Session config: access_ttl=900s refresh_ttl=7d revocation_ttl=960s rotation_grace=30s sso_ceiling=24h
Rate-limit storage: redis://...
```

**Startup now refuses an incoherent config.** If `RBAC_REVOCATION_TTL_SECONDS` is set
below the access-token lifetime the process will not boot, naming both values. Leave it
unset and it is derived correctly.

**An hourly sweep on the control-plane role.** `revoked_refresh_jti` is pruned of rows
whose tokens can no longer be presented. The first pass after upgrading drains greedily —
the backlog is however long the deployment has been running — then settles into the
schedule. It runs only on `SYNODIC_ROLE=controlplane` (or `dev`), never in web replicas.

**Sessions renew without a timer.** Refresh is reactive on 401. In an idle tab the
permission poller's 60-second call is what notices expiry and drives the renewal, and
every rotation slides the refresh window forward — so an open tab stays signed in
indefinitely. A backgrounded tab pauses and renews on refocus. This makes the poller
load-bearing for sessions as well as permissions; see the comment at its call site before
changing its interval or removing it.

---

## Upgrading

Two changes are not defaults-preserving:

**`JWT_EXPIRY_MINUTES` is now 15 everywhere.** It previously read 60 in all three `.env`
files, 15 in the k8s configmap and 5 in code — four values, none of them agreeing.
Shortening it means a revoked or demoted session stops working sooner, and the derived
revocation TTL follows automatically. If you deliberately want 60, set it explicitly and
be aware that permission changes take that long to reach a live session.

**Family-revocation rows now expire.** Sentinels were stamped year 9999 so the (absent)
sweep would skip them. They now carry a real expiry of one refresh TTL plus a day, which
is longer than any token in the family can live. No action needed.

No migration is required beyond the additive Alembic revision
`20260728_1700_rotation_grace`, which adds three nullable columns. Rows written before it
fall through to the previous behaviour, so the rollout needs no backfill and no flag day.
