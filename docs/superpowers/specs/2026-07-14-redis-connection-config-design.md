# Central Redis connection configuration — cache, streams, auth, TLS

**Status:** Approved (design) · **Date:** 2026-07-14

## 1. Problem

The platform is moving to a topology where the three Redis-speaking endpoints are
genuinely independent instances:

| Endpoint | Deployment | Topology |
|---|---|---|
| FalkorDB (graph) | self-managed | **Redis Cluster** |
| Streams / coordination bus | GCP MemoryStore | standalone |
| Cache | GCP MemoryStore (a **different** instance) | standalone |

Each needs its own credentials and its own TLS material. The current code cannot
express that, and fails in ways that are hard to diagnose.

### 1.1 Root cause — 12 client construction sites, 1 honours the password

There are 12 non-graph Redis client construction sites. Only **two** modules
(aggregation `redis_client.py`, versioning `messaging.py`) go through the central
`build_bus_redis`. The other ten each call `from_url(...)` directly.

Consequently `REDIS_PASSWORD` / `REDIS_USERNAME` / `REDIS_TLS_*` are honoured by
exactly one client family:

| Client | file:line | reads `REDIS_PASSWORD`? | reads `REDIS_TLS_*`? |
|---|---|---|---|
| Bus / streams (`build_bus_redis`) | `common/adapters/redis_bus.py:94` | yes | yes (incl. mTLS) |
| **Token revocation** | `app/services/revocation_service.py:98` | **no** | **no** |
| **Provider cache** (`build_cache_client`) | `app/providers/falkordb_connection.py:624` | **no** (URL userinfo only) | **inherits FalkorDB's certs**, and only on a `rediss://` URL |
| **Health probe — cache** | `app/services/system_status/probes.py:101` | **no** | **no** |
| **Health probe — FalkorDB node** | `app/services/system_status/probes.py:423` | **no** | **no** |
| **Neo4j provider cache** | `graph/adapters/neo4j_provider.py:269` | **no** | **no** |
| ops scripts (×3) | `backend/scripts/*` | no | no |

**The failure the user hit:** setting `REDIS_PASSWORD` — the documented way, the way
the bus expects — makes the aggregation/versioning bus authenticate correctly while
**token revocation silently fails to authenticate**. Revocation runs on every
authenticated request. Same asymmetry for TLS: a custom CA is honoured by the bus and
ignored by revocation, the probes, and the cache.

### 1.2 Cross-role inheritance is the wrong shape

`build_cache_client` derives the cache's TLS from `cfg.tls_settings()` — *the FalkorDB
connection's* TLS — on a shared-PKI assumption, and only when the cache URL starts with
`rediss://`. Two silent mis-configurations follow:

* FalkorDB TLS **off** + `rediss://` cache → cache falls back to redis-py's system trust
  store; the operator's custom CA is ignored.
* FalkorDB TLS **on** + `redis://` cache → cache runs with **no TLS at all**.

### 1.3 Two live security defects (verified)

1. **Sentinel credentials are stored in plaintext and returned by the API.**
   `falkordbConnection.sentinel.username` / `.password` ride `providers.extra_config`,
   which is `Column(Text)` — an *unencrypted* JSON blob (`app/db/models.py:284`) — and
   `ProviderResponse.extra_config` is returned to clients
   (`common/models/management.py:345`). Every other secret lives in the Fernet-encrypted
   `providers.credentials` column and is never returned.

2. **`credentials` is replace-not-merge.** `provider_repo.py:129` does
   `row.credentials = _encrypt(req.credentials.model_dump())`. A partial update dumps
   `None` for omitted fields and **wipes them**. Adding more secrets to that blob turns a
   latent footgun into a likely one.

### 1.4 Deployment reality

No application Redis has a password or TLS in any shipped environment today; the Redis
URLs live in a **ConfigMap**, not a Secret. So this is greenfield on the deploy side —
there is no existing secret material to migrate.

