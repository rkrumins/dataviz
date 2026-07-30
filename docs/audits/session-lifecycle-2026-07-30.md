# Session lifecycle review — 2026-07-30

**Scope:** JWT issuance, refresh-token rotation, session revocation, the
frontend's session state machine, and SSO integration readiness. Prompted
by three recurring user reports, all clustered around sessions that had
been open a while:

1. odd behaviour when the access token expired;
2. being signed back in without entering credentials;
3. a brief "you don't have permission to see this" that resolved into the
   real content moments later.

---

## 1. Verdict

The auth stack was sound and did not need rebuilding. HttpOnly cookie
transport, rotating refresh with reuse detection and a grace window, CSRF
double-submit, Redis session revocation, and a DB-backed multi-provider
SSO registry were all already in place and correct.

What produced the symptoms was **one architectural inconsistency and a set
of specific defects**. The inconsistency is why they kept coming back
after being fixed individually.

### The root cause

`GET /me/permissions` re-read the permission claims out of the access
token rather than consulting the database. Two consequences:

- The 60-second poller **could not observe a permission change** — it
  re-decoded the same unchanged token. Dynamic RBAC only landed when the
  token happened to rotate.
- "This user holds nothing" and "I could not work out what they hold"
  arrived as the same signal: a 200 with an empty claim set. Three code
  paths each guessed at it, and they disagreed. A rotation whose
  re-hydrate came back empty blanked every gated control; the poller
  restored them up to a minute later. That round trip is symptom 3.

`GET /me/session` resolves from the database through the same
`permission_service.resolve` that mints claims on login and refresh, so
those became distinct outcomes on the wire and one policy replaced three
heuristics. Backend enforcement was **not** moved: `requires(...)` still
reads the JWT on every request with no DB hit.

---

## 2. Fixed

| # | Sev | Finding |
|---|-----|---------|
| **A1** | High | `/auth/refresh` cleared the session cookies onto the injected `Response` and then raised `HTTPException`. FastAPI merges that object's headers only when the endpoint *returns*, so every `Set-Cookie` was discarded — the code read as though it evicted the dead cookie and evicted nothing. A condemned `nx_refresh` therefore stayed in the jar for its full 7-day `max-age`, and every page load re-presented it: 401 → refresh → 401 → "session lost", with reloading being the thing that re-presented the cookie. **This is the login loop.** |
| **A2** | High | Signing out revoked the refresh family but left the access token valid to `exp`. Clearing the cookie only removes it from the browser that asked to leave. |
| **B1** | High | A failed permission resolve was recorded as `ready` with an empty claim set — indistinguishable, to every guard, from a real denial. One rate-limited request during boot painted "You don't have access" over the whole app until a later poll succeeded. |
| **B2** | High | Three contradictory policies for an empty claim set (poller / hydrate / post-refresh hydrate). The post-refresh one runs on every rotation and believed it immediately. |
| **C1** | Med | Nothing scheduled a renewal. The permission poll was the de-facto keepalive and it pauses while the tab is hidden — so the reported case, a page left open, was the case with nothing keeping it alive. |
| **C2** | Med | The access TTL disagreed four ways (code 5, `.env`/k8s 15, both compose files 60) and the coherence test did not read the compose files. The one variable governing every expiry symptom differed 12× between environments, which is why nothing reproduced. |
| **C3** | Med | A deliberate sign-out could be undone: the refresh cookie restored on any route but `/login`, and a `custom_profile` payload in browser storage minted a *new* session that revocation cannot touch. |
| **C4** | Med | `_refresh_predates_cutoff` failed open on a token that could not date itself, so it survived "sign out everywhere". The case it was protecting was empty — `iat` has always been set and the decoder falls back to it. |
| **C5** | Med | Revocation silently fell back to a per-process store. With two gunicorn workers a revoked session alternates between refused and served depending on who answers. Now refused at boot in production; the per-request fail-open is unchanged, deliberately. |
| **D1** | Med | The global 403 card fired on *every* 403 unless a caller opted out, so background probes at admin-only endpoints announced denials over working content. Now: unsafe methods surface, reads opt in. |
| **D2** | Low | `RequireNav` waited on claims but not on the nav catalogue, so a resolved super-admin saw a denial the bundled seed invented. `redis` was exactly that — present in the routes and the backend catalogue, missing from the seed. |
| **D3** | Low | The poller seeded its change-detection baseline before claims landed, so every warm reload paid an unfiltered query invalidation and a cross-tab broadcast. |
| **D4** | Low | Account Settings navigated to `/login` after a password change and after revoke-all without clearing the store, so the login page greeted users as the account they had just signed out of. |
| **D5** | Low | An expiry lost the user's place — the bounce to `/login` discarded the current location. |
| **D6** | Low | SAML and self-service identity linking could not be exercised on a plain-HTTP dev box at all: their cookies force `Secure`, so the browser dropped them and the handshake failed with `missing_flow_cookie`, which reads like a broken IdP. |

---

## 3. SSO integration readiness

Sound and genuinely multi-provider: OIDC (authorization code + PKCE S256,
JWKS with a `kid`-miss refetch, `iss`/`aud` essential, nonce, `max_age` to
oblige `auth_time`), SAML2 (python3-saml strict, signature, conditions,
replay cache), plus `custom` and `custom_profile`. DB-backed registry with
Fernet-encrypted settings, draft/live lifecycle, home-realm discovery,
operator-configurable claim mapping with preview, dry-run rehearsal,
assurance tiers, group→role mapping with a `super_admin` guard, JIT
provisioning, and self-service linking that re-validates the live session.

### Deferred — real, but independent of the reported symptoms

| # | Finding |
|---|---------|
| **S1** | No IdP-initiated logout for OIDC (back-channel or front-channel). SAML has `/sls`. The IdP session outlives the app session. |
| **S2** | No SCIM. Group membership only refreshes on login *through that provider*, so a second linked IdP's groups stay stale until the next login via that IdP. |
| **S3** | An IdP that omits `auth_time` silently turns the 24 h re-auth ceiling into "24 h since this login". Logged as a warning with no admin-visible signal. |
| **S4** | `custom_profile._verify_jwt` disables `verify_aud` when no audience is configured, on an operator-supplied HS256 shared secret. Nine platform token families already share one HS256 key separated only by `aud`. |
| **S5** | Frontend nav-catalogue drift is unguarded (the backend side is covered). The `redis` gap above was this class of bug; a parity test over the two section maps would close it. |

Priority if hardening resumes: **S5** (cheap, and it is the one that has
already bitten) → **S4** → **S1** → **S3** → **S2**.

---

## 4. Verification

- Backend: `cd backend && python -m pytest tests/ -q -m "not integration"`.
  Note that `backend-tests.yml` runs the full suite `continue-on-error`, so
  CI going green is not evidence — the local run is.
- Frontend: `cd frontend && npm test`, plus `npx tsc --noEmit` compared
  against the pre-existing error count (61) rather than zero.
- New suites: `backend/tests/test_session_lifecycle.py`,
  `frontend/src/store/sessionRenewal.test.ts`,
  `frontend/src/store/signedOut.test.ts`,
  `frontend/src/services/fetchWithTimeout.surface403.test.ts`,
  `frontend/src/lib/safeNext.test.ts`.
