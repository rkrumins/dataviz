# Search & Display Rules: developer reference

Everything a script, an integration or an AI agent needs to search a View,
keep searches and display rules in a View's library, and move that library
between Views: the query model, every endpoint with its permissions and errors,
the library pack format, and ready-to-run recipes.

The user guides are [Advanced Search](/guide/advanced-search) and
[Display Rules](/guide/display-rules). How the search service is built — the
validate → scope → execute pipeline and its configuration — is in
[Search: Deep & Advanced](/docs/services-search).

**This page covers:**

- The **objects**: queries, saved queries, display rules, library packs
- **Signing in from a script** (cookie session + CSRF — there are no API tokens)
- The **query model**: predicates, operators, scope, options, responses
- Every **search endpoint** and every **view library endpoint**, with RBAC and errors
- The **library pack format**, a hand-authored pack, and its JSON Schema
- **Recipes**: curl, building a pack, dry-run → apply, publishing to every View of a data source
- What is **not supported**

---

## The objects

| Object | What it is | Where it lives | Scope |
| --- | --- | --- | --- |
| **SearchQuery** | A request: `{predicate, scope, options}` | Sent to `POST /search/advanced`; never stored | One View (`scope.viewId` is required) |
| **Predicate** | The filter tree inside a query, a saved query or a rule | — | — |
| **Saved query** | A predicate kept under a name for everyone who opens the View | Postgres `view_saved_queries` | The View (not a branch) |
| **Display rule** | A label, colour and icon on every entity a predicate matches | The View's config (`layout.referenceLayout.displayRules`), or a draft's layout overlay | The View, per branch |
| **Library pack** | A View's rules and saved queries as a file (`*.library.json`) | A file | Moves between Views |
| **"Mine" searches** | A user's recent, pinned and named searches | Browser `localStorage` (`synodic.advancedSearch.recent.v1`) | One browser — no API |
| **Templates** | Built-in starting queries | Frontend code (`searchTemplates.ts`) | Everywhere — no API |

