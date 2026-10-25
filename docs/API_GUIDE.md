# API Guide for Integrators

*For integrators — anyone who scripts against the API or automates {brand}.*

This page gets a script signed in, shows you where to find any endpoint, explains the
conventions every endpoint shares, and walks through the nine integrations people build
most often. Each recipe is a short procedure with the real request. New to the API? Start with
the [Integration Quickstart](/docs/integration-quickstart): a credential, a key, your first calls
and every answer, in order.

> **Before you start:** you need the address you open the app at, and an account that holds
> the permissions your task needs (each recipe says which). Scripts act as that account —
> with an API key it made, or its password — or as a service account, with a key its managers
> made. You also need `curl` and `jq`, or Python 3 with `requests` or `httpx`.

## Sign in from a script

A script acts as someone, and every change it makes is recorded under their name: a person, or a
[service account](/guide/service-accounts) — an account of its own that never signs in, whose
managers make its keys. It gets in one of three ways:

| | Personal key (`nxpat_…`) | Service account's key (`nxsat_…`) | Password |
|---|---|---|---|
| Acts as | You | The service account | The account that signed in |
| Who makes it | You — people who sign in through an identity provider too — unless your administrator switched keys off. [Some accounts can't](/guide/api-keys#confirming-its-you) | The account's managers, or a super admin | — |
| What it reaches | What you chose when you created it — some workspaces, views or data sources, read-only or read & write — and never more than you can | What its managers chose, and never more than the account's own workspace roles | Everything the account can |
| What it can call | The data plane: views, graphs, drafts and publishing, data-source signals and jobs — some of them under `/admin/`, such as the workspace list | The same | Every route |
| Stops when | You leave, or stop signing in through your identity provider | The account is disabled, or has had no manager for longer than its grace period | The session ends |
| What the script handles | One header | One header | Cookies, a CSRF header on writes, renewal when the access cookie expires |

Use a key unless the route you need is one a key cannot call — people and access, sharing,
settings and switches, layout templates, saved filters, or importing a view file. Each recipe
below says when that is. Those routes need a person signed in with a password: a service account
has none. New to keys? The [Integration Quickstart](/docs/integration-quickstart) takes you from
choosing one to handling every answer.

### With an API key

Create the key under **Account → API keys** — or, for a service account, on its page under
**Service accounts you manage** — limited to what the script needs: see [API Keys](/guide/api-keys)
and [Service Accounts](/guide/service-accounts). Making, rotating and revoking keys takes a
person's session, not a key; the routes are in the [Key Management API](/docs/key-management-api).
The key is shown once: keep it in your secrets manager, and hand it to the script in an
environment variable. Send it in the `Authorization` header on every request; nothing else is
needed — no cookies, no CSRF header, no renewal.

```bash
B=https://lineage.example.com        # the address you open the app at
HDR=$(mktemp)                        # the key's header; delete it when you're done
printf 'Authorization: Bearer %s\n' "$API_KEY" > "$HDR"   # a builtin, so the key stays off the process list

api() {   # api METHOD PATH [more curl options]
  local method=$1 path=$2; shift 2
  curl -sS -X "$method" "$B$path" -H @"$HDR" -H 'Content-Type: application/json' "$@"
}

api GET /api/v1/api-keys/self | jq -r '"\(.name): \(.status), until \(.expiresAt // "never")"'
```

```text
nightly lineage sync: active, until 2026-11-11T09:30:00+00:00
```

In Python, set the header once on the client:

```python
import os
import httpx      # or requests: session = requests.Session(); session.headers[...] = ...

api = httpx.Client(base_url=os.environ["API_BASE"], timeout=150,
                   headers={"Authorization": f"Bearer {os.environ['API_KEY']}"})
print(api.get("/api/v1/api-keys/self").json()["status"])
```

- **Never put the key in a URL.** A key in a query string isn't read: the request arrives
  with no key at all. Teach your secret scanner both prefixes, `nxpat_` and `nxsat_`
  ([Revoking a key](/guide/api-keys#revoking-a-key)).
- **Don't send cookies with it.** A request that carries a key is served as the key alone;
  any session cookies on it are ignored.
- **Name the data source.** A key limited to particular data sources must pass
  `?dataSourceId=` on the graph routes (`/api/v1/{ws_id}/graph/…`) — it cannot fall back on
  the workspace's primary data source.
- **Watch the expiry.** A key that expires sends `X-API-Key-Expires-At` on every answer below
  `400`; `/api-keys/self` says it too, as `expiresAt`. Rotate the key before that day, in
  **Account → API keys** or on the service account's page; the old token can keep working for
  up to a week while you swap the new one in.
- **Keep within the rate.** Each key may make 1,200 requests a minute, counted over a moving
  window, refused requests included. Past that the answer is `429 rate_limited` with
  `Retry-After`; there are no `X-RateLimit-*` headers. An address that sends 120 bad keys in a
  minute is refused the same way.
- **End a leaked key.** Whoever holds a key can end it, whatever state it is in short of
  revoked: `DELETE /api/v1/api-keys/self` with the key answers `204`.

A refused key answers `401` (the key isn't accepted: mistyped, revoked, expired, or paused —
until you next sign in, or for a service account's, until it has a manager again) or `403` (it
is, but may not do this), with the reason in `detail.error` — every reason is in
[When a key is refused](/guide/api-keys#when-a-key-is-refused).

### With a password

A script signs in the way the browser does: it posts a password, keeps the session cookies,
and copies one cookie into a header on every write. It can do everything the account can —
so use an account that holds only what the script needs. Only a person can: a service account
has no password and never signs in.

```mermaid
sequenceDiagram
    participant S as Your script
    participant A as API
    S->>A: POST /api/v1/auth/login with email and password
    A-->>S: 200 and the session cookies
    S->>A: GET requests with the cookies
    S->>A: POST, PUT, PATCH, DELETE with the cookies and X-CSRF-Token
    A-->>S: 401 once the access cookie expires
    S->>A: POST /api/v1/auth/refresh
    A-->>S: 200 and new cookies, including a new nx_csrf
```

1. **Sign in.** `POST /api/v1/auth/login` with `{"email": …, "password": …}`. A `200` sets
   four cookies: `nx_access` (the session, `HttpOnly`), `nx_refresh` (sent only to
   `/api/v1/auth/` routes), `nx_access_exp` (when `nx_access` expires, as Unix seconds) and
   `nx_csrf`. Where the deployment sets `AUTH_ENVIRONMENT_ID`, every name carries it as a
   suffix — `nx_csrf_production` — so match the cookies by prefix.
2. **Send the cookies back** on every request.
3. **On every `POST`, `PUT`, `PATCH` and `DELETE`, send `X-CSRF-Token`** with the current
   value of the `nx_csrf` cookie. Reads that are `POST`s — search, trace — need it too.
   Without it the answer is `403` with `{"detail": {"error": "csrf_failed", …}}`.
4. **Renew before the session lapses.** The access cookie lasts `JWT_EXPIRY_MINUTES`: 15
   minutes in the Compose files, 60 in the Helm chart, and 5 where it isn't set — so read
   `nx_access_exp` rather than assume. `POST /api/v1/auth/refresh` replaces every cookie,
   `nx_csrf` included, so read `nx_csrf` again after renewing. The simplest rule: on a `401`,
   renew once and retry. A session still ends after 7 days, or after 12 idle hours
   (`SESSION_ABSOLUTE_MAX_HOURS`, `SESSION_IDLE_MAX_HOURS`); then sign in again.
5. **Sign out** when the script finishes: `POST /api/v1/auth/logout`.

#### curl

```bash
B=https://lineage.example.com        # the address you open the app at
JAR=$(mktemp)                        # the session's cookies; delete it when you're done

jq -n --arg email "$API_EMAIL" --arg password "$API_PASSWORD" '{$email, $password}' |
  curl -sS -c "$JAR" -X POST "$B/api/v1/auth/login" \
       -H 'Content-Type: application/json' -d @- -o /dev/null -w '%{http_code}\n'

csrf() { awk '$6 ~ /^nx_csrf/ {print $7}' "$JAR"; }
api() {   # api METHOD PATH [more curl options]
  local method=$1 path=$2; shift 2
  curl -sS -b "$JAR" -c "$JAR" -X "$method" "$B$path" \
       -H "X-CSRF-Token: $(csrf)" -H 'Content-Type: application/json' "$@"
}

api GET /api/v1/auth/me | jq -r .user.email
```

```text
200
you@example.com
```

`api` reads the CSRF cookie afresh on every call and writes rotated cookies back to the jar,
so `api POST /api/v1/auth/refresh` is all a long-running script needs to renew. The recipes
below use `B`, `api` and `jq`. Building the login body with `jq` keeps a password that holds
quotes intact and off the command line. The search reference's
[Signing in from a script](/docs/feature-search-and-rules-reference#signing-in-from-a-script)
shows the same sign-in with the token read once into a fixed header list — fine for a session
shorter than the access cookie's lifetime.

#### Python with requests

```python
import os
import requests

BASE = os.environ["API_BASE"]                      # e.g. https://lineage.example.com
WRITES = {"POST", "PUT", "PATCH", "DELETE"}

session = requests.Session()
session.post(f"{BASE}/api/v1/auth/login",
             json={"email": os.environ["API_EMAIL"], "password": os.environ["API_PASSWORD"]}
             ).raise_for_status()


def csrf_token():
    # A suffix follows the name where AUTH_ENVIRONMENT_ID is set: nx_csrf_production.
    return next(c.value for c in session.cookies if c.name.startswith("nx_csrf"))


def call(method, path, **kwargs):
    """One API call: sends the CSRF header on writes, renews the session once on a 401."""
    for attempt in (1, 2):
        headers = dict(kwargs.pop("headers", {}))
        if method.upper() in WRITES:
            headers["X-CSRF-Token"] = csrf_token()
        response = session.request(method, f"{BASE}{path}", headers=headers, **kwargs)
        if response.status_code != 401 or attempt == 2:
            return response
        session.post(f"{BASE}/api/v1/auth/refresh").raise_for_status()


print(call("GET", "/api/v1/auth/me").json()["user"]["email"])
```

#### Python with httpx

```python
import os
import httpx

WRITES = {"POST", "PUT", "PATCH", "DELETE"}


def sign_in(base_url, email, password):
    client = httpx.Client(base_url=base_url, timeout=150)

    def add_csrf(request):
        if request.method in WRITES:
            token = next((c.value for c in client.cookies.jar if c.name.startswith("nx_csrf")), None)
            if token:
                request.headers["X-CSRF-Token"] = token

    client.event_hooks["request"] = [add_csrf]
    client.post("/api/v1/auth/login", json={"email": email, "password": password}).raise_for_status()
    return client


api = sign_in(os.environ["API_BASE"], os.environ["API_EMAIL"], os.environ["API_PASSWORD"])
print(api.get("/api/v1/auth/me").json()["user"]["email"])
```

The hook reads the cookie jar on every request, so a renewal (`api.post("/api/v1/auth/refresh")`)
needs nothing else. The 150-second timeout leaves room for the slowest routes, which the server
stops at 120 seconds.

#### Verify

`GET /api/v1/auth/me` answers `200` with your account under `user`, and a write answers
anything but `403 csrf_failed` — for example `404` for a workspace that doesn't exist.

#### When sign-in is refused

| Answer | Why | What to do |
|---|---|---|
| `401` `"Invalid email or password"` | Wrong email or password — or password sign-in is switched off for single sign-on and this account may not use one. The two answers are the same on purpose | Check both. While passwords are off, only system (break-glass) accounts keep a password: ask your administrator before automating with one. Only failures count toward the limit below |
| `429` with `Retry-After` | Too many failed sign-ins for this account in a short time (`RATELIMIT_LOGIN_PER_ACCOUNT`) | Wait the number of seconds in `Retry-After`, then check the password |
| `403` `password_change_required` on every request after sign-in | The account's password is a default, or one an administrator set | Sign in to the app, choose a new password, and give the script that one |
| `403` `csrf_failed` on sign-in | Your client sent an `Origin` or `Referer` that isn't the deployment's own address or in `CORS_ALLOWED_ORIGINS` | Send neither header, as curl and Python do by default |
| Every later request is `401` | Over plain `http`, the cookies are `Secure` and your client drops them | Use `https`. Only a development stack with `AUTH_COOKIE_SECURE=false` works over `http` |

## Find the endpoint you need

The live OpenAPI explorer lists every route with its parameters and request and response
shapes. Where to open it:

| Where you are | Explorer (Swagger UI) | ReDoc | Machine-readable schema |
|---|---|---|---|
| The app's address, through its web proxy | `/viz-docs` | `/viz-redoc` | `/openapi.json` |
| The API service itself — on a development stack, `http://localhost:8000` | `/docs` | `/redoc` | `/openapi.json` |

> **Note:** On the app's address, `/docs` is this documentation, not the explorer — use
> `/viz-docs` there.

> **If you don't see the explorer:** it is switched off when the API runs with `ENV` set to
> `prod` or `production`. `API_DOCS_ENABLED=true` serves it anyway — operators who do that
> should put it behind their own access control. Ask your operator which applies.

The schema is easy to search from a script:

```bash
curl -s "$B/openapi.json" | jq -r '.paths | keys[]' | grep '/versioning/'
```

The schema marks what a key may call. Those operations carry `security` (the `apiKey` bearer
scheme) and `x-api-key`, with how a key is held to what it reaches (`level`) and whether a
read-only key may call it (`readsOnly`). An operation without them answers a key with
`403 api_key_not_allowed`. To list every route a key may call:

```bash
curl -s "$B/openapi.json" | jq -r '.paths | to_entries[] | .key as $p | .value | to_entries[]
  | select(.value["x-api-key"]) | "\(.key | ascii_upcase) \($p)"'
```

For how the routers are grouped and which code owns each, see [Backend](/docs/backend).
Routes the explorer marks **deprecated** still answer, but build nothing new on them.

## Conventions every endpoint follows

### Paths and identifiers

- Everything is under `/api/v1`.
- The data plane is scoped to a workspace: `/api/v1/{ws_id}/graph/…`,
  `/api/v1/{ws_id}/versioning/…`, `/api/v1/{ws_id}/assets/…`. Add `?dataSourceId=ds_…` to choose a data source —
  without it, the workspace's primary data source answers — and `?branchId=…` to read or
  write a draft instead of the published graph.
- Views and layout templates are not workspace-scoped: `/api/v1/views/…`,
  `/api/v1/layout-templates/…`. Administration is under `/api/v1/admin/…`.
- Ids carry a prefix: workspaces `ws_…`, data sources `ds_…`, views `view_…`.
  `GET /api/v1/admin/workspaces` lists the workspaces you belong to, each with its
  `dataSources` — with a key, only those the key reaches, each with only the data sources it
  covers:

  ```bash
  api GET /api/v1/admin/workspaces | jq '.[] | {id, name, dataSources: [.dataSources[] | {id, label, isPrimary}]}'
  ```

- A URN in a path segment must be percent-encoded: URNs hold `/` and `:`, and an encoded
  `%2F` stays inside its segment. `jq` does it for you:

  ```bash
  api GET "/api/v1/$WS/graph/nodes/$(jq -rn --arg u "$URN" '$u|@uri')?dataSourceId=$DS"
  ```

- Some collections end in a slash: `GET /api/v1/views/`. Without it the answer is `307` to the
  slashed path, which curl follows only with `-L` and httpx only with `follow_redirects=True` —
  so write the slash.
- JSON keys are camelCase. A few older answers use snake_case; the explorer shows each
  route's exact shape.
- An id that belongs to a different workspace from the one in the path answers `404`, never
  `403`, so whether it exists never leaks across workspaces.

### Errors

Errors come back as `{"detail": …}`. `detail` is a sentence, a list (for a request that
doesn't match the model, `422`), or an object that names the reason in one of three keys:

| Key | Examples | Who sends it |
|---|---|---|
| `type` | `feature_disabled`, `merge_conflict`, `ontology_violation`, `not_up_to_date`, `graph_too_large_to_sync`, `access_denied` | Feature switches and the versioned graph |
| `code` | `PROVIDER_BUSY`, `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, `REQUEST_TIMEOUT`, `EXPORTS_BUSY`, `busy`, `DB_UNAVAILABLE`, `SEARCH_FAILED`, `CONFLICT`, `VALIDATION` | The graph store's health, timeouts, exports, the database, the feature-switch API |
| `error` | `csrf_failed`, `local_login_disabled`, `session_foreign`, `sso_reauth_required`, `password_change_required`, `missing_permission`, `api_key_expired`, `api_key_out_of_scope`, `rate_limited` | Sign-in and sign-up, the session, permissions and API keys |

A feature an administrator switched off answers the same way everywhere:

```json
{"detail": {"type": "feature_disabled", "feature": "traceEnabled",
            "message": "Lineage tracing is turned off for this deployment. An administrator can enable it under Admin → Features."}}
```

Two answers break the envelope: the retired trace route answers `{"error": {"code", "message",
"details"}}` (below), and a per-address rate limit answers `{"error": "Rate limit exceeded: …"}`.

| Status | Means |
|---|---|
| `400` | A rule of the request broken (a value out of range, an invalid combination) |
| `401` | Not signed in, the session expired — renew and retry — or the API key isn't accepted |
| `403` | Not allowed: a permission your role lacks (`missing_permission`, naming it in `permission`); a feature switched off (`feature_disabled`); the CSRF header missing (`csrf_failed`); a password to change first (`password_change_required`); more than the API key may do (`api_key_…`) |
| `404` | Not found, or in a workspace you can't see |
| `409` | A conflict: someone else changed it first, a draft is behind its published graph, a job is already running |
| `410` | A retired route (below) |
| `413` | The request body is too large |
| `422` | The body doesn't match the model, or breaks a rule of the data (an ontology violation) |
| `429` | Too busy right now, or too many attempts — see below |
| `500` | Something failed on the server. `detail` is a sentence, or a `code`: `SEARCH_FAILED` (a search couldn't finish — narrow it), `GRAPH_QUERY_ERROR` (the graph store refused a query) |
| `503` | A dependency is starting, recovering or out of reach: the graph store, the database, or the store that checks API keys (`api_keys_unavailable`) |
| `504` | The request ran past its time limit — the work may still have happened |

### When the server sheds load

`429`, `503` and `504` are "not now", not "no". When they carry `Retry-After`, wait that many
seconds and send the same request again:

| Answer | `detail.code` | What happened |
|---|---|---|
| `429` | `PROVIDER_BUSY` | The graph store, or your workspace's share of it, is at capacity |
| `429` | `EXPORTS_BUSY` | Every export turn on the server is taken (`Retry-After: 120`) |
| `429` | `busy` | Too many of one kind of slow read on this server at once — activity searches and exports, the API key inventory's export |
| `503` | `PROVIDER_LOADING`, `PROVIDER_FAILING_OVER`, `PROVIDER_UNAVAILABLE` | The graph store is starting, failing over, or not answering |
| `503` | `DB_UNAVAILABLE` | A database or Redis call failed |
| `504` | `REQUEST_TIMEOUT`, `PROVIDER_TIMEOUT` | The request, or one graph query, ran out of time |

Some say why in `detail.error` instead: `429 rate_limited` (an API key's 1,200 requests a minute,
too many bad keys from one address, or too many wrong passwords) and `503 api_keys_unavailable`
(keys can't be checked right now, `Retry-After: 5`). A database error answers `503` with a
sentence in `detail` and no `Retry-After`: wait a few seconds before you retry.

A `429` with no `Retry-After` comes from a per-address limit: back off for a while before you
retry. Never retry a `400`, `403`, `404` or `422` unchanged — it will fail the same way.

> **Warning:** A `504` means the server stopped waiting, not that nothing happened: the write
> may have landed. Read the state again before you send a write a second time.

### Retired routes answer 410

A route that has been retired answers `410 Gone` with RFC 8594 headers: `Sunset` (the
retirement date), `Deprecation: true`, and a `Link` to its successor. Today one route does:
`POST /api/v1/{ws_id}/graph/trace`.

> **Note:** That route's `Link` header and body point at `/api/v2/{ws_id}/graph/trace`, which
> this release does not serve. Use `POST /api/v1/{ws_id}/graph/trace/v2` —
> see [Run a lineage trace](#run-a-lineage-trace).

### Lists and paging

There is no single paging scheme; each route documents its own in the explorer.

- **Offset paging** (`limit`, `offset`) on most lists. `GET /api/v1/views/` answers
  `{items, total, hasMore, nextOffset}`; the versioning lists answer a plain array — stop
  when a page comes back shorter than `limit`. `GET /api/v1/admin/workspaces` sends the total
  in `X-Total-Count` when you pass `limit`.
- **Cursors** on long or changing lists: search hands back `cursor`; an entity's history and a
  graph's commit log hand back `nextBefore` with `hasMore`. Send the value back as-is, and keep
  going while `hasMore` is `true` — a page can be short and still have more. A commit log also
  takes `after`, the newest commit you already have, to fetch only what is new.

### Caching and concurrent edits

- A few frequently polled reads (announcements, the search schema, the graph schema, cached
  statistics) send an `ETag`. Send it back as `If-None-Match` to get `304 Not Modified` when
  nothing changed.
- Writes don't use `If-Match`. Where a write guards against a lost update, the token is in the
  body — `version` on feature switches, `baseVersion` on a graph edit, `expectedVersion` on
  branding — and a stale token answers `409`. Read again, re-apply your change, and retry.

### Request ids, reasons and response headers

- **`X-Request-ID`** names a request. Send your own — up to 128 letters, digits and `._:-` — and
  it is kept, sent back, and recorded in the activity log with whatever the request changed;
  anything else is replaced with one of the server's (`req_…`). Name a scheduled run's requests
  after the run, and you can find them again.
- **`X-Activity-Reason`** says why, on a change: percent-encoded, up to 500 characters, recorded
  with the change in the activity log.
- **Answers carry** `X-Request-ID` and `X-Process-Time`; `X-API-Key-Expires-At` with a key that
  expires, below `400`; `X-Total-Count` on some lists; and `Retry-After` when it matters.
- **A browser app on another origin** (one in `CORS_ALLOWED_ORIGINS`) can read all of them but
  `X-Process-Time`.

### Size and time limits

| Limit | Default | Applies to | Answer when exceeded |
|---|---|---|---|
| Request body | 8 MB (`MAX_REQUEST_BODY_BYTES`) | Most routes | `413` |
| Request body | 100 MB (`MAX_IMPORT_BODY_BYTES`) | Imports, `/versioning/` routes, view-file routes, `/graph/save` | `413` |
| Request body through the web proxy | 100 MB | Every `/api/` route | `413` from the proxy |
| Time | 30 s (`HTTP_TIMEOUT_DEFAULT_SECS`) | Most routes | `504 REQUEST_TIMEOUT` |
| Time | 120 s | `/graph/` routes — trace and search included; the rolled-up edge reads get 90 s — and `/versioning/` and view-transfer routes | `504 REQUEST_TIMEOUT` |

Streamed exports and stored exports' downloads have no time limit. Files larger than 100 MB go
in parts — see [Bulk import and export graph data](#bulk-import-and-export-graph-data). A data
source's refresh signal gets 90 s (`HTTP_TIMEOUT_AGGREGATION_SECS`), time to wait for its
rebuild — see [Tell the platform a data source changed](#tell-the-platform-a-data-source-changed).

## Recipes

Each recipe assumes either curl helper above (`B` and `api`). Set `WS` and `DS` to your workspace
and data source ids first. With an API key, **Needs** applies to whoever the key acts as — you,
or the service account — and the key must allow it too: **Data: read** to read a graph, **Data:
read & write** to change one or signal a data source, **Views: read & write** to change a view.
Searches and traces only read, though they are `POST`s: a read-only key may make them.

### Tell the platform a data source changed

**Needs:** `workspace:datasource:manage` in the data source's workspace — for a service
account, the Workspace member or Data engineer role there.

When something outside {brand} loads data into a graph, the platform notices on its own: a
drift probe reads the graph's counts every minute (`AGGREGATION_PROBE_INTERVAL_SECS`, 60 s by
default) and queues a rebuild of the rollups when they moved. Signal only when you need the
rebuild to start the moment your load finishes.

1. Signal the change, saying why:

   ```bash
   api POST "/api/v1/admin/data-sources/$DS/refresh" -d '{"scope": "auto", "reason": "nightly load finished"}'
   ```

2. Read the answer. `gate` is `changed` when your load moved the graph and a rebuild was
   queued (`jobId`), or `unchanged` when nothing moved — a success, not a failure.

   ```json
   {"scope": "auto", "gate": "changed", "changed": true, "jobId": "agg_…", "deferred": false,
    "actions": ["marker_set", "content_cleared", "stats_nudged", "rebuild_queued"], "eventId": "…"}
   ```

3. Follow the rebuild until `aggregationStatus` is `ready`:

   ```bash
   api GET "/api/v1/admin/data-sources/$DS/readiness" | jq '{aggregationStatus, isReady, driftState}'
   ```

> **Note:** To read the rebuilt graph straight after the signal, send `"wait": "complete"`
> instead of polling. The answer waits up to 60 seconds for the rebuild, and `actions` then ends
> with how it finished — `job:completed`, `job:failed` or `job:cancelled` — or with `job:timeout`
> if it is still running; then poll `/readiness` as in step 3.

Name the run in `X-Request-ID` to find it in the activity log later
([Request ids, reasons and response headers](#request-ids-reasons-and-response-headers)). Leave
`force` off — it queues a rebuild whether or not anything changed, and on a large graph that is
minutes of work for nothing.
The scopes, the batch verbs and how to check a signal worked are in
[Telling us an external data source changed](/docs/feature-external-change-notification).

### Keep a copy of a workspace's graphs and their history

**Needs:** `workspace:datasource:read` in the workspace. With an API key, one that covers the
whole workspace, with **Data: read**.

A workspace's data sources are its graphs. Each is external — loaded and owned elsewhere — or
versioned, with every published change a commit you can read.

1. List them, each with its version control. `providerId=` narrows the list to one provider:

   ```bash
   api GET "/api/v1/admin/workspaces/$WS/data-sources?include=versioning" |
     jq -r '.[] | [.id, .providerId, .graphName, .versioning.enabled, .versioning.graphId // "",
                   .versioning.mainHeadCommitSeq // ""] | @tsv'
   ```

   ```text
   ds_124482eedff6  prov_9f2c1a7d3b44  orders_lineage  true   graph_01M5DQ5P41JQC6HYTWN1YTPWVE  3
   ds_7c0e9a51b2d8  prov_9f2c1a7d3b44  payments        false
   ```

2. For each versioned graph, compare `mainHeadCommitSeq` with the newest `commit_seq` you hold.
   Equal means nothing new.
3. Otherwise read only what is new, newest first, until `hasMore` is `false`:

   ```bash
   api GET "/api/v1/$WS/versioning/graphs/$GID/commits?after=$SEEN&limit=500" |
     jq '{hasMore, nextBefore, commits: [.commits[] | {commit_seq, kind, message, actor, created_at}]}'
   ```

   While `hasMore` is `true`, ask again with `&before=<nextBefore>` added, keeping `after`.
4. Store each commit keyed by `commit_id`, then remember the highest `commit_seq` you stored.
   `after=0` reads the whole history.

What every field means, the kinds of commit, what you can rely on, and a complete Python loop are
in [Graph Metadata & History API](/docs/graph-metadata-api).

### Publish a search and display-rule library

**Needs:** edit access on every target view — you created it, you hold `workspace:view:edit`
in its workspace, or you have an editor grant on it. A dry run needs edit access too.

A library pack (`*.library.json`) carries a view's display rules and saved queries.

1. Export the pack from a view you've set up:

   ```bash
   api GET "/api/v1/views/$VIEW/library/export" -OJ        # saves <view name>.library.json
   ```

2. Dry-run it against the target view. `dryRun` is `true` unless you say otherwise, so this
   changes nothing:

   ```bash
   api POST "/api/v1/views/$TARGET/library/import?strategy=merge" \
       --data-binary @"Data-Lineage.library.json" | jq '{added, skipped, refused, items}'
   ```

3. Read `items`: every rule and query says `add`, `skip` or `refuse`, with the reason.
4. Import for real by sending the same request with `dryRun=false`.

To publish one pack to every view of a data source, the script in the repository lists the
views you can read and imports into each — a dry run unless you pass `--apply`. Run it from a
checkout of the repository; it needs only Python's standard library:

```bash
export SYNODIC_BASE_URL=$B SYNODIC_API_KEY=nxpat_…     # a key that may change views (or a service account's nxsat_…); or SYNODIC_EMAIL, and it asks for the password
python -m backend.scripts.publish_view_library governance.library.json --data-source "$DS"
python -m backend.scripts.publish_view_library governance.library.json --data-source "$DS" --apply
```

The pack format, the strategies (`merge`, `copy`, `replace`) and the script's exit codes are in
[Search & Display Rules: developer reference](/docs/feature-search-and-rules-reference).

### Move views between environments

**Needs:** the **View versions, import and export** switch on in both environments — it ships
off (`viewPortabilityEnabled`). Read access to the views you export; in the target,
`workspace:view:create` in the workspace for a new view, or edit access to update one. An API
key can export (step 1), but not inspect, check or import: in the target, a person signs in with
a password — a service account can't.

A view file (`*.view.json`) carries a view's design — its layers, assignments, rules and
settings — and is checked against the target's graph before anything is written.

1. In the source environment, export the view:

   ```bash
   api POST /api/v1/views/transfer/export -d '{"views": [{"viewId": "view_abc"}]}' -OJ
   ```

   The file is named for the view and its version, such as `finance-lineage.v7.view.json`.
2. Sign in to the target environment, and inspect the file. Nothing is written:

   ```bash
   api POST /api/v1/views/transfer/inspect --data-binary @finance-lineage.v7.view.json > inspect.json
   jq '{integrity, targetSuggestions}' inspect.json
   ```

   `targetSuggestions` ranks the data sources here that the file most likely belongs to.
3. Check the first view against your chosen data source. Nothing is written:

   ```bash
   jq --arg ws "$WS" --arg ds "$DS" '{views: [.views[0] | {
         key: "v1", portableId, definition, viewType: .metadata.viewType, manifest,
         history: [.history[].hash],
         target: {workspaceId: $ws, dataSourceId: $ds}, action: "create"}]}' inspect.json |
     api POST /api/v1/views/transfer/reconcile -d @- > reconcile.json
   jq '.views[0].report.summary | {verdict, verdictReason}' reconcile.json
   ```

   The verdict is `ready`, `attention` (something didn't match — read the report) or
   `blocked` (the view's type isn't enabled here, or it looks like a different graph).
4. Import it as a new view. It arrives **Private** unless you add `visibility` to `metadata`:

   ```bash
   jq -n --arg ws "$WS" --arg ds "$DS" --arg rid "move-$(date +%s)" \
         --slurpfile i inspect.json --slurpfile r reconcile.json '
     ($i[0].views[0]) as $v | {
       action: "create", target: {workspaceId: $ws, dataSourceId: $ds},
       metadata: $v.metadata, definition: $r[0].views[0].effectiveDefinition,
       origin: {portableId: $v.portableId, sourceViewId: $v.sourceViewId, version: $v.version,
                definitionHash: $v.definitionHash, name: $v.metadata.name},
       manifest: $v.manifest, history: $v.history, requestId: $rid}' |
     api POST /api/v1/views/transfer/import -d @- | jq '{integrity}'
   ```

   Keep the `requestId`: sending the same request again returns the first result, so a retry
   never creates a second view.

To update a view that already exists, use `"action": "update"` and `"target": {"viewId": …}`.
The actions, merge strategy, staging into a draft and the limits are in
[View portability](/docs/feature-view-portability).

### Move a layout template between environments

**Needs:** a person's password sign-in in both environments — API keys can't call the template
routes, so a service account can't move one.
Read access to the template; in the target, nothing for a personal template,
`workspace:view:create` in the workspace for a workspace one, `system:templates:manage` for an
organization one.

A template's layout travels in the same file the library's **Export as file** saves, so the result
can also be imported from **Templates → Import**.

1. In the source environment, save the template as a file:

   ```bash
   api GET "/api/v1/layout-templates/$TID" | jq '{format: "layout-template", formatVersion: 1,
       exportedAt: (now | todate), template: {name, description, category, layers}}' \
     > finance-flow.layout-template.json
   ```

2. Sign in to the target environment, and create it there — here as a personal template:

   ```bash
   jq '.template + {visibility: "private"}' finance-flow.layout-template.json |
     api POST /api/v1/layout-templates -d @- | jq '{id, version}'
   ```

   It starts at version 1. To update one you made before instead, send the layers to
   `PUT /api/v1/layout-templates/{id}` with a `changeNote`, and `"notifyUsers": true` to tell the
   people whose views were built from an older version.

### Find views by when they changed and who changed them

**Needs:** only to be signed in. Every answer counts only the views you can open.

1. List the versioned views someone edited since the start of the month:

   ```bash
   api GET "/api/v1/views/?updatedAfter=2026-10-01&contributorIn=$USER_ID&contributorRole=edited&sourceKind=versioned&limit=50" |
     jq '{total, names: [.items[].name]}'
   ```

   - **Dates.** `createdAfter`, `createdBefore`, `updatedAfter` and `updatedBefore` take an ISO
     date (midnight UTC) or date-time. *After* includes its instant; *before* doesn't.
   - **"Updated".** It is a view's last change of any kind: its settings, its layout or its data.
   - **People.** `contributorIn` is repeatable, up to 50 ids. `contributorRole` is `created`,
     `edited` (the view's latest edit) or `published` (whoever last published its data). Leave the
     role out for created or edited.
   - **Kind.** `sourceKind` is `versioned` or `external`. It answers `503` while the version store
     can't be reached; leave it out and the rest still works.

2. Count them without loading the rows; the answer is the list's `total`:

   ```bash
   api GET "/api/v1/views/count?updatedAfter=2026-10-01&sourceKind=versioned"
   ```

3. Ask what each choice would leave. Every facet is counted with all the filters except its own.
   Each facet you ask for costs a query, so ask only for the `fields` you will use:

   ```bash
   api GET "/api/v1/views/facets?updatedAfter=2026-10-01&fields=contributors&fields=tags" | jq '.contributors[:3]'
   ```

4. See when they changed: views per UTC hour over a window of up to 400 days.

   ```bash
   api GET "/api/v1/views/histogram?field=updated&after=2026-07-15T00:00:00Z&before=2026-10-13T00:00:00Z" |
     jq '{total, first: .buckets[0]}'
   ```

   Buckets are labelled `YYYY-MM-DDTHH`; fold them into your own time zone's days. For a time zone
   on the half hour, ask for `grain=10min`.

Each person's saved Explorer filters are at `/api/v1/views/saved-filters`, with a password
session — a key can't call them:

- `GET` lists them and `POST {name, query}` adds one.
- `PUT /order {ids}` reorders them.
- `PUT /{id}` renames one or replaces its query, and `DELETE /{id}` removes it.

A saved filter's `query` is the Explorer's address query, such as `sourceKind=versioned&updated=7d`.

### Bulk import and export graph data

**Needs:** version control on for the data source, and the **Version control** switch on
(`versioningEnabled`). Importing needs `workspace:datasource:manage`; exporting needs
`workspace:datasource:read` and the **Export graph data** switch on (`graphExportEnabled`).

An import never writes to the published graph: it lands in a draft, which you review and
publish.

1. Find the data source's versioned graph:

   ```bash
   GID=$(api GET "/api/v1/$WS/versioning/resolve?dataSourceId=$DS" | jq -r .graphId)
   ```

   A `404` means version control isn't on for this data source. A `bootstrap` object in the
   answer means it is still being turned on (its `status` is `pending`, `running`,
   `needs_decision` or `failed`): wait until `bootstrap` is `null`.
2. For a file up to 100 MB, send it as the request body. The answer is `202` with the import
   job and the draft it writes to:

   ```bash
   api POST "/api/v1/$WS/versioning/graphs/$GID/imports?format=ndjson&reconcileMode=upsert" \
       --data-binary @lineage.ndjson | jq '{jobId, branchId, status}'
   ```

   `format` is `ndjson`, `csv`, `tsv`, `json` or `xlsx`. `reconcileMode=replace` also deletes
   everything in scope that the file doesn't mention. `viewId=` places what the import creates
   in that view's layout, so it needs edit access to the view too — with a key, **Views: read &
   write**.

   An `idempotencyKey` makes the request safe to send again: the same key from you answers with
   the import it started — and if the first request failed before its file arrived, takes this
   one's file and starts it. A key you used for an export answers `409 idempotency_key_reused`.
3. For a larger file — up to 10 GiB as NDJSON, CSV or TSV; JSON and Excel files stay at
   100 MB — send it in parts instead. Ask for an upload, send each part (numbered from `0`),
   then complete it:

   ```bash
   SIZE=$(wc -c < lineage.ndjson)
   UP=$(api POST "/api/v1/$WS/versioning/graphs/$GID/imports/uploads" \
            -d "{\"fileName\": \"lineage.ndjson\", \"size\": $SIZE, \"format\": \"ndjson\"}")
   ID=$(jq -r .uploadId <<<"$UP"); PART=$(jq -r .partBytes <<<"$UP"); PARTS=$(jq -r .parts <<<"$UP")
   for ((n = 0; n < PARTS; n++)); do
     (( n > 0 && n % 20 == 0 )) && api POST /api/v1/auth/refresh -o /dev/null   # a password session: stay signed in
     dd if=lineage.ndjson bs="$PART" skip="$n" count=1 2>/dev/null |
       api PUT "/api/v1/$WS/versioning/graphs/$GID/imports/uploads/$ID/parts/$n" --data-binary @- -o /dev/null
   done
   api POST "/api/v1/$WS/versioning/graphs/$GID/imports/uploads/$ID/complete?reconcileMode=upsert" | jq .
   ```

   If the loop stops, `GET …/imports/uploads/$ID` lists the parts already `received`; send
   the others and complete. An upload has a day to finish.
4. Poll the job until `status` is `completed` (or `failed`, with `errorMessage`):

   ```bash
   api GET "/api/v1/$WS/versioning/graphs/$GID/imports/$JOB" | jq '{status, summary, errorMessage}'
   ```

5. Review the draft (`branchId` from step 2), then publish it:

   ```bash
   api POST "/api/v1/$WS/versioning/graphs/$GID/branches/$BRANCH/publish" -d '{"message": "Nightly import"}'
   ```

   A `409 not_up_to_date` means the published graph moved since the draft began: pull the
   latest in with `POST …/branches/$BRANCH/rebase` (body `{}`), then publish again. A draft
   that changes more than 20,000 entities publishes as a job: the answer is `202` with a
   `jobId` to poll at `GET …/graphs/$GID/publish-jobs/$JOB`.

To export, ask the workers to write the file, then download it — the download resumes:

```bash
JOB=$(api POST "/api/v1/$WS/versioning/graphs/$GID/exports?format=ndjson" | jq -r .jobId)
api GET "/api/v1/$WS/versioning/graphs/$GID/exports/$JOB" | jq '{status, summary}'   # until "completed"
api GET "/api/v1/$WS/versioning/graphs/$GID/exports/$JOB/download" -C - -o lineage-export.ndjson
```

`-C -` makes curl send a `Range` for what it already has, so an interrupted download carries
on where it stopped. A finished export is kept for a day. For a data source without version
control, stream it instead: `GET /api/v1/$WS/graph/export/stream?dataSourceId=$DS&format=ndjson`
(this one doesn't resume). The formats, columns and limits are in
[Import / Export](/docs/versioning-import-export).

### Run a lineage trace

**Needs:** `workspace:datasource:read` in the workspace — or a view you can read, passed as
`?viewId=` — and the **Lineage trace** switch on (`traceEnabled`). With a key, **Data: read**
is enough.

1. Find the entity's URN. A free-text search returns matching nodes:

   ```bash
   api POST "/api/v1/$WS/graph/search?dataSourceId=$DS" -d '{"query": "orders", "limit": 5}' |
     jq -r '.[] | [.urn, .entityType, .displayName] | @tsv'
   ```

2. Trace it. Only `urn` is required; this asks for five hops downstream, rolled up to the
   level of the `dataset` entity type:

   ```bash
   api POST "/api/v1/$WS/graph/trace/v2?dataSourceId=$DS" -d '{
     "urn": "urn:li:dataset:orders", "direction": "downstream",
     "downstreamDepth": 5, "level": "dataset"}' > trace.json
   jq '{focus, effectiveLevel, nodes: (.nodes | length), downstream: (.downstreamUrns | length),
        truncated, truncationReason}' trace.json
   ```

3. Read the answer:

   | Field | What it holds |
   |---|---|
   | `nodes` | Every entity in the trace, plus each one's containment ancestors up to the top level |
   | `edges` | The lineage between them: `AGGREGATED` rollup edges at the level you asked for (`properties.weight` counts the underlying edges, `properties.sourceEdgeTypes` names their types), or the raw lineage type at the finest level |
   | `containmentEdges` | The parent → child edges that place each node |
   | `upstreamUrns`, `downstreamUrns` | Which nodes are on which side of the focus |
   | `focus` | `{urn, level, entityType}` of the node you traced |
   | `truncated`, `truncationReason` | `true` when a cap stopped the walk, with why (`max_nodes`, `timeout`, `degree_cap`, …) |

   A cap never fails a trace: it answers `200` with what it found and marks it `truncated`.
   The caps are server settings: `TRACE_MAX_NODES` (2,000 nodes) and `TRACE_TIMEOUT_SECS`
   (120 seconds).
4. To drill into a rolled-up edge, send its two ends to `POST …/graph/trace/expand` with
   `{"sourceUrn", "targetUrn", "nextLevel"}`, or many at once to `POST …/graph/trace/expand-batch`
   with `{"pairs": [{"sourceUrn", "targetUrn", "nextLevel"}, …]}`.

| If you want | Use | Because |
|---|---|---|
| Lineage at one level of the hierarchy (domains, datasets, …) | `trace/v2` with `level` | It reads the rollups, so its cost follows the answer's size, not the graph's |
| Exact lineage at the finest grain, page by page | `trace/closure` | It walks raw lineage edges from the focus, at most 25 hops per request, and hands back where to continue (`frontierUp`, `frontierDown`, `seedCursor`) |
| What a draft would change | Either, with `&branchId=…` | Both read the draft instead of the published graph |

`level` takes `0` (the top of the hierarchy — the default), another level number, or an
entity type id such as `"dataset"`. The full request models are in the explorer under
`graph:workspace`.

### Integrate single sign-on over a back channel

**For:** the team that owns your organisation's sign-in service.

In a back-channel (**Enterprise gateway**) sign-in, {brand} never receives an assertion about
the person. It receives an opaque handle, and its server asks your gateway who the handle
belongs to — at sign-in, and again at every session renewal.

1. **Expose a redeem endpoint** (leg 1). It takes the handle — as a cookie, a header or a JSON
   body field, by `GET` or `POST` — and answers with a token in its JSON. The operator
   configures where each piece sits; you don't need to change your format.
2. **Answer `401` or `403` only when the session is over.** On those two, {brand} ends the
   person's session at once. Anything else — a `5xx`, a timeout — counts as an outage: the
   session carries on for a grace period the operator sets on the connection (15 minutes by
   default), measured from your last real answer. So a `500` for an invalid session only
   delays the sign-out, while a `401` during an outage signs everybody out as their sessions
   renew.
3. **Expose a user endpoint** (leg 2) that takes the token and answers the person's details:
   a stable subject id and an email are required; names, groups, the authentication instant
   and a picture URL are optional. Skip this leg if leg 1 already answers the details.
4. **Offer a validate-only endpoint if you have one.** Every renewal re-checks the session, and
   a check that doesn't mint a new token is cheaper for you.
5. **Meet the transport rules:** TLS that validates, no redirects (a `3xx` is an error, never
   followed), and an answer within the configured timeout.
6. **Hand the shape to your operator.** They allow your host and port under
   **Administration → SSO → Settings → Internal gateways SSO may call**, add an
   **Enterprise gateway** connection, and **Rehearse** a sign-in before publishing it.

The full contract — the optional browser-side first call, each leg's request and response, and
what {brand} never does with your tokens — is in
[Back-channel SSO integration contract](/docs/sso-backchannel-contract). The operator's side is
in [Single Sign-On](/guide/sso-setup).

## If it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Every write answers `403` `csrf_failed` | The `X-CSRF-Token` header is missing, or holds an old value after a renewal. With an API key: the request carries an `Origin` or `Referer` from another site | Read `nx_csrf` again before every write, as the helpers above do. With a key, send neither header |
| `401` `api_key_expired`, `api_key_revoked` or `invalid_api_key` | The key is past its expiry, revoked, or not copied in full | Find it on **Account → API keys** by its first characters: rotate an expired key, create a new one for a revoked key |
| `401` `owner_reauth_required` | The key is paused: its owner hasn't signed in through the identity provider for a while | Sign in to the app once; the key resumes |
| `401` `api_key_unmanaged` | A service account's key is paused: nobody has managed the account for longer than the grace period | Ask an administrator to appoint a manager; the key resumes at once |
| `401` `api_key_owner_inactive` | The person the key acts as is suspended, or the service account is disabled | Ask an administrator to reactivate them; ask the account's managers to enable it — or an administrator, if one disabled it |
| `401` `api_key_ip_not_allowed` | The request came from an address outside the key's networks | Run it from one of them. Behind a proxy, the deployment must trust the proxy's address: [Network limits behind a proxy](/guide/api-keys#network-limits-behind-a-proxy) |
| `401` `api_keys_disabled` | An administrator switched API keys off | Ask them; until then, a person signs in with a password |
| `403` `api_key_not_allowed` | The route can't be called with a key — people and access, sharing, settings and switches, layout templates, saved filters, importing a view file | A person signs in with a password for it; a service account can't |
| `403` `api_key_cannot_publish` | A key without **Publish** tried to create a view straight onto the enterprise tier | Create it private or workspace-wide, or use a key that may publish |
| `403` `missing_permission` | The request needs the permission named in `permission`: whoever it acts as — you, or the service account — lacks it, or the key wasn't given it | Use a key that allows it, or ask a workspace admin for a role that holds it; a service account's roles are on its page |
| `403` with `"type": "access_denied"` on a pull request | A service account can't approve one or be named its reviewer, and nobody approves one opened through a service account they manage | A person who doesn't manage the account reviews and approves it |
| `403` `api_key_out_of_scope` | The request reaches past what the key was limited to — or a key limited to data sources didn't name one | Pass `?dataSourceId=`, or use a key that reaches it |
| `403` `api_key_read_only` | A read-only key asked to change something | Use a key with read & write |
| Requests work, then all answer `401` | The access cookie expired | Renew with `POST /api/v1/auth/refresh` and retry; sign in again if the renewal is refused too |
| `401` with `{"error": "session_foreign"}` | The cookies belong to another environment or signing key | Start a new cookie jar and sign in again |
| `403` `feature_disabled` | An administrator switched the feature off | Ask them, or see [Feature Switches API](/docs/api-features) for which switch |
| `404` for something you can see in the app | Wrong workspace, data source or id in the path, or a URN not percent-encoded | Check the ids with `GET /api/v1/admin/workspaces`; encode URNs |
| `410` on `POST …/graph/trace` | The route is retired | Use `POST …/graph/trace/v2` |
| `413` | The body is larger than the route accepts | For imports, send the file in parts |
| `429` `rate_limited` with a key | More than 1,200 requests a minute with one key, or 120 bad keys a minute from one address | Wait `Retry-After` seconds, then spread your requests out |
| `503` `api_keys_unavailable` | Keys can't be checked right now — or authorization enforcement is switched off, which stops every key until it's back on | Retry after `Retry-After`; if it lasts, tell your operator |
| `429` or `503` repeating | The graph store is busy or recovering | Honour `Retry-After`, and spread your requests out |
| `504` `REQUEST_TIMEOUT` | The request needed more than its time limit | Narrow it (fewer hops, a smaller scope), or use the paged or job-based variant. Check whether a write landed before you send it again |

## Where in the code

| Concern | File | Symbol |
|---|---|---|
| Sign-in, renewal, sign-out | `backend/auth_service/api/router.py` | `login`, `refresh`, `logout`, `me` |
| Cookie names and the environment suffix | `backend/auth_service/cookies.py` | `ACCESS_COOKIE_NAME`, `CSRF_COOKIE_NAME`, `_scoped` |
| CSRF and origin checks | `backend/auth_service/csrf.py` | `CSRFMiddleware` |
| API keys on a request: checks, scope fence | `backend/app/auth/api_key_auth.py` | `authenticate` (any key, for the routes that describe or end it), `acting` (a key that works, for everything else), `_REFUSALS` |
| Which routes a key may call | `backend/app/auth/api_key_surface.py` | `SURFACE` |
| Every key route, and who may make a service account's keys | [Key Management API](/docs/key-management-api#where-the-code-lives) | — |
| Session lifetimes and sign-in and key limits | `backend/auth_service/core/config.py` | `JWT_EXPIRY_MINUTES`, `SESSION_ABSOLUTE_MAX_HOURS`, `RATELIMIT_LOGIN_PER_ACCOUNT`, `RATELIMIT_API_KEY`, `RATELIMIT_API_KEY_FAILURES_PER_IP` |
| Request ids and stated reasons | `backend/app/middleware/request_id.py`, `backend/app/common/activity_context.py` | `RequestIdMiddleware`, `valid_correlation_id`, `parse_stated_reason` |
| The expiry header on a key's answers | `backend/app/middleware/logging.py` | `_api_key_fields` |
| Router mounts and URL prefixes | `backend/app/api/v1/api.py` | `api_router` |
| Explorer switch, error handlers, body and time limits, the headers a browser may read | `backend/app/main.py` | `_DOCS_ENABLED`, `_feature_disabled_handler`, `_provider_busy_handler`, `_db_error_handler`, `_BodySizeLimitMiddleware`, `_TimeoutMiddleware`, `CORSMiddleware` |
| Explorer paths behind the web proxy | `frontend/nginx.conf` | `location = /viz-docs`, `location = /openapi.json` |
| Trace routes and the retired route | `backend/app/api/v1/endpoints/graph.py` | `trace_v2`, `trace_closure`, `trace_expand`, `trace_expand_batch`, `get_lineage_trace_deprecated` |
| Trace request and answer | `backend/common/models/graph.py` | `TraceRequest`, `TraceClosureRequest`, `ExpandRequest`, `TraceResult` |
| Refresh signal | `backend/app/api/v1/endpoints/freshness.py` | `refresh_data_source` |
| A workspace's data sources, with their version control | `backend/app/api/v1/endpoints/workspaces.py`, `backend/app/services/versioning/service.py` | `list_data_sources`, `GraphVersioningService.main_heads` |
| A graph's commit log | `backend/app/api/v1/endpoints/versioning.py` | `get_commit_log`, `CommitLogEntry` |
| Imports, uploads, exports, publish | `backend/app/api/v1/endpoints/versioning.py` | `create_import`, `create_import_upload`, `create_export`, `download_export`, `publish` |
| View files | `backend/app/api/v1/endpoints/view_transfer.py` | `export_view_file`, `inspect_view_file`, `reconcile_view_file`, `import_view_file` |
| Library packs | `backend/app/api/v1/endpoints/views.py`, `backend/scripts/publish_view_library.py` | `import_view_library`, `main` |
| Back-channel SSO | `backend/auth_service/providers/backchannel.py` | `_AUTHORITATIVE_REJECTIONS` |

## Where to next

- [Integration Quickstart](/docs/integration-quickstart) — a key, your first calls and every
  answer, in order.
- [Key Management API](/docs/key-management-api) — when you manage keys from a script, or a
  service account's keys.
- [Search & Display Rules: developer reference](/docs/feature-search-and-rules-reference) — when
  you want to search a view or keep display rules in step from a script.
- [Versioning API reference](/docs/versioning-api-reference) — when you need every draft,
  publish, history and import route.
- [Feature Switches API](/docs/api-features) — when an endpoint answers `feature_disabled`.
- [Onboarding a Data Source](/docs/onboarding-a-source) — when the data your script reads
  isn't in {brand} yet.
