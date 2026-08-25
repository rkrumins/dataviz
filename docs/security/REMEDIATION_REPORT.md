# Security remediation report

**Scope:** user-facing surface — the React SPA and every API endpoint it
drives, with the authentication lifecycle and the corporate-SSO identity
handover as the focus.
**Branch:** `claude/web-app-security-audit-7lihjb` (10 commits, `caf7876`..`9fb4821`)
**Date:** 2026-08-23
**Companion documents:** [`PENTEST_SCOPE.md`](PENTEST_SCOPE.md) (what to test,
what is an accepted risk), [`endpoints.md`](endpoints.md) (generated endpoint
inventory), [`../SSO_INTEGRATION.md`](../SSO_INTEGRATION.md) §10 (threat model).

---

## 1. What this was

The auth surface was already mature before this change. Sessions ride HttpOnly
cookies and never touch web storage; refresh tokens rotate with reuse detection
and family revocation; cookie names and the JWT issuer are environment-scoped; a
signing-key ring supports rotation without mass logout; eight token families are
separated by audience; OIDC uses PKCE + state + nonce + JWKS; SAML uses
python3-saml strict mode; RBAC resolves role bindings into per-request claims
with a typed 403 contract. CI already ran CodeQL, `pip-audit`, `npm audit`,
Trivy and dependency review.

So this was not a rebuild. A full read of the auth core, the SSO providers, the
HTTP perimeter and the SPA found **seven places where a documented control did
not actually hold**, plus roughly twenty-five hardening gaps.

That distinction shaped the work. The dangerous findings were not missing
features — they were controls the documentation asserted, the architecture
assumed, and the code did not implement. A reader of `SSO_INTEGRATION.md` would
have concluded SAML replay was defended. It was not. A reader of the RBAC guard
code would have concluded privileged roles could not be auto-granted through an
IdP. They could.

Every finding below was verified by reading the code, and every defect fix has a
regression test that was proven to fail before the fix.

---

## 2. Confirmed defects

| # | Finding | Severity | Commit |
|---|---|---|---|
| D1 | SAML assertion replay protection never wired | Critical | `fcf07ea` |
| D2 | Cross-workspace read/delete of assignment rule-sets (IDOR) | High | `caf7876` |
| D3 | Logout left the access token live | High | `caf7876` |
| D4 | Password reset did not revoke sessions | High | `caf7876` |
| D5 | Open redirect via backslash in `_safe_next` | Medium | `caf7876` |
| D6 | IdP group-membership mapping bypassed the privileged-role guard | High | `fcf07ea` |
| D7 | Draft IdP providers were live for authentication | High | `fcf07ea` |

### D1 — SAML assertion replay protection was never wired

**What the code did.** `SamlProvider` has always called a replay cache. Nothing
ever handed it one, so it fell back to a process-local dict whose own docstring
read *"never for prod. The real one is wired in `backend/app/main.py`."* It was
not — `grep -rn "replay_cache" backend --include=*.py` returned hits only inside
`saml2.py`. Compounding it, `ProviderRegistry` rebuilds every provider object on
a 60-second TTL, so each rebuild allocated a **fresh, empty cache**.

**Why it mattered.** `SSO_INTEGRATION.md:1409` documented this as a
"Redis-backed cache keyed by assertion id". A captured `SAMLResponse` replayed
inside its `NotOnOrAfter` window minted a full session as the victim on any
worker that had not seen it — a different gunicorn worker (4 per container), a
different replica, or the same worker 60 seconds later. In a multi-replica
deployment the control was effectively absent.

**What changed.** A Redis-backed `SharedSamlReplayCache` (`SET NX EX`, TTL =
`NotOnOrAfter`) built on the existing revocation backend and injected at startup.
In production a SAML provider now **refuses to build** without a shared store
rather than appearing to protect — the same fail-closed stance
`require_encryption_or_plaintext_ok()` takes for credential encryption. The
refusal is per-provider rather than at boot, so a deployment that merely has
python3-saml installed and configures no SAML provider still starts.

**Pinned by:** `test_saml_replay_cache_wired.py` — including replay rejection
across two provider rebuilds, which is the 60-second TTL case a
single-rebuild test would miss.

### D2 — Cross-workspace read and delete of assignment rule-sets

