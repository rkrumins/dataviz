# Running several environments of {brand} side by side

> **At a glance.** How {brand} decides whose session a request carries, and what you must
> configure when more than one instance (dev / uat / staging / prod) can be reached from
> the same browser. Covers the two settings that make instances distinguishable
> (`AUTH_ENVIRONMENT_ID`, `JWT_SECRET_KEY_PREVIOUS`), the signing-key rotation runbook,
> the `/auth/diagnostics` endpoint, and a symptom→cause table for session bugs. Read §1–§3
> before standing up a second environment.

For local development see [SETUP.md](SETUP.md); for single-host deploys see
[DEPLOYMENT.md](DEPLOYMENT.md); for IdP integration see [SSO.md](SSO.md).

---

## 1. Why this needs configuring at all

A browser stores cookies keyed by **name + domain + path**. Not by cluster, not by port,
not by which Kubernetes namespace served them. Two instances of {brand} that use the same
cookie names are, as far as the browser is concerned, *the same application* — the second
one to set `nx_access` silently overwrites the first.

That produces a specific, confusing failure:

1. You sign into dev. The browser stores `nx_access` (dev's token).
2. You sign into uat. The browser **overwrites** `nx_access` with uat's token.
3. You go back to dev. The browser sends uat's token. Dev verifies it with dev's signing
   key, the signature does not match, and the request 401s.
4. You are bounced to `/login`, having done nothing wrong.

Two properties of the default configuration make this worse than it needs to be:

- **The instances are indistinguishable.** Tokens carry `iss`/`aud` of `nexus-lineage`
  in every environment, so the receiving instance cannot tell "this token is from another
  environment" from "this token is corrupt". The only observable symptom is
  `Refresh rejected: Signature verification failed`, which points at the key rather than
  at the actual cause.
- **Nothing evicts the bad cookie.** The browser keeps re-sending it on every subsequent
  request, so the bounce repeats indefinitely — clicking any section logs you out again.

> **This is not limited to different hostnames.** The most common trigger is reaching two
> environments through the *same* host — `kubectl port-forward` to `localhost:8080` for
> dev, then the same port for uat. Same host, same cookie names: total collision. Setting
> `AUTH_ENVIRONMENT_ID` is what makes that case work, and it is why the fix scopes cookie
> *names* rather than relying on the `Domain` attribute.

Separately: **changing `JWT_SECRET_KEY` invalidates every live session at once.** Applying
a Kubernetes Secret does not restart pods, so during a rollout some replicas hold the old
key and some the new one. With no session affinity, one user's requests land on both and
authentication flaps request-to-request rather than failing cleanly. `JWT_SECRET_KEY_PREVIOUS`
(§4) exists to make that a non-event.

---

## 2. How a session is identified

Four cookies make up a session. Only the ones carrying a signature are environment-scoped:

| Cookie | Scoped by `AUTH_ENVIRONMENT_ID`? | Path | HttpOnly | Purpose |
|---|---|---|---|---|
| `nx_access` → `nx_access_<env>` | **Yes** | `/` | yes | The access JWT, 15 min |
| `nx_refresh` → `nx_refresh_<env>` | **Yes** | `/api/v1/auth/` | yes | Rotating refresh JWT, 7 days |
| `nx_csrf` | **No — deliberately** | `/` | no (JS-readable) | CSRF double-submit token |
| `nx_access_exp` → `nx_access_exp_<env>` | **Yes** (since 2026-07-30) | `/` | no (JS-readable) | When `nx_access` expires, for scheduled renewal |
| `nx_oidc`, `nx_saml`, `nx_link_intent`, `nx_mock_identity`, `nx_dryrun` | **Yes** | `/api/v1/auth/` | yes | Short-lived SSO handshake state |

`nx_csrf` is the one cookie the frontend reads from JavaScript by an unscoped name, and
sharing it is safe: the double-submit check only ever compares the cookie against the
`X-CSRF-Token` header **on the same request**, so a token minted by another environment
still proves exactly what the check is for — that same-origin script could read the cookie.
It carries no identity and no signature.

### `nx_access_exp` was unscoped for the same reason, and it did not hold

The original argument was that a timestamp carries no identity, so at worst a foreign value
"makes a tab reschedule sooner than it needed to — and the two cannot diverge without the
(scoped) access cookie having diverged first." Both halves were wrong.

The collision is not between the two cookies; it is **two backends writing one name into
one jar**, which is what scoping the access cookie leaves possible rather than prevents.
Any deployment with `AUTH_COOKIE_DOMAIN` set to a shared parent — two instances under
`.app.example.com` — has it.

And the effect is not "sooner". The keepalive arms at `expiry - 60s`, so a sibling's
**later** expiry arms past this tab's own token death. It never renews proactively, falls
back to reactive 401 refresh, and an idle tab issues no request to take a 401 with. The
session lapses in precisely the way the keepalive exists to prevent — and the symptom is
"`nx_access` is never replaced", with nothing in any log.

The name is now scoped. The client learns the suffix from `environment_id` on the
`GET /auth/me` response — the bootstrap call, which resolves before the keepalive is
allowed to start — and falls back to the unscoped name when the field is absent, so a
mid-rollout tab and a single-deployment install both keep working. Discovery failing is
survivable by construction: the scheduler already treats "no published expiry" as
"probe again in 60s" rather than as an error.

`nx_dryrun` was **not** scoped until 2026-07-29, despite carrying a JWT like its siblings —
it was added after the list and nothing compared the two. It is now, and
`test_every_signed_cookie_is_scoped` asserts the property rather than re-listing names, so
the next flow cookie cannot repeat it.

Tokens additionally carry:

- `iss` — `nexus-lineage:<env>` when `AUTH_ENVIRONMENT_ID` is set, otherwise `nexus-lineage`.
  This is what turns a cross-environment token from an opaque signature failure into a
  recognisable issuer mismatch.
- `kid` (header) — an 8-char SHA-256 fingerprint of the signing key. Not secret; it appears
  in every token. It lets verification pick the right key from the ring directly, and lets
  you compare two deployments without ever handling the secret itself.

### What happens to a token that does not belong here

The server distinguishes two cases, and they are treated very differently:

| Condition | Classified | Response | Why |
|---|---|---|---|
| Expired, signature valid | recoverable | plain `401 Not authenticated` | Normal. The frontend silently refreshes; the user notices nothing. |
| Wrong signing key, wrong issuer, wrong audience, undecodable | **foreign** | `401` with `detail.error = "session_foreign"`, **plus cookie eviction** | Retrying can never succeed, so the cookie is deleted and the frontend starts one clean login instead of looping. |

Eviction deletes each cookie across **every scope it might have been stored under** — the
configured `AUTH_COOKIE_DOMAIN`, host-only, and the immediate parent domain — plus the
un-suffixed legacy names. This matters because a browser only deletes a cookie when the
deletion repeats the exact domain it was stored with; a single-scope delete silently misses
a cookie written under different config, which is what makes a login loop permanent.

---

## 3. Standing up a second environment

Give every instance a **unique, stable** `AUTH_ENVIRONMENT_ID`. Unique so the cookie jars
are disjoint; stable because changing it logs that environment's users out once, by design.

Valid values: 1–32 characters of `[a-z0-9_-]`, starting alphanumeric. The value becomes part
of a cookie name, so anything else is rejected at startup rather than producing a cookie the
browser refuses to store.

### Kubernetes (kustomize)

Already wired — each overlay carries its own id:

```yaml
# deploy/k8s/overlays/<env>/patches/auth-environment.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: viz-config
  namespace: synodic
data:
  AUTH_ENVIRONMENT_ID: "dev"        # staging / production in their overlays
```

Adding a new environment means a new overlay with a new value here. Do **not** reuse an id
across clusters — the whole point is that the browser can tell them apart.

### Helm

```yaml
config:
  jwt:
    environmentId: "uat"
```

### Docker Compose / local

```bash
AUTH_ENVIRONMENT_ID=dev
```

Leave it unset for a single-environment deployment: every cookie name and the issuer stay
exactly as they were, so this is a no-op upgrade.

### Verify it took

```bash
curl -s https://dataviz-uat.local/api/v1/auth/diagnostics | jq '{environmentId, issuer, cookieNames, activeKid}'
```

Run it against both environments. `environmentId`, `issuer`, and `cookieNames.access` must
differ; `activeKid` should differ too (see §4). If any of those match across environments,
they will still collide.

---

## 4. Rotating the signing key without logging everyone out

`JWT_SECRET_KEY` signs. `JWT_SECRET_KEY_PREVIOUS` is a comma-separated list of retired keys
accepted for **verification only** — never used to sign. Retired keys are held to the same
32-character minimum, since they are still trusted.

**Runbook:**

1. Copy the current `JWT_SECRET_KEY` value into `JWT_SECRET_KEY_PREVIOUS`.
2. Set `JWT_SECRET_KEY` to the new key: `openssl rand -hex 48`.
3. Deploy. **Restart the pods** — updating a Secret does not restart them on its own:
   `kubectl rollout restart deploy/viz-service -n synodic`.
4. Confirm both keys are live: `curl -s .../auth/diagnostics | jq '{activeKid, acceptedKids}'`
   — `acceptedKids` should list two fingerprints, `activeKid` the new one.
5. Wait out `JWT_REFRESH_EXPIRY_DAYS` (default 7), then clear `JWT_SECRET_KEY_PREVIOUS` and
   deploy again.

Sessions survive the whole procedure. Skipping step 1 is what logs everyone out.

The same mechanism covers the rollout window: pods carrying only the new key and pods
carrying old+new both accept tokens minted before the change, so requests round-robining
across replicas stay authenticated.

> **Where the key comes from matters.** On the kustomize path `JWT_SECRET_KEY` originates in
> a gitignored, per-operator `deploy/k8s/.env.deploy`, and `./deploy.sh setup` **re-mints it**
> on every run. Deploying from a different machine, or after re-running setup, silently
> changes the key. Store it out-of-band and treat it as long-lived.

---

## 5. Diagnostics

### `GET /api/v1/auth/diagnostics`

Unauthenticated and secret-free by design — it is most needed exactly when nobody can
authenticate. It exposes no key material, only the `kid` fingerprints already published in
every token header.

```jsonc
{
  "environmentId": "uat",
  "issuer": "nexus-lineage:uat",
  "cookieNames": {
    "access": "nx_access_uat", "refresh": "nx_refresh_uat",
    "csrf": "nx_csrf", "access_exp": "nx_access_exp_uat"
  },
  "activeKid": "aac6b71e",
  "acceptedKids": ["aac6b71e"],
  "cookieSecure": true,
  "cookieDomain": null,
  "cookieSamesite": "lax",
  "requestIsSecure": false,
  "secureCookieWouldBeDropped": true,          // ← see §6
  "sessionCookiesPresented": {
    "access": "foreign: signed by a key this instance does not hold (kid=beefcafe)",
    "refresh": "absent",
    "csrf": "absent",
    "access_exp": "expired 41m ago"           // ← this tab never renewed
  }
}
```

`requestIsSecure` honours `X-Forwarded-Proto`, so it reports correctly behind an ingress
that terminates TLS upstream.

### Startup fingerprint

Every boot logs one line, so two deployments can be compared from `kubectl logs`:

```
Auth fingerprint: environment_id=uat issuer=nexus-lineage:uat cookies=nx_access_uat/nx_refresh_uat/nx_csrf
  active_kid=aac6b71e accepted_kids=aac6b71e cookie_secure=True cookie_domain=(host-only) cookie_samesite=lax
```

It also warns when `AUTH_ENVIRONMENT_ID` is unset while cookies use unscoped names, and
whenever `AUTH_COOKIE_SECURE=true` (§6).

---

## 6. Troubleshooting

| Symptom | Likely cause | Check | Fix |
|---|---|---|---|
| Signing into one environment logs you out of another | Both use the same cookie names | `cookieNames.access` identical across environments | Set a unique `AUTH_ENVIRONMENT_ID` per environment (§3) |
| `Refresh rejected: Signature verification failed` in logs | Token signed by a key this instance does not hold | `sessionCookiesPresented.access` reports `foreign` + a `kid` not in `acceptedKids` | Expected for a cross-environment cookie — it is now evicted automatically. If it follows a deploy, the signing key changed: see §4 |
| Everyone logged out after a redeploy | `JWT_SECRET_KEY` changed with no retired key | `activeKid` differs from before the deploy | Populate `JWT_SECRET_KEY_PREVIOUS` (§4) |
| Auth flaps — some requests fine, some 401 | Replicas disagree on the signing key mid-rollout | `activeKid` differs between pods | Same fix; restart pods so the fleet converges |
| **Login returns 200 but you land back on `/login`, and no cookie is ever stored** | `AUTH_COOKIE_SECURE=true` on a plain-HTTP host — browsers discard `Secure` cookies over HTTP **silently**, with no console error | `secureCookieWouldBeDropped: true` | Serve the host over HTTPS, or set `AUTH_COOKIE_SECURE=false` for an HTTP-only environment |
| Every POST 403s with a CSRF error | `nx_csrf` missing or not echoed | `sessionCookiesPresented.csrf` is `absent` | Usually the `Secure`-over-HTTP case above; otherwise check the `X-CSRF-Token` header is being sent |
| SSO login loops back to the IdP | Handshake cookie lost between redirect and callback | `AUTH_COOKIE_SAMESITE` must be `lax`, not `strict` | Leave `AUTH_COOKIE_SAMESITE` at `lax` |

`secureCookieWouldBeDropped` deserves emphasis: it produces *exactly* the same user-visible
symptoms as the cross-environment bug — login appears to succeed, then every subsequent
request is anonymous — but no code change fixes it. It is a TLS/config mismatch, and it is
easy to hit on `.local` hostnames that have no certificate.

---

## 7. Configuration reference

| Variable | Default | Notes |
|---|---|---|
| `JWT_SECRET_KEY` | *(none — required)* | ≥32 chars. No fallback: the process refuses to start if unset or weak. |
| `JWT_SECRET_KEY_PREVIOUS` | *(empty)* | Comma-separated retired keys, most-recent first. Verify-only. Same 32-char floor. |
| `AUTH_ENVIRONMENT_ID` | *(empty)* | `[a-z0-9_-]{1,32}`, starts alphanumeric. Scopes cookie names + JWT issuer. Unset = unchanged behaviour. |
| `JWT_ISSUER` | `nexus-lineage` | Base issuer; `AUTH_ENVIRONMENT_ID` is appended when set. |
| `JWT_AUDIENCE` | `nexus-lineage` | Per-token-family suffixes (`:refresh`, `:invite`, …) keep token types from being interchangeable. |
| `JWT_EXPIRY_MINUTES` | `5` | Access-cookie lifetime. The k8s ConfigMap overrides this to `15`. |
| `JWT_REFRESH_EXPIRY_DAYS` | `7` | Refresh lifetime — also the drain window for a key rotation. |
| `AUTH_COOKIE_SECURE` | `true` | Must be `false` on plain-HTTP hosts or cookies are silently dropped. |
| `AUTH_COOKIE_DOMAIN` | *(unset — host-only)* | Set only to deliberately share a session across subdomains. |
| `AUTH_COOKIE_SAMESITE` | `lax` | `strict` breaks the SSO redirect handshake. |
| `SSO_SESSION_MAX_AGE_HOURS` | `24` | Re-auth ceiling for SSO sessions; local password sessions are exempt. |

---

## 8. Known limitations

These are deployment-topology issues, not session-handling ones. The changes above make them
survivable rather than session-ending, but they are worth fixing:

- **All kustomize overlays deploy into one namespace with identical object names.**
  `deploy/k8s/overlays/*/kustomization.yaml` set no `namespace`, `namePrefix`, or
  `nameSuffix`, while the base pins `namespace: synodic`. Deploying dev and then staging to
  the same cluster overwrites `Secret/app-secrets`, `Deployment/viz-service`, and
  `Ingress/synodic-ingress`. The base ingress also pins one global static IP for every
  overlay, so two environments cannot coexist there.
- **`./deploy.sh setup` re-mints `JWT_SECRET_KEY`** into a per-operator `.env.deploy`, so a
  fresh checkout or a different machine silently rotates it.
- **Applying a Secret does not restart pods** — there is no checksum annotation on the pod
  template, so a key change reaches pods only as they are replaced.

---

## Related

- [SETUP.md](SETUP.md) — local development
- [DEPLOYMENT.md](DEPLOYMENT.md) — single-host self-hosting
- [SSO.md](SSO.md) — IdP integration and the auth surface
- [RBAC.md](RBAC.md) — roles, permissions, and workspace scoping