The same predicate model serves search, saved queries and display rules, so a
predicate that works in one works in the others (display rules have a few more
restrictions, [below](#what-a-rules-predicate-may-not-use)).

---

## Signing in from a script

{brand}'s API authenticates with a **cookie session**. There are no API keys,
bearer tokens or service accounts.

1. `POST /api/v1/auth/login` with `{"email": …, "password": …}` sets the
   session cookies: `nx_access` (HttpOnly), `nx_refresh`, `nx_access_exp` and
   `nx_csrf`. Where the deployment sets `AUTH_ENVIRONMENT_ID`, each name
   carries it as a suffix (`nx_csrf_uat`).
2. Send the cookies back on every request.
3. On every `POST`, `PUT`, `PATCH` and `DELETE`, send the header
   **`X-CSRF-Token`** with the `nx_csrf` cookie's value. Without it the answer
   is `403` with `{"detail": {"error": "csrf_failed", …}}`.

A client that sends no `Origin` or `Referer` header — curl, Python — passes the
origin check. Repeated wrong passwords answer `429` with `Retry-After`. Where
password sign-in is switched off for single sign-on, login answers `403`
`local_login_disabled` for every account except system accounts.

```bash
B=http://localhost:8000
JAR=$(mktemp)
curl -sc "$JAR" -X POST "$B/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$SYNODIC_EMAIL\",\"password\":\"$SYNODIC_PASSWORD\"}" >/dev/null
CSRF=$(awk '/nx_csrf/{print $7}' "$JAR")
auth=(-b "$JAR" -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json')
```

(The same pattern as [Integration Testing](/docs/integration-testing).)

---

## The query

### Shape

```json
{
  "predicate": {"kind": "group", "op": "and", "children": [
    {"kind": "entityType", "op": "in", "values": ["dataset"]},
    {"kind": "tag", "op": "hasAny", "values": ["PII"]}
  ]},
  "scope": {"viewId": "view_abc", "scopeMode": "view"},
  "options": {"results": "both", "pageSize": 100, "includeAncestorPath": true,
              "aggregations": [{"by": "entityType", "maxBuckets": 50}]}
}
```

Keys are camelCase (snake_case is accepted too); unknown keys are ignored.
`$schemaVersion` defaults to `"1"`.

> **Important:** Send a **group** at the root, as the panel does — wrap a
> single condition as `{"kind": "group", "op": "and", "children": [ … ]}`.
> Display rules are wrapped this way before they are counted or matched.

### Predicates

`kind` picks the predicate. There are 17 node predicates:

| `kind` | Fields (defaults) | Limits | Matches |
| --- | --- | --- | --- |
| `text` | `value`, `target` (`any`), `match` (`substring`), `propertyKey`, `caseSensitive` (false) | value 1–512 chars | Text in a field (targets below) |
| `property` | `key`, `op` (`eq`), `value`, `valueType` (`auto`), `caseSensitive` (false), `includeMissing` (false) | key 1–128 chars | A typed comparison ([operators](#property-operators)) |
| `tag` | `op`: `has` · `hasAll` · `hasAny` · `notHas` (`has`), `values` | 1–32 values | Tags, exactly. `has`/`hasAny`: any of them; `hasAll`: every one; `notHas`: none |
| `hasProperty` | `key`, `negate` (false), `keyMatch`: `exact` · `prefix` · `contains` (`exact`) | key 1–128 | The property is present — by its exact name, or (`prefix`, `contains`) by part of its name, ignoring case |
| `all` | — | — | Every entity in scope (an empty group is refused; ask for everything with this) |
| `entityType` | `op`: `in` · `notIn` (`in`), `values` | 1–32 values | The entity's type |
| `descendantOf` | `urns`, `maxDepth` | 1–64 urns; depth 1–20 | Inside those containers |
| `withinHops` | `urns`, `hops`, `direction`: `out` · `in` · `both` (`both`), `edgeClass` (`lineage`), `edgeTypes`, `edgePredicate` | 1–64 urns; hops 1–10 | Within N hops of those entities |
| `path` | `sourceUrns`, `targetUrns`, `direction`: `outgoing` · `incoming` · `any` (`outgoing`), `edgeClass` (`lineage`), `edgeTypes`, `maxHops` (4), `maxPaths` (32), `edgePredicate` | 1–8 urns each; hops 1–6; paths 1–128 | Paths between them (`results: "paths"`) |
| `degree` | `direction`: `in` · `out` · `both` (`both`), `op`: `eq` · `neq` · `gt` · `gte` · `lt` · `lte` (`eq`), `value`, `edgeClass` (`lineage`), `edgeTypes` | value 0–1,000,000; 1–32 edge types | The number of edges |
| `isOrphan` | `edgeClass` (`lineage`), `edgeTypes` | | No edges of the class (degree both = 0) |
| `isRoot` | same | | No incoming edges (in = 0) — "no upstream" |
| `isLeaf` | same | | No outgoing edges (out = 0) — "no downstream" |
| `hasIncoming` | same | | At least one incoming edge |
| `hasOutgoing` | same | | At least one outgoing edge |
| `layer` | `layerAssignment` | | *Legacy*: the node's stored `layerAssignment` property, not the View's layers. Use `descendantOf` for "inside this layer's roots" |
| `group` | `op`: `and` · `or` · `not` (`and`), `children` | 1–128 children (service caps below) | A boolean combination |

`edgeClass` is `lineage`, `containment` or `any`; it resolves to edge types
from the data source's ontology. `edgeTypes` names types explicitly instead.

Inside `withinHops` and `path`, `edgePredicate` filters every traversed edge
with 3 edge predicates:

| `kind` | Fields |
| --- | --- |
| `edgeProperty` | `key`, `op`, `value`, `valueType`, `caseSensitive`, `includeMissing` — as `property` |
| `edgeHasProperty` | `key`, `negate` |
| `edgeGroup` | `op`: `and` · `or` · `not`, `children` (1–32) |

**Text targets**: `name` (display name or qualified name), `qualifiedName`,
`description`, `tags`, `property` (with `propertyKey`), `any` (the entity's
searchable text, name and qualified name). The display name is the one the
canvas shows: `displayName`, or — for an entity without one, as in a graph
{brand} did not write — the data source's display-name property (**Node
Identity & Display Name**; `nameProperty` on the data source, provider,
workspace or platform), then `name`, `title` or `label`. **Match modes**: `substring`,
`prefix`, `suffix`, `exact`. `fulltext` and `regex` are part of the model but
refused (`400`).

### Property operators

19 operators. What each one takes and compares as is defined once in
`backend/common/search_semantics.py` and exported to
`backend/common/schema/searchoperators.v1.json`.

| `op` | `value` | Compares as | Notes |
| --- | --- | --- | --- |
| `eq` · `neq` | one value | string, number, boolean, date | `neq` is negative |
| `gt` · `gte` · `lt` · `lte` | one value | number, date, string | |
| `between` | `[low, high]` | number, date, string | Both ends included; swapped if reversed |
| `in` · `notIn` | a list | string, number, boolean | "is one of" / "is none of"; `notIn` is negative |
| `containsAll` | a list | string, number, boolean | A list property holding every value |
| `contains` · `notContains` · `startsWith` · `endsWith` | one value | string | `notContains` is negative |
| `withinLast` | an ISO-8601 duration: `P30D`, `P2W`, `P6M`, `P1Y`, `PT12H` | date | Relative to now; a time part compares to the second, else to the day |
| `isSet` · `isNotSet` | none | — | The key is present / absent |
| `isEmpty` · `isNotEmpty` | none | — | Missing, blank text or an empty list / anything else |

**`valueType`**: `auto` (default), `string`, `number`, `boolean`, `date`.
Under `number` a stored `"15"` is 15; under `string` a stored 15 is `"15"`.
`auto` compares booleans as booleans, numbers as numbers, and lets ordering
operators read numeric or ISO text as a number or date. Send an integer above
2^53 as its digits in a string with `valueType: "number"` — it is compared
exactly. Dates compare at the grain you give (`2026-05-01` compares days).

**Lists** match when any element does (a negative operator: when none does).
**Missing keys**: a negative operator (`neq`, `notIn`, `notContains`) leaves out
entities without the key unless `includeMissing` is true, whereas a `not` group
includes them — `not(owner = "alice")` matches entities with no owner, `owner
neq "alice"` does not. A value that can't be compared as asked is a `400` in
plain words ("between needs a lower and an upper value", "give a duration like
P30D").

### Tree rules and limits

| Rule | Default | Setting |
| --- | --- | --- |
| Depth (each group and leaf is a level) | 6 | `DEEP_SEARCH_MAX_TREE_DEPTH` |
| Leaves in the whole tree | 64 | `DEEP_SEARCH_MAX_LEAF_COUNT` |
| Children of one `or` group | 24 | `DEEP_SEARCH_MAX_OR_BRANCH` |
| A `not` group | exactly one child | — |
| `descendantOf`, `withinHops`, `path` | only in the top-level AND (never under `or` / `not`); one `path` per query | — |
| A query of only `text` with `target: "any"` | refused on a View that bounds neither its roots nor its entity types | — |

Breaking a rule is a `400` naming where (`$.children[2]`).

### Scope

| Field | Default | Notes |
| --- | --- | --- |
| `viewId` | **required** | Every search is bound to a View |
| `scopeMode` | `view` | `view`: the View's roots and everything below them. `visible`: only `visibleUrns`. `data_source`: the whole data source, past the View's boundary |
| `visibleUrns` | — | Up to 20,000; required for `visible` |
| `rootUrns` | — | Narrow to these containers. Up to 5,000 (`DEEP_SEARCH_SCOPE_ROOT_URNS_CAP`). URNs outside the View are dropped (`X-Search-Dropped-URNs`); when all are, the answer is empty |
| `maxDepth` | 12 | 1–20, and never deeper than the View's own |
| `entityTypes` | — | Up to 512, each one the View shows (else `400`) |
| `layerAssignment` | — | Accepted, not applied |

The server resolves the View's boundary itself and never takes it from the
request. The View must belong to the data source being searched, or the answer
is `400` "This view belongs to a different data source than the one being
searched."

### Options

| Field | Default | Range / values |
| --- | --- | --- |
| `results` | `aggregates` | `aggregates` · `hits` · `both` · `paths`. **The default returns no hits** — set `hits` or `both` |
| `aggregations` | — | A list of facets (below) |
| `pageSize` | 50 | 1–5,000 |
| `cursor` | — | From the previous page |
| `sort` | `relevance` | `relevance` · `displayName` · `qualifiedName` · `depth` · `matchCount` |
| `sortProperty` | — | Order by this property instead |
| `sortDir` | `desc` | `asc` · `desc` |
| `includeAncestorPath` | false | Each hit's containers, root first |
| `highlights` | true | Where the text matched |
| `softDeadlineMs` | 60,000 | 200–120,000. On expiry: what was found, with `deadlineExceeded: true` |
| `candidateCap` | 10,000 (`DEEP_SEARCH_CANDIDATE_CAP`) | 100–100,000. Bounds aggregate-only searches and facets; hits are never capped |
| `waitMs` | — | 0–120,000. Progressive: answer after this long with `status: "running"` |
| `sessionId` | — | Continue a running search |

**Aggregations** (`AggregationSpec`): `by` is `ancestorType` (needs
`ancestorEntityTypes`, up to 16), `ancestorLevel` (needs `ancestorLevel`,
0–20), `ancestor` (every container, with `typeCounts`), `parent`, `tag`,
`entityType` or `property` (needs `propertyKey`); `maxBuckets` 1–20,000
(default 50); `sampleHitsPerBucket` 0–20 (default 3). `subAggregation` is
refused (`400`).

**Which engine runs it.** With the default `DEEP_SEARCH_ENGINE=v2`, a search
that returns hits (`hits` or `both`, no `path`) runs on the uncapped engine:
every match is found and counted exactly, however many, and `candidateCap`
applies only to facets. `aggregates` and `paths` run on the capped engine.

**Paging and progress.** Repeat the same query with `options.cursor` set to the
last answer's `cursor` for the next page. With `waitMs` (the panel sends 800),
the first answer comes early with `status: "running"` and `progress`; repeat
the same query with `options.sessionId` until `status` is `complete`. One
request runs for at most about 100 s on the server; a longer scan answers with
what it has and a `sessionId` to continue from.

### The response

`SearchResultPage`:

| Field | Meaning |
| --- | --- |
| `hits` | `[{node, score, matchedPredicates, highlights, ancestorPath}]` in the **server's order** — don't re-sort by `score` |
| `aggregates` | One bucket list per requested aggregation: `{ancestorUrn, ancestorDisplayName, ancestorEntityType, ancestorDepthFromScopeRoot, matchCount, typeCounts, sampleHits}` |
| `paths` | `[{nodes: [{urn, displayName, entityType}], edges: [{sourceUrn, targetUrn, edgeType, properties}], hopCount}]` |
| `cursor` | The next page, when there is one |
| `totalCount` | Exact matches in scope; `null` while unknown |
| `candidateCount` · `countStatus` | Matches found; `exact` or `lowerBound` |
| `status` · `progress` · `sessionId` | `running` / `complete`, `{scanned, total, matched}`, the session to continue |
| `truncated` · `deadlineExceeded` | The answer stopped short |
| `elapsedMs` · `cacheHit` · `dataVersion` · `stale` | Timing, and which graph data it read (`stale`: the data changed since the session began) |
| `scopeDiagnostics` | What the server applied: `effectiveRootUrns`, `effectiveMaxDepth`, `effectiveEntityTypes`, `droppedRootUrns`, `lineageEdgeTypes`, `containmentEdgeTypes`, `notes` |

Headers: `X-Search-Scope-Hash`, and `X-Search-Dropped-URNs` when root URNs
were dropped. A search on a draft reads the published graph and says so in
`scopeDiagnostics.notes`.

---

## Search endpoints

All under `/api/v1/{ws_id}/graph`. Every route needs a signed-in user with
`workspace:datasource:read` in the workspace, **or** a `?viewId=` the user can
read (a share link — pinned to that View's data source, `view` scope only).
Optional query parameters on each: `dataSourceId` (default: the workspace's
primary data source; one outside the workspace is `404`) and `branchId`.

| Method · path | Body → answer | Notes |
| --- | --- | --- |
| `POST /search/advanced` | `SearchQuery` → `SearchResultPage` | The search |
| `POST /search/explain` | `SearchQuery` → `{cypher, hits_cypher, params, candidate_cap, hoisted_root_urns, effective_root_urns, notes, resolvedScope}` | Compiles without running |
| `GET /search/schema` | → the `SearchQuery` JSON Schema | `ETag`, `X-Schema-Version`; cached 5 min |
| `GET /search/discover?samplePerLabel=` | → `{labels, tagValues, edges, blobOnlyLabels, missingContainment, missingSearchableText, elapsedMs}` | Samples 1–2,000 (default 200) nodes per type. Not for share links |
| `GET /search/values?viewId=&key=&q=&limit=` | → `{key, values: [{value, count}], complete, truncated, elapsedMs}` | A property's most common values in the View; `limit` 1–50 (25); about 1.5 s. Not for share links |
| `POST /search/membership` | `{scope, items: [{id, predicate}], urns}` → `{matches: {id: [urn]}, errors: {id: why}, dataVersion, elapsedMs}` | Which of these entities (≤ 1,000) match which rules (≤ 32). What display-rule chips use |
| `POST /search/counts` | `{scope, items, waitMs, sessions}` → `{counts: {id: {count, status, sessionId, progress, error}}, dataVersion, elapsedMs}` | Exact matches per rule (≤ 32). Repeat with `sessions` until each is `complete`; a request works for at most 5 s whatever `waitMs` (0–60,000, default 1,000) says |
| `POST /search/catalog` | `{scope, waitMs, sessionId, refresh}` → every property of the View's entities, exactly | Repeat with `sessionId` until `complete` |
| `POST /search/ancestor-counts` | `{scope, sessionId, urns}` → `{counts: {urn: {count, typeCounts, displayName, entityType}}, status}` | Matches inside each container (≤ 2,000), from a search's session. `expired`: run the search again |
| `POST /search/exports` | `{scope, predicate, format: csv\|ndjson, columns, waitMs, sessionId}` → `{sessionId, status, rows, progress, format, columns, filename, downloadToken}` | Every match to a file; ≤ 200 property columns. Repeat until `complete`. Needs the **Export graph data** feature |
| `GET /search/exports/{sessionId}/download?token=` | → the file | For the user who exported it, for an hour |
| `POST /search` | `{query, limit, offset}` → nodes | Legacy free-text search |

**Errors**

| Status | When |
| --- | --- |
| `400` | A rule of the query broken (caps, types, values, placement, `fulltext`/`regex`, `subAggregation`), an unbounded text-only query, a View of another data source, an entity type the View doesn't show |
| `401` | Not signed in |
| `403` | No access to the workspace's data; a share link leaving its View; the CSRF header missing; an export feature off (`feature_disabled`); an expired download link |
| `404` | The View (`view_not_found: …`) or the data source isn't there |
| `422` | The body doesn't match the model |
| `429` | The graph is busy — retry after `Retry-After` |
| `501` | The data source's graph store has no search (FalkorDB has) |
| `504` | The request ran past its time (120 s for `/graph/` routes) |

---

## Display rules

### The rule

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string, 1–128 | Required in a `PUT` body, where the path's id wins. The UI mints `rule_<time>_<random>` |
| `name` | string, 1–120 | Unique in the View, ignoring case and surrounding spaces (`409`) |
| `color` | `^#[0-9a-fA-F]{3,8}$` | Use **6-digit** `#rrggbb`: the chip appends its own alpha |
| `icon` | string ≤ 64, optional | A Lucide icon name (unknown names show a box) |
| `predicate` | object | A predicate, [with restrictions](#what-a-rules-predicate-may-not-use) |
| `enabled` | boolean (true) | Off: kept, not evaluated |
| `createdAt` | string ≤ 64, optional | Stamped by the server; kept when a rule is replaced |
| `invalid` | read-only | On read only: why a stored rule can't run as a rule |

Rules have no priority, description, owner or scope field. Narrow a rule with
its predicate (`entityType`, `descendantOf`); the View's own boundary always
applies.

### What a rule's predicate may not use

A rule's predicate is checked as a search's is, and additionally may not use:

- `withinHops` or `path` — "A rule can't use 'within hops' or a path…"
- `text` with `match` `regex` or `fulltext`
- `descendantOf` under an `or` or `not` group

Each is a `422` on save. Rules stored without these checks — by a View file
import, a version restore, or a View created with rules in its config — come
back with `invalid: "<why>"`, are shown as **Can't be counted**, and are never
sent to be matched.

### How rules are evaluated

- **All-match.** Every enabled rule that matches adds its chip; the rules'
  order is the chips' order.
- **Always in the View.** Membership and counts resolve the View's scope on the
  server; an entity outside the View never matches.
- **Chips** come from `POST /search/membership` for the entities loaded on the
  canvas, in batches of up to 1,000 URNs × 32 rules, asked again when a rule's
  predicate or the set of enabled rules changes (not on a rename or recolour).
- **Counts** come from `POST /search/counts` in groups of 32, repeated with the
  returned `sessions` until complete.

### Where rules are stored

Published rules live in the View's config at
`layout.referenceLayout.displayRules`; a draft's rules live in that draft's
layout overlay, created on its first rule write from the published layout.
Every write changes **one rule** under a row lock, so people editing different
rules keep both edits, and none of them moves the View's `updated_at`. A
layout save never carries rules. When the draft is published its rules are
merged with the published ones by rule id.

Rules are part of the View's design: view versions keep them, and a View file
(`*.view.json`) carries them — with rule ids kept and URNs in their predicates
remapped on import — while saved queries stay behind.

---

## View library endpoints

All under `/api/v1/views/{view_id}` (the View's id, not a workspace path).
`branchId` addresses a draft's rules; saved queries belong to the View whatever
the branch.

| Method · path | Body → answer | Needs |
| --- | --- | --- |
| `GET /library[?branchId]` | → `{viewId, branchId, displayRules, savedQueries, canEdit}` | Read |
| `PUT /library/rules/{ruleId}[?branchId]` | a rule → the View's rules | Edit |
| `DELETE /library/rules/{ruleId}[?branchId]` | → the View's rules (no error when already gone) | Edit |
| `PUT /library/rules[?branchId]` | `{"ids": [...]}` → the rules, in that order (rules not named follow) | Edit |
| `PUT /library/queries/{queryId}` | `{name, description?, predicate}` → the saved query | Edit |
| `DELETE /library/queries/{queryId}` | → `204` (no error when already gone) | Edit |
| `PUT /library/queries` | `{"ids": [...]}` → the saved queries, in that order | Edit |
| `GET /library/export[?branchId]` | → a library pack, `Content-Disposition: attachment; filename="<view name>.library.json"` | Read |
| `POST /library/import?strategy=&dryRun=[&branchId]` | a library pack → an import result ([below](#importing-a-pack)) | Edit — **even for a dry run** |

A saved query answers `{id, name, description, predicate, createdAt, createdBy,
updatedAt, updatedBy}`. `name` is 1–120 characters and unique in the View;
`description` up to 500. Saved-query ids are unique across **all** Views, so a
script generates its own (`query_<uuid>`) rather than reusing one.

**Permissions.** *Read* is whoever can open the View (its visibility and
grants); anyone else gets `404`, as if it weren't there. *Edit* is `system:admin`,
the View's creator, `workspace:view:edit` in the View's workspace
(`workspace_member` and the admin roles — see [RBAC](/docs/rbac)), or an
`editor` grant on the View; anyone else gets `403` "Missing permission:
workspace:view:edit". `canEdit` in `GET /library` says which the caller has.

**Errors**

| Status | When |
| --- | --- |
| `403` | Not allowed to edit; CSRF header missing |
| `404` | The View doesn't exist, or the caller can't read it |
| `409` | "A rule named '…' already exists in this view." · "A query named '…' is already saved in this view." · "Query id '…' is taken." |
| `422` | An invalid predicate (with where and why), a rule-only restriction, "A view holds at most 200 display rules.", "A view holds at most 500 saved queries.", a pack that isn't one, a body that doesn't match the model |

---

## Library packs

### Format

```json
{
  "format": "synodic.view-library",
  "version": 1,
  "exportedAt": "2026-09-29T10:00:00+00:00",
  "source": {"viewId": "view_abc", "viewName": "Data Lineage"},
  "displayRules": [
    {"id": "rule_1", "name": "PII", "color": "#ef4444", "icon": "ShieldCheck", "enabled": true,
     "predicate": {"kind": "tag", "op": "hasAny", "values": ["PII"]},
     "createdAt": "2026-09-01T09:00:00+00:00"}
  ],
  "savedQueries": [
    {"id": "query_1", "name": "Tables", "description": "Every table",
     "predicate": {"kind": "group", "op": "and", "children": [
       {"kind": "entityType", "op": "in", "values": ["table"]}]}}
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `format` | yes | `"synodic.view-library"` |
| `version` | yes | `1` |
| `exportedAt` | no | Written by an export |
| `source` | no | `{viewId, viewName, branchId}`; the import dialog shows `viewName` |
| `displayRules` | no | Up to 200 rules. `id` and `createdAt` are optional |
| `savedQueries` | no | Up to 500 of `{id?, name, description?, predicate}` |

The server takes a pack without `format` and `version`, but the import dialog
and the publish script don't: always write both. An export writes rules as
stored and saved queries as `{id, name, description, predicate}`; nulls are
left out.

**JSON Schema**: `backend/common/schema/view-library.v1.json` describes the
pack and each item (the predicate schema included), rendered from the models the
import uses. Point an editor at it for completion while writing a pack by
hand. After changing the models, regenerate it with
`python -m backend.scripts.export_view_library_schema` (a test fails when it
is out of date).

### Importing a pack

`POST /api/v1/views/{view_id}/library/import?strategy=merge&dryRun=true`

| Parameter | Default | Meaning |
| --- | --- | --- |
| `strategy` | `merge` | `merge`: add what the View doesn't have — an item with the same name (ignoring case) **and** the same predicate is skipped. `copy`: add every item. `replace`: remove **all** the View's rules and saved queries, then add the pack's |
| `dryRun` | **`true`** | Say what would happen and change nothing. Send `dryRun=false` to import |
| `branchId` | — | Write the rules to this draft |

- Every added item gets a **new id** (`rule_<12 hex>`, `query_<12 hex>`); the
  pack's ids are only reported back as `sourceId`.
- A name already in the View gets a number: "PII (2)", "PII (3)".
- Each item is checked as it would be when saved. One that fails is
  **refused** with the reason, and the rest still import.
- An item whose predicate names entity types the View doesn't show is added
  with a warning: "Refers to entity types this view doesn't show: …".
- An item that would take the View past 200 rules or 500 queries is refused.

The answer:

```json
{
  "strategy": "merge", "dryRun": true,
  "items": [
    {"kind": "rule", "sourceId": "rule_1", "name": "PII", "action": "add",
     "newName": "PII (2)", "reason": null, "warnings": []},
    {"kind": "query", "sourceId": "query_1", "name": "Tables", "action": "skip",
     "newName": null, "reason": "Already in this view.", "warnings": []}
  ],
  "added": 1, "skipped": 1, "refused": 0, "removed": 0,
  "library": null
}
```

`removed` counts what a `replace` removes. After a real import, `library` holds
the View's library as it now stands.

### A pack by hand

1. **Start from the envelope**: `{"format": "synodic.view-library",
   "version": 1}`, and a `source.viewName` to label it in the import dialog.
2. **Write each rule's predicate** as you would a search's — easiest by
   building it in the Advanced Search panel and copying the JSON from
   **Options → JSON**, or from an export. Wrap several conditions in a group.
3. **Give each rule a name, a 6-digit colour, and optionally an icon.** Leave
   out `id` and `createdAt`: the import sets them.
4. **Add saved queries** as `{name, description, predicate}`.
5. **Dry-run it** against a View (below): every item says `add`, `skip` or
   `refuse` with a reason. Fix what's refused, then import.

Two complete packs — `governance.library.json` and `data-quality.library.json`
— and seven ready-to-run queries are in `docs/examples/search-and-rules/` in
the repository. A test imports every one, so they stay valid.

---

## Recipes

The recipes assume the sign-in above (`$B`, `$JAR`, `auth`). Find a View's
workspace and data source, and a data source's Views:

```bash
VIEW=view_abc
curl -s -b "$JAR" "$B/api/v1/views/$VIEW" | jq '{workspaceId, dataSourceId}'
WS=ws_…; DS=ds_…
curl -s -b "$JAR" "$B/api/v1/views/?dataSourceId=$DS&limit=200" | jq -r '.items[] | [.id, .name] | @tsv'
```

### Run a search

```bash
curl -s "${auth[@]}" -X POST "$B/api/v1/$WS/graph/search/advanced?dataSourceId=$DS" -d '{
  "predicate": {"kind": "group", "op": "and", "children": [
    {"kind": "entityType", "op": "in", "values": ["dataset"]},
    {"kind": "property", "key": "rowCount", "op": "gt", "value": 1000, "valueType": "number"}]},
  "scope": {"viewId": "'"$VIEW"'", "scopeMode": "view"},
  "options": {"results": "both", "pageSize": 100, "includeAncestorPath": true,
              "aggregations": [{"by": "entityType", "maxBuckets": 50}]}}' \
  | jq '{totalCount, status, cursor, hits: [.hits[].node.displayName]}'
```

- **Next page**: send the same body with `"cursor": "<cursor>"` in `options`.
- **Progressive**: add `"waitMs": 800`; while `status` is `running`, send it
  again with `"sessionId": "<sessionId>"`.
- **Without running it**: `POST …/search/explain` with the same body shows the
  Cypher and the resolved scope.

Every file in `docs/examples/search-and-rules/queries/` is a body for this
call: `-d @big-datasets.search.json`, after setting its `viewId`.

### Count a rule's matches

```bash
curl -s "${auth[@]}" -X POST "$B/api/v1/$WS/graph/search/counts?dataSourceId=$DS" -d '{
  "scope": {"viewId": "'"$VIEW"'", "scopeMode": "view"}, "waitMs": 1000,
  "items": [{"id": "pii", "predicate": {"kind": "group", "op": "and", "children": [
    {"kind": "tag", "op": "hasAny", "values": ["PII"]}]}}]}' | jq .counts
```

Repeat with `"sessions": {"pii": "<sessionId>"}` until `status` is `complete`.

### Save a query and a rule on a View

```bash
curl -s "${auth[@]}" -X PUT "$B/api/v1/views/$VIEW/library/queries/query_$(uuidgen | tr -d -)" -d '{
  "name": "Big datasets", "description": "rowCount over 1,000",
  "predicate": {"kind": "group", "op": "and", "children": [
    {"kind": "property", "key": "rowCount", "op": "gt", "value": 1000, "valueType": "number"}]}}'

curl -s "${auth[@]}" -X PUT "$B/api/v1/views/$VIEW/library/rules/rule_pii" -d '{
  "id": "rule_pii", "name": "PII", "color": "#ef4444", "icon": "ShieldCheck",
  "predicate": {"kind": "tag", "op": "hasAny", "values": ["PII"]}}'

curl -s "${auth[@]}" -X PUT "$B/api/v1/views/$VIEW/library/rules" -d '{"ids": ["rule_pii"]}'
curl -s "${auth[@]}" -X DELETE "$B/api/v1/views/$VIEW/library/rules/rule_pii"
```

Add `?branchId=<draft>` to the rule calls to change a draft's rules.

### Export a View's library, and import it into another

```bash
curl -s -b "$JAR" -OJ "$B/api/v1/views/$VIEW/library/export"          # <view name>.library.json
TARGET=view_xyz
curl -s "${auth[@]}" -X POST "$B/api/v1/views/$TARGET/library/import?strategy=merge" \
  --data-binary @"Data-Lineage.library.json" | jq '{added, skipped, refused, items}'     # dry run
curl -s "${auth[@]}" -X POST "$B/api/v1/views/$TARGET/library/import?strategy=merge&dryRun=false" \
  --data-binary @"Data-Lineage.library.json" | jq '{added, skipped, refused}'
```

### Build a pack programmatically

A pack is plain JSON, so any language can write one. This writes a rule and a
saved query per tier:

```python
import json

tiers = {"Gold": "#f59e0b", "Silver": "#06b6d4", "Bronze": "#ec4899"}

def tier_is(tier):
    return {"kind": "property", "key": "tier", "op": "eq", "value": tier.lower()}

pack = {
    "format": "synodic.view-library",
    "version": 1,
    "source": {"viewName": "Tiering"},
    "displayRules": [
        {"name": f"{tier} tier", "color": color, "icon": "Star", "predicate": tier_is(tier)}
        for tier, color in tiers.items()
    ],
    "savedQueries": [
        {"name": f"{tier} datasets", "predicate": {"kind": "group", "op": "and", "children": [
            {"kind": "entityType", "op": "in", "values": ["dataset"]}, tier_is(tier)]}}
        for tier in tiers
    ],
}
with open("tiering.library.json", "w", encoding="utf-8") as f:
    json.dump(pack, f, indent=2)
```

### Dry-run, then apply, to one View

`backend/scripts/publish_view_library.py` signs in, imports a pack and prints
what each View did. It uses only the Python standard library, so it runs from
any machine with Python 3.9 or later — from the repository as a module, or
copied on its own.

```bash
export SYNODIC_BASE_URL=https://lineage.example.com
export SYNODIC_EMAIL=you@example.com SYNODIC_PASSWORD='…'   # or --email / --password; prompted when unset

python -m backend.scripts.publish_view_library tiering.library.json --view view_abc           # dry run
python -m backend.scripts.publish_view_library tiering.library.json --view view_abc --apply   # import
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--view VIEW_ID` / `--data-source DATA_SOURCE_ID` | one is required | The target |
| `--strategy` | `merge` | `merge`, `copy` or `replace`, as the import endpoint |
| `--apply` | off | Import. Without it the run is a dry run and nothing changes |
| `--branch BRANCH_ID` | — | Write the rules to this draft of each View. The id isn't checked: a wrong one makes rules nobody sees |
| `--base-url` | `$SYNODIC_BASE_URL`, else `http://localhost:8000` | The API |
| `--email` / `--password` | `$SYNODIC_EMAIL` / `$SYNODIC_PASSWORD`, else a prompt | The password is never printed |

### Publish a pack to every view of a data source

{brand} has no data-source-level library — rules and saved queries always
belong to a View. Publishing to a data source is a **fan-out**: the script
lists every View of the data source that you can read
(`GET /api/v1/views/?dataSourceId=…`, page by page) and imports the pack into
each one.

```bash
python -m backend.scripts.publish_view_library governance.library.json --data-source ds_abc
```

```text
Dry run: 4 display rules and 3 saved queries into 3 views (strategy merge)

View               Would add  Skipped  Refused  Removed  Warnings  Result
-----------------  ---------  -------  -------  -------  --------  -------------------------------------------------
Finance (view_a1)  7          0        0        0        0         ok
Sales (view_b2)    5          2        0        0        1         ok
Ops (view_c3)      -          -        -        -        -         HTTP 403: Missing permission: workspace:view:edit

  Sales (view_b2): rule “Needs owner”: Refers to entity types this view doesn't show: dataset

Nothing changed. Run again with --apply to import.
```

Review the dry run, then run it again with `--apply`. Views you can read but
not edit answer `403`, as above: ask for edit access to them, or accept that
they are left out. Views created later don't get the pack — run the script
again (`merge` skips what a View already has).

**Exit status**: `0` when every View took the pack with nothing refused; `1`
when a View refused an item or answered with an HTTP error, or the data source
has no View you can read; `2` for a bad argument, a file that isn't a pack, or
a failed sign-in. That makes it safe in CI: a dry run that exits `0` means the
real run will do what it listed, unless the Views change in between.

### Export every match to CSV

```bash
BODY='{"scope": {"viewId": "'"$VIEW"'"}, "predicate": {"kind": "group", "op": "and", "children": [
  {"kind": "tag", "op": "hasAny", "values": ["PII"]}]}, "format": "csv", "columns": ["owner", "rowCount"]}'
curl -s "${auth[@]}" -X POST "$B/api/v1/$WS/graph/search/exports?dataSourceId=$DS" -d "$BODY"
# repeat with "sessionId" added to the body until "status" is "complete", then:
curl -s -b "$JAR" -o pii.csv \
  "$B/api/v1/$WS/graph/search/exports/$SID/download?dataSourceId=$DS&token=$TOKEN"
```

---

## What is not supported

- **No data-source, workspace or organisation library.** Display rules and saved
  queries belong to one View. "Publish to a data source" is the fan-out above;
  there is no bulk endpoint, and a View created later doesn't inherit anything.
- **No API tokens or service accounts.** Scripts sign in with a password and
  echo the CSRF cookie. Where password sign-in is off for single sign-on, only
  system accounts can.
- **Saved queries keep only the predicate** — not the scope mode, options,
  aggregations, sort or template inputs.
- **"Mine" searches stay in one browser**: no API, no sync, not in any export.
- **A View file (`*.view.json`) carries display rules but not saved queries**;
  export the library for those.
- **No custom templates** without a code change (`searchTemplates.ts`).
- **Rules only add chips.** No node colour, hiding, priority, first-match,
  description, owner or per-rule scope.
- **A rule can't use** `withinHops`, `path`, `regex` or `fulltext` text, or
  `descendantOf` under `or` / `not`.
- **`fulltext` and `regex` text matches** and **`subAggregation`** are in the
  model but refused.
- **Draft data isn't searchable**: searches, counts and chips read the published
  graph. Draft *rules* are kept per draft.
- **No live updates**: other open sessions see a rule change when they next
  load the View.
- **An import's dry run needs edit permission**: readers can't preview one.
- **`layer` doesn't follow the View's layers**: it compares a stored node
  property. Use `descendantOf` on the layer's roots.
- **No per-user rate limit on search** (`DEEP_SEARCH_RATE_LIMIT_PER_MIN` is not
  enforced): load is shed with `429` when the graph is busy.
- **The panel's Options tab** (page size, candidate cap, grouping) doesn't
  change what the panel sends; call the API for other options.
- **FalkorDB only**: other graph stores answer `501`.

---

## Where the code lives

| Concern | File |
| --- | --- |
| Query, scope, options, responses | `backend/common/models/search.py` |
| Operator meanings | `backend/common/search_semantics.py` |
| Validation, scoping, routing | `backend/app/services/advanced_search_service.py` |
| Search endpoints | `backend/app/api/v1/endpoints/graph.py` |
| Rule, saved query, pack models | `backend/common/models/view_library.py` |
| Library storage and import | `backend/app/services/view_library.py` |
| Library endpoints | `backend/app/api/v1/endpoints/views.py` |
| Schemas | `backend/common/schema/searchquery.v1.json`, `searchoperators.v1.json`, `view-library.v1.json` |
| Publish script | `backend/scripts/publish_view_library.py` |
| Examples | `docs/examples/search-and-rules/` |
| Panel, Code mode, templates | `frontend/src/components/canvas/search/` |
| Property Manager and rules UI | `frontend/src/components/canvas/property-manager/` |