**What the code did.** `assignment_repo.get_rule_set` and `delete_rule_set`
selected on `id` alone. The route took a `ws_id`, used it for an existence check
and an RBAC gate — and that gate authorised the caller against **their own**
workspace.

**Why it mattered.** A holder of `workspace:datasource:manage` in workspace A
could `GET` and `DELETE` `/api/v1/{ws_A}/assets/rule-sets/{id_from_ws_B}`. The
pre-fix regression test showed the `DELETE` returning **204** — it genuinely
destroyed another tenant's row. This is the finding a pen test would lead with,
because it is cross-tenant data destruction reachable by any legitimate
workspace manager.

**What changed.** Both repository functions take a `workspace_id` predicate,
mirroring the already-correct sibling `list_rule_sets_by_workspace`. The
id-only variants carry warning docstrings so the next caller does not repeat it.

**Pinned by:** `test_assets_rule_set_tenant_isolation.py` — both verbs return
404 across the tenant boundary.

### D3 — Logout left the access token live

**What the code did.** `logout()` revoked the refresh family and nothing else. It
never tombstoned the session `sid`.

**Why it mattered.** An access token captured before logout stayed valid for the
full remaining `JWT_EXPIRY_MINUTES + CLOCK_SKEW_LEEWAY_SECONDS` — up to 61
minutes under the shipped Compose default of 60. "Sign out" did not end the
session; it ended the ability to extend it.

**What changed.** The logout route reads the access cookie, decodes it for `sid`,
and passes it to a `session_revoker` injected the same way `session_killer`
already was — so `auth_service` still imports nothing from `backend.app.*`, an
isolation the test suite enforces. The decode is deliberately broad in what it
catches: it runs before the family revocation and before the cookies are
cleared, so anything escaping there would turn a sign-out into a 500 that also
failed to sign the user out.

**Pinned by:** `test_session_termination.py`.

### D4 — Password reset did not revoke sessions

**What the code did.** Self-service `POST /auth/reset-password` and admin
`POST /admin/users/{id}/reset-password` both called `update_password` and
stopped. Neither stamped `sessions_valid_from` nor tombstoned live `sid`s.
`POST /admin/users/{id}/suspend` had the same gap. `change_my_password` got it
right, which is what made the omission easy to miss.

**Why it mattered.** **An attacker holding a session survived the victim's
password reset** — the exact remediation a compromised user performs, and the
exact remediation an incident responder instructs. Four of five assertions in
the pre-fix regression test failed.

**What changed.** A shared helper performs both halves, because both are
required: the `sessions_valid_from` cutoff stops a refresh minting a fresh
untombstoned session, and the tombstones kill what is live now. Called from both
reset paths and from suspend. `_revoke_my_every_session` remains the caller-only
wrapper that also clears cookies.

**Pinned by:** `test_session_termination.py`.

### D5 — Open redirect via backslash in `_safe_next`

**What the code did.**

```python
if not raw or not raw.startswith("/") or raw.startswith("//"):
    return "/"
return raw
```

**Why it mattered.** `/\evil.com` starts with `/` and not `//`, so it passed.
Browsers treat `\` as `/` in the relative-slash state, so `Location: /\evil.com`
resolves to `https://evil.com/`. The value is sealed into the signed flow cookie
and consumed after the callback, so the **authenticated** user is bounced
off-origin — a credible phishing hand-off. 12 of 20 hostile inputs were
accepted.

**What changed.** Backslashes, control characters and encoded variants rejected
after one decode pass, keeping the existing scheme/host/`//` rules. One function
serves OIDC, SAML ACS and both custom kinds, so this was a single fix point.

**Pinned by:** `test_safe_next_hostile_inputs.py` — 29 collected cases.

### D6 — IdP group-membership mapping bypassed the privileged-role guard

**What the code did.** `role_binding` mappings are guarded twice — write-time
refusal applying `FORBIDDEN_AUTO_ROLES` plus an assurance check, and
reconcile-time refusal doing the same. `_validate_group_membership_target` did
neither. It checked existence, soft-delete and `is_protected` — and never asked
**what roles the target group holds**. The reconciler repeated the omission.

And `is_protected` has **no write path anywhere in the codebase**: it is read in
four places and written in none. `group_repo.create_group` does not accept it,
`PATCH /admin/groups/{id}` does not set it, and the migration adds it with
`server_default=FALSE`. Every group creatable through the API is unprotected.