## 2. Goals / non-goals

**Goals**

* Cache and streams are **separate instances** with **completely independent** hosts,
  credentials, and TLS/mTLS material.
* Secrets and cert material can be supplied **without env-only wiring**, and per provider.
* Every Redis client in every service honours auth + TLS — structurally, not by
  discipline.
* A global default cache shared by all providers; a provider may override it with a
  dedicated endpoint. One central streams bus.
* The resolved configuration is visible and testable from the Admin console.

**Non-goals**

* Redis Cluster support for cache or streams (see §6 — explicitly rejected, fail fast).
* Per-provider streams bus (see §3.2 — rejected).
* Making the global endpoints editable from the UI (deferred; see §9).

## 3. Decisions

### 3.1 Roles

Three independent roles. **No role inherits any field from another role. Ever.**

| Role | Workload | Topologies |
|---|---|---|
| `STREAMS` | job/event streams, consumer groups, DLQ, exec locks, cancel pub/sub, admission bucket, token revocation, `graph_cache` | standalone \| sentinel |
| `CACHE` | provider ancestor / URN-label / stats cache | standalone \| sentinel |
| *(graph)* | FalkorDB — unchanged, `FalkorDBConnConfig` | standalone \| sentinel \| **cluster** |

### 3.2 Streams stays central (per-provider streams rejected)

The bus is a fleet-wide coordination primitive: one `aggregation.jobs` stream, one
consumer group shared across all worker replicas, one DLQ, one admission token-bucket,
one cancel pub/sub. A per-provider bus would force every worker to discover and
`XREADGROUP` from N endpoints with N consumer groups while the DLQ and rate-limiter
remain global — a large complexity increase with no isolation benefit that ACLs on one
instance cannot provide. Per-tenant bus isolation, if ever needed, is a separate project.

### 3.3 Secrets are references, never literals in config

Global endpoints resolve their password from `*_PASSWORD` (a k8s `secretKeyRef`) or
`*_PASSWORD_FILE` (a mounted file — rotatable without a pod restart). Cert material is
supplied as **file paths** to mounted Secret volumes, one mount per role, so cache and
streams may carry entirely different PKI.

The resolved password exists only in the in-memory config object. It is never logged,
never returned by an API, and never embedded into a URL string.

Per-provider secrets live in the existing Fernet-encrypted `providers.credentials` blob.

## 4. Architecture

```
              resolve_redis_config(role, provider=None)
                 defaults → global env / file refs
                          → per-provider override (CACHE only)
                                    │
                                    ▼  RedisEndpointConfig
                        build_redis_client(cfg)
              standalone → Redis(pool)   sentinel → Sentinel.master_for()
              cluster    → RedisConfigError (fail fast)
              + ACL auth + TLS/mTLS + pool knobs
                                    │
   ┌──────────┬──────────┬──────────┼──────────┬───────────┬──────────┐
 streams   versioning  revocation graph_cache  provider   probes    neo4j
  bus       messaging  (was: no    fair_share   cache     (was: no   cache
                        auth)      jobs/*      (was:       auth)
                                              FalkorDB
                                               certs)
```

New module: `backend/common/adapters/redis_endpoint.py` — the dataclass, the resolver,
and the factory. It is the **only** place a non-graph Redis client is constructed.

### 4.1 `RedisEndpointConfig`

Deliberately shaped like `FalkorDBConnConfig` so there is one mental model for all three
endpoints.

