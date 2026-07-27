# SSO — operator reference

> **At a glance.** The operator reference for {brand}'s single sign-on: **what exists**
> and **how to run it**. Covers the OIDC + SAML2 transport, DB-backed per-row IdP
> providers, multi-identity users, claim mapping, group→role/group mapping, 24h SSO
> re-auth, and the platform posture switches — plus step-by-step operator playbooks
> (§2) and verification procedures (§3). For *how to integrate, extend, and debug*, read
> the [SSO Integration Guide](/docs/sso-integration).

Single source of truth for the SSO/IdP integration. Read this end-to-end
before working on the auth surface; share the relevant sub-sections with
operators standing up a new IdP.

> **For developers integrating on top of SSO** — read alongside
> [`SSO_INTEGRATION.md`](SSO_INTEGRATION.md). That guide covers
> developer setup (Day 1), architecture + component diagrams, 15
> user-journey sequence diagrams, backend + frontend integration
> cookbooks, testing strategy, operational runbooks, the threat
> model, and the reference tables (cookies / endpoints / outbox
> events / config / schema). This doc focuses on *what exists* +
> *how to operate it*; the integration guide focuses on *how to
> read, extend, test, and debug it*.

The SSO surface today: **OIDC** (Authlib, Authorization Code + PKCE + JWKS
verify), **SAML2** (python3-saml strict mode) and **custom profile**
(cookie / browser storage / proxy header) alongside local password
auth; DB-backed per-row IdP providers plus a custom dev IdP; multi-identity
per user; configurable claim mapping with indexed attribute pass-through;
group→role and group→internal-group mapping; 24h SSO re-authentication;
signup provenance; platform posture switches; and admin lookup + search.

---

## 1. What's implemented

**The login flow at a glance** — both SSO kinds converge on one `complete_sso_login`
path (JIT-provision, link, or reject by policy), then reconcile group→role/group
mappings before minting the session cookies:

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant FE as Login page
    participant A as /auth/{slug}/…
    participant IdP as OIDC / SAML IdP
    participant Svc as complete_sso_login
    U->>FE: pick a provider button
    FE->>A: GET /auth/{slug}/login
    A->>IdP: redirect (OIDC PKCE+nonce · or SAML AuthnRequest)
    IdP-->>A: callback (code) / POST /acs (SAMLResponse)
    A->>A: verify (JWKS / x509 + replay) → claim-map
    A->>Svc: identity + linking_policy
    alt subject known
        Svc->>Svc: touch last login
    else email free
        Svc->>Svc: JIT provision (signup_source='sso_jit')
    else email collides
        Svc->>Svc: linking_policy decides link vs reject
    end
    Svc->>Svc: reconcile_sso_targets (role bindings + group members)
    Svc-->>U: 302 + Set-Cookie nx_access / nx_refresh / nx_csrf