**Why it mattered.** IdP group → internal group holding a global `super_admin`
binding → whoever the IdP puts in that group becomes platform super-admin, with
no forbidden-role check and no assurance check. That is precisely what the
`role_binding` guard exists to prevent, reachable through the sibling mapping
kind. Three of six assertions failed pre-fix.

**What changed.** `roles_granted_by_group()` resolves the target group's
effective role bindings, and `_validate_group_membership_target` applies the
same `FORBIDDEN_AUTO_ROLES` and provider-assurance checks. Mirrored in the
reconciler — which matters more, because a group's bindings can change *after*
the mapping is created.

**Pinned by:** `test_idp_group_membership_guard.py` — refusal at write **and**
skip at reconcile, including when the binding is added after the mapping.

### D7 — Draft IdP providers were live for authentication

**What the code did.** `lifecycle='draft'` is documented as *"reaches no public
surface until published"*, and `list_public_providers` filters on it. But
`resolve_slug` and `get` go through `get_by_slug`/`get_by_id`, which do not
filter lifecycle, and `ProviderRegistry` checked only `snap.enabled` —
which `CreateProviderRequest` defaults to `True`.

**Why it mattered.** A draft, never-rehearsed, never-published provider was fully
live at `/api/v1/auth/{slug}/login` and its callback — **including JIT
provisioning** — for anyone who knew the slug. Slugs are enumerable by
404-vs-302. An administrator half-configuring a provider was, without knowing
it, opening an authentication path.

**What changed.** `lifecycle` carried onto `ProviderConfigSnapshot`; a non-`live`
provider is refused in `get`/`resolve_slug` via `_assert_usable`, with an
explicit `allow_draft` exemption for the dry-run flow — which is the legitimate
way to exercise a draft and is already gated by the signed `nx_dryrun` cookie.

**Pinned by:** `test_draft_provider_not_live.py` — draft login 404s, dry-run
still works.

---

## 3. Session, cookie and token lifecycle

| Gap | Why it mattered | Resolution |
|---|---|---|
| **CSRF token not bound to the session** | `mint_csrf_token()` returned bare `secrets.token_urlsafe(32)`; the check was `cookie == header` and nothing else. **Any** matching pair passed for **any** session, including one the attacker chose. Anyone able to write a cookie for the parent domain — a compromised sibling subdomain, subdomain takeover, XSS on any `*.example.com` host — reached every state-changing endpoint with the victim's `nx_access`. Amplified by `AUTH_COOKIE_DOMAIN` being designed for parent-domain sharing. | Token is `<random>.<HMAC_k(sid‖random)>` under the existing signing-key ring, verified against the `sid` from the access token, compared with `secrets.compare_digest`. A tossed cookie fails because the attacker cannot produce a valid HMAC for the victim's `sid`. |
| **No Origin/Referer validation** | `csrf.py` never read either header. The default `SameSite=Lax` covered most of it, but `AUTH_COOKIE_SAMESITE` is env-tunable and a cross-origin SPA deployment would plausibly set `none`, removing the only remaining CSRF defence. | Independent Origin/Referer allowlist on unsafe methods, reusing `CORS_ALLOWED_ORIGINS` plus same-origin. Applied to the CSRF-exempt paths too, which additionally closes login-CSRF. |
| **Local sessions had no lifetime ceiling** | Rotation minted a brand-new 7-day refresh token every time, and `_refresh_within_session` had no family-creation cap — the SSO ceiling only applied when `auth_time` was set. A local password session that refreshed once a week lived **indefinitely**, so a stolen refresh cookie was a permanent credential. | `SESSION_IDLE_MAX_HOURS` (12) and `SESSION_ABSOLUTE_MAX_HOURS` (168), both env-configurable, enforced alongside the existing `sessions_valid_from` and SSO `auth_time` checks. Absolute measured from the family's first mint, idle from the previous rotation. Boot refuses an incoherent combination. |
| **`REFRESH_ADOPT_RECORDLESS` defaulted `true`** | Any validly-signed unexpired refresh JWT with **no server-side row** was accepted once and a row written for it. The in-code comment said to disable it after one refresh lifetime; the default never flipped. Until it did, the allow-by-record design was not in force. | Defaults `false`. The env var is retained as a one-deploy escape hatch; the family-revoked check runs before adoption either way, so a killed family stays killed. |
| **`JWT_ALGORITHM` accepted any string** | `assert_signing_secret()` built the key ring but never test-signed, so `JWT_ALGORITHM=none` was not caught at boot. | `HS256`/`HS384`/`HS512` allowlist with a typed `UnsupportedAlgorithm` raised at startup. |
| **Reserved claims overridable at mint** | `payload.update(extra)` ran **after** the security-critical claims. A caller putting `aud` in `extra` would silently override the audience separation that is the only thing keeping a refresh token from being replayed as an access token. Not exploitable today — it was a review invariant rather than a code one. | `_safe_extra` filters reserved keys before the update. |
| **Login timing oracle** | *Correction to the initial finding:* the unknown-user path was **already** mitigated by a fixed dummy Argon2 hash. Only the SSO-sentinel short-circuit leaked, distinguishing an SSO-only account from a local one by response time. | The sentinel branch now verifies against the dummy hash too. |
| **Reset-token expiry failed open** | `if user.reset_token_expires_at:` — a row with a hash and a NULL expiry yielded a **non-expiring** reset token. Not reachable through any current write path, but the wrong default direction for a credential. | Inverted: a missing expiry is treated as expired. |