```python
class RedisRole(str, Enum):
    STREAMS = "streams"
    CACHE   = "cache"

@dataclass(frozen=True)
class RedisEndpointConfig:
    role: RedisRole
    mode: str = "standalone"              # standalone | sentinel   (cluster → error)
    host: str = "localhost"
    port: int = 6379
    db: int = 0
    username: Optional[str] = None        # ACL user
    password: Optional[str] = None        # resolved from a ref; never persisted here
    sentinel_master: Optional[str] = None
    sentinel_nodes: List[Tuple[str, int]] = field(default_factory=list)
    sentinel_username: Optional[str] = None
    sentinel_password: Optional[str] = None
    sentinel_auth_enabled: bool = False
    tls: TLSSettings = TLSSettings()      # OWN certs — never another role's
    max_connections: int = 20
    socket_timeout: float = 10.0
    socket_connect_timeout: float = 5.0
    health_check_interval: int = 30

    def describe(self) -> str: ...        # redacted, safe to log
    def identity(self) -> tuple: ...      # client-cache key; password hashed, never raw
```

Reuses the existing `TLSSettings` / `tls_client_kwargs` / `build_ssl_context` from
`backend/common/adapters/redis_tls.py` unchanged.

## 5. Configuration reference

Role-prefixed and **disjoint** — a cache secret cannot leak into the streams client.

```
REDIS_STREAMS_MODE                 standalone | sentinel
REDIS_STREAMS_HOST / _PORT / _DB
REDIS_STREAMS_USERNAME
REDIS_STREAMS_PASSWORD             ← secretKeyRef
REDIS_STREAMS_PASSWORD_FILE        ← mounted file (wins over _PASSWORD)
REDIS_STREAMS_TLS_ENABLED
REDIS_STREAMS_TLS_CA_CERTS / _CERTFILE / _KEYFILE / _CERT_REQS / _CHECK_HOSTNAME
REDIS_STREAMS_SENTINEL_MASTER / _NODES / _USERNAME / _PASSWORD / _PASSWORD_FILE / _AUTH_ENABLED
REDIS_STREAMS_MAX_CONNECTIONS / _SOCKET_TIMEOUT / _SOCKET_CONNECT_TIMEOUT / _HEALTH_CHECK_INTERVAL

REDIS_CACHE_*                      the same set, entirely independent
```

### 5.1 Precedence

```
CACHE:    provider.extra_config.cacheConnection (+ encrypted creds)
       →  REDIS_CACHE_*
       →  CACHE_REDIS_URL            (legacy, deprecated)
       →  fail fast in deployed roles

STREAMS:  REDIS_STREAMS_*
       →  REDIS_URL + REDIS_PASSWORD / REDIS_USERNAME / REDIS_TLS_*   (legacy)
       →  fail fast in deployed roles
```

Back-compat is **one-directional and role-scoped**: the legacy vars resolve *only* to the
role they always meant. `REDIS_URL` and the unprefixed `REDIS_PASSWORD` / `REDIS_TLS_*`
map to `STREAMS`; `CACHE_REDIS_URL` maps to `CACHE`. Nothing is shared across roles.
Role-prefixed vars win when both are present. Existing deployments keep booting unchanged;
a deprecation warning names the legacy var and its replacement.

### 5.2 Per-provider cache override

Whole-endpoint, **not** field-merge. A provider that specifies `cacheConnection` supplies
the complete spec; it inherits neither the global cache's credentials nor FalkorDB's
certs. Half-inherited credentials are exactly the failure class being removed. A provider
with no `cacheConnection` uses the global default in full.

```jsonc
// providers.extra_config — PLAINTEXT, returned by the API. NO SECRETS.
"cacheConnection": {
  "mode": "standalone" | "sentinel",         // "cluster" → 422 at the request boundary
  "host": "cache-b.internal", "port": 6379, "db": 0,
  "sentinel": { "masterName": "m", "nodes": [["h", 26379]] },
  "tls": { "enabled": true,
           "caCertPath": "/certs/cache-b/ca.crt",
           "certPath":   "/certs/cache-b/client.crt",
           "keyPath":    "/certs/cache-b/client.key",
           "verifyMode": "required", "checkHostname": true }
}

// providers.credentials — FERNET-ENCRYPTED, never returned
{
  "cache_username": "...", "cache_password": "...",
  "cache_sentinel_username": "...", "cache_sentinel_password": "...",
  "sentinel_password": "...", "sentinel_username": "..."   // moved out of extra_config
}
```

