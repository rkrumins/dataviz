# API Keys

*For Builders, and anyone automating their own work.*

An API key lets a script or a service call the API **as you**: it reads and
changes views and data the way you could yourself, and is recorded as you in
every audit trail. You choose how much of that it gets — some workspaces,
views or data sources, and read or write — and it can never do more than you
can. If your own access shrinks, so does the key's, on its next request.

> **Note:** *The one-sentence model* — a key is your access, narrowed to what
> you chose, checked afresh on every request.

A key that acts as you stops when you leave. For an integration that should
outlive you — a scheduled job, a sync with another system — make its key on a
[service account](/guide/service-accounts) instead: an account nobody signs in
as, whose keys its managers make.

---

## Creating a key

Open **Account → API keys** (or **API keys** in the menu under your avatar),
and choose **Create key**. Five short steps follow; every choice can be
changed on the way, and **Back** never loses what you filled in.

1. **Purpose** — pick the job closest to yours. Each sets sensible access and
   a lifetime to start from:

   | Starting point | Views | Data | Reach | Expires |
   | --- | --- | --- | --- | --- |
   | **Read data for reporting** | read | read | what you pick | 90 days |
   | **Load data and signal refreshes** | — | read & write | what you pick | 30 days |
   | **Publish views from CI** | read & write, publish | read | whole workspaces | 90 days |
   | **Custom** | read | — | what you pick | 30 days |

   A starting point you can't give a key — you don't hold that access in any
   workspace — is greyed out, with the reason. Then name the key after where
   it will be used ("nightly lineage sync" is more use in six months than
   "test"), and say what it is for.
2. **Reach** — **Selected views & data sources** (recommended, and the
   narrowest), **Selected workspaces**, or **Everything I can access** (every
   workspace, view and data source you reach, now and later). The pickers list
   everything you can reach, including views shared with you or published to
   everyone, and say whether *you* can edit or only read each.
3. **Permissions** — for **Views** and for **Data**: no access, read, or read
   & write. Each level says what a script holding the key could do. **Publish
   views to everyone** needs read & write on views. When the key asks for more
   than you have on something — write access to a view you can only read —
   the step says so: the key will only read it.
4. **Safety** — when it expires (the date is shown; **Never** only where your
   administrator allows it), and optionally the networks it may be used from,
   such as `203.0.113.0/24`. **Add this address** adds the one you are calling
   from now, as the server sees it.
5. **Review** — everything the key will be able to do, how exposed it would
   be if it leaked, and what it can do *right now* across your workspaces,
   views and data sources — worked out by the server exactly as creating it
   would be. Then confirm it's you, and create it.