Commits: `15f3b47`, `1e73211`, `1f6496d`.
Pinned by: `test_csrf_session_binding.py`, `test_csrf_middleware.py`,
`test_session_absolute_lifetime.py`, `test_startup_security_guards.py`.

---

## 4. SSO and identity

### MFA posture

The corporate IdP is the MFA authority. That was the intended design and it was
not enforced: the only control was the platform-wide
`app_auth_config.allow_local_login`, so a user with both a password and an SSO
identity could always take the password path — bypassing the IdP's conditional
access and MFA, and bypassing the 24-hour SSO re-auth ceiling, which only
applies when `auth_time` is present.

Separately, `POST /auth/reset-password` silently converted an SSO-only account
into a password account: it never checked the disabled-password sentinel,
`allow_local_login`, or whether the account was IdP-managed. A federated user
could acquire a local password and never see the IdP again.

**Resolution.** A per-user SSO-only flag, set automatically for JIT-provisioned
SSO users, enforced in `LocalIdentityService.login`. Both reset paths refuse an
SSO-only account unless an administrator sets an audited
`allowSsoOnlyOverride`. The framing is recorded in the threat model. No
TOTP/WebAuthn — the IdP is the authority, by decision.

Pinned by `test_sso_only_stays_sso_only.py`.

### Other identity findings

| Gap | Why it mattered | Resolution |
|---|---|---|
| **SAML `InResponseTo` never checked** | `process_response()` was called with no `request_id`, so python3-saml never compared `InResponseTo`, and `rejectUnsolicitedResponsesWithInResponseTo` was unset. The AuthnRequest ID was never captured at all. Unsolicited IdP-initiated responses were accepted with no cryptographic request↔response binding. | `build_authorization` returns the request id; it is sealed into the signed `nx_saml` cookie and compared at the ACS. |
| **Flow cookies not bound to their provider** | One `nx_oidc` and one `nx_saml` cookie name for **every** provider slug, and neither state token carried a provider id — `build_authorization` returned it in `flow_state` and the router dropped it. In a multi-IdP deployment a flow started at provider B satisfied the state check at provider A's callback. Token validation still bound `iss`/`aud` to A's config, so this was a hardening gap rather than a full IdP mixup — but it is the class RFC 9207 exists to close. | `provider_id` in both state tokens, compared at the callback. |
| **SSRF on IdP metadata fetches** | OIDC discovery and JWKS fetched admin-supplied URLs with no scheme allowlist and no private/link-local/loopback blocking — `http://169.254.169.254/…` and `http://10.x.x.x:port/…` were both reachable. SAML additionally set `follow_redirects=True`. `POST /admin/idp-providers/discover` turned a `system:admin` session into an arbitrary-URL GET whose response body was returned to the caller. | One shared `assert_fetchable` helper in `providers/outbound.py`: scheme allowlist, DNS resolution checked against RFC1918 / loopback / link-local / ULA before connect, no redirects, short timeout, response size cap. An unresolvable host falls through — it is not an SSRF target. |
| **Auth-posture switches failed open** | On a loader exception with a cold cache, all three switches reverted to permissive. A DB blip during a rolling restart silently re-enabled JIT provisioning that an operator had disabled. | Split into `_DEFAULTS` (nothing configured — permissive, matching the column server-defaults) and `_FAILSAFE` (loader raised — JIT off). Deliberately asymmetric: failing closed on `allow_local_login` would lock everyone out, and that reasoning is stated in-code. |
| **SLO accepted unsigned LogoutRequests** | `wantMessagesSigned: False`, so an unsigned IdP-initiated `LogoutRequest` was accepted. The route also answered **GET** and was CSRF-exempt, making `<img src=".../sls">` a logout CSRF. | Signature required on the `/sls` path specifically, via `_settings_dict(want_messages_signed=True)` — scoped there rather than globally, because requiring signed messages globally breaks ID-style IdPs. |

