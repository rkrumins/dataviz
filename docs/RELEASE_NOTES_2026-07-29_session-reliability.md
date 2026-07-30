# Session reliability — 2026-07-29

Users were being signed out at random, saw "You don't have access" flash before pages
loaded, and were sometimes signed back in without entering credentials. This documents
what caused each of those, what changed, and what an operator needs to configure.

It also covers what a review of the whole session design turned up afterwards, which
nobody had reported: renewal that worked only as a side effect of an unrelated poller, a
signing-secret check that passed the placeholder this repo shipped, clock skew between
replicas, and one token family outside the key ring.

Most of it needs no configuration — the new settings default to sensible values and the
client-side changes are automatic. **Read [Upgrading](#upgrading) before deploying**
though: a placeholder `JWT_SECRET_KEY` now stops the boot, and `JWT_EXPIRY_MINUTES` is now
15 in all four shipped config files.

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

### Renewal that worked by accident

Refresh was reactive only, so something had to make a request before a session could
renew — and an idle tab makes none. What kept idle tabs alive was the *permission* poller:
its 60-second call happened to be the request that took the 401. That worked, but nothing
said so. Raising the poller's interval past the access TTL, giving it `skipAuthRefresh`,
or removing it would have stopped sessions renewing, and the symptom would have surfaced
minutes later as a logout with nothing pointing back at the cause.

### A placeholder secret that passed validation

`JWT_SECRET_KEY` was checked for length, and length is not strength.
`dev-secret-key-change-in-production` — the value shipped in `.env.example` — is 34
characters, so it cleared the ≥32 floor and booted clean. Any deployment that copied that
file forward was signing every token with a secret published in this repository, and
nothing anywhere reported a problem.

### Our own tokens held to an exactness we never asked of an IdP

`exp`, `iat` and `nbf` were compared as exact boundaries. Every replica both mints and
verifies tokens, so those comparisons cross two machines' clocks: a pod a second ahead
rejects a token that has not expired, and a token minted a second in the future is
rejected as not-yet-valid. The OIDC path had allowed 60 seconds of skew from the start;
we did not extend the same tolerance to ourselves.

### An access cookie that outgrew what browsers accept

Permission claims rode in the access JWT in full, including per-workspace grants. Those grow
about 200 bytes of cookie per workspace a user is bound to, and past roughly **18 workspaces
the cookie crossed the 4096-byte limit browsers enforce** — at which point it is discarded
*silently*. `/auth/login` answered 200, the `Set-Cookie` went out, the browser threw it away,
the next request arrived anonymous, and the SPA bounced the user to `/login` with nothing in
any log. Because the size depends on how many workspaces that particular user holds, it
presented as random unreproducible sign-outs hitting the most privileged accounts first, and
it got worse as the product was adopted.

Almost all of that volume was redundancy: 150 workspace bindings produced 150 verbatim
copies of one 8-permission array — 29 KB of JSON, ~99% repetition, inflated another third by
base64url. A real login by such a user measured **43,197 bytes**.

**Workspace grants no longer travel in the cookie at all.** They live in the session store,
keyed by `sid` — the same entry already read on every request for revocation, fetched in the
same pipelined round trip, so reading them costs nothing extra. `to_jwt_dict()` has no option
to include them, so the invariant is enforced by the signature rather than by review, and the
access cookie is O(1) in tenant size: identical bytes for a user with 0 workspaces and one
with 2,000.

Stored payloads are also deduplicated (`{"ws": {id: 0}, "psets": [[…]]}`) — a ninefold
reduction, since every workspace a user holds the same role on resolves to the same
permission set. That is now a Redis-memory optimisation rather than a defence against the
cliff.

An intermediate version embedded the grants while they fitted and shed them above a byte
budget. It worked, and it was still the wrong shape: a user with 99 bindings and one with 101
exercised different authorization machinery, and the store path — the one serving the largest
tenants — was the one almost nothing routinely tested. Deduplication alone would only have
moved the cliff from ~18 workspaces to ~180.

Splitting the cookie across `nx_access_0/1/2…` was considered and rejected: it addresses the
per-cookie limit but not the constraint that actually binds, which is that the whole Cookie
header rides on every request. 44 KB of it exceeds nginx's default
`large_client_header_buffers 4 8k`, so it would have traded a silent drop for a hard 400.

No hard refresh is needed. A tab open across the deploy holds a token with inline grants and
no store entry, and the read path recognises each layout by inspection rather than assuming
one — so it keeps every permission it had. Both compatibility branches self-drain within one
refresh TTL.

**"We can't tell" is no longer reported as "you may not."** Moving the grants out of the
token means there is now a state where the server cannot establish them — Redis unreachable
*and* the Postgres fallback failing. Resolving that to an empty grant map would have produced
403 `Missing permission: …`, which asserts a fact about the user that was never checked, and
it is the same "you don't have permissions" flash this release set out to remove. The claim
set carries `ws_available` instead, and:

* a **workspace-scoped** check that fails while the grants are unknown answers **503**, not
  403;
* a **global** check is unaffected — it is settled by the token, so an outage must not touch
  it, which is why the decision is made in `requires` (where the permission is known) rather
  than in the read path;
* `GET /me/permissions` answers **503** rather than a 200 with an empty `ws`, because the SPA
  store installs whatever it returns and would blank every workspace-gated control; on an
  error it keeps the claims it already had.

A Redis outage alone never reaches that state: Postgres answers, cached 30 seconds per user
so an outage does not become one permission query per request.

**This is also a story about the test suite.** `conftest.py` builds the test identity service
with **no claims resolver**, so every test that signed in was minting a token carrying no
permission claims at all. Nothing could measure a cookie that grew with claims, because no
test had ever put a claim in one — the same shape of blindness as the transaction-semantics
gap documented on that fixture. Tests that care now inject a resolver, and the wide-tenant
test asserts its own premise so it cannot quietly stop testing anything.

### A rate limiter that could deny authentication

Introduced by this work and caught in production, so it is worth recording rather than
quietly fixing. `limits` supports several Redis client libraries for its **asynchronous**
storage and defaults to `coredis`, which this image does not ship. Its *synchronous*
storage — the one slowapi drives for the per-address limits — has no such default, which
is why the flood guard kept working while the new per-account throttle raised
`ConfigurationError` from its constructor and returned 500 from every `POST /auth/login`
and `POST /auth/forgot-password`.

No new dependency was needed: `redis>=8.0.1` was already declared, and `limits` will use
its asyncio client when asked.

The deeper fault was that the constructor was the one place in that class which did not
fail open. Every method swallows storage errors on the stated grounds that a limiter which
cannot reach Redis must not become a login outage — but a storage that could not be
*built* raised straight through into the endpoint. It now falls back to per-worker
counting and logs at ERROR, so no storage misconfiguration can deny sign-in again.

It reached production because the Redis branch had no test coverage at all: the resolver
returns nothing in dev and test, so every run built the in-memory backend and the Redis
path was never constructed. That branch is now covered, including a check that the client
library it selects is a package listed in `requirements.txt`.

### One token family outside the key ring

Seven of the eight families sign and verify through the shared key-ring helpers. The
dry-run family used `JWT_SECRET_KEY` directly and stamped no `kid`, so a key rotation
broke an admin's in-flight "what would happen if I signed in here?" round trip while every
other family drained cleanly. Its cookie was the one signed flow cookie
`AUTH_ENVIRONMENT_ID` did not scope either — the same omission, twice over. Both are fixed,
and the scoping is now asserted as a property rather than as a list of names.

---

## 2. What changed

| Area | Change |
|---|---|
| Rotation | Atomic claim on the primary key; a re-presented token within `REFRESH_ROTATION_GRACE_SECONDS` gets the successor the winner already minted instead of killing the family |
| Revocation | Rejections carry their side effects out of the request session and commit separately, so they survive the rollback |
| Rate limits | Generous per-address flood guard **plus** a strict per-account control; `/refresh` keyed per browser session; counters shared across replicas |
| Limiter storage | The async limiter uses the redis-py asyncio client we already ship, not the `coredis` default; construction falls back to memory instead of 500ing sign-in; both limiters' backends are reported at boot |
| Claim transport | Workspace grants moved out of the cookie entirely into the `sid` session store, read in the round trip revocation already made, so the access cookie is O(1) in tenant size; stored payloads deduplicated ~9x; reads accept the old inline layout so open tabs survive the deploy |
| Unknown vs none | Grants that no source can supply are flagged, not flattened to an empty map: a workspace-scoped check answers 503 rather than "Missing permission", and global checks are untouched |
| Client | `tryRefresh` classifies its outcome — only a definitive 401 signs you out; 429/5xx/network get one bounded retry |
| Guards | A real `permissionsStatus` tri-state; no denial rendered until the answer is known |
| Login page | Shows the form, with an explicit "Continue as \<name\>" for a still-valid session |
| Config | Revocation TTL derived from the access TTL *and* the clock-skew leeway; startup refuses an incoherent pair |
| Refresh validity | Allow-by-record: one row per issued token, and a token is refused unless an active row says otherwise. `auth_time` and the successor pointer move onto that row |
| Storage | `refresh_tokens` is swept hourly; nothing pruned the table it replaces |
| Environments | `AUTH_ENVIRONMENT_ID` scopes cookie names and the JWT issuer — including `nx_dryrun`, which it had missed |
| Key rotation | `JWT_SECRET_KEY_PREVIOUS` key ring with `kid` headers — now covering the dry-run tokens too, which signed and verified outside the ring |
| Renewal | Scheduled ahead of expiry off a new `nx_access_exp` cookie, serialised across tabs by a Web Lock; reactive 401 refresh stays as the fallback |
| Sign-out | Broadcast to every tab instead of surfacing on each one's next request |
| Clock skew | 60s leeway on our own tokens, matching what the IdP path always had; the revocation TTL is derived to cover it |
| Signing secret | The placeholders this repo publishes are refused by name — the `.env.example` one was 34 chars and cleared the length floor |

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
Rate-limit storage: redis://10.1.2.3:6379/0 (per-account limiter: redis)
```

If it says `in-memory (PER WORKER — limits are not shared across replicas)`, no Redis
endpoint resolved. Set `RATELIMIT_STORAGE_URI` explicitly to override.

**The two limiters are reported separately because they can disagree.** The per-address
limit runs on synchronous storage and the per-account limit on asynchronous storage —
different code paths to the same Redis, so one can succeed while the other does not. A
`per-account limiter: memory (FELL BACK)` against a configured Redis means the per-account
limits are per-worker; the preceding ERROR line says why.

An unreachable store degrades to per-worker counting rather than failing requests, and so
does a store that cannot be constructed at all.

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

### Clock skew between replicas

`JWT_CLOCK_SKEW_LEEWAY_SECONDS` (default 60) is how far outside its stated validity a
token we issued is still honoured. It exists because every replica both mints and verifies
tokens, so `exp`/`iat`/`nbf` are compared across two clocks.

Leave it alone unless you have a specific reason. Two things to know if you do change it:

- It is **not** an extension of token lifetime for anything else — the revocation TTL is
  derived from `access_ttl + leeway + 60`, so forced sign-out still outlives every token.
  Startup refuses to boot if an explicit `RBAC_REVOCATION_TTL_SECONDS` breaks that.
- Raising it widens the window in which a revoked-then-expired token is still accepted, by
  exactly that amount.

Setting it to `0` restores exact-boundary behaviour. Do that only if you are confident
your replicas' clocks are tightly synchronised, and expect occasional unexplained
sign-outs if they are not.

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
Session config: access_ttl=900s refresh_ttl=7d revocation_ttl=1020s rotation_grace=30s clock_skew_leeway=60s sso_ceiling=24h
Rate-limit storage: redis://... (per-account limiter: redis)
```

**Startup now refuses an incoherent config.** If `RBAC_REVOCATION_TTL_SECONDS` is set
below the window in which an access token is still accepted — the TTL *plus*
`JWT_CLOCK_SKEW_LEEWAY_SECONDS` — the process will not boot, naming every value. Leave it
unset and it is derived correctly.

**Diagnosing a session that lapsed anyway.** `GET /api/v1/auth/diagnostics` now reports
`nx_access_exp` as a delta rather than present/absent, because that is the question worth
asking:

```json
"session_cookies_presented": { "access_exp": "expired 41m ago" }
```

`expired … ago` means that tab never rotated — look at whether the page was frozen or
discarded, or whether the cookie is reaching the browser at all. `expires in …` means
renewal is working and the problem is elsewhere. `absent` on a long-lived session means it
predates this release and is still on the reactive path; it self-corrects on the next
rotation.

**Startup now refuses a published placeholder secret.** If `JWT_SECRET_KEY` (or an entry
in `JWT_SECRET_KEY_PREVIOUS`) is one of the values this repository ships in its example
files, the process will not boot and the error names the file. The `.env.example` value
was 34 characters, so the ≥32 length floor passed it — a deployment that copied that file
forward was signing production tokens with a secret published in the repo. `.env.example`
now ships the key empty.

### Refresh tokens are valid only while a record says so

`revoked_refresh_jti` was a **denylist**: a refresh token was valid *unless* a row said
otherwise. Correctness therefore rested on that denylist being complete and durable
forever — and the sweep below deletes from it. A row lost to an early prune, a failed
write, or a restore from a backup taken before the revocation made a consumed or revoked
token valid again, silently, in the attacker's favour.

`refresh_tokens` inverts it: a row per token, written at mint, and **nothing is accepted
without an active row**. Every way the storage can fail now points the safe way — a
missing row signs someone out instead of reviving a credential — and pruning an expired
row can only reject a token that had already expired.

Two things moved onto the row with it:

* **`auth_time`** was a claim the refresh JWT asserted about *itself*, and its absence
  meant "local password session, the 24-hour SSO re-auth ceiling does not apply". A token
  minted without it skipped the ceiling entirely — the bug fixed earlier in this release
  by defaulting the value at mint. Sourced from the record, the whole class is gone: the
  row cannot be absent for a token that was just accepted, and it is not editable by
  whoever holds the cookie.
* **Family revocation** marks the family's own rows instead of writing a
  `family-revoked:<id>` sentinel whose lifetime had to be hand-sized to outlive every
  token it guarded — first stamped year 9999, making every revocation a permanent row,
  then sized to the refresh TTL plus a grace day. There is nothing left that has to
  outlive anything.

**The signed JWT is still the bearer.** Switching to an opaque handle would change the
wire format, so a rollback would strand every session minted after the deploy — a visible
mass logout. Flipping *validation* delivers the security property with no format change,
no dual-accept window, and no rollback risk.

**Nobody is signed out by the deploy.** Sessions already live hold tokens with no row.
`REFRESH_ADOPT_RECORDLESS` (default on) accepts such a token once and writes the row it
should have had — which is exactly what the previous model did with the same token, so
the ramp is the status quo rather than a new weakness. It is still the old behaviour, so
turn it off once `JWT_REFRESH_EXPIRY_DAYS` have passed; every adoption logs at INFO, so
the drain to zero is watchable rather than assumed.

**Adoption consults the old denylist before it writes anything.** It has to. The
family check derives its answer from `refresh_tokens`, and a family that existed
before this revision has no rows there at all — so on its own it clears every
pre-deploy family, including the ones killed by reuse detection or the SSO ceiling.
The same applies to each `jti` the old model marked consumed: without the check,
every superseded pre-deploy cookie is spendable once. `revoked_refresh_jti` is
therefore still read on this one path, and only on it — a token minted under this
revision has a record and never reaches the call.

**It also closed a test blind spot.** Six fixtures wired
`refresh_store_factory=lambda s: None`, so no test of an SSO login had ever touched
refresh persistence — the same shape as the claims-resolver gap above.

**An hourly sweep on the control-plane role.** `revoked_refresh_jti` is pruned of rows
whose tokens can no longer be presented. The first pass after upgrading drains greedily —
the backlog is however long the deployment has been running — then settles into the
schedule. It runs only on `SYNODIC_ROLE=controlplane` (or `dev`), never in web replicas.

**Sessions renew on a schedule, ahead of expiry.** Each tab reads `nx_access_exp` and
rotates about a minute before it, so renewal no longer costs a user-visible request a
401 + refresh + replay. Reactive refresh on 401 is still there as the fallback, and every
rotation slides the refresh window forward — so an open tab stays signed in indefinitely.

Two consequences worth knowing:

- **Renewal continues while a tab is hidden**, deliberately, unlike the permission poller.
  Browsers throttle a background tab's timers to roughly one tick a minute, which is fine
  at these intervals; a tab that was frozen outright re-evaluates the moment it becomes
  visible again.
- **One refresh per browser, not per tab.** Tabs coordinate through a Web Lock: the winner
  rotates and the rest read the new expiry rather than posting again. Browsers without the
  Web Locks API fall back to the previous per-tab behaviour, which the rotation grace
  window already makes safe.

**Signing out is immediate in every tab.** Logout broadcasts on the existing
`rbac-permissions` channel and the other tabs tear down at once, rather than discovering
it on their next request. Sign-*in* is deliberately not broadcast — a tab sitting on
`/login` stays there.

---

## Upgrading

Four changes are not defaults-preserving:

**A placeholder `JWT_SECRET_KEY` now stops the boot.** If any environment still runs
`dev-secret-key-change-in-production`, `REPLACE_ME`, or `quickstart-demo-key`, generate a
real secret *before* deploying:

```
python -c 'import secrets; print(secrets.token_urlsafe(48))'
```

Replacing the signing key invalidates every live session unless you move the old value to
`JWT_SECRET_KEY_PREVIOUS` at the same time — see [rotating the signing
key](#if-you-need-to-rotate-the-signing-key). A placeholder is public, so it is worth
carrying for one refresh TTL to make the cutover non-disruptive; it is not worth keeping
longer.

`.env.example` and the tracked `.env.dev` now ship `JWT_SECRET_KEY=` empty — a key
committed to the repo is a key every clone shares. `./dev.sh` generates a per-machine
value on first run, so local development stays a single command; anyone starting services
by hand has to generate one.

**The derived revocation TTL grew by the clock-skew leeway**, from `access_ttl + 60` to
`access_ttl + 120` (1020s at the shipped 15-minute TTL). If you set
`RBAC_REVOCATION_TTL_SECONDS` explicitly and it now falls below `access_ttl + leeway`, the
process refuses to boot and names every value. Unset it and it derives correctly.

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
