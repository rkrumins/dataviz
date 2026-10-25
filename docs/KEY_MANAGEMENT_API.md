# Key Management API

*For integrators and administrators — the routes that describe, make, rotate and revoke API keys,
yours or a service account's.*

Every key route, what it takes, what it answers and every way it can refuse. To use a key once you
have one, start with the [Integration Quickstart](/docs/integration-quickstart).

| You want | Call | Who |
|---|---|---|
| What the key making this request is, and whether it works | `GET /api/v1/api-keys/self` | Any key |
| To end the key making this request | `DELETE /api/v1/api-keys/self` | Any key |
| To list, make, rotate, rename or revoke your own keys | `/api/v1/me/api-keys…` | You, signed in |
| The same for a service account's keys | `/api/v1/me/service-accounts/{account_id}/api-keys…` | Its managers |
| Every key on the platform, and to revoke any | `/api/v1/admin/api-keys…` | Auditors and user administrators |

> **Only `/api-keys/self` takes a key.** Every other route here needs a person's session — cookies,
> and `X-CSRF-Token` on writes, as in [With a password](/docs/api-guide#with-a-password) — and
> answers a key with `403 api_key_not_allowed`. So a key can describe or end itself, but can't
> rotate itself or make another. People who sign in through single sign-on manage keys in the
> app, under **Account → API keys**.

**This page covers:**

- **The key making the request**: describe it, end it
- **Your own keys**: the request that describes a key, the answer, confirming it's you, rotating
  and renewing, renaming, revoking, and the limits
- **A service account's keys**: who may manage them, and the account routes beside them
- **Every key**, for administrators
- **Errors**, what isn't supported, and where the code lives

---

## The key making the request

### Describe it

`GET /api/v1/api-keys/self`, with the key itself:

```json
{
  "id": "apk_63f1966bae8c",
  "name": "metadata reader",
  "prefix": "nxsat_kjF1eaT0",
  "kind": "service",
  "status": "active",
  "userId": "svc_7be5998c6784",
  "permissions": {"views": "none", "data": "read", "publish": false},
  "resources": {"workspaces": [], "views": [], "dataSources": ["ds_124482eedff6"]},
  "expiresAt": "2027-01-31T00:00:00+00:00",
  "createdAt": "2026-10-24T09:30:00+00:00"
}
```

| Field | What it is |
|---|---|
| `id` | The key's id, `apk_…`. |
| `prefix` | The first characters of the token: enough to recognise it, never enough to use it. |
| `kind` | `personal` (acts as a person, `nxpat_…`) or `service` (acts as a service account, `nxsat_…`). |
| `status` | `active`, or why it doesn't work: `paused`, `expired`, `owner_inactive` or `ip_not_allowed` (below). |
| `userId` | Who it acts as: a person (`usr_…`) or a service account (`svc_…`). Only while it works. |
| `permissions` | `views` and `data`: `none`, `read` or `write`; `publish`: whether it may publish views. Only while it works. |
| `resources` | `"all"`, or the `workspaces`, `views` and `dataSources` it is limited to. Only while it works. |
| `expiresAt` | When it stops working — its own expiry or the deployment's maximum lifetime, whichever is sooner. `null`: never. |
| `createdAt` | When it was made. |

This route answers `200` for any key that isn't revoked — even one that has stopped working — so it
can say why. A key that has stopped working shows only what it is, not what it reaches: it may be
in hands it was never meant for.

| `status` | Means |
|---|---|
| `active` | It works. |
| `paused` | A personal key: its owner hasn't signed in through the identity provider within the sign-in window, or has no way to sign in. A service account's key: the account has had no manager for longer than its grace period. |
| `expired` | Past its expiry. Rotate it to renew it. |
| `owner_inactive` | Its owner is suspended, deleted or a break-glass account, or its service account is disabled. |
| `ip_not_allowed` | This request came from an address outside the key's networks. |

A revoked or unknown key answers `401` (`api_key_revoked`, `invalid_api_key`); a request with no
key answers `401 api_key_required`; while keys are switched off, `401 api_keys_disabled`.

### End it

`DELETE /api/v1/api-keys/self`, with the key itself, answers `204` — for whoever finds a key where
it shouldn't be. It works whatever state the key is in, short of already revoked, but not while
keys are switched off. Ending a service account's key tells whoever answers for the account.

---

## Your own keys

Under `/api/v1/me/api-keys`, signed in as yourself:

| Route | Does |
|---|---|
| `GET /options` | The deployment's rules, how you would confirm it's you, and every workspace you could give a key |
| `GET /resources?type=view\|data_source&q=&workspaceId=&limit=` | Views or data sources you could give a key, by name (`limit` up to 50) |
| `GET ?history=recent\|all` | Your keys, newest first: those in date and those that ended in the last 90 days, or with `history=all` every one, up to the newest 500 |
| `POST /preview` | What a key would be if made now — nothing is made |
| `POST` | Make a key |
| `GET /{key_id}` | One key, with what it reaches and its use per day |
| `GET /{key_id}/last-use` | When and where it was last used |
| `PATCH /{key_id}` | Rename it, or change what it says it is for |
| `POST /{key_id}/rotate` | Replace it with a new token, or renew an expired one |
| `DELETE /{key_id}` | Revoke it |

### Describe a key

`POST /preview` and `POST` take the same body:

```json
{
  "name": "metadata reader",
  "description": "Reads graph metadata every night",
  "permissions": {"views": "none", "data": "read", "publish": false},
  "resources": {"dataSources": ["ds_124482eedff6"]},
  "allowedCidrs": ["203.0.113.0/24"],
  "expiresAt": "2027-01-31T00:00:00Z",
  "currentPassword": "…"
}
```

| Field | Rules |
|---|---|
| `name` | Required, 1 to 80 characters. |
| `description` | Up to 500 characters. |
| `permissions` | `views` and `data`, each `none`, `read` or `write` — at least one not `none`; `publish` needs `views: "write"`. |
| `resources` | `"all"` (everything you can reach), or `workspaces`, `views` and `dataSources` — up to 100 ids each, and at least one. Every id must exist and be yours to give. |
| `allowedCidrs` | Up to 20 addresses or networks the key may be used from; empty means anywhere. |
| `expiresAt` or `neverExpires: true` | One of them, never both. The date must be in the future and, where the deployment sets a maximum lifetime, within it — then `neverExpires` is refused. |
| `currentPassword` | Your password, if you sign in with one: see [Confirming it's you](#confirming-its-you). |

A body that breaks a rule answers `422` with `{"detail": {"error": "invalid_api_key_request",
"message": …}}`, and for ids that don't exist or aren't yours, `unknown` lists them by kind:
`{"unknown": {"dataSources": ["ds_…"]}}`. A field this page doesn't list is refused with FastAPI's
own `422`.

### The answer

`POST` answers `201` with the key and its token, and `Cache-Control: no-store`. The token is in
this answer and nowhere else — it can't be read again.

```json
{"key": {"id": "apk_63f1966bae8c", "name": "metadata reader", "kind": "personal", "status": "active", …},
 "token": "nxpat_…"}
```

A key, as every route here describes it:

| Field | What it is |
|---|---|
| `id`, `name`, `description`, `prefix`, `kind` | As above. |
| `permissions`, `resources`, `allowedCidrs` | What it may do, what it reaches, where from. |
| `expiresAt` | When it stops working; `null`: never. |
| `status` | `active`, `paused`, `expired`, `revoked` or `owner_inactive`. |
| `createdAt`, `createdIp` | When it was made, and from where. |
| `lastUsedAt`, `lastUsedIp`, `lastUsedUserAgent` | Its last use. |
| `revokedAt`, `revokedBy`, `revokedReason`, `revokedNote` | When and why it ended, and what an administrator said. |
| `rotatedFrom` | The key it replaced. |
| `usage` | Requests, writes, refusals and errors over 30 days (`requests30d`, `writes30d`, `refused30d`, `errors30d`), and requests per day for the last 14 (`daily14`, oldest first). |

`GET /{key_id}` adds `effectiveAccess` (what it may do in each workspace, view and data source it
reaches, as of now), `usageDays` (30 days, per day), and `replaces` / `replacedBy`. `POST /preview`
answers what the key would be — `permissions`, `resources`, `allowedCidrs`, `expiresAt`,
`effectiveAccess` — with `activeKeys` and `maxActiveKeys`.

### Confirming it's you

Making or rotating a key asks you to prove it's really you, not a session left open:

- **With a password**, send it as `currentPassword`. Without it the answer is
  `403 step_up_required` with `"method": "password"`; a wrong one, `403 step_up_failed`; too many
  wrong ones, `429 rate_limited` with `Retry-After`.
- **Through an identity provider**, you must have signed in there within 15 minutes. If not, the
  answer is `403 step_up_required` with `"method": "sso"` and a `loginUrl` to sign in again
  (or, for a company gateway, `gateway`). While the provider is down: `503 idp_unreachable`
  (`Retry-After: 60`); a gateway that doesn't answer: `503 gateway_unreachable` (`Retry-After: 30`).
- **Some sessions can't confirm at all**, and get `403 step_up_unavailable` with a `reason`:
  `provider` (a portal connection, unless an administrator allows a round trip instead),
  `passwords_off` (a password while password sign-in is switched off) or `system_account` (a
  break-glass account, which holds no keys).

`GET /options` tells you beforehand: `stepUp.method`, `stepUpAvailable` and `stepUpReason` — one of
those three reasons, or `idp_unreachable` while the provider is down.

### Rotate or renew

`POST /{key_id}/rotate` makes a new token that does **exactly what the old one did** — the same
name, description, permissions, reach and networks. Only its expiry can change:

```json
{"graceSeconds": 86400, "expiresAt": "2027-04-30T00:00:00Z", "currentPassword": "…"}
```

- `graceSeconds`: how long the old key keeps working beside the new one — `0`, `3600`, `86400` or
  `604800` (a week). With `0` the old key is revoked at once.
- `expiresAt` or `neverExpires`: the new key's expiry. Neither: it lives as long as the old one
  was made to.
- A key that has **expired** is renewed instead: a new token, and no grace — there is nothing to
  keep working.

It answers `200` with the new key and token, like `POST`. To change what a key may do or reach,
make a new key and revoke the old.

### Rename, revoke

- `PATCH /{key_id}` with `name` and/or `description` answers the key. A revoked key is a record and
  can't be changed: `409 api_key_revoked`.
- `DELETE /{key_id}` revokes it at once: `204`.

### Limits

- **25 active keys** for each person and each service account: those still in date, paused ones
  included; expired and revoked ones don't count. A new key, a renewal, or a rotation that keeps
  the old key working for a while, past that, answers `409 too_many_api_keys`.
- **5 keys made or rotated a minute**, and 30 previews, from each address on each API server. Past
  that, `429` with `{"error": "Rate limit exceeded: …"}` and no `Retry-After`: wait a minute.

---

## A service account's keys

The same routes, under `/api/v1/me/service-accounts/{account_id}/api-keys`. A key made here has
`kind: "service"`, a token starting `nxsat_`, acts as the account, and counts against the
account's own 25.

**Who may call them:** the account's managers — people named as managers, and the members of teams
named as managers — and anyone holding `system:users:manage` (a super admin), whose actions the
managers are told about. To anyone else the account doesn't exist: `404`. Administering service
accounts (`system:service-accounts:manage`) doesn't make keys on its own.

**A disabled account** makes and rotates no keys: `409 service_account_disabled`. Its keys answer
`401 api_key_owner_inactive` until it is enabled.

**Finding your accounts:**

| Route | Answers |
|---|---|
| `GET /api/v1/me/service-accounts?limit=&offset=` | The accounts you manage, yourself or through a team, by name: `{items, total, graceDays}` (`limit` up to 200) |
| `GET /api/v1/me/service-accounts/{account_id}` | One of them — or, holding `system:users:manage`, any — with its `roles` and `liveKeys` |

Each account: `id`, `name`, `description`, `status` (`active` or `disabled`), `managers` (people and
teams, each with `inGoodStanding`), `managed` (someone can act for it now), `singleManager`,
`unmanagedSince` and `pausesAt` (when nobody has, and when its keys pause).

**Setting accounts up** is for administrators of service accounts
(`system:service-accounts:manage`), under `/api/v1/admin/service-accounts`:

| Route | Does |
|---|---|
| `GET ?q=&status=&managedBy=&limit=&offset=` | Every account; `managedBy` lists what a person's leaving touches |
| `POST` | Create one: `{name, description, managers: [{type: "user"\|"group", id}]}` |
| `GET`, `PATCH /{id}` | Read, rename or describe one |
| `POST /{id}/disable`, `/{id}/enable` | Stop every key it holds, or let them work again |
| `PUT`, `DELETE /{id}/managers/{users\|groups}/{subject_id}` | Appoint or remove a manager |
| `POST /{id}/roles`, `DELETE /{id}/roles/{binding_id}` | Give it a workspace role (`{workspaceId, role}`), or take one away |
| `POST /hand-over` | Move a person's manager seats to a successor: `{fromUserId, to: {type, id}}`, and `accountIds` to move only some |

They answer `409` for a manager who isn't an active person or is a break-glass account, `422` for a
role that administers a workspace or lets people in, and `403` when you couldn't grant that role
yourself — or, appointing a manager, any of the account's roles: a manager can do whatever the
account can. The rules behind them: [Service Accounts](/guide/service-accounts).

---

## Every key

For administrators, under `/api/v1/admin/api-keys`:

| Route | Needs | Does |
|---|---|---|
| `GET ?ownerId=&status=&focus=&unusedDays=&q=&sort=&order=&limit=&offset=` | `system:audit:read` | Every key, with its owner: `{items, total}` (`limit` up to 200) |
| `GET /stats?ownerId=&q=` | `system:audit:read` | Counts by status, and of keys expiring soon, never expiring, unused for 90 days and revoked in the last 30 |
| `GET /export.csv` (the list's filters) | `system:audit:read` | The list as CSV, up to 10,000 keys, with `X-Total-Count`. Two exports at a time per server; a third gets `429` with `Retry-After: 30` |
| `GET /{key_id}` | `system:audit:read` | One key, with its owner and what it reaches |
| `POST /{key_id}/revoke` with `{"note": …}` | `system:users:manage` | Revoke it, telling its owner why (`note` up to 500 characters): `204` |
| `DELETE /{key_id}` | `system:users:manage` | Revoke it: `204` |

`status` is `active`, `paused`, `owner_inactive`, `expired` or `revoked`; `focus` is
`expiring_soon`, `never_expires`, `unused` or `recently_revoked`; `sort` is `created`, `lastUsed`,
`expires` or `name`.

And for a person, under `/api/v1/admin/users/{user_id}/api-keys`, with `system:users:manage`:

| Route | Does |
|---|---|
| `POST /revoke-all` with `{"note": …}` | Revoke every key they hold: `{"revoked": n}` |
| `POST /revoke-made` with `{"note": …}` | Revoke the service accounts' keys they made that still work — when they leave: `{"revoked": n}` |

Whoever answers for each key — its owner, or a service account's managers — is told.

---

## Errors

Every refusal carries `{"detail": {"error": …, "message": …}}` unless it says otherwise.

| Status | `error` | When |
|---|---|---|
| `401` | `api_key_required` | `/api-keys/self` called without a key. |
| `401` | `invalid_api_key`, `api_key_revoked` | `/api-keys/self` with a key that doesn't exist, or was revoked. |
| `401` | `api_keys_disabled` | A key, while keys are switched off — `DELETE /api-keys/self` included. |
| `403` | `api_keys_disabled` | Making or rotating a key while keys are switched off. Revoking still works. |
| `403` | `api_key_not_allowed` | A key calling any route here but `/api-keys/self`. |
| `403` | `step_up_required`, `step_up_failed`, `step_up_unavailable` | [Confirming it's you](#confirming-its-you). |
| `404` | — | A key that isn't yours (or doesn't exist), or a service account you don't manage. |
| `409` | `too_many_api_keys` | 25 active keys already. |
| `409` | `api_key_rotated` | Rotating a key that was already replaced: rotate its replacement. |
| `409` | `api_key_revoked` | Rotating or changing a revoked key. |
| `409` | `service_account_disabled` | Making or rotating a disabled service account's key. |
| `422` | `invalid_api_key_request` | A body that breaks a rule, with `unknown` for ids you can't give a key. |
| `429` | `rate_limited` | Too many wrong passwords; or, on `/api-keys/self`, the key's 1,200 requests a minute, or too many bad keys from one address. Wait `Retry-After` seconds. |
| `429` | — | Too many keys made, rotated or previewed from one address: `{"error": "Rate limit exceeded: …"}`, with no `Retry-After`. |
| `429` | `busy` (in `detail.code`) | Two exports already running on this server: `Retry-After: 30`. |
| `503` | `idp_unreachable`, `gateway_unreachable` | The sign-in that confirms it's you can't be reached: try again after `Retry-After`. |
| `503` | `api_keys_unavailable` | `/api-keys/self`, while keys can't be checked or authorization enforcement is switched off: `Retry-After: 5`. |

What a key gets when it is used — `401` and `403` on any other route — is in [When a key is
refused](/guide/api-keys#when-a-key-is-refused).

---

## What isn't supported

- **A key managing keys.** A key can describe and end itself, nothing more: rotation needs a person,
  so a compromised key can't mint its own replacement.
- **Changing what a key may do.** Make a new key and revoke the old one.
- **Reading a token again.** It is shown once, when the key is made or rotated.
- **Keys acting as another person.** A key acts as the person who made it, or as a service account
  its maker manages.

---

## Where the code lives

| Concern | File | Symbol |
|---|---|---|
| Creating, previewing, renaming, rotating and revoking keys; the key describing or ending itself | `backend/app/api/v1/endpoints/api_keys.py` | `create_my_api_key`, `preview_my_api_key`, `update_my_api_key`, `rotate_my_api_key`, `revoke_my_api_key`, `describe_this_key`, `revoke_this_key` |
| Confirming it's you | `backend/app/api/v1/endpoints/api_keys.py` | `_step_up`, `_sso_step_up`, `_minting_refusal` |
| Who may act for a service account | `backend/app/api/v1/endpoints/api_keys.py` | `_principal`, `_unless_disabled` |
| Every key: counts, filters, detail, revoking with a note, CSV export | `backend/app/api/v1/endpoints/api_keys.py`, `backend/app/db/repositories/api_key_repo.py` | `api_key_stats`, `list_api_keys`, `export_api_keys`, `admin_revoke_api_key_with_note`, `status_expr` |
| Service accounts and their managers | `backend/app/api/v1/endpoints/service_accounts.py`, `backend/app/db/repositories/service_account_repo.py` | `list_my_service_accounts`, `create_service_account`, `hand_over`, `grant_role` |
| Whether a service account still has a manager | `backend/app/services/service_account_standing.py` | `refresh`, `key_audience` |
| The token format, its checksum, and when a key stops working | `backend/auth_service/core/api_keys.py` | `generate`, `looks_valid`, `lifecycle_refusal` |
| Checking a key on every request | `backend/app/auth/api_key_auth.py` | `authenticate`, `acting`, `_REFUSALS` |
| Which routes a key may call | `backend/app/auth/api_key_surface.py` | `SURFACE` |
| Counting each key's requests per day | `backend/app/services/api_key_usage.py` | `record_request`, `UsageRecorder.flush` |

## Where to next

- [Integration Quickstart](/docs/integration-quickstart) — a key's first calls, and every answer.
- [API Keys](/guide/api-keys) and [Service Accounts](/guide/service-accounts) — the same, from the
  app.
- [ADR-027](/docs/decisions#adr-027-personal-api-keys-scoped-per-resource) and
  [ADR-028](/docs/decisions#adr-028-service-accounts-answer-to-their-managers) — why keys and service
  accounts work this way.