The key is shown **once**, with ready-to-paste snippets for cURL, Python,
JavaScript and a `.env` file. Copy it into a secrets manager and tick **I've
stored it somewhere safe** — it is not stored anywhere you can see it again.
The page then waits for the key's first call and says when it arrives. If you
lose a key, [rotate](#rotating-or-renewing-a-key) it.

> **Tip:** Make one key per integration, each limited to what that
> integration needs. A key that reads one view is a small loss if it leaks; a
> key that writes everything is not.

### Confirming it's you

Creating, rotating or renewing a key asks you to prove you are at the
keyboard — a session left open on a shared machine must not be enough to walk
away with a credential.

- **With a password**, type it — while password sign-in is switched on. When
  your administrator has switched it off to enforce single sign-on, a
  password confirms nothing, even while an emergency window lets people sign
  in with one during an identity-provider outage: a key made then would
  outlive the emergency. Sign in through single sign-on to manage your keys.
- **Through an identity provider**, you need to have signed in there within
  the last 15 minutes, and the provider must say when. OIDC and SAML
  connections do. If it has been longer, **Sign in again** takes you to your
  provider and brings you back to the review, with everything you chose still
  there — never the key itself, which doesn't exist yet.
- **Through your company's Enterprise gateway**, there is usually nothing to
  do: the gateway is asked, as you create the key, whether your company
  sign-in is still live. If it has ended, the page signs you in through it
  again without leaving the review, and carries on — or says why it
  couldn't; if the gateway doesn't answer, try again in a moment — no key is
  made without its answer. Where only your browser talks to the gateway, a
  sign-in through it in the last 15 minutes counts, and when it has been
  longer the page signs you in through it again the same way. If your
  company sign-in turns out to be someone else's, nothing is made.
- **Portal connections** can't say when you signed in, so keys can't be
  created through them unless your administrator has turned on **Accept a
  fresh sign-in round trip for API keys**. The review step tells you when that
  is the case.

While your identity provider is down — the platform confirms that after a few
minutes of it not answering — keys can't be created, rotated or renewed
through it, and the page says so: try again once it's back. A sign-in it
confirmed in the last 15 minutes, before it went down, still counts.

### What it can do, before and after

Open a key to see **what it can do right now**: per workspace, and per view
and data source it names. This is your access today narrowed by the key — so
if you lose a role, it shows the key losing it too.

---

## Using a key

Send it in the `Authorization` header:

```bash
curl -H "Authorization: Bearer nxpat_…" \
  https://your-host/api/v1/views/v_123
```

Never put a key in a URL: addresses end up in logs and browser history. Keys
in a query string are not accepted.

A key is read from this header and nowhere else. If a proxy or company
gateway in front of the API sets, replaces or strips `Authorization` — some
single sign-on proxies put their own token there — your key never arrives.
Ask your administrator for a route to the API that passes the header through
untouched.

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
| Find views, count them, or chart when they were made or changed | `GET /api/v1/views/`, `/views/count`, `/views/histogram` |
| Read a view and its layout | `GET /api/v1/views/{id}` |
| Read the data behind a view you can read | `/api/v1/{workspace}/graph/…?viewId={id}` |
| Read or change a data source's graph | `/api/v1/{workspace}/graph/…?dataSourceId={id}` |
| List a workspace's graphs, and which are versioned | `GET /api/v1/admin/workspaces/{workspace}/data-sources?include=versioning` — a key covering the whole workspace |
| Propose a change | open a draft, stage the change, open a merge request (`/versioning/…`) |
| Publish a change | merge a request you may merge, or publish your draft |
| Follow what changed | the view's activity (`GET /views/{id}/activity`), the commit log and watermark of its graph (`/versioning/graphs/{id}/commits`, `/watermark` — see [Graph Metadata & History API](/docs/graph-metadata-api)), a data source's jobs and their event stream |

A key limited to particular data sources must **name** one with
`dataSourceId`; it cannot rely on a workspace's default data source. A key
limited to views reads a view's data through `viewId`, read-only, exactly as
you can open a view's data without being able to change it — but not the
routes about that data source itself, such as its jobs or pull requests,
which need the data source. A pull request from a fork lands in the graph it
was forked from, so it needs that graph's data source too.

A key's job event stream ends after five minutes. Reconnect with the last
event's id in `Last-Event-ID` and it carries on where it stopped; the key is
checked again each time.

### When a key is refused

| Status | `error` | What it means |
| --- | --- | --- |
| 401 | `invalid_api_key` | Not a key this platform issued, or mistyped. |
| 401 | `api_key_revoked` | Revoked. It will not work again. |
| 401 | `api_key_expired` | Past its expiry, or older than your administrator's maximum. |
| 401 | `owner_reauth_required` | Paused: you have not signed in through your identity provider for too long — or have no way to sign in, such as only a password while password sign-in is switched off. Sign in and it resumes. |
| 401 | `api_key_owner_inactive` | Your account is suspended, deleted, or marked as a break-glass (system) account — which holds no keys. For a service account's key: the account is disabled. |
| 401 | `api_key_unmanaged` | A service account's key, paused: the account has had no manager for longer than the grace period. It works again as soon as an administrator appoints one. |
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

If you sign in only with a password, your keys pause while your administrator
has password sign-in switched off — an emergency window that lets passwords
back in during an identity-provider outage doesn't count, since it closes —
and resume when it is switched back on, or once you sign in through single
sign-on. The switch reaches your keys within 30 seconds.

Suspending an account stops its keys at once. Signing out everywhere or
changing your password does **not** stop your keys: revoke them if one may
have leaked.

---

## Keeping a key current

**Edit** renames a key or changes what it says it is for. What it may do,
where it reaches and when it expires are fixed when it is made: to change
those, rotate it or make a new key.

### Rotating or renewing a key

**Rotate** makes a new token that can do exactly what the old one does.
Choose how long the old token keeps working beside it — not at all, an hour,
a day or a week — and the dialog says when that is, so you can swap the new
one in everywhere first. While both work they count as two of your 25, so at
the limit, rotate without keeping the old one. A key can be replaced once:
rotate its replacement next time.

**Renew** is for a key that has expired: it makes a new token with the same
access as the old one, starting from what your access is *today*. There is no
old token left to keep working, and a renewed key counts towards your 25 like
a new one. An expired key that something is still calling says so, so you know
to renew it.

The new token is shown once, like a new key. The old key and its replacement
point to each other.

## Revoking a key

**Revoke** stops a key at once, permanently. Keys that have ended stay under
**Expired and revoked** for 90 days, as a record.

Whoever holds a key can also revoke it — even a paused or expired one — so if
you find a key where it should not be, end it:

```bash
curl -X DELETE -H "Authorization: Bearer nxpat_…" https://your-host/api/v1/api-keys/self
```

Better still, stop a key reaching a repository at all. Every key is `nxpat_`
— or, for a service account's, `nxsat_` — followed by 38 letters and digits,
the last six a checksum of the rest, so this pattern finds one:

```text
nx[ps]at_[0-9A-Za-z]{38}
```

Add it as a custom pattern to GitHub secret scanning — with push protection
on, a push that contains a key is blocked — or as a rule for gitleaks or
GitGuardian.

---

## What is recorded

Each key's card shows its requests per day for the last two weeks, and the
key's own page the last 30 days: how many requests, how many changed
something, and how many were refused or failed. Counts are added every half
minute.

Creating, renaming, rotating and revoking a key are on your account's
activity, and in **Administration → Activity**, as is a revoked key being used
again or a key being used from a network it does not allow — those also tell
you in your inbox. Everything a key changes is recorded as you, marked with
the key, and an administrator can list everything one key did: **Its
activity** on the key. A week before a key expires, you get a reminder.

## Network limits behind a proxy

A key limited to networks is checked against the address the API server sees
you calling from. Behind a load balancer or proxy that address comes from the
`X-Forwarded-For` header, which the server believes only from the proxies
`FORWARDED_ALLOW_IPS` names. The shipped Compose and Kubernetes settings
believe every private address range, so anything inside one of them could
claim to be anywhere. Ask your administrator to name exactly your proxies
before you rely on a network limit.

## For administrators

**Administration → API keys** opens on counts — active, expiring within 7
days, never expiring, unused for 90 days, paused — each of which filters the
list. Tabs narrow it by status, the search finds a key by name or prefix or
its owner by email, and the columns sort by name, last use, expiry or
creation. Open a key for its owner, what it can do right now, its usage and
the keys it replaced. With permission to manage users you can revoke one key —
optionally with a note its owner sees — or every key a person holds; ending
someone's sessions does not touch their keys. **Export CSV** downloads the list
as filtered and sorted, up to 10,000 keys; two exports run at once on each
server, and a third is asked to try again shortly. The access drawer on
**Administration → Users** links to each person's keys. A service account's
keys are marked as such; its managers, rather than a person, hear when you
revoke one.

Five switches in **Administration → Features → Authentication** govern keys:
**API keys** (the switch for all of them at once), **Longest an API key may
live**, **Pause keys of people who stop signing in**, **Accept a fresh
sign-in round trip for API keys**, which concerns portal connections only (see
[Confirming it's you](#confirming-its-you)), and **Keep a service account's keys
working after its last manager goes** (see [Service
Accounts](/guide/service-accounts)). See [Feature
Switches](/guide/feature-switches).

---

## Where to next

- [Service Accounts](/guide/service-accounts) — when an integration must keep
  running whoever set it up.
- [Versioning & Change Control](/guide/versioning-change-control) — when your
  integration proposes changes: how drafts, reviews and publishing work.
- [Import & Export](/guide/import-export) — when a script loads data in bulk
  rather than change by change.
- [Users & Access](/guide/users-access) — when a key reaches less than you
  expect: it can only ever reach what you can.
