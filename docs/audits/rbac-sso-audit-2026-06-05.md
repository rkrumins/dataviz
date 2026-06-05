# RBAC + SSO Audit & Remediation — 2026-06-05

**Scope:** Full audit of role-based access control (roles / groups /
permissions), workspace-scoped permissions, and SSO / identity-provider
integration across frontend, backend, and architecture. Remediation this
round was deliberately narrowed (per stakeholder direction) to the
**critical security/correctness findings only**; hardening items are
documented below as deferred recommendations.

---

## 1. Verdict

The platform already implements a **mature, well-architected** RBAC + SSO
system (internally "Phase 18"). It realises the intended model directly:

> **Roles bundle Permissions. A Role binds to a User or a Group. Each
> binding is scoped either `global` (entire system) or to a single
> `workspace`.**

No architectural rework was required. The audit surfaced a small number of
concrete bugs (not design flaws), three of which were security- or
lockout-critical and have been fixed.

---

## 2. Architecture as built

### 2.1 Data model (`backend/app/db/models.py`)
| Table | Role |
|-------|------|
| `permissions` | Catalogue; semantic-string PK (`workspace:view:edit`), `category` ∈ `system` / `workspace` / `resource`. |
| `roles` → `role_permissions` | A role bundles permissions. System roles: `super_admin`, `org_admin`, `workspace_admin`, `workspace_member`, `workspace_viewer`. |
| `groups` / `group_members` | Groups aggregate users; SCIM/SSO or local provenance. |
| `role_bindings` | **Core.** Polymorphic subject (`user`|`group`) → role within scope (`global`|`workspace`), optional `expires_at`, `source` (`local`|`sso`). |
| `resource_grants` | Layer-3 per-view shares (`editor`/`viewer`). |
| `idp_providers` | One row per SSO IdP (OIDC / SAML2 / custom); Fernet-encrypted `settings`. |
| `user_identities` | Multi-identity per user (`provider_id`,`external_id`). |
| `idp_group_role_mappings` | IdP group → role-binding or group-membership. Refuses mapping to `system:admin` and to protected groups. |
| `app_auth_config` | Singleton SSO posture (`sso_enabled`, `allow_local_login`, `allow_jit_provisioning`). |
| `auth_audit_log` / outbox | Auth + RBAC audit trail. |

### 2.2 Enforcement
- **Backend authority:** FastAPI dependency `requires(permission, workspace=…, workspace_any=…)` in `backend/app/auth/dependencies.py`, evaluating JWT `PermissionClaims` via `has_permission` (`backend/app/services/permission_service.py`). Short-circuits: `system:admin` ⇒ all; `system:org-admin` ⇒ all workspace perms. Wildcard (`workspace:view:*`) expansion supported.
- **Frontend advisory:** `checkPermission` in `frontend/src/store/auth.ts` mirrors the backend rules; `<RequireNav>` / `<RequirePermission>` gate routes and controls; the FE never holds tokens (HttpOnly cookies) and treats 403 as authoritative.

### 2.3 SSO
JWT access (5 min) + rotating refresh (7 day, reuse-detected) over HttpOnly
cookies, CSRF double-submit. Multi-provider DB-backed registry; OIDC
(code+PKCE, state+nonce, id-token verification) and SAML2 (signature,
conditions, replay cache). JIT provisioning + group→role reconciliation on
login/refresh, gated by `app_auth_config`.

---

## 3. Findings

