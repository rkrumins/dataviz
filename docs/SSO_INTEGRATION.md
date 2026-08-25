# SSO Integration Guide

> **Team-facing developer + operator guide.** Read this end-to-end on
> day one; keep it open as you build on top of, debug, or audit the
> auth surface. **Pairs with** the [SSO operator reference](/docs/sso).
> When the same topic appears in both, this doc focuses
> on *how to integrate* and *how to debug*; the operator reference focuses on *what
> exists* and *how to operate*. Role names throughout come from the
> [RBAC taxonomy](/docs/rbac).

> Covers the current auth surface: local password auth plus OIDC + SAML2,
> DB-backed IdP providers, multi-identity per user, configurable claim
> mapping, and the admin/self-service identity surfaces.

---

## Table of contents

| # | Section | What you'll find |
|---|---------|------------------|
| 1 | [Orientation](#1-orientation) | How to read this doc + cross-ref matrix |
| 2 | [Developer setup (Day 1)](#2-developer-setup-day-1) | Cold-start to first successful login |
| 3 | [Architecture](#3-architecture) | Component map + module boundaries + bootstrap |
| 4 | [Core concepts](#4-core-concepts) | User/Identity model, policies, reconciliation invariants |
| 5 | [User journeys](#5-user-journeys-sequence-diagrams) | 15 sequence diagrams of every flow |
| 6 | [Backend integration cookbook](#6-backend-integration-cookbook) | 8 recipes with file:line refs |
| 7 | [Frontend integration cookbook](#7-frontend-integration-cookbook) | 7 recipes for consumers |
| 8 | [Testing strategy](#8-testing-strategy) | Fixtures + stub patterns + smoke flow |
| 9 | [Operational runbooks](#9-operational-runbooks) | 7 failure-mode playbooks |
| 10 | [Threat model](#10-threat-model--security-boundaries) | What we defend, what we don't |
| 11 | [Reference tables](#11-reference-tables) | Quick-lookup: cookies, endpoints, events, env, schema |
| 12 | [Glossary](#12-glossary) | One canonical definition per term |

---

## 1. Orientation

### 1.1 Who this is for

* **Backend developers** integrating new endpoints, claim mappings,
  IdP kinds, audit events, or admin surfaces.
* **Frontend developers** consuming the auth state (user, identities,
  permissions) and handling its failure modes (401, 403, SSO re-auth).
* **Support / SRE engineers** debugging end-user reports and running
  the operational runbooks in §9.
* **Security reviewers** auditing the trust boundaries in §10 and the
  reference tables in §11.

### 1.2 How to read it

| If you're… | Read in this order |
|------------|--------------------|
| Joining the team and want to learn auth | §1 → §2 → §3 → §4 → skim §5 → §6 or §7 as your area |
| Building a new feature on top of SSO | §4 → §5 (the journeys closest to your feature) → §6 / §7 cookbook |
| Reviewing a PR that touches auth | §3.2 (isolation) → §10 (threat model) → §11 (reference) |
| On call for an SSO outage | §9 → cross-check with `SSO.md §2` |

### 1.3 Cross-reference matrix with `SSO.md`

| If you want… | Look in… |
|--------------|----------|
| "How do I configure an Entra IdP as an operator?" | `SSO.md §2.1` |
| "How does `complete_sso_login` decide whether to JIT or link?" | this doc, §4.3 + §5.2–5.4 |
| "What test suites cover this branch?" | `SSO.md §3.1` |
| "Where is the source of truth for the `users` ORM?" | this doc, §11.5 + `app/db/models.py:858` |
| "What's the planned follow-up (SCIM, KMS, …)?" | `SSO.md §4` |
| "How do I run pytest against the new tables?" | this doc, §8 + §2.5 |
| "I just got a 401 with sso_reauth_required — what now?" | this doc, §7.4 + §5.9 |

---

## 2. Developer setup (Day 1)

### 2.1 Prerequisites

| Tool | Version | Why |
|------|---------|-----|
| Python | 3.13 | Backend runtime |
| Postgres | 16 | Management DB (auth + RBAC + outbox + audit) |
| Redis | 7 | Refresh-token revocation set + SAML replay cache |
| Node.js | 20 LTS | Frontend (vite + react 19) |
| FalkorDB | 1.4 (optional) | Only for graph features; auth works without it |

`.env.dev` (sourced automatically by `auth_service.core.config`,
see `SSO.md §2.0`) needs:

```bash
JWT_SECRET_KEY=<48+ chars; generate via python -c 'import secrets; print(secrets.token_urlsafe(48))'>
ENV=dev
MANAGEMENT_DB_URL=postgresql+asyncpg://synodic:synodic@localhost:5432/synodic
REDIS_URL=redis://localhost:6379/0
AUTH_CUSTOM_PROVIDER_ENABLED=true     # enables the dev IdP
VITE_AUTH_CUSTOM_PROVIDER_ENABLED=true # exposes the /dev-login route
CREDENTIAL_ENCRYPTION_KEY=<base64 Fernet key; for encrypting IdP settings>
```

Generate the Fernet key once:

```bash
python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

### 2.2 Cold-start sequence

```bash
# 1. Clone + install
git clone <repo> && cd synodic
python3.13 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
(cd frontend && npm install)

# 2. Drop the dev env file
cp .env.example .env.dev      # then edit JWT_SECRET_KEY + CREDENTIAL_ENCRYPTION_KEY

# 3. Start infra (Postgres + Redis) — assumes docker-compose.dev.yml
./dev.sh up infra              # or docker-compose -f docker-compose.dev.yml up postgres redis

# 4. Apply migrations (Phase 0-4 chain, ends at 20260530_1200_display_rules)
python -m backend.scripts.upgrade upgrade
python -m backend.scripts.upgrade check      # must exit 0

# 5. Start backend
uvicorn backend.app.main:app --reload

# 6. Start frontend (separate shell)
cd frontend && npm run dev
```

### 2.3 First login via the dev IdP

The custom (dev) IdP is a signed-cookie mock that simulates an
enterprise IdP returning AD-style attributes. With
`AUTH_CUSTOM_PROVIDER_ENABLED=true`:

1. Open <http://localhost:5173/login> in your browser.
2. Click **Dev Login (mock IdP)** under the password form.
3. Fill in the form:
   * `external_id`: `S-1-5-21-1001`
   * `email`: `alice@dev.local`
   * `first_name`: `Alice`
   * `last_name`: `Dev`
   * `groups`: `DataViz-Admins, Eng-All`
   * `claims (JSON)`: `{"department": "Eng", "staff_id": "12345"}`
4. Submit. Browser is redirected back to `/dashboard`, logged in as
   Alice.
5. Visit `/me/identities` to see the linked identity.
6. Visit `/admin/sso/users` (Find user tab) to see Alice's signup
   provenance pill (`sso_jit` via `default-custom`) and her indexed
   attributes (`staff_id=12345`, `department=Eng`).

If anything fails, see §9.1.

### 2.4 Three smoke checks

```bash
# A. Auth-service unit + integration tests (≈8 s)
JWT_SECRET_KEY=$(python -c 'import secrets;print(secrets.token_urlsafe(48))') \
  PYTHONPATH=. pytest backend/tests/test_sso_phase{2,3,4}.py \
    backend/tests/test_oidc_provider.py \
    backend/tests/test_auth_cookie_flow.py -q

# B. Auth-service isolation regression (≈2 s)
JWT_SECRET_KEY=… pytest backend/tests/test_auth_service_isolation.py

# C. Frontend store tests (≈2 s)
cd frontend && npx vitest run src/store/
```

Expected: A → 96 passed · B → 18 passed · C → 19 passed.

### 2.5 IDE setup

| Concern | Recipe |
|---------|--------|
| Pytest discovery | Point at `backend/tests`; set `PYTHONPATH=.` in the run config. JWT_SECRET_KEY must be set per invocation. |
| Type checking (frontend) | `npx tsc --noEmit -p tsconfig.json` — the pre-existing TS errors in canvas/property code are tracked in `TECHNICAL_DEBT.md`; don't fix them here. |
| Type checking (backend) | None enforced; comments are the contract. |
| Pytest watch | `ptw backend/tests/test_sso_*.py` (install `pytest-watch`). |
| Linting | None enforced in CI for this branch; prefer functional changes over style changes. |

---

## 3. Architecture

### 3.1 Component map

```mermaid
graph TB
    subgraph Browser
        FE[React 19 + Vite frontend]
        Cookies[(HttpOnly cookies<br/>nx_access / nx_refresh / nx_csrf<br/>+ flow cookies)]
    end

    subgraph "Process: viz-service (uvicorn)"
        subgraph auth_service["backend/auth_service/ (isolation-locked)"]
            ASRouter[api/router.py<br/>/auth/*]
            ASCore[core/config.py<br/>core/tokens.py<br/>core/password.py]
            ASProv[providers/<br/>oidc / saml2 / custom<br/>custom_profile / backchannel / local<br/>claim_mapper + registry]
            ASSvc[service.LocalIdentityService<br/>orchestrates login/refresh/SSO]
            ASCfg[app_auth_config.py<br/>posture switches accessor]
        end

        subgraph app["backend/app/ (DB + RBAC + endpoints)"]
            AppRoutes[api/v1/endpoints/<br/>admin_idp_*, me_identities, …]
            AppRepos[db/repositories/<br/>user, user_identity, user_attribute,<br/>idp_provider, idp_group_mapping,<br/>app_auth_config, binding, …]
            AppSvc[services/<br/>permission_service.reconcile_sso_targets<br/>revocation_service<br/>outbox_relay]
        end

        ASSvc -.injected.-> AppRepos
        ASSvc -.injected.-> AppSvc
        ASRouter --> ASSvc
        AppRoutes --> AppRepos
        AppRoutes --> ASSvc
    end

    PG[(Postgres 16<br/>users, user_identities,<br/>idp_providers, app_auth_config,<br/>role_bindings, group_members,<br/>auth_audit_log, outbox_events, …)]
    Redis[(Redis 7<br/>rbac:revoked:* sids<br/>rbac:user_sids:* index<br/>saml:asid:* replay)]
    IdP[Enterprise IdP<br/>OIDC / SAML / 'custom']

    FE <--> ASRouter
    FE <--> AppRoutes
    FE <--> Cookies
    FE <-->|browser redirect| IdP
    AppRepos <--> PG
    AppSvc <--> Redis
    ASSvc <-->|jwks fetch / SAML cert| IdP
```

Two source trees, one process. The auth_service is intentionally
isolated from `backend.app` (enforced by
`test_auth_service_isolation`) so it can be lifted into a separate
microservice without rewriting consumers; every DB-side concern is
**injected** via constructor (`user_repo`, `user_identity_repo`,
`refresh_store_factory`, `outbox_emit`, `claims_resolver`,
`sso_role_reconciler`, `sso_role_preview`, `session_killer`,
`auth_config_provider`, `email_domain_resolver`, `assertion_recorder`).

### 3.2 Module-boundary contract (isolation)

* `backend/auth_service/**/*.py` must never import from
  `backend.app.*`. Enforced by
  `backend/tests/test_auth_service_isolation.py` via AST inspection.
* The local provider (email + password) is registered through the
  Phase-2 compat shim `register_provider("local", …)`.
* SSO providers are materialised per `idp_providers` row by the
  registry (`auth_service/providers/registry.py`); the registry's
  loader Protocol is implemented in `backend/app/main.py` as a
  closure that hits the repo.
* New cross-cutting concerns that the auth_service needs (e.g.
  the Phase 4 `app_auth_config`) follow the same pattern:
  1. Define the DTO + Protocol in `auth_service/`.
  2. Implement the concrete loader in `app/` (closure over a
     session_factory).
  3. Inject at app startup in `app/main.py`.

A failing isolation test means a future developer has added an
import the extractable service can't carry. Roll it back and use
injection instead.

### 3.3 Per-request data flow — OIDC happy path

```mermaid
sequenceDiagram
    autonumber
    actor User as Browser
    participant FE as React SPA
    participant Auth as /auth/{slug}/...
    participant Svc as LocalIdentityService
    participant Reg as ProviderRegistry
    participant Repo as user_identity_repo
    participant DB as Postgres
    participant Outbox as outbox_events
    participant IdP as OIDC IdP

    User->>FE: visit /login
    FE->>Auth: GET /api/v1/auth/providers
    Auth->>Reg: list_enabled()
    Reg->>DB: SELECT * FROM idp_providers WHERE enabled=TRUE
    DB-->>Reg: rows
    Reg-->>Auth: ProviderConfigSnapshot[]
    Auth-->>FE: [{slug:"entra-staff", displayName:"…"}, …]
    FE-->>User: render login form + SSO buttons

    User->>Auth: GET /auth/entra-staff/login?next=/dashboard
    Auth->>Reg: resolve_slug + get()
    Reg-->>Auth: OidcProvider instance
    Auth->>IdP: redirect (authorization_endpoint + PKCE + state + nonce)
    Auth-->>User: 302 + Set-Cookie: nx_oidc (signed JWT)
    User->>IdP: present credentials
    IdP-->>User: 302 -> /auth/entra-staff/callback?code=…&state=…
    User->>Auth: GET /callback
    Auth->>Auth: read nx_oidc cookie, verify state, CSRF
    Auth->>IdP: POST /token (code, code_verifier)
    IdP-->>Auth: id_token + access_token
    Auth->>Auth: verify ID token (JWKS, iss, aud, exp, nonce, at_hash)
    Auth->>Auth: claim_mapper.apply_claim_mapping(claims, mapping)
    Auth->>Svc: complete_sso_login(identity, provider_id, slug, policy)
    Svc->>Repo: get_by_subject(provider_id, external_id)
    alt subject known
        Repo-->>Svc: existing identity row
        Svc->>Repo: touch_last_login
    else subject new + email free
        Svc->>DB: INSERT users (signup_source='sso_jit')
        Svc->>Repo: create_identity(...)
    else collision + policy allows
        Svc->>Repo: create_identity(user_id=existing.id, ...)
    end
    Svc->>DB: set_user_idp_metadata (idp_groups + attributes JSON)
    Svc->>DB: user_external_attributes upsert (staff_id, department, ...)
    Svc->>DB: reconcile_sso_targets (role_bindings + group_members)
    Svc->>Outbox: emit "user.sso_provisioned" or "user.logged_in"
    Svc-->>Auth: (User DTO, SessionTokens)
    Auth-->>User: 302 -> /dashboard + Set-Cookie: nx_access/nx_refresh/nx_csrf
```

Same shape applies to SAML (POST binding to `/{slug}/acs`) and the
custom IdP (cookie validation in `/{slug}/login`).

### 3.4 Trust boundaries — what's signed / encrypted / where

| Asset | Mechanism | Where |
|-------|-----------|-------|
| Access JWT | HS256 with `JWT_SECRET_KEY` | `auth_service/core/tokens.py:create_access_token` |
| Refresh JWT | HS256 with `JWT_SECRET_KEY` + `auth_time` claim for SSO | same |
| CSRF token | HMAC-bound nonce; double-submit | `auth_service/csrf.py` |
| OIDC state/nonce/PKCE | signed JWT cookie `nx_oidc` | `tokens.create_oidc_state_token` |
| SAML RelayState + next_path | signed JWT cookie `nx_saml` | `tokens.create_saml_state_token` |
| Custom IdP payload | signed JWT cookie `nx_mock_identity` | `tokens.create_mock_identity_token` |
| Self-service link intent | signed JWT cookie `nx_link_intent` | `tokens.create_link_intent_token` |
| IdP provider secrets (`client_secret`, `sp_private_key`) | Fernet-encrypted in `idp_providers.settings` | `idp_provider_repo.encrypt_settings` using `CREDENTIAL_ENCRYPTION_KEY` |
| Workspace data-source creds | same Fernet envelope | `connection_repo._get_fernet` |
| User password | argon2id; SSO-only users carry a sentinel | `auth_service/core/password.py` |
| SAML IdP cert | plaintext (signature verification material) | per-provider `settings.idp_x509_cert` |
| Audit events | append-only with `source_event_id` UNIQUE | `auth_audit_log` table |

Two trust boundaries:

* **Browser ↔ backend** — closed by HttpOnly cookies (browser never
  exposes them to JS) + CSRF double-submit (closed for writes) +
  open-redirect guards (`_safe_next` only accepts same-site
  relative paths).
* **Backend ↔ IdP** — closed by JWKS verification (OIDC) or x509
  signature + replay cache (SAML). For the custom IdP the
  "external" side is our own signed cookie, which only matters
  in dev because the gate refuses to load in prod.

### 3.5 Bootstrap sequence

Bootstrapping order (the `app.main.lifespan` entry point):

1. Import-time: `auth_service/core/config.py` runs — `.env.dev`
   gated auto-load, then `_resolve_secret()` reads
   `JWT_SECRET_KEY`. Process refuses to start if missing.
2. App startup:
   1. DB engines + session factory wired (`app/db/engine.py`).
   2. `register_provider("local", LocalIdentityProvider())`.
   3. `ProviderRegistry` configured with a DB-backed loader closure;
      env-bootstrap seeds `default-oidc` / `default-saml2` /
      `default-custom` rows from legacy env vars if no row exists.
      `custom_profile` and `backchannel` have no env seed — they are
      created through the admin UI only.
   4. `AuthConfigProvider` (Phase 4) wired as a TTL-cached closure
      over `app_auth_config_repo.get_snapshot`.
   5. `LocalIdentityService` constructed with every injected hook
      (user_repo, user_identity_repo, refresh_store_factory,
      outbox_emit, claims_resolver, sso_role_reconciler,
      sso_role_preview, session_killer, auth_config_provider,
      email_domain_resolver, assertion_recorder).
   6. `_app.state.identity_service = …` makes it reachable from
      every route via `request.app.state.identity_service`.
3. FastAPI mounts `auth_session_router` at `/api/v1/auth` and
   every admin router under `/api/v1/admin/*`.

   7. The IdP health loop is started **only if `runs_scheduler()`** —
      see §3.6.

If you ever touch the bootstrap order, run the auth suite — most
isolation regressions surface as `RuntimeError("IdentityService not
configured on app.state")` or `RuntimeError("ProviderRegistry not
configured")` on the first request.

### 3.6 The IdP health plane is a background loop, not a fan-out

`GET /admin/idp-providers/status` **opens no sockets**. It reads
`app.state.idp_health_cache`, which a background task
(`app/services/idp_health.py`) refills every 15 minutes.

Three constraints shaped that, and each one is load-bearing:

* **Not a frontend sweep.** `useProviderHealthSweep` deliberately has *no*
  interval — the mount-time fan-out was removed as a P0.4 regression
  ("this storm hit the backend on every cold boot"). Doing it for IdPs
  would re-introduce a bug this codebase already paid for. Mirror the
  provider-warmup architecture instead.
* **Gated on `runs_scheduler()`**, so N replicas do not run N sweeps
  against the same IdPs.
* **Shutdown via `await asyncio.wait_for(shutdown.wait(), timeout=interval)`**,
  the idiom from `outbox_relay.py` — not a bare `asyncio.sleep`, which
  would make every deploy wait out the interval.

A replica that runs no schedulers serves an empty cache. That is expected:
the provider list must render regardless, so the frontend treats the health
read as separate and non-fatal.

Certificate expiry must be computed **server-side** — `idp_x509_cert` is a
secret field and is redacted on read, so the UI cannot parse it. Note
`_normalise_cert()` returns headerless base64, so the parse path is
`load_der_x509_certificate(b64decode(body))`, not the PEM loader.

---

## 4. Core concepts

### 4.1 User vs Identity (1:N)

In Phase 2 the user row carried `(auth_provider, external_id)`. In
Phase 3 we normalised that into `user_identities`. Read the schema
section §11.5 for the columns.

```
┌─────────────┐         ┌──────────────────┐         ┌──────────────┐
│   users     │ 1     N │ user_identities  │ N     1 │ idp_providers│
│             │─────────│ (provider_id,    │─────────│              │
│ id, email,  │         │  external_id,    │         │ id, slug,    │
│ password,   │         │  user_id, …)     │         │ kind,        │
│ status      │         │                  │         │ settings,    │
└─────────────┘         └──────────────────┘         └──────────────┘
       │
       │ 1                                     N
       ├──────────────────────────┐
       │                          │
       v                          v
┌─────────────────────────┐  ┌─────────────────────────┐
│ user_external_attributes│  │ user_roles / role_      │
│ (staff_id=12345, …)     │  │ bindings / group_members│
└─────────────────────────┘  └─────────────────────────┘
```

* "Has password?" → `is_password_set(user.password_hash)` from
  `auth_service/core/password.py` (the sentinel literal vs an
  argon2 hash).
* "Has SSO?" → `EXISTS(user_identities WHERE user_id=?)`.
* "Linked to a specific IdP?" → query `(user_id, provider_id)` —
  UNIQUE is enforced.

### 4.2 Signup source taxonomy

| `signup_source` | Set when | `signup_provider_id` |
|-----------------|----------|----------------------|
| `local_signup` | `create_user` (legacy signup, default) | NULL |
| `sso_jit` | `create_sso_user` in `complete_sso_login` JIT branch | the JIT provider |
| `invite` | Phase-0 signup via invite token (shape-ready; flow not in scope) | NULL or invite-creator's IdP |
| `admin_created` | Admin endpoint creates a user manually (shape-ready) | NULL |
| `admin_linked` | Admin `POST /admin/users/{id}/identities` on a user with no prior signup_source | the linked provider |

The column is CHECK-constrained. Migrations backfill existing rows:
users with an existing identity get `sso_jit` + the earliest
identity's provider; everyone else stays `local_signup`. See
`backend/alembic/versions/20260527_1200_sso_phase4.py`.

### 4.3 Linking policy matrix

Per-provider; controls what happens when an SSO subject lands and
the email collides with an existing user.

| Policy | Auto-link condition | Otherwise |
|--------|---------------------|-----------|
| `strict` (default) | `email_verified=true` AND existing account is local AND active AND has no other SSO identity | `SSOAuthError("unsafe_auto_link")` + audit |
| `allow_verified` | `email_verified=true` AND existing account is active (existing identities are OK) | same |
| `manual_only` | never (user must initiate from `/me/identities`) | same |
| `disabled` | never (and existing-email also blocks JIT) | same |

`complete_sso_login` builds a `deny_reasons` list and dumps it into
the `user.sso_link_denied` outbox event when it fires — that's the
audit query when a user reports "SSO bounced me back to the
collision modal". See §5.4 + §9.1.

### 4.4 Mapping target shapes (`role_binding` vs `group_membership`)

`idp_group_role_mappings.target_type`:

| Target | Required columns | Reconciler effect |
|--------|------------------|-------------------|
| `role_binding` | `scope_type, scope_id, role_name` | Insert/expire `RoleBindingORM` with `source='sso'` |
| `group_membership` | `target_group_id` | Insert/delete `GroupMemberORM` with `source='sso'` |

`group_membership` is the recommended pattern for enterprise
operators: IdP groups map to internal Groups; internal Groups
carry the actual `RoleBinding`s. That way an internal Group rename
is invisible to the IdP, and internal admins can manage memberships
freely without IdP coordination.

### 4.5 Refresh rotation + auth_time invariant

The refresh JWT carries:

* `sub` — user id
* `jti` — unique per token; consumed on `/refresh`
* `fam` — family id; persists across rotations
* `exp` — wall-clock expiry (7 days)
* `auth_time` — IdP-issued epoch (SSO only); propagates **unchanged**
  through every rotation

When `/refresh` runs:

1. Validate `jti` not seen before. If it has, **revoke the entire
   family** — reuse-detection (`refresh.check_and_record_rotation`).
2. If the user is SSO (`auth_time IS NOT NULL`) and
   `now - auth_time > SSO_SESSION_MAX_AGE_SECONDS`:
   * Revoke family.
   * Kill all live access tokens (`session_killer`).
   * Emit `user.sso_session_expired`.
   * Raise `SsoReauthRequired(login_url=…)` — router returns 401
     with structured body the frontend follows.
3. Re-run the reconciler (`reconcile_sso_targets`) against the
   cached `users.metadata_.idp_groups` snapshot — admin mapping
   changes propagate within one refresh cycle.
4. Mint the new (access, refresh, csrf) tokens; propagate
   `auth_time` unchanged.

### 4.6 Reconciliation runs on login AND refresh

This is the design choice that separates this implementation from
"login-only" reconcilers (which most enterprise SaaS ship). At login
we have fresh IdP groups; at refresh we use the cached snapshot from
the user's last login. The cost is constant — O(matched mappings)
per user per refresh — and the win is that admin mapping changes are
visible to active sessions within ≤ refresh interval (≈ 5 minutes
by default).

Operators who want immediate revocation use the per-user
`revocation_service.revoke_all_user_sessions` (the same hook the 24h
re-auth path uses).

### 4.7 Claim attribute provenance

Every key written to `user_external_attributes` records its
`source_provider_id`. When two IdPs both assert `staff_id` for the
same user, the most recent login wins — `set_user_idp_metadata`
calls the upsert path which updates `value` + `source_provider_id`
+ `set_at` atomically. The audit trail (`auth_audit_log`) carries
the rest.

---

## 5. User journeys (sequence diagrams)

Every diagram is paired with a 1-paragraph prose walk-through so
markdown viewers without mermaid still render usable content.

### 5.1 Local password login

```mermaid
sequenceDiagram
    actor U as User
    participant FE as React
    participant R as /auth/login
    participant Svc as LocalIdentityService
    participant Local as LocalIdentityProvider
    participant DB as Postgres
    U->>FE: enter email + password
    FE->>R: POST /api/v1/auth/login {email, password}
    R->>Svc: login(email, password)
    Svc->>Svc: auth_config.get() — allow_local_login?
    alt allow_local_login = false
        Svc-->>R: raise LocalLoginDisabled
        R-->>FE: 403 {"error":"local_login_disabled"}
    else allow_local_login = true
        Svc->>Local: authenticate(email, password)
        Local->>DB: get_user_by_email
        DB-->>Local: user row
        Local->>Local: verify_password (argon2id)
        Local-->>Svc: ProviderIdentity(local, sub=user.id, …)
        Svc->>DB: get_user_roles
        Svc->>Svc: claims_resolver -> PermissionClaims
        Svc->>DB: outbox "user.logged_in" (provider=local)
        Svc-->>R: (User, SessionTokens)
        R-->>FE: 200 + Set-Cookie nx_access/nx_refresh/nx_csrf
    end
```

Walkthrough: the local provider is the only one that does
credential verification inline; SSO providers verify the IdP's
assertion. The platform posture toggle (`allow_local_login`) gates
this path before the provider runs, so timing is constant when the
toggle is off — no oracle for "does this email exist?".

### 5.2 OIDC SSO — fresh JIT

```mermaid
sequenceDiagram
    actor U as User
    participant FE as React
    participant A as /auth/{slug}/...
    participant Svc as LocalIdentityService
    participant Reg as ProviderRegistry
    participant Repo as user_identity_repo
    participant DB as Postgres
    participant IdP as Entra
    U->>FE: click "Sign in with Entra"
    FE->>A: GET /auth/entra-staff/login?next=/dashboard
    A->>Reg: resolve_slug + get()
    A->>IdP: 302 (auth URL + PKCE + state + nonce + max_age=86400)
    Note over A,U: Set-Cookie nx_oidc (signed flow state)
    U->>IdP: authenticate
    IdP-->>U: 302 /auth/entra-staff/callback?code=…&state=…
    U->>A: GET /callback
    A->>A: verify nx_oidc, state, exchange code, verify id_token
    A->>A: apply_claim_mapping(claims, override)
    A->>Svc: complete_sso_login(identity, provider_id, slug, policy)
    Svc->>Svc: auth_config.get() — sso_enabled? jit allowed?
    Svc->>Repo: get_by_subject(provider_id, external_id) -> None
    Svc->>DB: get_user_by_email(claim.email) -> None
    Svc->>DB: INSERT users (signup_source='sso_jit', signup_provider_id=…)
    Svc->>Repo: create_identity(user, provider, external_id)
    Svc->>DB: set_user_idp_metadata (idp_groups, attributes -> user_external_attributes)
    Svc->>DB: reconcile_sso_targets (RoleBindings + GroupMembers)
    Svc->>DB: outbox "user.sso_provisioned" (+ logged_in)
    Svc-->>A: (User, SessionTokens)
    A-->>U: 302 -> /dashboard + Set-Cookie nx_access/refresh/csrf
```

### 5.3 OIDC SSO — auto-link to existing local user

```mermaid
sequenceDiagram
    participant A as /auth/{slug}/callback
    participant Svc
    participant Repo as user_identity_repo
    participant URepo as user_repo
    participant DB
    A->>Svc: complete_sso_login(identity, policy="strict")
    Svc->>Repo: get_by_subject -> None
    Svc->>URepo: get_user_by_email(claim.email) -> existing local user
    Svc->>Repo: has_any_identity(user) -> false
    Note over Svc: deny_reasons = [] (email_verified, local, active, no existing identity)
    Svc->>Repo: create_identity(user, provider, external_id)
    Svc->>DB: outbox "user.sso_linked" (policy, had_existing_identity=false)
    Svc-->>A: (User, SessionTokens) — same user.id as the local one
```

### 5.4 OIDC SSO — collision blocked (`unsafe_auto_link` modal)

```mermaid
sequenceDiagram
    participant A as /auth/{slug}/callback
    participant Svc
    participant URepo
    participant DB
    A->>Svc: complete_sso_login(identity, policy="strict")
    Svc->>URepo: get_user_by_email -> existing
    Svc->>Svc: deny_reasons += "email_unverified" (email_verified=false)
    Svc->>DB: outbox "user.sso_link_denied" {deny_reasons, email}
    Svc-->>A: raise SSOAuthError("unsafe_auto_link")
    A-->>browser: 302 /login?error_code=unsafe_auto_link&email=alice@corp.com
    Note over browser: LoginPage reads ?error_code -> renders CollisionModal
```

The modal in `frontend/src/components/auth/LoginPage.tsx`
(`CollisionModal`) tells the user to log in with their password
first, then link from `/me/identities`.

### 5.5 SAML SSO — full POST binding

```mermaid
sequenceDiagram
    actor U
    participant A as /auth/{slug}/...
    participant Reg as ProviderRegistry
    participant Saml as SamlProvider
    participant Svc
    participant IdP
    U->>A: GET /auth/okta-prod/login?next=/dashboard
    A->>Reg: resolve_slug + get()
    A->>Saml: build_authorization(host, https, force_authn=false)
    Saml->>Saml: python3-saml.OneLogin_Saml2_Auth.login(...)
    Saml-->>A: (idp_sso_url + SAMLRequest, relay_state)
    A-->>U: 302 to IdP + Set-Cookie nx_saml (signed relay_state + next_path)
    U->>IdP: authenticate
    IdP-->>U: HTML auto-POST form to /auth/okta-prod/acs
    U->>A: POST /acs (SAMLResponse, RelayState)
    A->>A: read nx_saml cookie, compare RelayState (hmac.compare_digest)
    A->>Saml: fetch_identity(host, https, post_data)
    Saml->>Saml: process_response (signature, conditions, audience, recipient)
    Saml->>Saml: replay_cache.record(assertion_id, NotOnOrAfter)
    Saml->>Saml: apply_claim_mapping (NameID + AttributeStatement)
    Saml-->>A: ProviderIdentity
    A->>Svc: complete_sso_login(...)
    Note over Svc: identical from here (see 5.2)
```

### 5.6 Self-service link an additional IdP

```mermaid
sequenceDiagram
    actor U
    participant FE
    participant MeR as /me/identities
    participant A as /auth/{slug}/...
    participant Svc
    U->>FE: visit /me/identities, click "Link Auth0"
    FE->>MeR: POST /api/v1/me/identities/link/auth0/start
    MeR-->>FE: {loginUrl: "/auth/auth0/login?next=/me/identities"} + Set-Cookie nx_link_intent (signed JWT(user_id, provider_id))
    FE->>FE: window.location.href = loginUrl
    FE->>A: GET /auth/auth0/login (carries nx_link_intent)
    Note over A: standard OIDC flow up through fetch_identity
    A->>Svc: complete_sso_login(identity, link_intent_user_id=<from cookie>)
    Svc->>Svc: skip find-by-email and policy gates, bind to intent user
    Svc->>DB: create_identity(user=intent_user, provider, external_id)
    Svc->>DB: outbox "user.identity.linked"
    Svc-->>A: (User, SessionTokens) — same as before, just rebound
    A-->>FE: 302 /me/identities + clear nx_link_intent
```

### 5.7 Self-service unlink (with last-authenticator guard)

```mermaid
sequenceDiagram
    actor U
    participant MeR as /me/identities
    participant Repo as user_identity_repo
    U->>MeR: DELETE /api/v1/me/identities/{id}
    MeR->>Repo: delete_identity(id, enforce_last_authenticator=True)
    Repo->>Repo: count other identities + check password_set
    alt user has password OR at least 1 other identity
        Repo->>DB: DELETE FROM user_identities WHERE id=…
        Repo-->>MeR: ok
        MeR->>DB: outbox "user.identity.unlinked"
        MeR-->>U: 204
    else neither
        Repo-->>MeR: raise LastAuthenticatorError
        MeR-->>U: 409 {"error":"last_authenticator", "message":"…set a password or link another identity first."}
    end
```

### 5.8 Admin link from CSV (bulk bootstrap)

Use case: ops has a CSV of `(email, IdP subject)` pairs from a
manual reconciliation exercise. Loop calling
`POST /api/v1/admin/users/{user_id}/identities` with each row.
Admin unlink bypasses the last-authenticator invariant (intentional;
admins follow up with a password reset / re-invite). See §11.2 for
the payload.

### 5.9 24h SSO re-auth (silent /refresh bounce)

```mermaid
sequenceDiagram
    actor U
    participant FE
    participant R as /auth/refresh
    participant Svc
    participant Repo as user_identity_repo
    participant Revoke as revocation_service
    participant IdP
    U->>FE: trigger any API call (cookie ~5 min old)
    FE->>R: POST /api/v1/auth/refresh (cookie nx_refresh)
    R->>Svc: refresh(token)
    Svc->>Svc: decode token, check_and_record_rotation
    Svc->>DB: get_user_by_id (still active)
    Svc->>Svc: is SSO (auth_time≠NULL) AND now-auth_time > 24h
    Svc->>Repo: list_for_user -> pick most-recent provider_slug
    Svc->>Svc: store.revoke_family + outbox "user.sso_session_expired"
    Svc->>Revoke: revoke_all_user_sessions(user_id)
    Svc-->>R: raise SsoReauthRequired(login_url="/auth/entra-staff/login?next=/&force=1")
    R-->>FE: 401 {"error":"sso_reauth_required","login_url":...}
    Note over FE: fetchWithTimeout.tryRefresh detects sso_reauth_required<br/>clears nx_user_v1 sessionStorage cache<br/>window.location.href = login_url
    FE-->>U: 302 to IdP (max_age=86400 + prompt=login)
    U->>IdP: re-authenticate
    Note over IdP,Svc: ... standard OIDC happy path resumes ...
    Svc->>Svc: new auth_time written to fresh refresh JWT
```

### 5.10 Logout (local) vs SAML SLO

```mermaid
sequenceDiagram
    actor U
    participant FE
    participant A as /auth/logout or /auth/{slug}/sls
    participant Svc
    participant IdP
    U->>FE: click "Sign out"
    alt local-only logout
        FE->>A: POST /api/v1/auth/logout
        A->>Svc: logout(refresh_token)
        Svc->>Svc: revoke_family
        Svc->>DB: outbox "user.logged_out"
        A-->>FE: clear nx_access/refresh/csrf
    else SAML SLO (IdP-initiated)
        IdP-->>U: 302 /auth/okta-prod/sls?SAMLRequest=…
        U->>A: GET /sls
        A->>SamlProvider: process_slo
        A->>Svc: logout(refresh_token from cookie)
        A-->>U: 302 to IdP's SLO redirect URL + clear cookies
    end
```

### 5.11 Group → RoleBinding propagation

```mermaid
sequenceDiagram
    participant Svc
    participant Map as idp_group_mapping_repo
    participant Perm as permission_service
    participant DB
    Svc->>Perm: reconcile_sso_targets(user, idp_groups, provider_id)
    Perm->>Map: list_active_for_groups(provider_id, idp_groups)
    Map-->>Perm: mappings (role_binding rows)
    Perm->>DB: existing role_bindings for user (source='sso')
    loop each mapping
        alt role==system:admin
            Perm->>Perm: skip + log warning (forbidden auto-role)
        else
            Perm->>DB: upsert role_binding (source='sso', expires_at=NULL)
        end
    end
    loop existing sso bindings missing in mappings
        Perm->>DB: UPDATE role_bindings SET expires_at=now() (soft-revoke)
    end
    Perm-->>Svc: {created, revoked, reactivated, mappings_matched}
```

The same flow runs in `service.refresh()` against
`users.metadata_.idp_groups` (the cached snapshot from the last
login) — see §4.6.

### 5.12 Group → internal Group membership propagation

Identical structure to 5.11, with the mapping's
`target_type='group_membership'`. Inserts/deletes
`GroupMemberORM(group_id=mapping.target_group_id, user_id=…,
source='sso')`. Manually-added members (`source='local'`) are
**never** removed — even when the IdP stops asserting the source
group. This is intentional: internal admins own their group
memberships; SSO only adds, never tramples.

### 5.13 Admin flips "Disable local login" (lockout safeguard)

```mermaid
sequenceDiagram
    actor Op as Operator
    participant Cfg as /admin/sso/config
    participant Repo as app_auth_config_repo
    participant DB
    Op->>Cfg: PATCH {"allowLocalLogin": false, "expectedVersion": 7}
    Cfg->>DB: every active admin must have ≥1 user_identities row
    alt at least one admin without an SSO identity
        Cfg-->>Op: 409 {"error":"would_lock_out_admin", "adminsWithoutSso":[...]}
        Note over Op: fix offenders (link them) and retry
    else all admins are SSO-linked
        Cfg->>Repo: update_config(allow_local_login=false, expected_version=7)
        Repo->>DB: bump version, UPDATE singleton
        Cfg->>Svc: invalidate_auth_config_cache (next /refresh sees it)
        Cfg->>DB: outbox "auth.config.updated"
        Cfg-->>Op: 200 + new snapshot
    end
```

### 5.14 Find user by staff_id

```mermaid
sequenceDiagram
    actor Admin
    participant Look as /admin/users/lookup
    participant Attr as user_attribute_repo
    Admin->>Look: GET /admin/users/lookup?mode=attribute&attributeKey=staff_id&attributeValue=12345
    Look->>Attr: get_users_by_attribute(key="staff_id", value="12345", limit=2)
    Attr->>DB: SELECT * FROM user_external_attributes WHERE key=? AND value=? LIMIT 2
    DB-->>Attr: [row]
    alt 1 row
        Look->>DB: get_user_by_id + identities + attributes (UserSummary)
        Look-->>Admin: 200 UserSummary
    else 2+ rows
        Look-->>Admin: 409 — use /search to disambiguate
    else 0 rows
        Look-->>Admin: 404
    end
```

`/admin/users/search?q=12345` would fan out across email + names +
identity external_id + attribute substring — useful when the admin
doesn't know which key was set or has a partial value.

### 5.15 New IdP onboarded by admin (no redeploy)

```mermaid
sequenceDiagram
    actor Op
    participant UI as Admin/SSO/Providers
    participant Cfg as /admin/idp-providers
    participant Reg as ProviderRegistry
    participant DB
    Op->>UI: fill slug, kind, settings(JSON), claim_mapping(JSON)
    UI->>Cfg: POST /admin/idp-providers (settings encrypted)
    Cfg->>DB: INSERT idp_providers (settings = Fernet(JSON))
    Cfg->>Reg: invalidate(provider_id)
    Cfg->>DB: outbox "idp.provider.created"
    Cfg-->>UI: 201 ProviderDTO (settings redacted)
    Op->>UI: click Test, paste sample claims
    UI->>Cfg: POST /admin/idp-providers/{id}/test {claims, override}
    Cfg->>Cfg: apply_claim_mapping(claims, override) — pure function
    Cfg-->>UI: resolved ProviderIdentity preview
    Op->>UI: enable the row
    Note over Reg: next /auth/providers fetch returns the new row<br/>within ≤ 60 s registry TTL
```

---

## 6. Backend integration cookbook

Each recipe gives the minimum-viable steps + file:line references.
Read §3.2 (isolation) before adding code under `backend/auth_service/`.

### 6.1 Adding a new SSO-gated endpoint

```python
# backend/app/api/v1/endpoints/my_admin_thing.py
from fastapi import APIRouter, Depends
from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.auth_service.interface import User

router = APIRouter()

@router.get("/things")
async def list_things(
    _admin: User = Depends(requires("system:admin")),
    session = Depends(get_db_session),
):
    ...
```

Then mount in `backend/app/api/v1/api.py`:

```python
from .endpoints import my_admin_thing
api_router.include_router(
    my_admin_thing.router, prefix="/admin/things",
    tags=["admin:things"],
)
```

`requires(...)` reads the `PermissionClaims` JWT claim that was
embedded at login by `claims_resolver`. For workspace-scoped
permissions: `Depends(requires("workspace:datasource:read",
workspace="ws_id"))` — see `auth/dependencies.py`.

### 6.2 Adding a new IdP claim → user attribute (operator-driven)

No code change needed. Operators add the claim path to the
provider's `claim_mapping.extras` via the admin UI:

```json
{
  "extras": {
    "manager_email": ["manager.email", "profile.managerEmail"]
  }
}
```

On the next login the value lands in `users.metadata_.attributes`
AND in `user_external_attributes(key='manager_email')`. The admin
lookup picks it up automatically. If the value is a list, the
attribute repo flattens to CSV (`a, b, c`).

### 6.3 Adding a new `linking_policy` variant

1. Add the value to the CHECK constraint in `models.py` AND in
   `idp_provider_repo.VALID_LINKING_POLICIES`.
2. Add a new branch in `service.complete_sso_login`'s
   `deny_reasons` decision tree.
3. Write a test in `test_oidc_login_flow.py` exercising the new
   policy.
4. Update the §11.6 table in this doc + `SSO.md §1.7`.
5. Update the admin UI's `linking_policy` `<select>` in
   `AdminSso.tsx` (`CreateProviderForm`).

Open a migration (Alembic) only to update the CHECK constraint.

### 6.4 Adding a new outbox event + audit

Outbox writes go through the existing `outbox_emit` hook:

```python
await self._outbox_emit(
    session, "user.identity.unlinked",
    {"user_id": user.id, "identity_id": ident.id, "actor": admin.id},
)
```

The relay (`outbox_relay.py`) drains rows from `outbox_events` and
inserts them into `auth_audit_log` with a UNIQUE on
`source_event_id`. Document the new event in §11.3.

### 6.5 Tests with conftest fixtures

```python
# Repo test (sqlite via db_session fixture)
@pytest.mark.asyncio
async def test_my_repo(db_session):
    row = await my_repo.create(db_session, ...)
    assert row.id

# Endpoint test (test_client fixture wires the FastAPI app + fake user)
@pytest.mark.asyncio
async def test_my_endpoint(test_client):
    resp = await test_client.get("/api/v1/admin/things")
    assert resp.status_code == 200

# Service test (stub repos like Phase 4)
@pytest.mark.asyncio
async def test_login_path():
    svc = LocalIdentityService(
        session_factory=_factory,
        user_repo=_StubUserRepo(),
        user_identity_repo=_StubUserIdentityRepo(),
        refresh_store_factory=lambda s: _NoopRefreshStore(),
        auth_config_provider=StaticAuthConfigProvider(snap),
    )
    ...
```

The `test_client` fixture in `backend/tests/conftest.py` overrides
`get_current_user` etc. so endpoints get the `_FAKE_USER` DTO
without needing a real login flow. See `conftest.py:204` for the
overrides.

### 6.6 Adding a new IdP kind (e.g. OAuth2-only, no OIDC)

1. Implement the provider class under
   `backend/auth_service/providers/oauth2.py` matching the
   `IdentityProvider` Protocol.
2. Build a settings dataclass + `settings_from_snapshot()` factory.
3. Add `build_oauth2_provider` to the
   `PROVIDER_BUILDERS` dict in `providers/__init__.py`.
4. Update the CHECK on `idp_providers.kind` to include `oauth2` via
   a new migration.
5. Wire the slug routes (`/auth/{slug}/...`) — most are kind-agnostic
   already; add new ones if your kind needs additional bindings
   (e.g. SAML `metadata` / `acs` / `sls`).
6. Update `claim_mapper.DEFAULT_OAUTH2` and register it in
   `KIND_DEFAULTS`, plus the defaults map in
   `admin_idp_providers.get_default_mapping` so the admin editor can
   pre-fill it.
7. Add any new secret field names to `idp_provider_repo._SECRET_FIELDS`
   so they're redacted on the way back to the UI.
8. Add the kind to `IdpKind` in `frontend/src/services/ssoAdminService.ts`
   and to the `<select>` in `components/admin/ProviderForm.tsx`.
9. Add tests + a recipe to `SSO.md`.

`custom_profile` (`providers/custom_profile.py`) is the most recent
worked example of all nine steps — including a kind that needs a
non-redirect entry point (`POST /auth/{slug}/browser-profile`) and a
kind-specific settings form rather than the JSON textarea.

**Adding a new source to `custom_profile`** is much smaller than a new
kind: add it to `VALID_SOURCES` (and to `BROWSER_STORAGE_SOURCES` if
only JS can read it), teach `_custom_profile_login_flow` how to pull the
raw string out of the request, and add the label to `SOURCE_LABELS` in
`ProviderForm.tsx`. Everything downstream — verification, mapping,
linking, reconciliation, auditing — is source-agnostic.

### 6.7 Touching `auth_service` — the isolation contract

If you need a DB access pattern the service doesn't have yet:

* **DON'T** import from `backend.app.*`. The isolation test
  enforces this.
* **DO** define a small Protocol + DTO in `auth_service/` (see
  `app_auth_config.py:AuthConfigProvider` as a model).
* **DO** implement the concrete adapter in `backend/app/main.py`
  as a closure over a session factory.
* **DO** inject via the service's constructor; default to a
  no-op static stub so existing tests don't have to wire it.

### 6.8 Adding a new posture toggle (`app_auth_config`)

1. Add the column to `AppAuthConfigORM` (CHECK / default).
2. Add to `AuthConfigSnapshot` (both `app_auth_config_repo` and
   `auth_service/app_auth_config.py`).
3. Add the field to `app_auth_config_repo.update_config` kwargs.
4. Add the field to the `AuthConfigDTO` / `AuthConfigPatch` in
   `admin_sso_config.py`.
5. **Add the lockout-safeguard branch** if the toggle could lock
   anyone out — model it on the
   `_admins_without_sso_identity` pattern.
6. Add the enforcement point in `service.py` (e.g. raise from
   `login` or `complete_sso_login`).
7. Migration: extend the `app_auth_config` row with the new column
   + seed value.
8. Add a test in `test_sso_phase4.py`.
9. Surface in `AdminSso.tsx`'s Settings tab.

---

## 7. Frontend integration cookbook

### 7.1 Reading the current user

```tsx
import { useAuthStore } from '@/store/auth'

function Header() {
  const user = useAuthStore((s) => s.user)
  return <span>{user?.firstName} {user?.lastName}</span>
}
```

Narrow selectors avoid re-renders when unrelated slices of the
store change. Don't destructure the whole store unless you need
everything.

### 7.2 Gating UI on a permission

```tsx
import { RequirePermission } from '@/components/auth/RequirePermission'
import { usePermission } from '@/store/auth'

// declarative
<RequirePermission perm="workspace:view:edit" workspaceId={ws}>
  <SaveButton />
</RequirePermission>

// imperative
const canEdit = usePermission('workspace:view:edit', wsId)
```

The check mirrors the server's `has_permission` exactly: wildcard
expansion + `system:admin` shortcut. Server still enforces; the
gate is advisory (UI hides actions the user can't perform).

### 7.3 Calling a new admin endpoint

Add a service module under `frontend/src/services/`:

```ts
// frontend/src/services/thingsService.ts
import { fetchWithTimeout } from './fetchWithTimeout'

export interface Thing { id: string; name: string }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithTimeout(url, {
    ...init, credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) throw new Error(await res.text())
  return res.status === 204 ? (undefined as T) : res.json()
}

export const thingsService = {
  list(): Promise<Thing[]> { return request('/api/v1/admin/things') },
}
```

`fetchWithTimeout` is the shared wrapper: timeout, credentials,
CSRF header injection, silent 401-refresh, `sso_reauth_required`
redirect. New services should NEVER call `fetch()` directly.

### 7.4 Handling 401 / 403 / `sso_reauth_required`

| HTTP | Body | What it means | What to do |
|------|------|---------------|------------|
| 401 (generic) | `"Refresh token invalid or expired"` | Session is gone | `fetchWithTimeout` already dispatches `auth:session-lost` → store routes to `/login` |
| 401 (structured) | `{"error":"sso_reauth_required","login_url":"…"}` | 24h ceiling hit | `tryRefresh()` navigates to the IdP transparently |
| 403 (CSRF) | `"CSRF token missing"` | Race after logout | clear local state + reload |
| 403 (permission) | `{"detail":"Missing permission: X"}` | UI shouldn't have shown the action | `auth:access-denied` dispatched; AppLayout modal renders |
| 403 (`local_login_disabled`) | `{"error":"local_login_disabled"}` | Platform is in SSO-only mode | login page shows the SSO buttons only |
| 409 (`last_authenticator`) | `{"error":"last_authenticator","message":…}` | Trying to unlink the only auth method | inline error + offer "set a password" CTA |
| 409 (`would_lock_out_admin`) | `{"error":…,"adminsWithoutSso":[…]}` | Settings PATCH refused | render the offender list + suggest "Link an SSO identity for these admins first" |

### 7.5 Reacting to `auth:session-lost`

`main.tsx` listens for the event and calls
`useAuthStore.getState().handleSessionLost()` which clears the
sessionStorage cache + transitions to `unauthenticated`. Route
guards then push to `/login`. If you want to take an extra action
(toast, analytics), subscribe inside an `useEffect`.

### 7.6 Adding a new admin UI tab

Edit `frontend/src/pages/AdminPage.tsx`. The sidebar is two
groups (System / Identity & Access); pick the right one and add an
entry with `path`, `label`, `icon`, `description`. Then add the
route in `routes.tsx` and the page component under
`components/admin/`. See the Phase 3 commit `221ec94` for an
example (the SSO tab).

### 7.7 Self-service link UI

`MyIdentitiesPage` already covers the standard flow. To extend it
(e.g. add a "Set password" button for SSO-only users), the
`passwordSet` flag in the `IdentitiesResponse` is your branching
input. Server-side, add an endpoint that the FE can call with the
new password + the current one.

---

## 8. Testing strategy

### 8.1 Pure-function unit tests

`claim_mapper`, `password`, `cookies`, `tokens` are pure libraries
— no DB, no network, no FastAPI. Test them with `pytest` no
fixtures needed. See `test_sso_phase2.py` for the claim mapper +
custom envelope cases.

### 8.2 Repo tests against in-memory SQLite

The `db_session` fixture in `conftest.py` creates the schema via
`Base.metadata.create_all` (no Alembic; faster). Use it for any
test that needs to exercise the actual ORM relationships.

```python
@pytest.mark.asyncio
async def test_create_and_lookup(db_session):
    provider = await idp_provider_repo.create_provider(db_session, ...)
    rec = await idp_provider_repo.get_provider(db_session, provider.id)
    assert rec.slug == provider.slug
```

### 8.3 Service tests with stub repos

`LocalIdentityService` takes everything via constructor → stubs are
trivial. See `test_sso_phase2.py:_StubUserRepo` for the pattern. Use
this for "what does the service do under condition X?" without
spinning up a DB.

### 8.4 Route tests via `test_client`

`conftest.py:test_client` is an `httpx.AsyncClient` wired to the
FastAPI app with `db_session` shared, auth-dependency overrides
that inject the fake user, and CSRF disabled. Use it for endpoint
contract tests — request body shape, status codes, headers.

### 8.5 Frontend store tests (vitest, jsdom)

`frontend/src/store/userCache.test.ts` and `auth.test.ts` show the
pattern: `vi.mock('@/services/authService')`, reset the Zustand
store between tests, exercise the actions, assert state. No real
fetches; the auth-service mock is what makes the tests fast.

### 8.6 End-to-end smoke against the dev IdP

The dev IdP (custom provider, gated by
`AUTH_CUSTOM_PROVIDER_ENABLED`) makes "real" SSO testing trivial:

```bash
# 1. Stand up the app with the dev IdP.
# 2. Use the DevLogin page to plant the cookie.
# 3. Assert downstream behaviour (/me, /admin/sso/users, etc.).
```

Helpful for: claim-mapping changes, lockout-safeguard logic,
group→target reconciliation, signup-source stamping.

### 8.7 Idempotency expectations

* Every migration is idempotent (CHECK before INSERT/ALTER).
* The reconciler is idempotent — running it twice with the same
  input is a no-op.
* Provider create/update events emit twice if the relay re-drains —
  consumers should dedupe on `source_event_id`.
* `db_session` fixture wipes between tests (`drop_all` on teardown).

---

## 9. Operational runbooks

### 9.1 User reports SSO login failed

0. **Ask for the reference.** Every failure lands on
   `/login?ref=<8 hex chars>&sso_error=1`. Paste that ref into Admin →
   SSO → **Activity** and the `user.sso_login_failed` event gives you the
   provider and the exact reason. The reason is deliberately absent from
   the page the user sees, so this is the intended route — the SQL below
   is the fallback for when you have an email but no ref.
1. **Get the audit envelope** — ask the user for the URL they were
   bounced to. If `?sso_error=1` (no error_code), the failure is
   pre-`complete_sso_login` (signature, JWKS, replay). If
   `?error_code=unsafe_auto_link`, it's the linking-policy gate
   (see §5.4).
2. **Query the audit log**:
   ```sql
   SELECT id, event_type, payload, recorded_at
   FROM auth_audit_log
   WHERE event_type LIKE 'user.sso_%'
     AND payload::text LIKE '%alice@corp.com%'
   ORDER BY recorded_at DESC
   LIMIT 20;
   ```
3. `payload.deny_reasons` is the linking gate's verdict. Common
   patterns:
   * `email_unverified` — fix at the IdP (`email_verified=true`).
   * `policy:manual_only` — direct user to `/me/identities`.
   * `strict_existing_sso` — switch the provider to
     `allow_verified`.
4. If no audit row matches, the failure is earlier — check the
   server logs for `OIDC callback failed:` or `SAML ACS failed:`
   in `auth_service/api/router.py`.

### 9.2 IdP rotated their certificate (SAML)

You should not be finding out about this from a user. The health sweep
(§3.6) reports certificate expiry in the provider list and warns from 30
days out; an expired signing cert takes every sign-in down at once.

1. PATCH the provider:
   ```bash
   curl -X PATCH /api/v1/admin/idp-providers/idp_xxx \
     -d '{"settings": {"idp_x509_cert": "<new cert body>"}}'
   ```
2. Registry invalidates the cached provider; next request rebuilds
   it with the new cert.
3. No restart needed.
4. Confirm with a dry run (`SSO.md` §2.11) rather than waiting for a user
   to try — it verifies the new cert against a real assertion and writes
   nothing.

For OIDC IdPs the JWKS endpoint is fetched on a `kid` miss
(`oidc.py:_VERIFY_ERRORS` retry loop), so cert rotation Just
Works.

### 9.3 Revoke a user across all sessions immediately

```python
from backend.app.services.revocation_service import get_revocation_service
await get_revocation_service().revoke_all_user_sessions("usr_xxx")
```

Or via psql + a small admin endpoint we haven't added yet — file
an issue. The user's next request from any tab gets a 401 + lands
on `/login` (or the SSO bounce if they're SSO).

### 9.4 Outbox relay logging constant warnings

Almost always one of:

* **Schema drift** — run `python -m backend.scripts.upgrade check`
  on the affected pod. If it exits nonzero, the chain isn't applied;
  re-run `upgrade`.
* **Postgres connection cycling** — relay reconnects each tick; if
  every tick fails, check the DB. The relay does NOT retry within
  a tick; it relies on the loop.
* **A genuinely deleted table** — someone ran a destructive
  migration. Restore from the WAL or backups.

### 9.5 Schema drift between environments

Compare via:

```bash
# On each environment
python -m backend.scripts.upgrade current
python -m backend.scripts.upgrade heads
```

Both commands print the same head id when in sync. If `current`
shows an older id than `heads`, run `upgrade`. The
`schemaCheckInitContainer` on k8s would have caught this for you
on pod restart — verify it's enabled (`services.viz.skipSchemaCheck`
must be false in Helm values).

### 9.6 Admin lost their only SSO link

If the admin still has a password: they log in normally.

If SSO-only AND `allow_local_login=false`: someone else with admin
must `POST /api/v1/admin/users/{id}/identities` for them with a
known external_id from their IdP, OR `DELETE` the corrupt one and
re-invite via the standard signup flow.

The "no admin left at all" scenario is prevented at write time by
the `would_lock_out_admin` 409 — see §5.13. If you somehow get
there anyway (forced via raw SQL), break-glass restore is `INSERT
INTO user_identities (...)` directly on the DB.

### 9.7 Disaster: someone deleted all `idp_providers`

* `user_identities` rows have an FK to `idp_providers` with
  `ON DELETE RESTRICT` — the delete fails unless they cascaded.
* If it cascaded, every SSO user is orphaned. Recovery: restore
  the row from a backup; the `(provider_id, external_id)` join key
  must match the original provider_id (the FK isn't on slug). If
  the provider_id has changed, every linked user needs to re-link
  manually.

Prevention: don't grant `system:admin` to operators who shouldn't
have it. The `delete_provider` endpoint is gated by it.

---

## 10. Threat model + security boundaries

The auth surface defends against these threats. Out-of-scope
attacks at the bottom of the section.

### 10.1 In scope

| Threat | Defense | Location |
|--------|---------|----------|
| Cookie theft via XSS | HttpOnly on `nx_access`/`nx_refresh` | `cookies.py:set_session_cookies` |
| CSRF on writes | double-submit (`nx_csrf` + `X-CSRF-Token`) | `csrf.py` + `fetchWithTimeout.ts` |
| Refresh token replay | per-`jti` revocation + family kill on reuse | `refresh.py:check_and_record_rotation` |
| Open redirect on post-login bounce | `_safe_next` only accepts same-site relative paths | `api/router.py:_safe_next` |
| OIDC state mismatch (CSRF for callback) | `hmac.compare_digest(flow.state, callback.state)` | `api/router.py:oidc_callback` |
| OIDC ID-token forgery | JWKS verify + `iss`, `aud`, `exp`, `nonce`, `at_hash` (Authlib) | `providers/oidc.py:_verify_id_token` |
| OIDC JWKS rotation desync | refetch on `kid` miss once before failing | same |
| SAML signature forgery | python3-saml strict mode + `wantAssertionsSigned` | `providers/saml2.py:_settings_dict` |
| SAML assertion replay | Redis-backed cache keyed by assertion id, TTL = NotOnOrAfter | `providers/saml2.py:fetch_identity` |
| Signature wrapping (XSW) on SAML | strict-mode XML parsing in python3-saml | library |
| Account takeover via email collision | `linking_policy` matrix, default `strict` | `service.py:complete_sso_login` |
| Back-channel gateway impersonation | nothing in either token is parsed; identity comes only from the exchange reply, over TLS with redirects refused | `providers/backchannel.py:fetch_identity` |
| Request forgery via an admin-typed gateway URL | resolved-address check before connecting; private addresses need an explicit `host:port` allowlist entry, and loopback / link-local are refused whatever it contains | `providers/outbound.py:assert_fetchable` |
| Back-channel session outliving the upstream one | re-confirmed with the provider on every rotation; an outage is tolerated only inside a grace window anchored to the last successful answer | `service.py:_settle_liveness` |
| Forged handle posted by a browser | redeemed against the provider's gateway rather than parsed, so an invented value does not survive leg 1 | `api/router.py:backchannel_handle_login` |
| `system:admin` granted via group | per-mapping write-time refusal + reconcile-time skip | `idp_group_mapping_repo.FORBIDDEN_AUTO_ROLE` |
| Operator self-lockout via posture toggle | `_admins_without_sso_identity` check | `admin_sso_config.update_config` |
| Stale permissions after admin change | `claims_resolver` re-runs on every `/refresh` | `service.refresh` |
| 24h SSO drift | `auth_time` ceiling check on `/refresh` | same |
| Stolen mock-IdP cookie (custom) | HS256 signature + short TTL + ENV/feature gate | `core/tokens.create_mock_identity_token` |
| Encrypted IdP secret at rest | Fernet via `CREDENTIAL_ENCRYPTION_KEY` | `idp_provider_repo.encrypt_settings` |
| Signing-key absence/weakness | fail-fast at import (≥32 chars required) | `core/config._resolve_secret` |
| Audit completeness | every state change emits an outbox event | grep `create_outbox_event` |

### 10.2 Out of scope (defended elsewhere or deferred)

* **DDoS / rate limiting** — two controls with different keys, because
  they do different jobs.

  The **per-address** limits (`RATELIMIT_LOGIN_PER_IP`,
  `RATELIMIT_SENSITIVE_PER_IP`) are a coarse flood guard. Behind a NAT
  or an ingress every user shares one address, so a tight cap does not
  stop an attacker — they have many addresses — while it does stop an
  office, which has one. They are sized so a ~2000-seat tenant never
  reaches them during a morning sign-in rush. Anything broader is the
  reverse proxy / WAF's job.

  The **per-account** limits (`RATELIMIT_LOGIN_PER_ACCOUNT`,
  `RATELIMIT_PASSWORD_RESET_PER_ACCOUNT`) are the security control.
  They key on the account being attacked rather than the address
  attacking it, so a spray is bounded however many hosts it comes from.
  Login counts failures only and clears on success.

  `/refresh` is keyed on the **rotation family** — one browser session
  — because keying it on the address put every user behind an ingress
  in one bucket, and a 429 on refresh reads to the client as a lost
  session. Counters resolve through the central Redis resolver so they
  are shared across replicas; an unreachable store degrades to
  per-worker counting rather than failing requests.
* **MFA** — not implemented. See `SSO.md §4` for the deferred
  pattern.
* **SCIM provisioning** — same; manual `admin_user_identities`
  endpoints cover the small-scale need.
* **HSM / KMS for signing keys** — HS256 with a fail-fast env
  secret is fine in-process; KMS for RS256/ES256 + JWKS rotation
  is a deferred phase.
* **Per-session activity log** — `auth_audit_log` carries event
  shapes; a fuller `user_session_log` is a future polish.
* **Sandboxing the custom IdP** — gated by env + ENV
  ≠ `prod`/`production`; we rely on operators not flipping the
  flag in prod (the config module refuses to start if they do).

---

## 11. Reference tables

### 11.1 Cookies

| Name | Path | HttpOnly | Secure | SameSite | TTL | Signed | Audience | Source of truth |
|------|------|----------|--------|----------|-----|--------|----------|-----------------|
| `nx_access` | `/` | yes | yes | lax | 15 min | HS256 | `nexus-lineage` | `cookies.py` + `tokens.create_access_token` |
| `nx_refresh` | `/api/v1/auth/` | yes | yes | lax | 7 days | HS256 | `nexus-lineage:refresh` | `cookies.py` + `tokens.create_refresh_token` |
| `nx_csrf` | `/` | **no** (FE reads it) | yes | lax | follows refresh | unsigned random | — | `cookies.py:set_session_cookies` |
| `nx_access_exp` | `/` | **no** (FE reads it) | yes | lax | follows refresh | unsigned epoch | — | `cookies.py:set_session_cookies` |
| `nx_oidc` | `/api/v1/auth/` | yes | yes | lax | 10 min | HS256 | `nexus-lineage:oidc_state` | `cookies.py` + `tokens.create_oidc_state_token` |
| `nx_saml` | `/api/v1/auth/` | yes | yes | **none** (see below) | 10 min | HS256 | `nexus-lineage:saml_state` | `cookies.py` + `tokens.create_saml_state_token` |
| `nx_mock_identity` | `/api/v1/auth/` | yes | yes | lax | 10 min | HS256 | `nexus-lineage:mock_identity` | `cookies.py` + `tokens.create_mock_identity_token` |
| `nx_link_intent` | `/api/v1/auth/` | yes | yes | **none** (see below) | 10 min | HS256 | `nexus-lineage:link_intent` | `cookies.py` + `tokens.create_link_intent_token` |
| `nx_dryrun` | `/api/v1/auth/` | yes | yes | **none** (see below) | 10 min | HS256 (key ring) | `nexus-lineage:dryrun` | `cookies.py` + `tokens.create_dryrun_token` |
| `nx_user_v1` (sessionStorage) | n/a (browser) | n/a | n/a | n/a | tab lifetime | n/a | n/a | `frontend/src/store/userCache.ts` |

`Secure` and `SameSite` come from
`auth_service/core/config.COOKIE_*` (env-overridable for dev) — **except**
for the three cookies that have to survive a cross-site landing.

`nx_saml`, `nx_link_intent` and `nx_dryrun` are `SameSite=None; Secure`
unconditionally, ignoring `COOKIE_SECURE`. The SAML ACS is a cross-site
top-level **POST**, which `Lax` explicitly withholds cookies from — under
`Lax` the ACS handler never sees the flow cookie and the whole SP-initiated
flow is dead, on every IdP. Browsers only send `SameSite=None` alongside
`Secure`, so the two go together. Deriving `Secure` from config would
reintroduce that bug in the off position, which is the configuration where
it is hardest to notice. `nx_oidc` keeps the default: the OIDC callback is
a cross-site **GET**, which `Lax` permits.

Two cookies are deliberately readable by JavaScript. `nx_csrf` has to be —
double-submit works by the page echoing it into a header. `nx_access_exp`
carries the epoch at which `nx_access` expires, so the client can rotate
ahead of expiry rather than after a 401; the access token itself is
HttpOnly, so there is no other way for it to know. Neither value carries
identity or a signature, and the expiry is already implicit in the access
cookie's own `Max-Age`.

`nx_access_exp` follows the **refresh** TTL rather than the access TTL it
describes. Matching the access cookie would delete it at the exact moment
it becomes useful: a tab restored after the token died still needs to
read *when* it died, and that tab is precisely the one that should
refresh immediately instead of firing a request it knows will 401.

`nx_csrf` and `nx_access_exp` are the only two **not** suffixed with
`AUTH_ENVIRONMENT_ID` — both are read from JS by name, and a
per-environment name would have to be discovered at runtime before the
first write or the first scheduled renewal. Neither is signature-bearing,
so sharing the name across environments is harmless. Every cookie that
does carry a signature is scoped, `nx_dryrun` included;
`test_every_signed_cookie_is_scoped` asserts the property rather than a
list, because the list is what let `nx_dryrun` slip through.

### 11.2 Endpoints (Phases 0–4)

#### Public auth surface

| Method | Path | Body | Auth | Response |
|--------|------|------|------|----------|
| GET | `/api/v1/auth/providers` | — | none | `ProviderSummary[]` |
| POST | `/api/v1/auth/login` | `{email, password}` | none | `SessionResponse` + cookies |
| POST | `/api/v1/auth/logout` | — | cookie | `{ok: true}` + clear cookies |
| POST | `/api/v1/auth/refresh` | — | cookie | `SessionResponse` or 401 `sso_reauth_required` |
| GET | `/api/v1/auth/me` | — | cookie | `SessionResponse` |
| GET | `/api/v1/auth/{slug}/login` | next, force | none | 302 to IdP |
| GET | `/api/v1/auth/{slug}/callback` | code, state | nx_oidc | 302 |
| POST | `/api/v1/auth/{slug}/acs` | SAMLResponse, RelayState (form) | nx_saml | 302 |
| GET | `/api/v1/auth/{slug}/metadata` | — | none | `application/samlmetadata+xml` |
| GET\|POST | `/api/v1/auth/{slug}/sls` | SAML* | cookie | 302 |
| POST | `/api/v1/auth/{slug}/mock` | mock identity | dev-only env gate | `{ok}` + cookie |
| POST | `/api/v1/auth/{slug}/browser-profile` | `{payload}` from web storage | signature/freshness server-side; 404 unless the row's source is browser storage | `{user}` + session cookies |
| POST | `/api/v1/auth/resolve` | `{email}` | none — pre-session, CSRF-exempt, rate limited 20/min | `{provider}` or `{provider: null}`; every miss identical |
| GET | `/api/v1/auth/login-context` | — | none — pre-session | `{allowLocalLogin, emailFirstLogin, providers[]}`. What the login page renders from; fails open to the permissive posture |

#### Self-service identities

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/api/v1/me/identities` | cookie | `IdentitiesResponse` |
| POST | `/api/v1/me/identities/link/{slug}/start` | cookie | sets `nx_link_intent`; returns `{loginUrl}` |
| DELETE | `/api/v1/me/identities/{id}` | cookie | 409 on last-authenticator |

#### Admin SSO surface

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/v1/admin/idp-providers` | settings redacted |
| POST | `/api/v1/admin/idp-providers` | create; 409 on slug conflict |
| PATCH | `/api/v1/admin/idp-providers/{id}` | merge into settings; bumps registry cache |
| DELETE | `/api/v1/admin/idp-providers/{id}` | 409 if identities exist |
| POST | `/api/v1/admin/idp-providers/{id}/test` | preview claim mapping against a pasted blob |
| POST | `/api/v1/admin/idp-providers/discover` | fill the form from an OIDC issuer or SAML metadata; never persists; a probe failure is `{success:false,error}`, not a 500 |
| GET | `/api/v1/admin/idp-providers/status` | last known health from the background sweep; **opens no sockets** |
| POST | `/api/v1/admin/idp-providers/{id}/dry-run/start` | mints `nx_dryrun`; returns `{loginUrl}`. The callback then reports the would-be outcome and writes nothing |
| GET | `/api/v1/admin/idp-providers/{id}/last-assertion` | the most recent claims blob, decrypted; 404 until one is captured |
| GET | `/api/v1/admin/idp-providers/defaults/{kind}` | default mapping shape |
| GET\|POST\|DELETE | `/api/v1/admin/idp-group-mappings` | listing + role_binding + group_membership target shapes |
| GET\|POST\|DELETE | `/api/v1/admin/users/{user_id}/identities` | admin link/unlink |
| GET | `/api/v1/admin/users/lookup?mode=...` | structured lookup |
| GET | `/api/v1/admin/users/search?q=...` | fan-out |
| GET | `/api/v1/admin/sso/config` | posture switches |
| PATCH | `/api/v1/admin/sso/config` | with `expectedVersion` for optimistic concurrency |

Every admin endpoint is gated by `requires("system:admin")`.

### 11.3 Outbox events

| Event type | Emitted by | Payload keys |
|------------|------------|--------------|
| `user.logged_in` | login/refresh/SSO | `user_id, email, provider, auth_time?, groups?, reconcile?` |
| `user.logged_out` | logout | `user_id` |
| `user.sso_provisioned` | JIT branch | `user_id, email, provider_id, external_id, linking_policy, signup_source` |
| `user.sso_linked` | auto-link branch | `user_id, email, provider_id, external_id, linking_policy, has_password, had_existing_identity` |
| `user.sso_link_denied` | unsafe_auto_link | `email, provider_id, external_id, reason, deny_reasons, linking_policy, email_verified, existing_status` |
| `user.sso_jit_blocked` | `allow_jit_provisioning=false` | `email, provider_id, external_id, reason` |
| `user.sso_session_expired` | 24h ceiling | `user_id, provider_slug, auth_time, elapsed_seconds` |
| `user.sso_login_failed` | any SSO callback failure | `ref, provider_slug, provider_id, reason` — the `ref` is what the user sees at `/login?ref=…`; the reason never leaves the audit log |
| `user.identity.linked` | self-service link | `user_id, provider_id, external_id, via` |
| `user.identity.unlinked` | self-service unlink | `user_id, identity_id, via` |
| `user.identity.admin_linked` | admin link | `user_id, identity_id, provider_id, external_id, actor` |
| `user.identity.admin_unlinked` | admin unlink | `user_id, identity_id, actor` |
| `idp.provider.{created,updated,deleted}` | admin CRUD | `provider_id, slug, kind, actor, …` |
| `rbac.sso_mapping.{created,deleted}` | mapping CRUD | `mapping_id, target_type, idp_group, …, actor` |
| `auth.config.updated` | posture PATCH | `actor, sso_enabled, allow_local_login, allow_jit_provisioning, version` |

All events end up in `auth_audit_log` via the outbox relay; deduped
by `source_event_id` UNIQUE.

### 11.4 Config env vars

| Var | Default | Where it bites |
|-----|---------|----------------|
| `JWT_SECRET_KEY` | (none — fail-fast) | every token sign/verify |
| `JWT_ALGORITHM` | `HS256` | same |
| `JWT_EXPIRY_MINUTES` | `5` | access TTL |
| `JWT_REFRESH_EXPIRY_DAYS` | `7` | refresh TTL |
| `JWT_ISSUER` | `nexus-lineage` | issuer claim |
| `JWT_AUDIENCE` | `nexus-lineage` | audience claim |
| `AUTH_COOKIE_SECURE` | `true` | cookie `Secure` |
| `AUTH_COOKIE_DOMAIN` | (none) | cookie `Domain` |
| `AUTH_COOKIE_SAMESITE` | `lax` | cookie `SameSite` |
| `SSO_SESSION_MAX_AGE_HOURS` | `24` | 24h re-auth |
| `ENV` | `dev` | prod-guard on custom IdP + .env auto-load |
| `AUTH_CUSTOM_PROVIDER_ENABLED` | `false` | dev IdP gate |
| `CREDENTIAL_ENCRYPTION_KEY` | (none) | Fernet for provider settings + connection creds |
| `OIDC_*` (legacy) | (none) | env-only seed for `default-oidc` provider |
| `SAML_*` (legacy) | (none) | env-only seed for `default-saml2` provider |
| `REDIS_URL` | `redis://localhost:6379/0` | revocation set + replay cache |
| `RBAC_REVOCATION_TTL_SECONDS` | derived: access TTL + 60s | sid TTL in Redis. Derived from `JWT_EXPIRY_MINUTES` rather than set beside it — the two drifted, and a tombstone shorter than the token means revocation silently stops taking effect. Startup refuses an override below the access TTL. |
| `REFRESH_ROTATION_GRACE_SECONDS` | `30` | how long a re-presented refresh token is read as a concurrent refresh rather than a stolen chain. `0` = strict rotation |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | peers whose `X-Forwarded-For` is trusted. Must name the proxy (or `*`) behind an ingress, or every caller is recorded as the proxy |
| `RATELIMIT_STORAGE_URI` | (none → resolver) | Override for rate-limit counter storage. Unset, counters resolve through the central Redis resolver on the STREAMS role — the same path revocation takes — so they follow whatever each environment configures, including production's Memorystore coordinates. A defaulted (unconfigured) endpoint means in-process memory |
| `AUTH_ENVIRONMENT_ID` | (none) | Scopes session cookie names (`nx_access_uat`) and binds the JWT issuer. Set it when two deployments can be open in one browser: cookie jars key on domain, not cluster, so identically-named cookies overwrite each other and the receiving side can only report an opaque signature failure |
| `JWT_SECRET_KEY_PREVIOUS` | (none) | Comma-separated retired keys, most-recent first, accepted for **verification only**. Set before rotating `JWT_SECRET_KEY`. Same ≥32-char floor as the active key, since a retired key is still trusted |
| `RATELIMIT_LOGIN_PER_IP` | `1000/minute` | Per-address cap on `/login`, `/resolve` and portal login. A coarse flood guard only — behind a NAT every user shares one address, so a tight cap stops the office and not the attacker. Sized so a ~2000-seat tenant never reaches it |
| `RATELIMIT_SENSITIVE_PER_IP` | `200/minute` | Same, for signup, invite redemption, and password forgot/reset |
| `RATELIMIT_REFRESH_PER_SESSION` | `30/minute` | Per rotation family, i.e. per browser session. Already per-user, so it needs no headroom for tenant size — a session needs ~4 rotations an hour |
| `RATELIMIT_LOGIN_PER_ACCOUNT` | `10 per 15 minutes` | **The brute-force control.** Keys on the account under attack, so it holds however many addresses the attempts come from. Counts failures only and is cleared by a successful sign-in, so a legitimate user is never throttled |
| `RATELIMIT_PASSWORD_RESET_PER_ACCOUNT` | `3/hour` | Bounds mailbombing one person. Counted on every request, since reset responses are deliberately identical whether or not the account exists |
| `MANAGEMENT_DB_URL` | (none — required) | management Postgres |

### 11.5 DB schema (auth subset)

```mermaid
erDiagram
    users ||--o{ user_identities : "has"
    users ||--o{ user_external_attributes : "has"
    users ||--o{ user_roles : "carries"
    users ||--o{ group_members : "joins"
    users ||--o{ role_bindings : "subject"
    idp_providers ||--o{ user_identities : "issues"
    idp_providers ||--o{ user_external_attributes : "sources"
    idp_providers ||--o{ idp_group_role_mappings : "scopes"
    groups ||--o{ group_members : "contains"
    groups ||--o{ idp_group_role_mappings : "target"
    roles ||--o{ role_bindings : "name"
    app_auth_config }|--|| app_auth_config : "singleton"
```

| Table | Phase | Key columns |
|-------|-------|-------------|
| `users` | core + 4 | `id, email, password_hash, status, signup_source, signup_provider_id, metadata_` |
| `user_identities` | 3 | `id, user_id, provider_id, external_id, email_at_link, created_at, last_login_at, metadata_` |
| `user_external_attributes` | 4 | `id, user_id, key, value, source_provider_id, set_at` |
| `idp_providers` | 3 | `id, slug, display_name, kind, enabled, priority, settings (encrypted), claim_mapping, linking_policy` |
| `idp_group_role_mappings` | 2/3 | `id, provider_id, idp_group, target_type, scope_type, scope_id, role_name, target_group_id` |
| `app_auth_config` | 4 | `id='singleton', sso_enabled, allow_local_login, allow_jit_provisioning, version` |
| `role_bindings` | RBAC | `id, subject_type, subject_id, role_name, scope_type, scope_id, source, expires_at` |
| `group_members` | RBAC | `group_id, user_id, source, added_by` |
| `auth_audit_log` | 0 | `id, source_event_id, event_type, payload, occurred_at, recorded_at` |
| `outbox_events` | RBAC | `id, event_type, payload, processed, created_at` |

### 11.6 Linking policy decision matrix

See §4.3.

### 11.7 `signup_source` values

See §4.2.

### 11.8 `target_type` values

See §4.4.

---

## 12. Glossary

| Term | One-line definition |
|------|---------------------|
| `auth_time` | IdP-issued epoch second of the user's actual authentication; carried in the refresh JWT; anchor for the 24h ceiling. |
| `external_id` | IdP-assigned subject (OIDC `sub`, SAML `NameID`, custom payload `external_id`); the durable identity key. |
| identity | One row in `user_identities` — the link between a user and an IdP subject. A user can have many. |
| link intent | Signed cookie (`nx_link_intent`) carrying `(user_id, provider_id)` while a self-service link flow is in progress. |
| linking policy | Per-provider gate on auto-linking SSO subjects to existing users by email. Four values; see §4.3. |
| posture switches | The three `app_auth_config` toggles (`sso_enabled`, `allow_local_login`, `allow_jit_provisioning`). |
| provider id | The `idp_providers.id` UUID. Stable; never changes across slug renames. |
| provider slug | URL-safe identifier (`entra-staff`). The user-facing handle; can change. |
| refresh family | The chain of refresh tokens issued from one login. Reuse of any `jti` revokes the whole family. |
| reconciler | `permission_service.reconcile_sso_targets`. Diffs the user's `source='sso'` RoleBindings + GroupMembers against what the current IdP groups imply. |
| signup source | `users.signup_source` ∈ {`local_signup`, `sso_jit`, `invite`, `admin_created`, `admin_linked`}. |
| `sso_reauth_required` | Structured 401 error body emitted by `/auth/refresh` when the 24h ceiling triggers; carries `login_url` the FE follows transparently. |
| target type | `idp_group_role_mappings.target_type` ∈ {`role_binding`, `group_membership`}. |
| workspace scope | A `RoleBindingORM` scope where `scope_type='workspace'` and `scope_id` points to a `workspaces.id`. |

---

*Maintenance: when you touch the auth surface, update the relevant
table here in the same commit. The 11-table reference section is the
one consumers grep first — stale entries waste support engineers'
time. PR reviewers should reject auth-surface changes that don't
update this doc.*