Commits: `fcf07ea`, `1f6bcd1`, `80f50ff`.
Pinned by: `test_sso_flow_binding.py`, `test_idp_metadata_ssrf.py`,
`test_sso_only_stays_sso_only.py`.

---

## 5. HTTP perimeter

### Security headers never reached the SPA document

The highest-impact perimeter finding. `SecurityHeadersMiddleware` runs inside the
backend, and in the shipped topology nginx serves `index.html` from disk and only
proxies `/api/`. There was **no `add_header` anywhere** in
`frontend/nginx.conf`, `deploy/k8s`, or `deploy/helm`.

So the strong `script-src 'self'` policy applied exclusively to JSON API
responses, where it does nothing, and **the only document a browser renders
shipped with no CSP, no `X-Frame-Options`, no HSTS, no `Referrer-Policy` and no
`nosniff`. The application was frameable.**

Resolved in `frontend/nginx.conf`, mirroring the middleware so the two cannot
drift, and adding `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`
and `Cross-Origin-Opener-Policy: same-origin`. `index.html` had two inline
`<script>` blocks (pre-hydration branding and theme paint); both moved to a
single classic external `public/boot.js` so `script-src 'self'` holds without
nonce machinery. The four `URL.createObjectURL(blob)` sites were checked and are
all download anchors (`a.href = url; a.download = …; a.click()`), which CSP
fetch directives do not govern; there are no workers or blob script sources.

Also fixed there: `proxy_set_header X-Forwarded-Proto $scheme`. nginx listens on
port 80 inside the container, so `$scheme` was always `http` and it
**overwrote** what the TLS-terminating ingress had already set. The backend
therefore never emitted HSTS, and `/auth/diagnostics` reported
`requestIsSecure: false` on a correctly secured deployment — precisely the field
an operator reads when sessions are misbehaving. Now honours the incoming header
via a `map`, falling back to `$scheme` for a direct hit.

### Remaining perimeter findings

