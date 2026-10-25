# Integration Quickstart

*For integrators — a script, a pipeline or a service that calls the {brand} API.*

From nothing to a working, well-behaved integration: choose the credential it runs with, make a
key, check it, find your workspace, make your first calls, and handle every answer the API can
give. Each step links to the page with the detail.

## Your path

1. **Integration Quickstart** — this page: a credential, a key, your first calls, every answer.
2. [API Guide for Integrators](/docs/api-guide) — the conventions every endpoint shares, and
   recipes for the integrations people build most.
3. [Key Management API](/docs/key-management-api) — the key routes: describe, make, rotate and
   revoke keys, yours or a service account's, and every refusal.
4. [Graph Metadata & History API](/docs/graph-metadata-api) — a workspace's graphs, external or
   versioned, and each versioned graph's commit history, field by field.
5. [Search & Display Rules: developer reference](/docs/feature-search-and-rules-reference) —
   the query model and every search and view-library endpoint.
6. [Versioning API reference](/docs/versioning-api-reference) — drafts, publishing, history,
   imports and exports over HTTP.
7. [Import / Export](/docs/versioning-import-export) — how a bulk file is read, matched and
   applied.
8. [View portability](/docs/feature-view-portability) — the view file format and the checks an
   import runs.
9. [Feature Switches API](/docs/api-features) — which administrator switch turns which endpoint
   off.

## 1. Choose the credential

An integration acts as someone, and everything it changes is recorded as them. Choose who:

| | Personal key (`nxpat_…`) | Service account's key (`nxsat_…`) | Password session |
|---|---|---|---|
| Acts as | You | The service account | The account that signed in |
| Reaches | What you chose when you made it, never more than you can | What you chose, never more than the account's own workspace roles | Everything the account can |
| Made by | You | The account's managers | — |
| Stops when | You leave, or stop signing in through your identity provider | The account is disabled, or has had no manager for longer than its grace period | The session ends (7 days, or 12 idle hours) |
| Calls | The data plane | The data plane | Every route |

- **Anything scheduled or shared runs as a service account.** A personal key stops when its
  person leaves; a service account's key keeps working as long as someone manages the account.
- **A personal key is for your own scripts.** Some accounts can't make one: a break-glass
  account; an account with only a password while password sign-in is switched off; and, unless
  an administrator allows it, an account that signs in through a portal connection — see
  [Confirming it's you](/guide/api-keys#confirming-its-you).
- **A password session** is for the few routes a key can't call (below). It needs a person:
  a service account has no password and never signs in.

### Get a service account

Ask a super admin or an org admin (**Administration → Service accounts**) to:

1. **Create it**, named for what it does — "Metadata sync", say — with a line on what it is for.
2. **Make you, or better your team, its manager.** Managers make, rotate and revoke its keys.
3. **Give it a role in each workspace it works in**: Workspace viewer to read, Workspace member
   or Data engineer to change data. A service account never holds a role that administers a
   workspace or lets people in.

It then appears under **Account → API keys → Service accounts you manage**. What it is and who
answers for it: [Service Accounts](/guide/service-accounts).

## 2. Make the key

Under **Account → API keys** — or, for a service account, on its page under **Service accounts
you manage** — choose **Create key** and give it only what the integration needs:

- **Reach**: the workspaces, views or data sources it works on, not everything.
- **Permissions**: **Data: read** to read graphs; **read & write** only if it changes them.
- **An expiry**, and the **networks** it runs from if you know them.

You confirm it's you, and the token is shown once. Keep it in your secrets manager and hand it
to the integration in an environment variable; the examples use `API_KEY` for the token and
`API_BASE` for the address you open the app at. A key can't make or rotate another key: that
takes a person's session — see the [Key Management API](/docs/key-management-api).

## 3. Check the key

Send it as a bearer token, and nothing else: no cookies, no CSRF header, no renewal.

```bash
B=$API_BASE
HDR=$(mktemp)                                              # delete it when you're done
printf 'Authorization: Bearer %s\n' "$API_KEY" > "$HDR"   # a builtin: the key stays off the process list

api() {   # api METHOD PATH [more curl options]
  local method=$1 path=$2; shift 2
  curl -sS -X "$method" "$B$path" -H @"$HDR" -H 'Content-Type: application/json' "$@"
}

api GET /api/v1/api-keys/self | jq '{name, kind, status, expiresAt}'
```

```json
{"name": "metadata reader", "kind": "service", "status": "active", "expiresAt": "2027-01-31T00:00:00+00:00"}
```

In Python:

```python
import os
import httpx

api = httpx.Client(base_url=os.environ["API_BASE"], timeout=150,
                   headers={"Authorization": f"Bearer {os.environ['API_KEY']}"})
me = api.get("/api/v1/api-keys/self").json()
```

`/api-keys/self` answers `200` for any key that isn't revoked — even one that has stopped working —
so it can say why. **Check `status`, not the HTTP code**:

| `status` | Means |
|---|---|
| `active` | It works. |
| `paused` | A personal key: its owner must sign in again. A service account's key (`kind: "service"`): the account has had no manager for longer than its grace period. |
| `expired` | Past its expiry. Rotate it to renew it. |
| `owner_inactive` | Its owner is suspended or a break-glass account, or its service account is disabled. |
| `ip_not_allowed` | It was sent from an address outside its networks. |

`userId`, `permissions` and `resources` are there only while the key works. A revoked key
answers `401` here too. Give real work a timeout of 150 seconds: the slowest routes stop at 120.

## 4. Find your workspace and data source

A key sees only the workspaces it reaches, each with only the data sources it covers:

```bash
api GET /api/v1/admin/workspaces | jq -r '.[] | [.id, .name, ([.dataSources[].id] | join(" "))] | @tsv'
```

```text
ws_4d1c0b2e9f37  Sales  ds_124482eedff6 ds_7c0e9a51b2d8
```

A key limited to particular data sources must name one on every graph route
(`?dataSourceId=ds_…`): it can't fall back on the workspace's primary data source.

## 5. Make your first calls

Read, page by page. Note the trailing slash: `/api/v1/views` answers `307` with a redirect to it,
and httpx doesn't follow redirects unless told to.

```bash
api GET "/api/v1/views/?limit=5" | jq '{total, hasMore, nextOffset, names: [.items[].name]}'
```

List a workspace's graphs, external or versioned (a key covering the whole workspace, **Data:
read**):

