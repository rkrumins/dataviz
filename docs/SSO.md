# SSO — operator + reviewer reference

Single source of truth for the SSO/IdP integration shipped in Phases
0–4. Read this end-to-end before reviewing the branch; share the
relevant sub-sections with operators standing up a new IdP.

Branch under review: `claude/audit-rbac-enforcement-PikQK`
Phases landed: **Phase 0** (RBAC hardening + fail-fast secrets) →
**Phase 1** (OIDC) → **Phase 2** (SAML, custom dev IdP, 24h re-auth,
group→role mapping v1) → **Phase 3** (multi-IdP, multi-identity,
configurable claim mapping, group→Group mapping) → **Phase 4** (signup
provenance, indexed claim attributes, platform posture switches,
admin lookup + search).

---

## 1. What's implemented

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
| `user.sso_session_expired` | 24h ceiling hit during /refresh |
| `user.identity.linked` / `user.identity.unlinked` | self-service link/unlink |
| `user.identity.admin_linked` / `user.identity.admin_unlinked` | admin link/unlink |
| `idp.provider.{created,updated,deleted}` | IdP provider CRUD |
| `rbac.sso_mapping.{created,deleted}` | Group→target mapping CRUD |
| `auth.config.updated` | platform posture switch changed |

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
3. Register the redirect URI at the IdP. Use the **Test** button
   (POST `/admin/idp-providers/{id}/test`) to paste a sample
   id_token claims blob and confirm the mapping resolves to the
   expected `ProviderIdentity` (incl. `attributes`).
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

### 2.3 Set up IdP group → role mapping

Admin → SSO → Group mappings → **Create mapping**.

* **Role-binding target** — "Everyone in the IdP group
  `DataViz-Admins` gets `admin` globally":
  * `idpGroup`: `DataViz-Admins`
  * `targetType`: `role_binding`
  * `roleName`: `admin`
  * `scopeType`: `global`
* **Group-membership target** — "Everyone in the IdP group
  `engineering` joins the internal `Engineers` group":
  * `idpGroup`: `engineering`
  * `targetType`: `group_membership`
  * `targetGroupId`: `grp_xxxxxxxxxx`

Mapping takes effect on the next SSO login OR the next `/refresh`
(within ~5 min) for sessions already in flight.

### 2.4 Disable local login (SSO-only mode)

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
  backend/tests/test_auth_service_isolation.py
```

Expected: 96 passing.

```bash
# Frontend sessionStorage cache
cd frontend && npx vitest run src/store/
```

Expected: 19 passing.

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

### 3.4 PR review checklist (for reviewers)

1. Read `docs/SSO.md` (this file) end-to-end.
2. Walk the migrations in chronological order:
   `20260517_1200_user_sso_unique.py` →
   `20260517_1300_auth_audit_log.py` →
   `20260521_1200_sso_phase2.py` →
   `20260524_1100_sso_phase3.py` →
   `20260527_1200_user_provenance_and_config.py` →
   `20260530_1200_context_models_display_rules.py`.
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

Known follow-ups (deferred, not in scope for this PR):

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
    tokens.py            # access/refresh/invite/oidc-state/saml-state/mock-identity/link-intent JWTs
  providers/
    base.py              # ProviderIdentity dataclass (with groups, auth_time, attributes)
    claim_mapper.py      # configurable extraction (dotted JSONPath-lite + extras)
    registry.py          # TTL-cached DB-backed factory
    oidc.py              # Authorization Code + PKCE + JWKS verify
    saml2.py             # python3-saml strict + replay cache
    custom.py            # dev/demo cookie envelope
    local.py             # email + password
  app_auth_config.py     # AuthConfigSnapshot + provider Protocol + CachedAuthConfigProvider
  service.py             # LocalIdentityService (orchestrates login/refresh/SSO)
  interface.py           # User DTO + AuthError taxonomy
  cookies.py             # session/OIDC/SAML/mock/link-intent cookie helpers
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

backend/app/api/v1/endpoints/
  admin_idp_providers.py   # CRUD + /test dry-run
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
  20260527_1200_user_provenance_and_config.py
  20260530_1200_context_models_display_rules.py  # (main; re-pointed)

frontend/src/
  store/auth.ts                  # auth store (Zustand)
  store/userCache.ts             # sessionStorage cache for User DTO
  services/authService.ts        # /auth + /me/identities client
  services/ssoAdminService.ts    # /admin/sso/* client
  services/fetchWithTimeout.ts   # 401 silent refresh + sso_reauth_required redirect
  pages/MyIdentitiesPage.tsx     # /me/identities
  pages/DevLogin.tsx             # /dev-login (custom IdP)
  components/admin/AdminSso.tsx  # Providers / Mappings / Settings / Find user tabs
  components/auth/LoginPage.tsx  # dynamic SSO buttons + collision modal
```