| Gap | Why it mattered | Resolution |
|---|---|---|
| **Middleware order was the reverse of its own comments** | Starlette's `add_middleware` inserts at index 0 and wraps in `reversed()`, so the **last** registered is **outermost**. `CSRFMiddleware`, commented "innermost", was outermost — its early 403 bypassed `SecurityHeadersMiddleware` and `CORSMiddleware`. `_TimeoutMiddleware`, commented "must wrap all other middleware", was innermost, so the gzip pass whose on-loop CPU cost the timeout exists for ran *outside* the deadline. | Reordered to match intent. `test_middleware_order.py` asserts `app.user_middleware` — nothing pinned it before. |
| **`Cache-Control` unset on authenticated responses** | `/users/me`, `/me/permissions` and `/directory` were cacheable by intermediaries and by bfcache. | `no-store, no-cache, must-revalidate, private` on authenticated responses. |
| **Uncapped pagination** | Eight graph endpoints declared `Query(100, ge=1)` with no `le=`. `?limit=100000000` flowed into `SKIP/LIMIT` against FalkorDB on the highest-cost reads, bounded only by the 60s tier timeout. | `le=1000` on all of them. |
| **No app-level body-size limit** | The only cap was nginx's `client_max_body_size 100m` — an edge setting anything reaching the container directly never meets, and deliberately generous because bulk import needs it. Every JSON endpoint would accept 100 MB and hand it to Pydantic, which parses into memory before a handler sees it. | `_BodySizeLimitMiddleware`, enforced on `Content-Length`, with a larger tier only for the routes that legitimately need it — so a route that has not asked for a big body cannot receive one. |
| **Docs and OpenAPI unauthenticated** | An anonymous caller got the complete route inventory and every schema for ~300 endpoints, admin routes included. | `_DOCS_ENABLED` gates `docs_url`/`redoc_url`/`openapi_url`; off in production, on elsewhere. |
| **`RBAC_ENFORCE_*` read per request** | Two flags gate real authorization: `RBAC_ENFORCE_VIEWS` guards 19 checks in `views.py` including the object-level `can_read_view`, and `RBAC_ENFORCE_WORKSPACES` guards three in `workspaces.py`. The default was safe, but setting either false removed object-level authorization at runtime with no redeploy and no audit trail. | Read once at startup, logged in the auth fingerprint, and boot refused in production when either is disabled. |
| **`FORWARDED_ALLOW_IPS="*"`** | Set in both `docker-compose.yml` and the k8s configmap, so uvicorn rewrote `request.client` from `X-Forwarded-For` **from any peer** and slowapi read it. Anything that could reach the container port chose its own per-IP rate-limit bucket, a fresh one per request. Medium rather than high because the per-**account** limiter is unaffected, which is what keeps password spray bounded. | RFC1918 + loopback in both. Pod CIDRs are RFC1918 on every managed cluster we target; a wrong CIDR degrades to one shared bucket, not an outage. |
| **No Host validation** | *Correction to the initial finding:* the usual Host-poisoning-to-account-takeover chain does **not** exist here — the application sends no email and builds no reset or invite links. What does depend on the claimed host is SAML: python3-saml derives `current_url` from it to validate an assertion's `Destination` and `Recipient`, so an attacker replaying an assertion minted for a different SP could set the header to match. | `ALLOWED_HOSTS` honoured in `_request_https_host`, plus a perimeter `_TrustedHostMiddleware`. Deliberately **not** Starlette's `TrustedHostMiddleware`: kubelet dials the pod IP, so a probe's Host is a dynamic address no operator can allowlist, and Starlette's version has no path exemption — mounting it would have made every pod fail its own readiness probe. Off when `ALLOWED_HOSTS` is unset. |
| **Access-token TTL drift** | Compose defaulted to 60, the k8s configmap to 15, the code to 5, and the release notes claimed 15 everywhere. Since permission claims ride in the token, that number **is** the revocation latency — a role change, suspension or forced sign-out does not reach a live session until its next rotation — and it is the exposure window for the fail-open revocation tier. | 15 in every shipped config. Production **refuses** a value above `MAX_ACCESS_TTL_MINUTES` rather than warning: a warning had been in the log the whole time the configs disagreed and nobody read it. |
| **Revocation degraded silently to per-process memory** | `get_revocation_service()` catches broadly and installs an in-process backend whose docstring says not to use it in production. With 4 workers × N replicas, a Redis misconfiguration made every revocation a no-op for 4N−1 of them: the admin UI shows the session killed and the browser keeps working. It logged at ERROR and nothing failed readiness. | `/health/ready` reports `revocation: shared\|in_process` everywhere and returns 503 on `in_process` in production only — a dev stack has one worker, where the in-process backend is genuinely equivalent. **Stated limitation, in-code:** this catches a misconfiguration at boot, not a Redis that dies later. A round trip does not belong on a probe hot path, and dropping every replica out of rotation on a transient blip is a worse failure than the fail-open it would be guarding. |

Commits: `15f3b47`, `1e73211`, `18e8e22`.
Pinned by: `test_middleware_order.py`, `test_request_body_limit.py`,
`test_pagination_limits_bounded.py`, `test_trusted_host.py`,
`test_api_health.py`, `test_startup_security_guards.py`.

---

## 6. Deployment, configuration and shipped data