```bash
api GET "/api/v1/admin/workspaces/$WS/data-sources?include=versioning" |
  jq -r '.[] | [.id, .versioning.enabled, .versioning.graphId // ""] | @tsv'
```

Tell the platform a data source changed (**Data: read & write**). Name the run in `X-Request-ID`
so you can find it again, and say why in `X-Activity-Reason`:

```bash
api POST "/api/v1/admin/data-sources/$DS/refresh" \
  -H 'X-Request-ID: metadata-sync-20261024' -H 'X-Activity-Reason: nightly%20load%20finished' \
  -d '{"scope": "auto", "reason": "nightly load finished"}'
```

Then poll `GET /api/v1/admin/data-sources/$DS/readiness` until `aggregationStatus` is `ready` —
or send `"wait": "complete"` with the refresh, and its answer waits up to 60 seconds for the
rebuild. More: [Tell the platform a data source changed](/docs/api-guide#tell-the-platform-a-data-source-changed).

Searches and traces are reads made with `POST`: a read-only key may make them. Their requests are
in the [search reference](/docs/feature-search-and-rules-reference) and the [API
Guide](/docs/api-guide#run-a-lineage-trace).

## 6. Handle what comes back

| Answer | Means | Do |
|---|---|---|
| `2xx` | Done. | — |
| `401` with `detail.error` | The key isn't accepted: mistyped, revoked, expired, paused, its owner inactive, or the wrong address. | Fix the key: [When a key is refused](/guide/api-keys#when-a-key-is-refused). |
| `403` with `detail.error` | The key is accepted but may not do this: `api_key_not_allowed` (a route keys can't call), `api_key_read_only`, `api_key_out_of_scope`, `missing_permission`. | Widen the key, or the role it acts with, or use another route. |
| `404` | Not there, or not yours to see. | — |
| `409` | It clashes with the current state. | Read it again, then decide. |
| `422` | The request is malformed. | Fix it; the answer says which field. |
| `429` or `503` with `Retry-After` | Slow down, or try again shortly. | Wait that many seconds, then send it again. |
| `504` | The server stopped waiting; the work may or may not have happened. | Send a read again. Check before you repeat a write. |

- **Each key may make 1,200 requests a minute** (a sliding window; refused requests count too).
  There are no `X-RateLimit-*` headers: past the limit the answer is `429` with `Retry-After`.
- **`X-API-Key-Expires-At`** comes on answers below `400`, and only for a key that expires.
- Every error and limit: [Errors](/docs/api-guide#errors) and [When the server sheds
  load](/docs/api-guide#when-the-server-sheds-load).

A retry that honours the server:

```python
import time

def call(method, path, **kwargs):
    """Send a request, waiting and trying again while the server says when to."""
    for attempt in range(5):
        r = api.request(method, path, **kwargs)
        wait = r.headers.get("Retry-After")
        if r.status_code in (429, 503) and wait is not None:
            time.sleep(min(int(wait), 60))
        elif r.status_code == 504 and method == "GET":
            time.sleep(2 ** attempt)
        else:
            return r
    return r
```

## 7. Before you go to production

- [ ] It runs with a **service account**, managed by a **team** rather than one person.
- [ ] Its key reaches **only what it needs**, read-only unless it writes, with an **expiry**.
- [ ] It is limited to the **networks** it runs from — and, behind a proxy, the deployment
      trusts the proxy's address ([Network limits behind a proxy](/guide/api-keys#network-limits-behind-a-proxy)).
- [ ] You know **how to rotate** it: the new key and the old work side by side for up to a
      week ([Rotating or renewing a key](/guide/api-keys#rotating-or-renewing-a-key)).
- [ ] Your **secret scanner** knows the key pattern ([Revoking a key](/guide/api-keys#revoking-a-key)).
      Whoever finds a key where it shouldn't be can end it with `DELETE /api/v1/api-keys/self`.
- [ ] It **never puts the key in a URL** (a key in a query string isn't read) and never logs it.
- [ ] It sends **`X-Request-ID`** (up to 128 letters, digits and `._:-`; kept and sent back) and,
      for changes, **`X-Activity-Reason`** (percent-encoded, up to 500 characters; shown in the
      activity log).
- [ ] A **browser app on another origin** can't read `X-Total-Count`, `X-Request-ID` or
      `X-API-Key-Expires-At`: use the body (`total`, `hasMore`) and `/api-keys/self` instead.

## What a key can't call

People and access, settings and switches, sharing, layout templates, saved filters, importing a
view file, turning version control on, and creating a graph. For these a person signs in with a
password ([With a password](/docs/api-guide#with-a-password)) or uses the app; a service account
can't. Everything a key may call: [What a key can call](/guide/api-keys#what-a-key-can-call), and
the API explorer marks each one ([Find the endpoint you need](/docs/api-guide#find-the-endpoint-you-need)).

## Where to next

- [API Guide for Integrators](/docs/api-guide) — conventions and recipes.
- [Key Management API](/docs/key-management-api) — every key route and refusal.
- [API Keys](/guide/api-keys) and [Service Accounts](/guide/service-accounts) — the same, from the
  app.