```

Full per-flow sequence diagrams (15 of them, including the collision-blocked and 24h
re-auth paths) live in the [SSO Integration Guide §5](/docs/sso-integration).

### 1.1 Authentication transport

* HttpOnly cookies for `nx_access` / `nx_refresh` / `nx_csrf`. JS
  never sees the access token; the CSRF cookie is JS-readable and
  echoed back as `X-CSRF-Token` on writes (double-submit).
* Refresh-token rotation with reuse-detection: presenting the same
  `jti` twice revokes the whole `family_id`.
* Session-cookie cache: `frontend/src/store/userCache.ts`
  sessionStorage-only, schema-versioned, wiped on logout / 401 /
  SSO re-auth bounce. Eliminates the cold-boot `/me` flash without
  introducing localStorage XSS exposure.

### 1.2 Identity providers (per-row, DB-backed)

| Provider | Implementation | When to use |
|---|---|---|
| `local` | argon2id over email+password | default; everyone has it unless `allow_local_login=false` |
| `oidc` | Authorization Code + PKCE + JWKS verify | Entra ID, Auth0, Ping, Keycloak, Okta-OIDC |
| `saml2` | python3-saml strict mode + replay cache | ADFS, OneLogin, Okta-SAML, PingFederate |
| `custom_profile` | profile handed over via cookie / browser storage / proxy header | internal deployments where a corporate portal or auth proxy already authenticated the user |
| `custom` | HS256-signed cookie envelope (dev/demo only) | local development, CI smoke, demo videos |

Every provider is one row in `idp_providers`. The runtime
`ProviderRegistry` (`backend/auth_service/providers/registry.py`)
caches built instances for 60 s; admin mutations explicitly
invalidate. Multiple providers of the same kind are allowed
(e.g. `oidc/entra-staff` + `oidc/auth0-contractors`).

### 1.3 Configurable claim mapping

`backend/auth_service/providers/claim_mapper.py` is the single,
pure-function library every provider delegates to. The operator
declares per-provider mappings as JSON:

```json
{
  "external_id":    ["sub"],
  "email":          ["email", "mail"],
  "email_verified": ["email_verified"],
  "first_name":     ["given_name", "givenName"],
  "last_name":      ["family_name", "surname"],
  "groups":         ["groups", "wids", "roles"],
  "auth_time":      ["auth_time"],
  "extras": {
    "department":   ["department", "extension_Department"],
    "employee_id":  ["employeeid", "employee_id"],
    "staff_id":     ["staffNumber"]
  }
}
```

* Path syntax: dotted JSONPath-lite (`profile.given_name`,
  `address.country[0]`). No wildcards.
* Each field's value is the first non-empty match from its candidate
  list. Empty list / unset key → falls back to the kind's defaults
  (`DEFAULT_OIDC`, `DEFAULT_SAML`, `DEFAULT_CUSTOM`).
* `extras` lands two places:
  * `users.metadata_.attributes` — JSON snapshot (canonical raw).
  * `user_external_attributes` rows — indexed projection used by the
    admin `staff_id=12345` lookup.

### 1.4 Multi-identity per user

One user row, N `user_identities` rows. Schema:

* `UNIQUE(provider_id, external_id)` — the durable SSO join key.
* `UNIQUE(user_id, provider_id)` — one identity per (user, provider)
  pair.

Implications:

* A user can stack `local password + Entra OIDC + Auth0 OIDC + SAML`
  simultaneously.
* "Does this user have a password?" is
  `is_password_set(user.password_hash)` — a sentinel check, not a
  heuristic.
* "Does this user have SSO?" is
  `user_identity_repo.has_any_identity(user_id)`.

### 1.5 Group → target mapping (v2)

`idp_group_role_mappings` rows are typed:

* `target_type='role_binding'` — Phase 2 default. Creates a
  `RoleBindingORM` row with `source='sso'` in
  `(scope_type, scope_id, role_name)`.
* `target_type='group_membership'` — Phase 3. Creates a
  `GroupMemberORM` row with `source='sso'` in the configured internal
  `Group`. Internal admins manage group composition; permissions
  flow through the existing Group→RoleBinding pipeline.

Validation at write time:

* `role_binding`: `role_repo.role_is_bindable_in_scope` must return
  true.
* `group_membership`: the target group must exist and have
  `is_protected=false`.
* Universal: `role_name='system:admin'` is refused (forbidden auto-role).

Reconciliation (`permission_service.reconcile_sso_targets`) runs on
**every SSO login AND on every `/refresh`** for SSO sessions. Admin
mapping changes propagate to active sessions within ~5 min (one
refresh cycle).

### 1.6 24-hour SSO re-authentication

SSO refresh tokens carry the IdP-issued `auth_time` claim. On
`/refresh`:

* `SSO_SESSION_MAX_AGE_HOURS` exceeded → revoke the family + every
  live access token via the injected session-killer (Redis
  reverse-index) + raise `SsoReauthRequired` → router returns 401
  `{"error":"sso_reauth_required","login_url":"..."}`.
* Frontend's `fetchWithTimeout.tryRefresh` detects this body and
  navigates via `window.location.href` to the IdP — silent re-auth.
* OIDC authorize URL pins `max_age=86400` + `prompt=login` on the
  re-auth bounce (belt-and-suspenders at the IdP).
* SAML AuthnRequest sets `ForceAuthn=true` on the re-auth bounce.
* Local password sessions are exempt — `auth_time` is NULL.

### 1.7 Linking + manual linking

Per-provider `linking_policy` controls auto-link behaviour on
existing-email collisions:

| Policy | Auto-link when… | Use case |
|---|---|---|
| `strict` (default) | `email_verified=true` AND existing account is local (no SSO yet) AND active | Most enterprise rollouts |
| `allow_verified` | `email_verified=true` AND active (even if other identities exist) | Multi-IdP stacking |
| `manual_only` | never; user must initiate from `/me/identities` | High-security; explicit operator approval |
| `disabled` | never (also blocks JIT on collision) | Test/demo deny path |

Self-service link/unlink: `/me/identities` (FE) and
`/api/v1/me/identities/*` (BE). The link-intent cookie is a signed
JWT carrying `(user_id, provider_id)`; the SSO callback honours it
to bind the verified subject to the current user instead of
provisioning.

Admin link/unlink: `/api/v1/admin/users/{user_id}/identities/*`.
Admin unlink bypasses the last-authenticator invariant (operators
follow up with a password reset / re-invite).

### 1.8 Signup provenance + indexed claim attributes (Phase 4)

* `users.signup_source` ∈ `{local_signup, sso_jit, invite,
  admin_created, admin_linked}` — answers "how did this account
  come into existence?" without replaying the audit log.
* `users.signup_provider_id` — FK to the IdP that JIT-provisioned
  the account (NULL for local).
* `user_external_attributes (user_id, key, value, source_provider_id,
  set_at)` — indexed projection of `claim_mapping.extras`. UNIQUE
  on `(user_id, key)`; INDEX on `(key, value)` powers the
  staff_id lookup. Multi-valued claims flatten to CSV in `value`
  so a single index serves both exact and substring search.

### 1.9 Platform-wide posture switches (Phase 4)

Singleton row in `app_auth_config`:

| Toggle | Default | When OFF |
|---|---|---|
| `sso_enabled` | true | `/auth/providers` returns `[]`; `/auth/{slug}/*` 404s |
| `allow_local_login` | true | `POST /auth/login` returns 403 `{"error":"local_login_disabled"}` |
| `allow_jit_provisioning` | true | New IdP subjects with no email match raise `jit_disabled` |
| `email_first_login` | **false** | `POST /auth/resolve` always answers `{"provider": null}`; the login page is byte-for-byte what it was |

The PATCH endpoint refuses lockout scenarios:

* `allow_local_login=false` is rejected (HTTP 409) when any active
  admin lacks an SSO identity. Response carries the offending admin
  list so the operator can fix it.
* `sso_enabled=false` AND `allow_local_login=false` together is
  rejected — there'd be no way to log in.

### 1.10 Admin lookup + search

* `GET /api/v1/admin/users/lookup?mode=email|identity|attribute&...`
  — structured single-result. Each mode hits a dedicated index.
* `GET /api/v1/admin/users/search?q=...&limit=20` — free-text
  fan-out across email + names + identity external_id + indexed
  attribute values. `asyncio.gather`; dedupes on user_id; returns
  `matchedOn` per row.

Shared response shape (`UserSummary`): id, email, name, status,
`signupSource`, `signupProvider`, `passwordSet`, `identities[]`,
`attributes[]`, `matchedOn[]`.

### 1.11 Secrets handling

* Provider `settings` (incl. `client_secret`, `sp_private_key`,
  `idp_x509_cert`) stored Fernet-encrypted in
  `idp_providers.settings`. Reuses the existing
  `CREDENTIAL_ENCRYPTION_KEY` envelope from `connection_repo._get_fernet`
  — one key-management surface for the whole project.
* Admin `GET /admin/idp-providers` redacts secret fields to
  `"********"`. Rotation happens by PATCH-ing the field with a new
  value (the merge logic preserves the rest of the settings dict).
* JWT_SECRET_KEY fails fast at import if < 32 chars (Phase 0
  hardening).

### 1.12 Audit

Outbox events (consumed by `auth_audit_log` table via the relay):

| Event | When |
|---|---|
| `user.logged_in` | every successful login (local + SSO; payload distinguishes) |
| `user.logged_out` | refresh family revoked |
| `user.sso_provisioned` | JIT new user via SSO (includes `signup_source: 'sso_jit'`) |
| `user.sso_linked` | existing user auto-linked to a new SSO identity |
| `user.sso_link_denied` | unsafe_auto_link rejected (payload carries deny_reasons) |
| `user.sso_jit_blocked` | JIT refused because `allow_jit_provisioning=false` |
| `user.sso_unsigned_accepted` | `custom_profile` login accepted an unsigned payload (`trust_unsigned`) |
| `user.sso_header_accepted` | `custom_profile` login trusted a proxy-injected header |
| `user.sso_session_expired` | 24h ceiling hit during /refresh |
| `user.identity.linked` / `user.identity.unlinked` | self-service link/unlink |
| `user.identity.admin_linked` / `user.identity.admin_unlinked` | admin link/unlink |
| `idp.provider.{created,updated,deleted}` | IdP provider CRUD |
| `rbac.sso_mapping.{created,deleted}` | Group→target mapping CRUD |
| `auth.config.updated` | platform posture switch changed |
| `user.sso_login_failed` | any SSO sign-in failure, keyed by the `ref` the user was shown |

### 1.13 Assurance level

Every kind ends up calling `complete_sso_login` with a `ProviderIdentity`,
and from there the platform treats them identically — but they did not all
*earn* the same trust. Assurance makes that difference one word that can be
shown in a list, stamped into an audit event, and used to refuse an
escalation.

| Level | Means | Which providers |
|---|---|---|
| `verified` | a signature over a third-party assertion was checked against a key we hold | `oidc`, `saml2`, `custom_profile` with `payload_format=jwt` |
| `asserted` | a trusted network position vouched for it — sound when the proxy strips inbound copies, a full bypass when it does not, and we cannot tell which from here | `custom_profile` with `source=header` |
| `unverified` | we cannot distinguish a genuine claim from a forged one | `custom_profile` with `trust_unsigned`, and the dev-only `custom` kind |

**Derived on every read, never stored** (`auth_service/providers/assurance.py`).
A column would be a second source of truth that drifts the moment an
operator edits settings.

It is enforced, not just displayed: a **privileged role**
(`PLATFORM_ADMIN_ROLES`) may only be mapped from a `verified` provider.
The check sits in `idp_group_mapping_repo` at mapping-creation time and is
mirrored in the reconciler at login, so a mapping created before the guard
existed — or inserted out of band — is still refused when it would take
effect. `super_admin` is refused from *every* provider regardless of
assurance; admin grants stay manual.

### 1.14 Email-first login (Home Realm Discovery)

Off by default (§1.9). When on, the login page asks for an address first
and routes it to the matching provider, instead of showing every configured
IdP as a button — which is a coin flip once an org has three of them, and
publishes the org's IdP topology to anyone who loads `/login`.

The page's shape follows the posture; it is not a fixed layout with
email-first bolted underneath. `GET /auth/login-context` returns the
catalog and the two posture booleans in one call, and the page renders one
of:

| Posture | Page |
|---|---|
| local + SSO, email-first off | password form, divider, full button row (the default — unchanged) |
| local + SSO, email-first on | email field → routed provider as the primary action; password behind "use a password instead"; button row behind "other ways to sign in" |
| SSO-only, email-first off | the button row alone — no password form, no divider, no "forgot password" |
| SSO-only, email-first on | email field → routed provider; no password escape, because there is nothing to escape to |
| local only | password form; no divider, no empty SSO section |

`login-context` **fails open**: a posture read that raises yields local
login on and email-first off. That is the shape that always has a usable
control on it — failing closed here would render a page nobody can sign in
from.

* Domains live on `idp_providers.email_domains` — plaintext JSON, no
  secrets, normalised on write (`@Corp.Example` and `corp.example` are one
  thing).
* Matching is **exact**. `corp.example.com` does not resolve to a provider
  claiming `example.com`; routing someone to the wrong IdP is worse than
  not routing them at all.
* `POST /auth/resolve` is deliberately **not an enumeration oracle**: a
  miss from the feature being off, an unknown domain, a disabled provider,
  or malformed input all return the same empty body. Rate limited like
  `/login`, and CSRF-exempt because it is called before any session exists.
* Additive: an address that matches nothing falls through to the password
  form and the button row, so a wrong domain mapping cannot strand anyone.

### 1.15 IdP health

A background sweep (`app/services/idp_health.py`) probes every enabled
provider every 15 minutes and writes `app.state.idp_health_cache`.
`GET /admin/idp-providers/status` reads that cache and **opens no
sockets** — the same contract the data-source health endpoint states.

The payload that matters is **certificate expiry**: an expired SAML signing
cert takes every sign-in down at once, and the date was readable months
ahead. Warned at 30 days. It must be computed server-side —
`idp_x509_cert` is a secret field and is redacted on read, so the UI can
never parse it itself. OIDC has no cert dates; there "health" means
discovery/JWKS reachability.

The loop is gated on `runs_scheduler()` so replicas do not duplicate it,
and shuts down instantly via `wait_for(shutdown.wait(), timeout=...)`
rather than sleeping through a deploy. Note this is deliberately **not** a
frontend sweep: the mount-time fan-out pattern was removed from
`useProviderHealthSweep` as a P0.4 regression, and repeating it for IdPs
would re-introduce a bug this codebase already paid for.

### 1.16 Last assertion

The most recent claims blob each provider sent, kept so an operator can
build a claim mapping against what actually arrived rather than a sample
typed from memory.

* Fernet-encrypted at rest, same envelope as `settings`.
* Written best-effort on every successful sign-in — a failure there must
  never cost someone their login.
* Credential-shaped values (`*token*`, `*secret*`, `*password*`, …) are
  replaced with `********` **at capture**; the unredacted form is never
  written. Keys stay so the shape is still visible.
* **Never on `ProviderDTO`.** `GET /admin/idp-providers` reports only
  `lastAssertionAt` so the UI can offer the button; the claims come from
  `GET /admin/idp-providers/{id}/last-assertion`. That is deliberate — it
  cannot leak by someone adding a field to the list response.

---

## 2. How to use it (operator playbooks)

### 2.0 Local laptop bootstrap

The auth service refuses to start without `JWT_SECRET_KEY` (≥32 chars)
in the environment — by design, no ephemeral fallback. For local
development, drop a `.env` or `.env.dev` file in the repo root with
the entries from `.env.example`. The auth-service config will
auto-source it on import, **gated on** `ENV` not being a
production-looking value AND the file existing in CWD. Anything you
export in the shell beforehand wins (`override=False`), so you can
still pin a one-off secret without editing the file. Production
containers that don't ship a `.env` remain on the bare-env path; a
stray `.env` accidentally baked into a prod image is ignored because
the `ENV` gate fails.

```bash
# fresh laptop, first time
cp .env.example .env.dev   # or write your own with a 48-char secret
uvicorn backend.app.main:app --reload
# -> boots. No need to manually `export JWT_SECRET_KEY` first.

# CI / one-off override
export JWT_SECRET_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
uvicorn backend.app.main:app --reload
# -> shell value wins over .env.dev's value (override=False is honoured).
```

### 2.0.1 Apply the migrations (laptop-only step)

The auth path writes to `auth_audit_log` (Phase 0 table) and reads
from `user_identities`, `idp_providers`, `user_external_attributes`,
`app_auth_config` (Phase 2–4 tables). On Kubernetes those are
created by the Helm `pre-install,pre-upgrade` hook
(`deploy/helm/dataviz/templates/upgrade-job.yaml`) and every backend
pod refuses to start until the `schemaCheckInitContainer` confirms
the DB matches every Alembic head. `uvicorn --reload` on a laptop
bypasses both — you have to apply the chain yourself once, when
pointing the app at a fresh Postgres:

```bash
# one-time bootstrap against a local Postgres
export MANAGEMENT_DB_URL=postgresql+asyncpg://synodic:synodic@localhost:5432/synodic
python -m backend.scripts.upgrade upgrade   # alembic upgrade head, under pg_advisory_lock
python -m backend.scripts.upgrade check     # exits 0 iff the DB matches every head
```

`backend/scripts/upgrade.py` is the same CLI the Helm Job runs. Using
it (rather than raw `alembic upgrade head`) gets you the
`pg_advisory_lock(0x53594E4F)` serialisation guard for free, so a
second invocation from `kubectl exec` or another shell can't race.

If you skip this step you'll see a stream of warnings from the
outbox relay:

```
WARNING [backend.app.services.outbox_relay] Outbox relay drain failed:
  relation "auth_audit_log" does not exist
```

This is loud on purpose — the relay reports a genuinely missing
table every few seconds and we deliberately do NOT swallow it (silent
schema drift is exactly what the Phase 0 hardening pass set out to
prevent). The stream stops the moment `upgrade` completes; no need
to restart uvicorn.

K8s deployments via Helm do not need this step — the hook Job runs
ahead of every `helm install/upgrade`.

### 2.1 Configure a new OIDC provider

1. Admin → SSO → Providers → **Add provider**.
2. Fill in:
   * **Slug** — URL-safe identifier (e.g. `entra-staff`). Becomes
     `/api/v1/auth/entra-staff/login`.
   * **Display name** — shown on the login button (e.g. `Corporate
     Entra ID`).
   * **Kind** — `oidc`.
   * **Linking policy** — `strict` for most cases.
   * **Settings (JSON)**:
     ```json
     {
       "issuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
       "client_id": "<your client id>",
       "client_secret": "<your client secret>",
       "redirect_uri": "https://app.example.com/api/v1/auth/entra-staff/callback",
       "scopes": "openid email profile"
     }
     ```
   * **Claim mapping (JSON)** — empty `{}` to use defaults, or
     override fields. Operators commonly add `extras`:
     ```json
     {
       "groups": ["wids"],
       "extras": {
         "department": ["department"],
         "employee_id": ["employeeid"]
       }
     }
     ```
3. Register the redirect URI at the IdP. Use the claim-mapping
   editor's **Preview** button (POST `/admin/idp-providers/{id}/test`)
   to paste a sample id_token claims blob and confirm the mapping
   resolves to the expected `ProviderIdentity` (incl. `attributes`).
   Preview needs a saved row, so create the provider first, then reopen
   it with the row's edit (pencil) action.
4. Toggle **Enabled** on; the login page picks it up within 60 s
   (registry TTL).

### 2.2 Configure a new SAML provider

1. Same flow as OIDC, with kind `saml2`.
2. Settings JSON:
   ```json
   {
     "sp_entity_id": "https://app.example.com/saml/metadata",
     "sp_acs_url":   "https://app.example.com/api/v1/auth/okta-prod/acs",
     "sp_slo_url":   "https://app.example.com/api/v1/auth/okta-prod/sls",
     "idp_entity_id":"http://www.okta.com/...",
     "idp_sso_url":  "https://example.okta.com/app/.../sso/saml",
     "idp_slo_url":  "https://example.okta.com/app/.../slo/saml",
     "idp_x509_cert":"MIID...",
     "sp_x509_cert": "MIID... (optional, for signing)",
     "sp_private_key":"-----BEGIN PRIVATE KEY-----..."
   }
   ```
3. Hand the SP metadata XML to the IdP team:
   `GET /api/v1/auth/okta-prod/metadata` returns it.
4. Smoke test with `/admin/idp-providers/{id}/test` (paste a SAML
   attribute statement as the `claims` blob).

### 2.2.1 Configure a custom profile provider (cookie / storage / header)

For internal deployments where there is no IdP redirect at all: a
corporate portal or auth proxy has already authenticated the user and
simply hands the profile over. Field names vary per enterprise, so the
mapping is configured in the admin UI rather than in code.

> **Read this first.** A payload in `localStorage` — or in a forgeable
> header — is **not** an authentication. Anyone who can open a browser
> console can write a storage key, and any client can send a header
> unless your proxy strips inbound copies. The default therefore expects
> a **signed JWT**, verified server-side; the transport is then just
> transport. The two escape hatches below (`trust_unsigned`,
> `trusted_proxy_acknowledged`) each require an explicit toggle in the
> admin UI and emit their own audit event on every login.

1. Admin → SSO → Providers → **Add provider**, kind
   `Custom profile (cookie / browser storage / header)`.
2. Pick the **source**:

   | Source | Read by | Login flow |
   |---|---|---|
   | `cookie` | server, off the request | plain 302 through `/auth/{slug}/login`; works with `HttpOnly` |
   | `header` | server, off the request | plain 302; requires `trusted_proxy_acknowledged` |
   | `local_storage` | the browser (JS) | bounces to `/portal-login`, which POSTs to `/auth/{slug}/browser-profile` |
   | `session_storage` | the browser (JS) | same as `local_storage` |

   One source per row. Multiple rows of this kind are fine — run a
   cookie provider and a storage provider side by side if you need to.
3. Set **source key** — the cookie name, storage key, or header name.
4. Settings, for the signed (recommended) case:
   ```json
   {
     "source":          "local_storage",
     "source_key":      "corp.user",
     "payload_format":  "jwt",
     "signing_alg":     "HS256",
     "shared_secret":   "<the secret the portal signs with>",
     "issuer":          "https://portal.corp.example",
     "audience":        "dataviz",
     "max_age_seconds": 300,
     "encoding":        "none"
   }
   ```
   * `exp` is **required** on every payload. `max_age_seconds`
     independently bounds `iat`, so a portal minting a year-long token
     still can't hand out a year-long session. `0` disables that check.
   * `encoding` handles cookies that carry `base64url` or URL-encoded
     JSON, since a raw JSON blob isn't a legal cookie value.
   * `signing_alg: "RS256"` swaps `shared_secret` for `public_key` (PEM).
   * `issuer` / `audience` are enforced only when set.
5. Map the fields. The **Profile field mapping** editor lists our fields
   against ordered candidate keys — first non-empty wins. Defaults
   already cover the common casings (`firstName` / `first_name` /
   `givenName`, `emailAddress` / `mail` / `upn`, `fullName` split into
   first + last), so most portals need no override. For a storage
   source, **Read from my browser** pulls the real object out of your own
   browser so you can map against it; **Preview** resolves it through
   the mapping server-side and shows the resulting profile.
6. Anything else worth keeping (department, employee ID) goes under
   **Extra attributes** — those land in `users.metadata_.attributes` and
   the indexed `user_external_attributes` table, so Admin → SSO → Find
   user can search on them.
7. Toggle **Enabled** on. The login page picks it up within 60 s.

Note on `external_id`: it is the durable join key for
`user_identities`, so it must be stable per user. If the portal has no
subject id, the default candidate list falls back to `email` — workable,
but a renamed mailbox then reads as a new user.

**Unsigned payloads.** If the portal genuinely cannot sign, set
`payload_format: "json"` and tick **Trust unsigned payloads**. Understand
what you are accepting: any user of the app can become any other user,
including an administrator, network isolation notwithstanding. Every such
login is audited as `user.sso_unsigned_accepted`.

**Proxy headers.** `source: "header"` requires
`trusted_proxy_acknowledged: true`. Only tick it once you have confirmed
your proxy strips the header from inbound requests before setting its
own — otherwise a request can name any user it likes. Audited as
`user.sso_header_accepted`.

### 2.3 Set up IdP group → role mapping

Admin → SSO → Group mappings → **Create mapping**.

* **Role-binding target** — "Everyone in the IdP group
  `DataViz-Admins` gets `super_admin` globally":
  * `idpGroup`: `DataViz-Admins`
  * `targetType`: `role_binding`
  * `roleName`: `super_admin`
  * `scopeType`: `global`
* **Group-membership target** — "Everyone in the IdP group
  `engineering` joins the internal `Engineers` group":
  * `idpGroup`: `engineering`
  * `targetType`: `group_membership`
  * `targetGroupId`: `grp_xxxxxxxxxx`

Mapping takes effect on the next SSO login OR the next `/refresh`
(within ~5 min) for sessions already in flight.

> **Warning:** An IdP-group mapping that grants a **global admin** role (`super_admin`
> or `org_admin`) hands platform-wide power to whoever your IdP puts in that group.
> Validation refuses `roleName: system:admin` outright (a forbidden auto-role — that is
> a *permission*, not a bindable role), and `role_is_bindable_in_scope` must pass, but a
> valid `super_admin` binding is exactly as powerful as it sounds. Prefer mapping to
> `group_membership` and managing privileged membership internally. Role names come from
> the [RBAC taxonomy](/docs/rbac).

### 2.4 Disable local login (SSO-only mode)

> **Caution:** This is a lockout-class change. The API refuses it (HTTP 409) if any
> active admin lacks an SSO identity, and refuses `sso_enabled=false` +
> `allow_local_login=false` together (no way left to log in) — but you still want an
> SSO login verified end-to-end **before** you flip it.

Pre-flight: every admin must have at least one linked SSO identity.
Check via `Admin → SSO → Find user` and confirm each admin has a
`Linked identities` row, OR have them go to `/me/identities` and
click **Link** for an IdP.

Admin → SSO → Settings → toggle **Allow local login** OFF →
confirm. If any admin lacks an SSO identity the API returns 409
with the offending list and the toggle reverts; fix them first
and retry.

### 2.5 Master kill-switch

Admin → SSO → Settings → toggle **SSO enabled** OFF. The login page
will only show the password form; SSO routes 404. Per-provider
`enabled` rows are unchanged; flipping the master toggle back on
restores everything.

### 2.6 Block JIT provisioning

Admin → SSO → Settings → toggle **Allow JIT provisioning** OFF. New
IdP subjects whose email doesn't match an existing user get
`jit_disabled` (audited as `user.sso_jit_blocked`). Existing users
keep working — admins must pre-create / invite new users before
they can SSO in.

### 2.7 Find a user

Admin → SSO → Find user. Three modes:

* **Free-text** — type any of email, name, external_id, or attribute
  value. Fan-out across all four; results show which dimension
  matched.
* **Find by email** — exact match on `users.email`.
* **Find by claim attribute** — type `staff_id` + the value;
  uses the `(key, value)` composite index. Returns 409 if the value
  matches more than one user (operator narrows with a provider
  filter or uses fan-out instead).

Each result row shows: signup source (color-coded pill), signup
provider, linked identities, indexed attributes with source
attribution, last-login timestamps.

### 2.8 Daily SSO re-auth in practice

Operators don't see this — it's silent. The 24-hour ceiling
expires the refresh family; the FE detects the structured 401 on
the next `/refresh` and navigates the browser to the IdP. If the
IdP session is still warm the user sees a brief redirect; if not,
they see the IdP login form. After auth they land where they
were trying to go.

To trigger manually for testing: set
`SSO_SESSION_MAX_AGE_HOURS=0.001` in the backend env, wait 5 s,
make any API request from a logged-in tab.

### 2.9 Migrating from env-vars to DB-stored config

Phase 3 boot seeder reads the legacy `OIDC_*` / `SAML_*` env vars
and inserts `default-oidc` / `default-saml2` provider rows
**once**. After first start, operators edit the rows via the admin
UI; env vars become advisory. To restart from scratch: delete the
row in the admin UI, set the env vars, restart.

### 2.10 Onboard a provider by discovery (instead of typing 15 fields)

Admin → SSO → Providers → **Add provider** → paste one of:

* an **OIDC issuer URL** — the `.well-known/openid-configuration` is
  fetched and `authorization_endpoint` / `token_endpoint` / `jwks_uri` /
  `issuer` are filled in. Trailing slashes are normalised first; without
  that an admin who pastes one gets a confusing issuer mismatch.
* a **SAML metadata URL**, or the **metadata XML** itself — entity id,
  SSO/SLO URLs, and the signing certificate are extracted.

Then review and save. `POST /admin/idp-providers/discover` **never
persists** — it fills a form. A probe failure is a structured
`{"success": false, "error": ...}` result, not a 500: "your IdP is
unreachable" is an answer, not a server fault. On an image without
`libxmlsec1` the SAML half reports the capability as missing rather than
crashing the router.

### 2.11 Rehearse a sign-in before users do (dry run)

`/test` rehearses the claim *mapping* against a pasted blob. The half that
actually breaks in production — redirect URI registered at the IdP,
signature verifies, clock skew, certificate still valid — is what this
covers.

1. Admin → SSO → Providers → the flask icon on the provider row.
2. A new tab opens the real IdP login. **Sign in with your own account.**
3. The callback reports what *would* have happened: which branch fires
   (`provision_new` / `sign_in_existing` / `link_existing` / `rejected`),
   which user would be touched, why a link would be refused, and which
   group mappings would match.

No session is minted and no rows are written — close the tab and you are
still signed in as yourself. The marker cookie is minted only by
`POST /admin/idp-providers/{id}/dry-run/start`, which requires
`system:admin`; that is what keeps this from being a way for an anonymous
caller to probe identities. It expires in 10 minutes.

A rehearsal cannot disagree with the sign-in it rehearses: both run the
same `_classify_sso_login`, which decides the branch from reads alone. The
real login then executes the writes for that decision; the dry-run renders
it. There is one implementation of "which branch fires", not two kept in
agreement by hand.

Available on **every** provider kind, including `custom_profile` — the
kind with the weakest assurance, so the one where rehearsing matters most.
The browser-storage variant answers with JSON rather than the result page,
since it is reached by `fetch()`.

### 2.12 Debug a failed sign-in from the reference the user was shown

Every SSO failure redirects to `/login?ref=<8 hex chars>&sso_error=1`. The
reason is deliberately withheld from that page — it is admin-only by
construction and lives in the audit log instead.

Admin → SSO → **Activity** → paste the ref. The `user.sso_login_failed`
event carries the provider and the precise reason
(`state_mismatch`, `token_or_idtoken:…`, `saml_validate:…`,
`sso_login_rejected:jit_disabled`, …).

The tab needs `system:audit:read` in addition to `system:admin` — the two
do not imply each other.

### 2.13 Map claims against what the IdP actually sent

In the claim-mapping editor, **Load last assertion** pulls the most recent
claims blob this provider sent (§1.16) into the sample box, then the live
preview shows exactly what the current mapping would produce from it. This
beats pasting a sample from the IdP's documentation, which is where most
mapping bugs come from.

The button 404s with an explanation until one has been captured — it is
recorded on the next successful sign-in through that provider.

### 2.14 Turn on email-first login

1. Set each provider's **Email domains** (comma or space separated) in the
   provider form. Do this **first**.
2. Admin → SSO → Settings → **Email-first sign-in**.

An address that matches nothing falls back to the password form and the
button row, so nobody is stranded by a domain you missed. To reverse it,
flip the switch off; the login page returns to exactly what it was.

---

## 3. How to verify the implementation is sound

### 3.1 Test suites (cheap, deterministic)

```bash
# Auth/SSO suite — 96 tests
JWT_SECRET_KEY=$(python3 -c "print('x'*48)") PYTHONPATH=. pytest \
  backend/tests/test_sso_phase2.py \
  backend/tests/test_sso_phase3.py \
  backend/tests/test_sso_phase4.py \
  backend/tests/test_oidc_provider.py \
  backend/tests/test_oidc_login_flow.py \
  backend/tests/test_auth_cookie_flow.py \
  backend/tests/test_auth_service_isolation.py \
  backend/tests/test_sso_custom_profile.py \
  backend/tests/test_sso_assurance.py \
  backend/tests/test_sso_activity.py \
  backend/tests/test_sso_discovery.py \
  backend/tests/test_idp_health.py \
  backend/tests/test_sso_hrd_assertion.py \
  backend/tests/test_sso_dry_run.py
```

Expected: 233 passing.

```bash
# Frontend: session cache, the claim mapper UI, and the silent
# custom_profile sign-in (including its anti-loop guard).
cd frontend && npx vitest run src/store/ src/components/admin/ src/components/auth/
```

### 3.2 Architectural invariants

1. **auth-service isolation.** No file under
   `backend/auth_service/` may import from `backend.app.*`. Enforced
   by `test_auth_service_isolation`. If you add a hook the service
   needs, inject it via constructor in `app/main.py`.
2. **Secret redaction.** Every code path that returns an
   `idp_providers` row to the network passes through
   `idp_provider_repo.redact_settings()`. There are no exceptions.
3. **Disabled-password sentinel.** SSO-only users carry the literal
   `_DISABLED_SENTINEL` from `core/password.py`. `verify_password`
   short-circuits to False on this value in constant time.
4. **Alembic chain linearity.** `grep -E "^revision|^down_revision"
   backend/alembic/versions/*.py | sort` must show a single chain.
5. **Outbox audit coverage.** Every state-changing endpoint emits at
   least one event. Grep `create_outbox_event` to confirm.

### 3.3 End-to-end happy paths

Spin up a dev IdP via the custom provider and validate the matrix:

```bash
# 1. Bring the app up with the dev IdP enabled.
export ENV=dev
export AUTH_CUSTOM_PROVIDER_ENABLED=true
export JWT_SECRET_KEY=$(python3 -c "import secrets;print(secrets.token_urlsafe(48))")
```

1. Visit `/login` → should see the password form + a yellow
   `Dev Login (mock IdP)` button.
2. Click Dev Login → fill in the mock identity form → submit. Expect
   to land on `/dashboard`, logged in as the mock user.
3. Visit `/me/identities` → see the linked identity from
   `default-custom`.
4. Visit `/admin/sso` → Providers tab shows `default-custom`;
   Settings tab shows all three toggles ON; Find user finds the
   mock user.
5. Toggle **Allow local login** OFF in Settings → confirm.
6. Log out → try password login → 403 `local_login_disabled`. Try
   Dev Login again → succeeds.
7. Toggle **Allow JIT provisioning** OFF → log out → Dev Login with
   a brand-new external_id + email → `/login?sso_error=1`. Logs
   show `user.sso_jit_blocked`.
8. Toggle everything back ON.

### 3.4 Review checklist

1. Read `docs/SSO.md` (this file) end-to-end.
2. Walk the migrations in chronological order:
   `20260517_1200_user_sso_unique.py` →
   `20260517_1300_auth_audit_log.py` →
   `20260521_1200_sso_phase2.py` →
   `20260524_1100_sso_phase3.py` →
   `20260527_1200_sso_phase4.py` →
   `20260530_1200_display_rules.py`.
   Each is idempotent + reversible.
3. Skim `auth_service/service.py:complete_sso_login` — the linking
   policy matrix is the highest-risk surface.
4. Confirm `auth_service/api/router.py` honours both
   `sso_enabled` (via `_require_sso_enabled`) and
   `allow_local_login` (via the 403 mapping for `LocalLoginDisabled`).
5. Confirm `permission_service.reconcile_sso_targets` is called
   from both `complete_sso_login` AND `refresh()`.
6. Confirm the lockout safeguard in `admin_sso_config.update_config`
   refuses the dual-deny states.
7. Confirm `claim_mapper` is the only place field extraction
   happens — providers should not have hand-rolled email/group
   extraction code anymore.

---

## 4. Best-in-class alignment

The implementation matches what cookie-session enterprise SaaS
apps (Linear, Notion, Vercel, Stripe Dashboard) ship today. Where
we go beyond the typical pattern:

* **Per-provider claim mapping with attribute pass-through** —
  most platforms expose three or four fixed fields. We pass any
  operator-declared `extras` through to a searchable index, which
  unlocks `staff_id` lookup without a SCIM detour.
* **Group → internal-Group mapping** — most platforms only allow
  IdP group → direct RoleBinding, forcing operators to mirror
  every IdP rename. Group-membership mapping decouples IdP-side
  and internal group management.
* **Continuous reconciliation on /refresh** — many platforms only
  reconcile on login. Admin mapping changes propagate within ~5 min
  here.
* **Multi-identity per user with last-authenticator invariant** —
  most platforms lock you to one IdP per account. Ours stacks
  arbitrarily, with a server-side guarantee the unlink path can't
  brick a user.
* **Posture switches with lockout safeguard** — the
  `allow_local_login` toggle refuses to land if it would lock out
  any admin. Most platforms make the operator manually verify; we
  enforce it.
* **Assurance as an enforced property** (§1.13) — platforms that
  support header-trusting or unsigned providers at all generally
  treat their word as equal to a verified assertion. We rank it and
  refuse to auto-grant a privileged role from a provider that only
  asserts.
* **Dry-run against the real IdP** (§2.11) — the usual offering is a
  claim-mapping preview against a pasted blob, which does not test
  the things that actually break. Rehearsing the full round trip
  with nothing written is, as far as we know, not standard.
* **Certificate expiry surfaced before it fires** (§1.15) — an
  expired SAML signing cert is the classic Monday-morning lockout,
  and the date was readable months ahead.

Known follow-ups (not yet implemented):

* SCIM 2.0 user + group provisioning / deprovisioning. Currently
  group sync is reactive (per login); SCIM would be push-based.
* JIT validation gates: `require_email_verified` global +
  `jit_allowed_email_domains` allow-list.
* `default_jit_role` (grant a role at global scope to every fresh
  JIT user).
* HS256 → RS256/ES256 + JWKS rotation. HS256 with a fail-fast
  secret is fine for an in-process auth service; the move matters
  once we extract it.
* KMS/Vault envelope for secrets. The Fernet pattern is consistent
  with the rest of the codebase; KMS would swap the
  `_get_fernet()` helper without touching the SSO surface.

---

## 5. Reference: file map

```
backend/auth_service/
  core/
    config.py            # env + SSO_SESSION_MAX_AGE_HOURS + AUTH_CUSTOM_PROVIDER_ENABLED
    password.py          # argon2id + disabled-password sentinel + is_password_set()
    tokens.py            # access/refresh/invite/oidc-state/saml-state/mock-identity/
                         #   link-intent/dry-run JWTs
  providers/
    base.py              # ProviderIdentity dataclass (with groups, auth_time, attributes)
    claim_mapper.py      # configurable extraction (dotted JSONPath-lite + extras)
    registry.py          # TTL-cached DB-backed factory
    oidc.py              # Authorization Code + PKCE + JWKS verify
    saml2.py             # python3-saml strict + replay cache
    custom.py            # dev/demo cookie envelope
    custom_profile.py    # cookie / browser storage / proxy header ingest
    local.py             # email + password
    assurance.py         # verified / asserted / unverified, derived from kind+settings
  app_auth_config.py     # AuthConfigSnapshot + provider Protocol + CachedAuthConfigProvider
  service.py             # LocalIdentityService (orchestrates login/refresh/SSO)
  interface.py           # User DTO + AuthError taxonomy
  cookies.py             # session/OIDC/SAML/mock/link-intent/dry-run cookie helpers
  api/router.py          # /auth/* slug-routed endpoints

backend/app/db/
  models.py              # UserORM (signup_source, signup_provider_id) + UserIdentityORM
                         # + IdpProviderORM + IdpGroupRoleMappingORM (target_type)
                         # + UserExternalAttributeORM + AppAuthConfigORM + ...
  repositories/
    user_repo.py             # create_user / create_sso_user / set_user_idp_metadata / search_users
    user_identity_repo.py    # multi-identity CRUD + last-authenticator invariant
    user_attribute_repo.py   # indexed extras: upsert_for_user / get_users_by_attribute / substring search
    idp_provider_repo.py     # Fernet-encrypted CRUD + redaction
    idp_group_mapping_repo.py# role_binding + group_membership targets + validation
    app_auth_config_repo.py  # singleton CRUD with optimistic version bump
  services/
    permission_service.py    # reconcile_sso_targets (both target types)
    idp_health.py            # background probe loop -> app.state.idp_health_cache

backend/app/api/v1/endpoints/
  admin_idp_providers.py   # CRUD + /test mapping preview + /discover + /status
                           #   + /dry-run/start + /last-assertion
  admin_idp_groups.py      # mapping CRUD (both target types)
  admin_user_identities.py # admin link/unlink
  admin_users_lookup.py    # /lookup (structured) + /search (fan-out)
  admin_sso_config.py      # platform posture switches
  me_identities.py         # self-service link/unlink + link-intent

backend/alembic/versions/
  20260517_1200_user_sso_unique.py
  20260517_1300_auth_audit_log.py
  20260521_1200_sso_phase2.py
  20260524_1100_sso_phase3.py
  20260527_1200_sso_phase4.py                    # (Phase 4; renamed from
                                                  #  user_provenance_and_config to
                                                  #  fit alembic_version VARCHAR(32))
  20260530_1200_display_rules.py                  # (main; re-pointed + renamed
                                                  #  from context_models_display_rules)
  20260725_1200_custom_profile.py                 # custom_profile kind
  20260725_1400_sso_hrd_assertion.py              # email_domains + last_assertion
                                                  #  + email_first_login

frontend/src/
  store/auth.ts                  # auth store (Zustand)
  store/userCache.ts             # sessionStorage cache for User DTO
  services/authService.ts        # /auth + /me/identities client
  services/ssoAdminService.ts    # /admin/sso/* client
  services/fetchWithTimeout.ts   # 401 silent refresh + sso_reauth_required redirect
  pages/MyIdentitiesPage.tsx     # /me/identities
  pages/DevLogin.tsx             # /dev-login (custom IdP)
  pages/PortalLogin.tsx          # /portal-login (custom_profile web storage)
  components/admin/AdminSso.tsx  # Providers / Mappings / Settings / Find user tabs
  components/admin/ProviderForm.tsx      # create + edit, kind-aware settings
  components/admin/ClaimMappingEditor.tsx # visual field mapper + live preview
  components/auth/LoginPage.tsx  # dynamic SSO buttons + collision modal
                                 # + one-shot silent custom_profile sign-in
```