| Item | Finding | Resolution |
|---|---|---|
| `.env.dev`, `.env.backup-dev` | **Tracked in git**, despite `.env.dev` claiming in its own header to be gitignored. `JWT_SECRET_KEY` was correctly empty, but `ADMIN_PASSWORD=admin123` shipped in the repository. | Untracked; `.gitignore` corrected to `.env.*` with `!.env.example` / `!.env.prod.example`. |
| `data/quickstart/nexus_core.db` | The quickstart seed, baked into the image, carried **four real Argon2id password hashes and two live reset-token hashes** — including `admin@synodic.local`, a platform admin `QUICKSTART.md` never mentions. The documented login is the bootstrap admin `admin@nexuslineage.local`, so every quickstart image shipped a second, undocumented admin account whose hash was public. | Credentials cleared to the disabled-password sentinel; reset tokens nulled. The rows stay — they are demo data and other tables carry FKs to them. `test_shipped_seed_has_no_credentials.py` asserts the property via `is_password_set`, because the seed is regenerated by hand from a developer's stack, which is exactly how the hashes got in. |
| `nexus_core.db`, `backend/nexus_core.db` | Tracked despite already being listed in `.gitignore`. | Removed from the index. |
| Service port bindings | Every service bound `0.0.0.0`. FalkorDB has no auth and its Browser UI on `:3000` has none either. `DEPLOYMENT.md` documented loopback binding as a manual hardening step. | Made the default via `${*_BIND:-127.0.0.1}` on Postgres, Redis, FalkorDB, control-plane and viz. |
| `AGGREGATION_INTERNAL_TOKEN` | Unset disabled bearer auth on **every** :8091 route — job trigger, cancel, delete, purge, settings — with a log warning saying it *"must never be the deployed state"*. A log line is not a control. | Production refuses to start unauthenticated. Non-production keeps the convenience, loudly. |
| `lxml`, `xmlsec` | Unpinned and left to transitive resolution, despite performing the signature verification the SAML trust model rests on. lxml bundles libxml2/libxslt in its wheels, so a libxml2 advisory is an lxml upgrade. | Explicit floors at the versions `pip-audit` reports clean. |

Commits: `1f6bcd1`, `19e48d1`.

---

## 7. Frontend

| Item | Finding | Resolution |
|---|---|---|
| SSO re-auth redirect | `fetchWithTimeout.ts` followed `detail.login_url` with only a `startsWith('/')` check, missing the `//` guard that `PortalLogin.tsx` gets right. | `//` and backslash guards added. |
| Announcement CTA | `href={ann.ctaUrl}` with no scheme check on either side. Admin-only write, but that makes it an **admin-to-everyone** stored-XSS vector: the banner renders to every signed-in user. | `http(s)` or site-relative only. Authoritative server-side on create **and** update (`_validated_cta_url`), repeated at render (`safeHref.ts`) for rows written before the validator existed. Rejected rather than sanitised — there is no safe reading of a `javascript:` CTA, and a silent rewrite would hide the mistake from the admin who made it. |
| Mermaid rendering | `securityLevel: 'loose'` with raw `dangerouslySetInnerHTML` and no sanitisation. Not exploitable today: input traces to build-time static markdown imports, and the property-editor preview renders only the author's own draft. | The first attempt — DOMPurify — **broke rendering**, stripping `foreignObject` HTML labels and `<use>` arrowheads. Caught by the tests written alongside it, then backed out along with the dependency. Replaced with `userContentMarkdownComponents`, which renders user-authored code blocks as plain text so mermaid is unreachable from user content at all. Stronger than `securityLevel: 'strict'`, and it also fixed a preview/render mismatch. |
| `MyIdentitiesPage.tsx:83` | Flagged as an unvalidated `window.location.href`. On inspection, slugs match `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`, so it is not exploitable. | **Left alone** rather than adding speculative code. |

**Confirmed strong; do not regress.** No tokens in `localStorage`/`sessionStorage`
anywhere (~60 call sites, all UI state); relative API base URL, so no
config-injection surface; single-flight refresh with a cross-tab Web Lock and a
classified outcome enum; `RequirePermission` renders a skeleton rather than a
denial while claims are unresolved; no `eval`, no `srcdoc`, no `iframe`, no
`rehype-raw`.

Commits: `1f6bcd1`, `19e48d1`.

---

## 8. Documentation corrected

Stale documentation is a security problem when a test team plans against it.

- **`SSO_INTEGRATION.md` §10** had two rows asserting controls that did not hold
  — SAML assertion replay (D1) and `system:admin` via group mapping (D6). Both
  now describe what exists and state what was wrong. The MFA framing was added.
- **`ARCHITECTURE.md` and `TECHNICAL_DEBT.md`** still described **localStorage
  JWTs**, 60-minute tokens, and "CSP applied via middleware to all responses" —
  all three wrong. Rewritten.