Legacy `credentials.cache_redis_url` continues to resolve to a `CACHE` config. The UI
stops writing it; a deprecation surfaces in the Admin console (§8).

## 6. Cluster policy — explicit, fail fast

Cluster is **rejected** for `STREAMS` and `CACHE`, with an error naming the reason.
`build_bus_redis` already does this for the bus; the same policy now covers the cache.
Cluster remains **FalkorDB-only**.

This is not laziness — the cache genuinely cannot run clustered today:

* `app/services/graph_cache.py:412-420` — `SCAN MATCH <pattern>` + variadic `DEL *keys`:
  cross-slot, and `SCAN` needs per-node iteration on a cluster.
* `app/jobs/brokers/redis_streams.py:83` — a pipeline that `XADD`s to **two different
  keys** (`job:events:<job_id>` and `job:tenant:<workspace_id>`) with **no hash tag**:
  cross-slot.
* No key anywhere uses a hash tag.
* Both production URLs use DB index **`/1`** — Redis Cluster supports DB 0 only.

Supporting a clustered cache means fixing all of the above. It is a scoped follow-up, not
a silent half-support.

## 7. Migration of the 12 construction sites

| Site | Change |
|---|---|
| `common/adapters/redis_bus.py` `build_bus_redis` | becomes a thin wrapper over `build_redis_client(STREAMS)`; existing callers and `test_bus_redis.py` keep working |
| `services/aggregation/redis_client.py:104` | unchanged (goes via the wrapper) |
| `services/versioning/messaging.py:40` | unchanged (goes via the wrapper) |
| **`services/revocation_service.py:98`** | → `build_redis_client(STREAMS)`. **Gains auth + TLS — the primary bug fix.** Also drops its divergent default (`:6379/0` vs the bus's `:6380/0`) |
| **`providers/falkordb_connection.py:624` `build_cache_client`** | → `build_redis_client(CACHE, provider=...)`. Stops borrowing FalkorDB's certs; gains its own username/password + TLS |
| `providers/falkordb_connection.py:668` `build_cache_redis_fallback` | **delete** — dead code, always returns `None`, no production callers |
| **`services/system_status/probes.py:101`** (cache probe) | → `build_redis_client(CACHE)` |
| **`services/system_status/probes.py:423`** (FalkorDB node probe) | → use the FalkorDB config's auth + TLS, so probes can talk to an authenticated instance |
| `graph/adapters/neo4j_provider.py:269` | → `build_redis_client(CACHE, provider=...)`; `extra_config["redisUrl"]` becomes a legacy alias |
| `scripts/*` (×3) | unchanged behaviour (already `assert_standalone_env`-guarded); pick up auth from the resolver |

### 7.1 Startup validation

Replaces `ProviderManager._assert_dedicated_cache_configured`, which only checks the *env*
`CACHE_REDIS_URL` and therefore fails a deployment that configures the cache purely
per-provider.

Each deployed role validates the roles it actually uses and **fails fast**, naming the
role, the resolved host, and what is missing. Never a silent cache-off, never a silent
unauthenticated connect. Dev degrades gracefully as today.

## 8. Admin surface — read-only diagnostics

New `Admin › System › Redis` entry in `adminGroups` (`frontend/src/pages/AdminPage.tsx`),
between *Infrastructure* and *Branding*. Global endpoints stay deploy-managed; the console
makes them **visible, attributable, and testable** — which is what is missing today.

Backend: `GET /api/v1/admin/redis/config` returns, per role, the **resolved** config with
provenance and **redacted** secrets, plus live health. `POST /api/v1/admin/redis/{role}/test`
performs a bounded connect + `PING` + `INFO` and reports the precise failure
(`NOAUTH` / `WRONGPASS` / TLS verify failure / unreachable / cert file unreadable).

Shown per role:

* status pill (healthy / degraded / down), mode, resolved host:port, db
* **provenance** for every field — which env var or file it came from, or which provider
  overrode it (`REDIS_CACHE_HOST`, `← _PASSWORD_FILE`, `provider "acme-prod"`)
* auth: username + `••••`, and *where the secret came from* — never the value
* TLS: on/off, mutual or not, cert paths, and **whether each cert file is readable by the
  process** (a common, invisible mis-mount)
* cache only: how many providers use a dedicated cache override, linking to them
* a deprecation banner listing providers still on legacy `cache_redis_url`, and any
  deployment still on legacy `REDIS_URL` / `CACHE_REDIS_URL`

Provider onboarding wizard (`ProviderOnboardingWizard.tsx`): the free-text
*"Dedicated cache Redis URL (optional)"* input is replaced by a structured
**Dedicated cache** panel mirroring the existing FalkorDB TLS/sentinel panels —
mode, host, port, db, username, password, and a TLS/mTLS sub-panel. Existing providers
with a legacy URL render read-only with a one-click *"Convert to structured config"*.

## 9. Security fixes carried by this work

1. **Move sentinel credentials into the encrypted blob.** `sentinel.username` /
   `sentinel.password` migrate from `extra_config.falkordbConnection.sentinel` into
   `providers.credentials`. The old location is read for one release (with a warning), then
   dropped.
2. **Redact `extra_config` on the way out.** A deny-list pass on `ProviderResponse` strips
   any key matching `password` / `secret` / `token` so no future key can leak the same way.
3. **`credentials` becomes merge-not-replace.** Omitted key = keep existing; explicit
   `null` = clear. Prevents an admin editing the cache host from silently wiping the
   FalkorDB password.
4. **Move the Redis URLs out of the ConfigMap** into the `app-secrets` Secret, since they
   will now carry credentials.

## 10. Deployment

* New k8s Secret keys (per role): `REDIS_STREAMS_PASSWORD`, `REDIS_CACHE_PASSWORD` —
  or mounted files when `*_PASSWORD_FILE` is used.
* Two cert Secrets + mounts, one per role, so the two instances may use different PKI:
  `/certs/streams/{ca.crt,client.crt,client.key}` and `/certs/cache/...`.
* Add the new vars to the `envsubst` pipeline (`deploy/k8s/Makefile` `ENVSUBST_VARS`) and
  `.env.deploy.example`.
* Compose dev: keep the single unauthenticated Redis (two DB indices) working via the
  legacy vars — **zero-config dev is preserved**.
* A `deploy/topologies/` harness with an **authenticated + TLS** Redis for cache and a
  **separately authenticated + TLS** Redis for streams, to prove independence end to end.

## 11. Testing

* **Unit** — resolver precedence (per-provider > role-prefixed > legacy > fail-fast);
  role isolation (a cache password must never appear in a streams client, and vice versa);
  cluster → fail fast for both roles; `_PASSWORD_FILE` beats `_PASSWORD`; legacy vars map
  to the correct role only.
* **Regression tripwires** — a test that constructs every client and asserts each one
  carries the role's auth + TLS. This is the test that would have caught the revocation
  bug, and it fails if a future client is added outside the factory.
* **Security** — sentinel password is never present in a `ProviderResponse`;
  `extra_config` redaction; a partial credentials update does not wipe other secrets.
* **Live** — the two-instance authenticated+TLS harness from §10: prove the streams client
  authenticates to instance A with CA-A while the cache authenticates to instance B with
  CA-B, and that swapping either credential fails *only* that role.

## 12. Rollout

Back-compatible by construction: every existing env var keeps working and maps to the role
it always meant. No deployment change is required to keep running. Adopting auth/TLS is
opt-in per role.

## 13. Deferred

* Editable (DB-backed) global Redis config in the Admin console.
* Redis Cluster support for the cache (requires the §6 fixes).
* Per-tenant streams bus isolation.