| # | Sev | Status | Finding |
|---|-----|--------|---------|
| **H1** | High | **Fixed** | Admin self-lockout guard was dead. `_admins_without_sso_identity` queried the legacy `user_roles` table for `role_name == "admin"`; Phase 5 renamed admin roles to `super_admin` and moved authority to `role_bindings`, so it matched **zero** users — an operator could set `allowLocalLogin=false` with no SSO-linked admin and lock everyone out. |
| **H2** | High | **Fixed** | SSO callback consumed the signed `nx_link_intent` cookie without re-validating the live session, so a replayed/stolen link-intent cookie could bind an IdP identity to an account the caller did not control. |
| **H3** | High | **Fixed** | IdP-provider and graph-connection secrets fell back to **plaintext JSON** (warning only) when `CREDENTIAL_ENCRYPTION_KEY` was unset — including in production. |
| E1 | Med-High | Deferred | Enforcement-coverage test (`tests/test_rbac_endpoint_coverage.py`) uses hardcoded path lists, not route discovery — a new endpoint shipped without `requires(...)` would pass CI unnoticed. Recommend an `app.routes`-walking drift test asserting every route is gated or explicitly allow-listed. |
| M1 | Med | Deferred | No cleanup job prunes expired `revoked_refresh_jti` (and expired `role_bindings`) rows; the table grows unbounded. |
| M2 | Med | Deferred | `resource_grants` has no `expires_at`, so per-view shares never expire (unlike `role_bindings`). |
| M3 | Med | Deferred | `email_verified` is treated as `False` when the IdP omits the claim, with no warning — a `strict` linking policy then silently refuses, hiding IdP misconfiguration. |
| M4 | Med | Deferred | No rate limiting on authenticated `/admin/*` paths (login/refresh are limited); denied-access audit signal can be flooded. |
| M5 | Med | Deferred | Denied-access audit dedupe is hourly per (user, perm, scope), collapsing up to 60 probes/hour into one event. |
| P1 | Med | Deferred | FE `checkPermission` mirrors BE `has_permission` by hand with no shared test vector — silent drift risk. Recommend a shared `(claims, permission, ws, expected)` fixture asserted on both sides. |
| L1 | Low | Deferred | No IdP-initiated SLO (app-side logout only); OIDC/SAML session persists at the IdP. |
| L2 | Low | Deferred | Multi-identity group staleness: reconciliation reads the latest-login provider snapshot, so a second linked IdP's groups can be stale until next login via that IdP. |
| L3 | Low | Deferred | SAML routes 404 silently when `python3-saml` / `libxmlsec1` is unavailable; no admin-visible warning if a SAML provider is configured. |
| L4 | Low | Deferred | No bulk "what does this role grant across all workspaces" permission-audit endpoint. |
| L5 | Low | Deferred | No frontend nav-catalogue drift test (backend side is covered). |

---

## 4. Remediation delivered this round

All three High findings fixed with regression tests (run via the repo
`.venv`):

### H1 — `backend/app/api/v1/endpoints/admin_sso_config.py`
New `_super_admin_user_ids()` resolves admins from `role_bindings`
(`role_name='super_admin'`, `scope_type='global'`), expanding group
membership and skipping expired bindings; `_admins_without_sso_identity()`
now uses it. The legacy `UserRoleORM` join is removed.
Tests: `tests/test_rbac_admin_lockout.py` (2).

### H2 — `backend/auth_service/api/router.py`
New `_resolve_link_intent()` re-validates the access-cookie session and only
honours the link-intent when its user_id matches the live session; on
mismatch it logs and drops the intent (falls through to a normal login). All
three callback sites (OIDC, SAML ACS, custom) use it and now clear the
link-intent cookie whenever one was presented (matched or rejected).
Tests: `tests/test_sso_link_intent_session.py` (4).

### H3 — `backend/app/db/repositories/connection_repo.py` (+ `idp_provider_repo.py`)
New shared `require_encryption_or_plaintext_ok()` raises
`CredentialEncryptionError` when `CREDENTIAL_ENCRYPTION_KEY` is unset and
`ENV ∈ {prod, production}`. Both `_encrypt` and `encrypt_settings` call it
before the plaintext fallback; dev/test behaviour is unchanged.
Tests: `tests/test_credential_encryption_failclosed.py` (4).

**Verification:** new tests green; existing auth/RBAC/SSO suites green
(306 passed across the `rbac|auth|sso|permission|binding|idp|credential`
selection). Two unrelated pre-existing failures were confirmed present on a
clean checkout and are out of scope: `test_rbac_migration.py::test_seed_leaves_match_catalogue`
(ontology wildcard-leaf catalogue drift) and the `trace_v2` collection
import errors; plus network-reachability tests in `test_api_providers.py`
that require DNS.

---

## 5. Recommended next steps (deferred items)

Priority order if/when hardening resumes: **E1** (route-coverage drift test —
cheap, high assurance, directly protects the H-class enforcement guarantee) →
**M2 / M1** (grant/binding expiry + cleanup) → **P1** (FE/BE parity vectors) →
**M3 / M4 / M5** (operational hardening) → **L1–L5**.