- **`docs/security/endpoints.md`** (457 lines) is **generated** by
  `backend/scripts/export_pentest_surface.py`, which walks `app.routes` and reads
  the `required_permission` introspection tags that `requires()` attaches. Not
  hand-maintained, so it cannot drift.

---

## 9. Verification

| Suite | Result |
|---|---|
| Backend | **5007 passed**, 11 failures |
| Frontend | **3235 passed / 3235** |
| Typecheck | Clean in every file touched |
| New tests | **200 backend across 18 new files**, 24 frontend across 2, plus additions to six existing suites |

All 11 backend failures are pre-existing and were reproduced at the branch base
in a clean worktree: 9 in `test_feature_gates.py`, 1 in
`test_invite_lifecycle.py`, and 1 versioning integration test that needs a live
Redis on 6379.

### Course corrections during the work

Recorded because each changed the outcome, and because they are the kind of
thing a later reader would otherwise re-litigate.

1. **Removing `/auth/refresh` from the CSRF exempt list broke 10 tests**, and a
   conftest workaround broke 3 more. Reverted entirely; the Origin check was
   applied to exempt paths instead — better security, because it covers
   login-CSRF too, with no test churn.
2. **The production SAML refusal was initially too broad.** It ran at startup, so
   a deployment that merely had python3-saml installed and configured no SAML
   provider would not boot. Moved into the builder.
3. **The CSRF origin check was an availability risk as first written.** It built
   our own origin from `X-Forwarded-Proto`; on a deployment whose proxy does not
   set that header, the browser sends `Origin: https://host` while the app
   computes `http://host`, and **every write would 403**. Both schemes are now
   accepted for our own host; `CORS_ALLOWED_ORIGINS` entries stay exact, because
   for a third-party origin the scheme is part of naming it.
4. **Two TTL-ceiling tests passed alone and failed in the full suite** — the
   worst failure mode, since they asserted nothing while looking green. They
   patched `JWT_EXPIRY_MINUTES` through a module binding that two other suites
   pop from `sys.modules`, so the patch hit an orphan and the check measured the
   code default. Fixed by patching via dotted string (`9fb4821`).

---

## 10. Deliberately not done

Listed so a test team knows these are known, not missed. Fuller treatment in
[`PENTEST_SCOPE.md`](PENTEST_SCOPE.md) §7.

- **MFA (TOTP/WebAuthn)** — the corporate IdP is the authority, by decision.
- **Unauthenticated `GET /auth/diagnostics`** — by design; it is most needed when
  nobody can authenticate. No key material is exposed.
- **SLO does not propagate** to a user's other devices. D-series work
  authenticates the `LogoutRequest`; making it terminate other sessions is new
  capability.
- **No per-provider email-domain binding at login.** `email_domains` is used for
  home-realm-discovery routing only, so a contractor IdP can assert an address in
  the staff domain.
- **Fail-open revocation** for permissions outside the six-item fail-closed set,
  during a Redis outage, for up to one access-token lifetime — now 15 minutes
  rather than 60.
- **No pre-expiry warning in the UI.** The session ceilings are enforced
  server-side; a countdown banner is new product surface. Expect an abrupt
  sign-out at the ceiling.
- **Session inventory UI**, **`__Host-` cookie prefixes** (the CSRF binding
  removes the cookie-tossing risk that motivates them, and the prefix conflicts
  with the supported `AUTH_COOKIE_DOMAIN` subdomain-sharing mode), and **new CI
  gates** (route-coverage drift test, gitleaks, DAST).

---

## 11. Open items for the operator

1. **The scrubbed quickstart hashes remain in git history.** They were removed
   from `HEAD` and a guard added, but a history rewrite is a separate decision.
   Until then, treat those Argon2 hashes as disclosed.
2. **`ALLOWED_HOSTS` defaults to off.** The perimeter Host check engages only
   when it is set. Configure it before the penetration test, or the finding will
   be reported as unfixed.
3. **`docker-compose.quickstart.yml` still cannot boot** — its 19-character
   signing key is denylisted by `assert_signing_secret()`. Its hardcoded
   `ADMIN_PASSWORD=admin123` and `JWT_SECRET_KEY=quickstart-demo-key` are
   unchanged; generating both at first run is a container-entrypoint change that
   was left out of scope.
