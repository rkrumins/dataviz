# API Keys

*For Builders, and anyone automating their own work.*

An API key lets a script or a service call the API **as you**: it reads and
changes views and data the way you could yourself, and is recorded as you in
every audit trail. You choose how much of that it gets — some workspaces,
views or data sources, and read or write — and it can never do more than you
can. If your own access shrinks, so does the key's, on its next request.

> **Note:** *The one-sentence model* — a key is your access, narrowed to what
> you chose, checked afresh on every request.

---

## Creating a key

Open **Account → API keys** (or **API keys** in the menu under your avatar),
and choose **Create key**.

1. **Name it** after where it will be used — "nightly lineage sync" is more
   use to you in six months than "test".
2. **Choose what it can reach.**
   - **Selected views & data sources** — the narrowest, and the default. The
     pickers list everything you can reach, including views shared with you or
     published to everyone, and say whether *you* can edit or only read each.
   - **Selected workspaces** — everything in those workspaces.
   - **Everything I can access** — every workspace, view and data source you
     can reach, now and later.
3. **Choose what it can do there.**
   - **Views**: none, read, or read & write (create, edit, delete).
   - **Publish views to everyone**: only with read & write on views.
   - **Data**: none, read (the data, and the semantic layer and catalog entry
     that explain it), or read & write (change data, propose and publish
     changes, start refreshes).
4. **Choose when it expires.** 30 days is chosen for you. Your administrator
   may set a maximum; "Never" is only offered when they have not.
5. **Optionally, limit it to networks** — addresses or ranges such as
   `203.0.113.0/24`. From anywhere else the key is refused.
6. **Confirm it's you.** With a password, type it. If you sign in through an
   identity provider, you are asked to sign in again unless you did in the
   last 15 minutes; what you filled in is waiting when you come back.

The key is shown **once**. Copy it into a secrets manager before you close the
dialog — it is not stored anywhere you can see it again. If you lose it,
[rotate](#rotating-a-key) it.

> **Tip:** Make one key per integration, each limited to what that
> integration needs. A key that reads one view is a small loss if it leaks; a
> key that writes everything is not.

### What it can do, before and after

Expand a key on the page to see **what it can do right now**: per workspace,
and per view and data source it names. This is your access today narrowed by
the key — so if you lose a role, it shows the key losing it too.

When the key asks for more than you have on something — write access to a
view you can only read — the form says so before you create it. The key will
only read that view.

---

## Using a key

Send it in the `Authorization` header:

```bash
curl -H "Authorization: Bearer nxpat_…" \
  https://your-host/api/v1/views/v_123
```

Never put a key in a URL: addresses end up in logs and browser history. Keys
in a query string are not accepted.

To check a key without changing anything, ask it about itself:

```bash
curl -H "Authorization: Bearer nxpat_…" https://your-host/api/v1/api-keys/self
```

The answer says whether it is active, paused or expired, what it may do, and
when it stops working. Every successful response also carries
`X-API-Key-Expires-At`, so a client can warn you before the day comes.

### What a key can call

Keys are for the data plane: reading and changing views and the data behind
them, proposing and publishing changes, and following what changed.
Administration, sharing and settings are not available to keys. The API
reference marks every operation a key may call.

| To… | Use |
| --- | --- |
| Read a view and its layout | `GET /api/v1/views/{id}` |
| Read the data behind a view you can read | `/api/v1/{workspace}/graph/…?viewId={id}` |
| Read or change a data source's graph | `/api/v1/{workspace}/graph/…?dataSourceId={id}` |
| Propose a change | open a draft, stage the change, open a merge request (`/versioning/…`) |
| Publish a change | merge a request you may merge, or publish your draft |
| Follow what changed | the view's activity (`GET /views/{id}/activity`), the commit log and watermark of its graph (`/versioning/graphs/{id}/commits`, `/watermark`), a data source's jobs and their event stream |

A key limited to particular data sources must **name** one with
`dataSourceId`; it cannot rely on a workspace's default data source. A key
limited to views reads a view's data through `viewId`, read-only, exactly as
you can open a view's data without being able to change it.

### When a key is refused

| Status | `error` | What it means |
| --- | --- | --- |
| 401 | `invalid_api_key` | Not a key this platform issued, or mistyped. |
| 401 | `api_key_revoked` | Revoked. It will not work again. |
| 401 | `api_key_expired` | Past its expiry, or older than your administrator's maximum. |
| 401 | `owner_reauth_required` | Paused: you have not signed in through your identity provider for too long. Sign in and it resumes. |
| 401 | `api_key_owner_inactive` | Your account is suspended. |
| 401 | `api_key_ip_not_allowed` | Used from outside the networks it is limited to. |
| 401 | `api_keys_disabled` | Your administrator has switched API keys off. |
| 403 | `api_key_not_allowed` | This endpoint cannot be called with a key. |
| 403 | `api_key_read_only` | A read-only key asked to change something. |
| 403 | `api_key_out_of_scope` | The request reaches past what the key was limited to. |
| 429 | `rate_limited` | Too many requests with this key; wait for `Retry-After`. |
| 503 | `api_keys_unavailable` | The key could not be checked just now. Retry — it says nothing about the key. |

Refusals carry a standard `WWW-Authenticate: Bearer` header:
`error="invalid_token"` when the key is not accepted, `error="insufficient_scope"`
when it is but may not do this.

---

## Paused keys

If you sign in through an identity provider, your keys **pause** when you
have not signed in through it for a while — 30 days unless your administrator
chose otherwise — and **resume** the next time you do. Nothing is revoked.
This is how the keys of someone who has left, and so can no longer sign in,
stop working without anyone having to remember them.

Suspending an account stops its keys at once. Signing out everywhere or
changing your password does **not** stop your keys: revoke them if one may
have leaked.

---

## Rotating a key

**Rotate** makes a new token that can do exactly what the old one does. Choose
how long the old token keeps working beside it — not at all, an hour, a day or
a week — so you can swap the new one in without a gap. The new token is shown
once, like a new key.

## Revoking a key

**Revoke** stops a key at once, permanently. Revoked keys stay on the page as
a record.

Whoever holds a key can also revoke it — even a paused or expired one — so if
you find a key where it should not be, end it:

```bash
curl -X DELETE -H "Authorization: Bearer nxpat_…" https://your-host/api/v1/api-keys/self
```

---

## What is recorded

Creating, rotating and revoking a key are on your account's activity, and on
the audit log administrators read, as is a revoked key being used again or a
key being used from a network it does not allow — those also tell you in your
inbox. Everything a key changes is recorded as you, marked with the key. A
week before a key expires, you get a reminder.

## For administrators

**Administration → API keys** lists every key, its owner, what it can reach
and when it was last used; filter to keys nobody has used for 90 days. With
permission to manage users you can revoke one key, or every key a person
holds — ending someone's sessions does not touch their keys.

Three switches in **Administration → Features → Authentication** govern keys:
**API keys** (the switch for all of them at once), **Longest an API key may
live**, and **Pause keys of people who stop signing in**. See
[Feature Switches](/guide/feature-switches).

---

## Where to next

- [Versioning & Change Control](/guide/versioning-change-control) — when your
  integration proposes changes: how drafts, reviews and publishing work.
- [Import & Export](/guide/import-export) — when a script loads data in bulk
  rather than change by change.
- [Users & Access](/guide/users-access) — when a key reaches less than you
  expect: it can only ever reach what you can.
