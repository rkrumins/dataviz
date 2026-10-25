# Changelog

Release history for {brand}. Notable changes, newest first. Dates are release dates.

Sections follow [Keep a Changelog](https://keepachangelog.com): **Added**, **Changed**,
**Deprecated**, **Removed**, **Fixed**, **Security**. Anything that requires action on upgrade
is called out under **Upgrading**, and anything we know is still wrong is under **Known
limitations** — a changelog that only lists good news is not worth reading.

---

## [Unreleased] — Ask the graph: plain words, Search Studio, relationships, names, routes and your own Cypher

### Added

**Ask in plain words.** Beside its filters, the query card takes a question in plain words: "datasets
that feed finance dashboards", "unowned datasets", "datasets in Snowflake updated in the last 7 days". Before anything
changes it reads the question back — what it reads as, and how many that finds — offers the other
readings of a word that has several, lets you pick among entities sharing a name, and says which
words it searched for by name. It is rule-based, reading the View's own types, tags, properties and
layers: nothing is sent to an AI service. **Enter** runs it; starting with "and" adds to the query.

**A query as a sentence, with its map.** The new **Sentence** mode reads the query the way you'd say
it — *Find* **datasets** *that* **feed** **a dashboard** — every word a token you click to change,
with a map of the query's shape whenever it has a relationship or a route. The card still opens on
**Form**, the filter cards, for everyone; Sentence is the guided alternative, a click away.

**Counts as you build.** Each Sentence line says how many still match once it is added, and the map,
the Ask preview, recipes and type chips carry counts too — all before anything runs. On a very large
View, **Options → Live counts** turns them off. `POST /search/counts` takes `purpose: "search"` to
count a search's conditions, lineage of more than one hop included; rules keep their one-hop limit.

**When nothing matches.** The Sentence line where the matches run out is marked before anything
runs, with up to three fixes, each counted, one click to apply. An empty answer leads with the same,
whichever builder you use.

**Refine from the answer.** Chips over the results narrow the query to one type, or leave one out,
each counted; a match's breadcrumb narrows to inside a container; a match says why it matched. Rows
take their icons and colours from the ontology.

**Search Studio.** The panel opens out over the canvas (**Open Search Studio**, `E`, or the command
palette): the query; the matches as a table, whose picked rows can be framed on the canvas, kept as
the only ones, left out or copied; and the View's types, tags and properties, counted exactly, a
click adding one to the query.

**Recipes.** Ready-made questions by intent — impact, root cause, governance and PII, documentation
gaps, ownership, cleanup, discovery — in the View's own words, each counted, and offered only when
the View holds what they name: on the empty query card, in **Library → Recipes** and in an idle
Studio. One with something to fill in opens at it.

**Guidance.** A first-run tip points at Search Studio, and the guide is a click away. The command
palette gains **Ask about this view** and **Open Search Studio**. The panel's edge resizes from the
keyboard, and the Sentence builder tells screen readers its settled total, or where the matches run
out.

**Search by relationships.** Advanced Search finds entities by the entities related to them: up
the containment tree (a parent, any ancestor, the top-level container), down it (children, any
descendant), or along lineage (what feeds it, what it feeds, either way). "Datasets whose parent is
a domain", "tables with a PII column", "tables where every column is described", "more than 100
columns", "feeds a dashboard within three hops whose parent is *Finance*". A relationship's
condition is any filter — other relationships included, three deep — and a lineage relationship
can require every edge it walks to meet a filter. **Add filter → Relationships** in the panel and in
the rule editor; `parent(…)`, `every child(…)`, `count(child(…)) > 100` and
`downstream*..3(…).via(…)` in Code mode; `"kind": "related"` in the API. Every match is found and
counted exactly, and display rules, counts and exports take relationships too.

**Name entities instead of pasting URNs.** Every filter that names entities — inside a container,
within N hops, the ends of a path, and the new **Is a named entity** — takes a path of display names
from the top: `Country / United Kingdom`, `Country / ** / London`, `** / orders`. The picker says
as you type how many entities a path names, and where they sit. A name means the same in every
environment, so saved searches, rules and library packs that use names keep working after they
move. `POST /search/resolve` answers what a path names; every search reports it in
`scopeDiagnostics.resolvedRefs`.

**Routes between conditions.** Either end of a path can be a condition: "every route from a topic
to a dataset through edges in stream mode". Paths have a visual editor now (**Add filter →
Advanced → Paths from A to B**).

**The properties you put on edges.** Edge filters — on paths, within N hops and relationships —
read the properties users add to edges, not only the platform's own fields: is set, is not set,
is, is not, is one of, is none of. Discovery says where each edge key is kept
(`edges[].storedAs`).

**Questions from the canvas.** Right-click an entity for **Everything inside this**, **Its
children**, **What feeds this**, **What this feeds** or **Routes from this to…**; with several
selected, **What all N feed** and **What feeds all N**. On a container, the lineage questions take in
everything inside it — a dataset's lineage often runs through its columns — and the server walks out
from the container's contents once, so the answer costs what the container's own lineage costs, not
what the graph does. A match found through lineage offers **How it matches**: its routes to the
relatives it was matched by.

**A query editor that knows the language.** Code mode is a real editor now: words are coloured by
how they are read, a red underline marks where a query stops making sense and says why, and
suggestions offer what fits where the cursor is — entity types, tags, a property's values, edge
properties inside `.via(`, entities by name after `@"` — from the View's own data. **Reads as**
says the query in words while you type, and **Examples** insert a ready-made condition. `Esc` undoes
your edit, and a query that doesn't read is never applied.

**The Cypher tab.** The query card's third mode shows the query in words and the Cypher a search
runs as — built by the same code that builds the run, so it is exactly what is sent — with its
parameters and notes. **Copy with values** gives a statement that runs as it is anywhere Cypher
runs (`inlinedCypher` on `POST /search/explain`).

**Your own read-only Cypher.** On FalkorDB and Neo4j data sources, **Edit and run** on the Cypher tab
runs your own Cypher on the whole data source, starting from the search's own statement. Answers
come back as a table of typed values — nodes, edges and paths as chips that open to their
properties — and **Highlight on canvas** lights up the entities an answer names. It is for everyone
whose role reads the workspace's data sources (the new `workspace:native-query:read` permission,
which an administrator can remove from any role), and for someone a View is shared with directly
when the share turns on **Query data**. Writes, `LOAD CSV`, other databases, plugins and parameters
are refused before the query runs; rows, time and size are capped; every run is recorded in the
activity log. The **Native read-only queries** switch turns it off. `POST /search/native`.

**Examples.** Four example queries in `docs/examples/search-and-rules/queries/`, and a **Holds PII**
rule in the governance pack.

### Changed

- In Code mode, `parent(`, `child(`, `ancestor(`, `descendant(`, `root(`, `upstream(`,
  `downstream(`, `neighbor(` and `count(` start a relationship, and `@"…"` names an entity — only
  when `(` or the quote follows directly: `root cause` and `parent (x)` are still a search for the
  words.
- A path in a saved search opens in the visual editor instead of as JSON.
- New settings: `DEEP_SEARCH_MAX_RELATION_DEPTH` (3) and `DEEP_SEARCH_RELATION_MAX_HOPS` (3).
- An empty query card lists every filter under the search field; the **All filters** link, which
  opened the drawer's options instead, is gone.
- The query card reopens on the mode you used last — Form, Sentence, Code or Cypher — and opens in
  Form until you choose another.
- **Library → Templates** is now **Recipes**, and recipes replace the empty card's example cards.
- Over an answer that stopped short, Business reads what it means in plain words, with the engine's
  account behind **Why?**. The Cypher tab folds its cap, parameters and notes under **Engine
  details**, open for Technical.
- Type chips over the results change the query; they used to filter only the rows already loaded.
- **Enter** on a button in the search panel presses it; it used to reveal the current match.
- Relationship sentences say the edges a relationship walks after its condition: "has a target that
  has an ancestor that is Tableau, through edges where logic is Direct Query".
- The drawer keeps Options and JSON; the compiled Cypher moved to the Cypher tab.
- The JSON editor follows the light and dark themes.
- New settings for native queries: `NATIVE_QUERY_DEFAULT_ROWS` (200), `NATIVE_QUERY_MAX_ROWS`
  (1,000), `NATIVE_QUERY_DEFAULT_TIMEOUT_MS` (10 s), `NATIVE_QUERY_MAX_TIMEOUT_MS` (30 s),
  `NATIVE_QUERY_RATE` (20 a minute per person), `NATIVE_QUERY_CONCURRENCY` (2 per data source per
  process) and `NATIVE_QUERY_MAX_REPLY_BYTES` (16 MiB).

### Fixed

- With results showing, the search panel's header pushed **Close** past the panel's edge at its usual
  width. Its chips now shrink to icons when room runs short, and take a second row at the narrowest.
- A path with an edge filter on a value (`confidence >= 0.8`) failed: the filter's parameters were
  never sent with it.
- On the capped engine (aggregate-only searches, facets), *Within N hops* was applied after the
  candidate cap, so it missed matches past the cap and counted candidates it then dropped.
- A display rule using a lineage shape (*No lineage edges*, *No upstream lineage*, …) failed in rule
  membership with a type mismatch, so its chips never showed.
- An edge filter on a property a user added to edges matched nothing.
- Edge filters had no size limit; they now nest at most three groups deep and hold at most 16
  conditions.
- A search that failed or was cancelled wiped the query; it now stays in the box.
- Search errors showed raw server text (`API Error 422: {"detail": …}`); the error card and the match
  bar now say what is wrong in plain words.
- In Code mode, clicking away from a query with an error applied an empty query and wiped the one you
  had; some errors read `[object Object]`; `rowCount >` threw instead of saying what was missing; an
  unclosed `"` or `@"` went unreported; and `tag:PII,GDPR` was read as three terms instead of either
  tag.
- The compiled Cypher the panel showed could differ from what a search ran (its candidate cap,
  `LIMIT`, scope and incomplete rows), and a late answer could replace a newer one.
- A date comparison (`updated > 2024-05-01`, *in the last 30 days*) could crash FalkorDB, and with it
  every user's queries, when it met a short text with an accented letter or an emoji (`Zoë1`):
  FalkorDB 4.18 reads past the end of such a text when a slice starts at or past its last
  character. The comparison now reads its positions from the text padded with zeros, which never
  starts past the end and decides exactly the same.

### Security

- A share link could follow lineage out of its View: a path returned the entities on it, and a
  hop test answered yes or no about entities the link can't see. Searches, explains and exports
  that follow lineage or relationships now answer `403` for share links; in rule membership and
  counts only the rule that does is refused, so the other rules still colour the shared View.
- A share link's name references are resolved inside its View only.
- Native queries are read-only three ways: the engine's read-only mode (`GRAPH.RO_QUERY`, a Neo4j
  `READ` transaction that is always rolled back), Neo4j's own plan check before anything runs, and
  a guard in front of both that reads the query as tokens. They are never open to API keys, to a
  View's visibility or to drafts, and a run's activity record is committed before any row is
  returned — no record, no rows. See
  [Native read-only queries: security](docs/NATIVE_QUERIES.md).
- On FalkorDB, a native query may start `substring()` only at 0: started anywhere else it can crash
  the server on accented text, so one person's query could stop everyone's. `left()` and `right()`
  do the same job safely, and the refusal says how.

### Upgrading

- **Run the upgrade job.** Migration `20261024_1000_native_query` adds the
  `workspace:native-query:read` permission, grants it to every built-in and custom role that holds
  `workspace:datasource:read`, and adds `resource_grants.can_query_source` (the share's **Query
  data**). Downgrading removes them.
- **Native read-only queries is on by default.** Turn it off under **Administration → Features**
  before people can run their own queries, or remove the permission from roles that shouldn't have
  it.
- Set FalkorDB's `TIMEOUT_MAX` and `QUERY_MEM_CAPACITY` (and Neo4j's `db.transaction.timeout` and
  `db.memory.transaction.max`), and limit the database hosts' outbound network: both engines run
  `LOAD CSV` as a read, so the guard is what stops it. See
  [Operator hardening](docs/NATIVE_QUERIES.md#operator-hardening).
- The relationship settings default to what the panel offers.

### Known limitations

- A relationship whose far end is a condition follows lineage at most 3 hops (10 when the far end
  is an entity you name). Complete end-to-end lineage stays the Trace feature's job.
- An edge property users added takes presence and equality only, and a key of a nested object
  reads as present when it is only nested.
- A relationship's condition tests a relative's native properties; a value kept as raw JSON
  (`propertiesRaw`) doesn't match there.
- The first run of a new relationship shape can take up to about half a second longer while
  FalkorDB plans it (a number comparison in a relationship's edge filter); later runs reuse the
  plan.
- **How it matches** draws routes up to 4 hops, and routes a path lists stop at 128.
- Share links can't use relationships, paths or *Within N hops*.
- Counts as you build need a FalkorDB data source; on other engines, and through a share link, the
  numbers don't appear until the query runs.
- Ask reads the phrasings its rules know; other words are searched for by name, and it says which.
- The Sentence view hands *Within N hops* and *Number of edges* to Code mode, and Form's **Group as**
  for several selected rows stays in Form.
- A native query reads the whole data source, not only the View, including internal bookkeeping
  such as rollup edges. A share's **Query data** stays on until someone turns it off, even if the
  person who turned it on later loses their own access.
- FalkorDB may keep working on a native query past the client's deadline, until its own
  `TIMEOUT_MAX` stops it; Neo4j can't cap one huge row on the client, so its transaction memory
  limit is what bounds it.
- Native queries use the data source's existing login; the engines' read-only modes keep them
  read-only, not the login's privileges.

## [Unreleased] — Fixes for integrations

### Fixed

- **An import or export sent again with its `idempotencyKey` answers with the job it started.** A
  key already used on the graph answered `503` and left an empty "Import" draft behind. A key is
  now its sender's own: sent again, it answers `202` with that job, starting it if its file never
  arrived, and a key that started the other kind of job answers `409 idempotency_key_reused`.
- **A graph's branch list pages correctly for someone who doesn't manage it.** Drafts they couldn't
  see were dropped after the page was cut, so a page could come back short, or empty, before the
  end. Drafts shared with a team they are in are now listed and readable, and a draft whose sharing
  is turned off is neither.
- **A data source's refresh can wait for its rebuild.** `"wait": "complete"` waits up to 60
  seconds, but the request was cut off after 30 and answered `504`. A refresh now has 90 seconds
  (`HTTP_TIMEOUT_AGGREGATION_SECS`).
- **A browser app on another origin can read `X-Total-Count`, `X-Request-ID` and
  `X-API-Key-Expires-At`.**
- **The view library publish script says why a key stopped.** A paused service account key waits
  for its account to have a manager again, not for a sign-in, and a key refused for the caller's
  address says so.

### Upgrading

- An `idempotencyKey` sent before the upgrade isn't recognised after it: sent again, it starts a
  new job.

---

## [Unreleased] — Service accounts: integrations that outlive the person who set them up

### Added

**Service accounts.** An account nobody signs in as, for an integration to run as. Super and org
admins create one under **Administration → Service accounts**, name its managers — people, or
teams — and give it workspace roles: any that neither administers a workspace nor lets people in.
Its managers make, rotate and revoke its keys from **Account → API keys → Service accounts you
manage**, confirming it's them as for their own keys. A key (`nxsat_…`) acts as the account,
reaches what the account's roles give it, and counts against the account's own limit of 25. An
integration swaps its `nxpat_…` key for one and changes nothing else.

**What happens when a manager leaves.**
- **Teams as managers.** A team, ideally one your identity provider keeps, keeps an account
  managed as people join and leave. Anyone in it can make keys that act as the account, which
  the page says where you choose one — so only an administrator of service accounts adds
  someone to a team that manages one, and its managers are told when someone joins.
- **Hand-over.** Suspending someone on **Administration → Users** lists every service account
  their leaving touches — those they manage themselves or through a team, and those they made a
  key for that still works — flags those nobody else manages and the keys they made, hands their
  own seats to a successor, and offers to revoke the keys they made, before suspending them.
  **Administration → Service accounts → Hand over…** hands over on its own. Whenever someone who
  made keys that still work stops answering for an account, those who still answer are told.
- **A safety net.** When an account's last manager in good standing goes — suspended, removed,
  out of their team, or no longer signing in — every super and org admin is told at once. Its
  keys keep working for a grace period (**Keep a service account's keys working after its last
  manager goes**: at once, 7, 14 or 30 days; 14 by default), the admins are reminded three days
  before it ends — again if the grace period is lengthened, and once that the keys have paused if
  it is shortened past the day — and then the keys pause (`401 api_key_unmanaged`) until a
  manager is appointed. More than five accounts at once make one notice, not one each.
- **A single-manager marker** on every account one person is all it depends on.

A new permission, `system:service-accounts:manage`, granted to super and org admins. Someone
who may manage users (a super admin) can make an account's keys without managing it; its
managers are told when they do. `POST /admin/users/{id}/api-keys/revoke-made` (with
`system:users:manage`) revokes the service account keys a person made.

A new counter, `api_key_housekeeping_steps_total{step,outcome}`, says whether each step of the
hourly API key pass completed; [Observability](/docs/observability) has an alert for the service
account check not completing.

### Changed

- A key's notices — misuse, expiry reminders, an administrator revoking it, a key revoking
  itself — go to those who answer for a service account's key: its own managers and whoever made
  the key while they still can act for it; failing those, up to 25 members of its managing teams,
  the most recently active first; or its administrators while nobody can act for it. So does
  anything said to the account itself — a workspace removing its access or setting an end date
  on it, that access about to end, a decision on a publication it asked for, an administrator
  disabling or enabling it — naming the account.
- The API explorer's API key scheme names both kinds of key, `nxpat_…` and `nxsat_…`.
- People lists, pickers, the directory, the admin user search, people counts, analytics and
  inboxes leave service accounts out; the routes about a person answer `404` for one. Where
  access is listed — a workspace's members, everyone with access, access reviews, the activity
  log — one is marked as a service account and links to its page.

### Security

- A service account never signs in: every sign-in path refuses it, an identity provider can't
  link to one, and it can't join a team or a workspace's members directly. It holds only the
  workspace roles given it on its own page: never a platform role, a team's roles, or a role
  that administers a workspace — not even one widened to after it was given — and no view,
  template or draft can be shared with it. A view it made is its own only while it holds a role
  in that view's workspace.
- A service account neither reviews nor approves a pull request, and nobody approves one opened
  through an account they manage.
- Appointing a manager, or handing an account over, takes being able to grant each of its roles:
  a manager can do whatever the account can.
- A service account key whose account record is missing is refused.

### Upgrading

- The upgrade job adds the `service_accounts` and `service_account_managers` tables and the new
  permission (`20261023_1200_service_accounts`). Nothing else to run.
- Secret scanning: widen the pattern to `nx[ps]at_[0-9A-Za-z]{38}` to find service account keys
  too.

### Known limitations

- Service accounts can't be deleted: disable one, and revoke its keys.
- Its standing is re-checked when its managers change and once an hour, so a manager who signs
  in again after their sign-in window lapsed brings its keys back within the hour. The account's
  page says what its keys do in the meantime.
- No warning before a manager's own standing lapses; the alert comes when the account has nobody
  left.
- Auditors see service accounts' keys in the API keys inventory and the activity log, but not
  the accounts' own page.

---

## [Unreleased] — Move a data source to another workspace, with its views

### Added

**Move a data source, and everything built on it.** **Move to another workspace…** on a data
source's **⋯** menu opens a guided move. Its views go with it — including those in the trash, and
those with no source of their own that read it as the workspace's default — together with their
history, its version history, open drafts and reviews, and its aggregation state and stats. Nothing
is rebuilt. The steps:

- **Destination** says, for each workspace you can see, whether you can move the source there now,
  ask its admins, or why not.
- **What moves** counts the views by visibility and shows the version history, then lists what to
  resolve first (an aggregation run or a version-history job in progress, or a failed attempt to
  turn on version control) and what to know (the workspace's last source leaving, its primary
  source, views published to everyone, requests to publish, layout templates that stay behind,
  open drafts whose owners can't reach the new workspace, a restricted source going to a
  workspace open to everyone).
- **Access** shows who keeps access, who gains it and who loses it. The new workspace's own
  members, groups and identity-provider mappings decide who reads the moved views, so the people
  and groups who read them only through the old workspace lose them — each listed with where their
  access came from (the app, a group, or your identity provider).
- **Confirm** asks why — the reason is shown in both workspaces' activity — and, when anyone loses
  access, for **I understand … lose access**.

**Nobody is left guessing.** Everyone who loses access gets an Inbox notice saying where the views
went and how to get back in, the way the new workspace takes people: **Ask to join**, **Join** when
it's open to everyone, or its admins when it's closed to requests. Both workspaces' admins are told who, the
source's panel says how many, and the move records each person and group. Nothing is copied to
keep the old audience reading: a copy would grow with people × views and would outlive an
identity provider removing someone.

**Ask the other workspace to take it.** When you administer only the workspace a source is in,
the same steps end in **Send request**. The destination's admins hear in their Inbox and find it
on **Workspaces → Requests** and as a banner on the workspace's **Data Sources** tab. Review shows
a fresh picture of what would move, who would lose access, and what has changed since you asked. They **Accept and move** — refused if anything changed after they read it — or
**Decline** with a reason you see. Requests expire after 14 days. You can cancel yours, and one is
cancelled when its source is deleted or moved some other way. One that expires unanswered is
recorded in both workspaces' activity, and you're told.

**Undo, for a week.** A completed move can be undone for 7 days — the workspace, the primary
source and the views, with the people who lost access told they have it back — while it is the
source's latest move and nothing new has been built on it in its new workspace. The source's panel says where it came from,
offers **Undo**, and lists each move under **Where it has lived**. Each moved view's activity says
where it went.

### Changed

- **`POST /api/v1/admin/workspaces/{id}/data-sources/{ds}/move` moves a source that has views**,
  which it used to refuse with a 409. For such a source it needs `workspace:admin` in both
  workspaces (a source with nothing on it still needs `workspace:datasource:manage` in both). It
  takes `previewToken` — required, with a 422 `preview_required`, when anyone would lose access —
  and returns the move's record rather than the data source.
- **A move re-files everything that named the old workspace**, including for a source with no
  views: each moved view's activity and the aggregation state now go with the versioned graph,
  which moves with its source since the release below. The graph moves first, so a refusal from
  version control changes nothing.
- **Open drafts and review requests no longer hold a move back**, as they did since the release
  below: they go with the source, and the preview names any draft whose owner can't open the new
  workspace. A move still waits while version control is busy with the source, or while a failed
  attempt to turn it on waits to be resumed or cancelled — which the preview now says up front.
- **Both workspaces' activity records a move**, as `workspace.data_source.moved`; it was filed
  only under the destination. It names the versioned graph that moved (`graphId`), as
  `workspace.datasource.moved` did (`graph_id`); those older events still show in history.
- **`POST /api/v1/views/` checks the data source belongs to the view's workspace**, as the import
  already did: a view naming a source in another workspace is refused with a 422.

### Security

- A move of a source with views fails closed like every `workspace:admin` route: a session whose
  revocation can't be checked gets a 503. Answering, cancelling or undoing a transfer requires
  `workspace:admin` somewhere before the transfer is looked up.
- A preview, request or move naming a workspace you couldn't find answers 404, as for one that
  doesn't exist; a preview would otherwise name its sources and people.
- A view can't be created in the workspace its source is leaving: creating one holds the source's
  row, so a concurrent move either takes the new view along or has finished and the view is
  refused.
- API keys can't reach any of these routes.
- A restricted source going to a workspace open to everyone, where anyone who joins reads it, is
  flagged in the preview, as opening a workspace that holds one is. It's a warning, not a refusal,
  and part of what the preview's token covers: a destination that opens after you read the preview
  sends you back to it.

### Resilience

- A retried move, request, answer or undo whose first try went through (its response lost) gets
  that result for ten minutes, instead of an error; so does a second click queued behind the first.
- The version store is written first and put back if the rest of a move fails. If putting it back
  fails too, the reaper re-files the graph under its source's workspace — as it does for graphs
  left behind by moves made before graphs moved with their sources. A source being moved is
  skipped and looked at next time.
- Answering a request and expiring it never race: whoever holds the request decides it, once.

### Performance

- A move writes each view's history in bulk and counts who loses access per person or group, never
  per person per view. Measured on Postgres, 5,000 views move in 1.3 s and 50,000 in 9.5 s.
- Moves, accepts and undos get two minutes (`HTTP_TIMEOUT_DATA_SOURCE_MOVE_SECS`, default 120)
  rather than the 30-second default, and the browser waits 150 seconds for them
  (`VITE_TIMEOUT_DATA_SOURCE_MOVE_MS`) so the server's answer always arrives. A source with more
  than 50,000 views is refused up front.
- Transfer lists return at most 200 rows.

### Upgrading

- **Run the upgrade job.** Migration `20261020_1000_ds_transfers` adds `data_source_transfers`,
  the record of every move and request, with one open request per data source, and allows a view
  activity entry to say `moved`. Downgrading removes the table and those entries.

### Known limitations

- Forks of a source's version history stay in the old workspace.
- File uploads in progress for the source when it moves have to be started again.
- API keys limited to the old workspace no longer reach the moved views; keys that name the source
  or a view follow it.
- A source with more than 50,000 views (trash included) can't be moved in one go.
- A layout template shared only in the old workspace stays there: views that use it keep working,
  but people in the new workspace can't open the template.
- The picker on **Add Source** doesn't count views that read a source as the workspace's default,
  so it may offer a move the server then refuses, saying why.

---

## [Unreleased] — Follow a workspace's graphs and their history from a script

### Added

**For integrators: a workspace's graphs, and which are versioned.**
`GET /api/v1/admin/workspaces/{ws}/data-sources` takes `providerId` to list one provider's graphs,
and `include=versioning` to add each one's version control:
`{enabled, graphId, kind, mainHeadCommitSeq, mainHeadCommitId, mainHeadCommittedAt}`.
`mainHeadCommitSeq` is a change watermark — a graph's history has something new only when it
moved — so one call per workspace tells a script which histories to read. `enabled` stays `false`
while version control is still being turned on, so a `graphId` it hands out never vanishes.

**For integrators: a commit log you can walk end to end.**
`GET /api/v1/{ws}/versioning/graphs/{graph_id}/commits` takes `before` and `after`, exclusive bounds
on `commit_seq`, and answers `hasMore` and `nextBefore`. A walk never skips or repeats a commit
while new ones land, and `after` fetches only what is new. Every field of a commit is now described
in the API explorer.

**Graph Metadata & History API**, a new page on the integrators' reading path: every field of both
answers, every kind of commit, what a script can rely on, and a polling loop that keeps a copy in
step.

### Changed

- The log of `main` stops at `main`'s head. It no longer shows the import commit of a "turn on
  version control" that hasn't finished — or failed.
- On the commit log, `before`/`after` with `offset`, or on a view's history across drafts, answer
  `400`.
- Data-source answers carry `versioning`, `null` unless asked for.
- The `workspace.datasource.moved` event names the versioned graph that moved with the source
  (`graph_id`).

### Fixed

- A graph in the trash still answered its routes by id — history, state, drafts and reviews, even
  while its purge ran. It now answers `404` until its data source is restored.
- Moving a versioned data source left its version history behind: the source read as external in
  its new workspace, and deleting it later left its graph standing for good. The history now moves
  with it. A move waits (`409`, with the reason) while version control is busy with the source,
  while a failed attempt to turn it on waits to be resumed or cancelled, and while it holds open
  drafts or review requests. (The move entry above lifted that last condition: open drafts and
  review requests now go with the source.)

### Security

- After a move, a versioned data source's history, state, drafts and reviews stayed readable by
  the members of its **old** workspace, through the versioning routes. They now answer only in the
  workspace the source lives in.

### Upgrading

- Nothing to run. When the versioning worker's bootstrap lane starts, and every 15 minutes after
  (`GRAPHVER_REAP_POLL_SECS`), its reaper files each graph that an earlier move left behind under
  its data source's workspace — and puts it in the trash if its source is there.

### Known limitations

- No push notification of new commits yet: poll the data-source list and compare
  `mainHeadCommitSeq`.
- The list answers for one workspace at a time, and a key limited to particular data sources
  can't call it; `GET /api/v1/{ws}/versioning/resolve?dataSourceId=` finds each source's graph.
- The data-source list doesn't fill in its aggregation fields; a source's readiness
  (`GET /api/v1/admin/data-sources/{id}/readiness`) has them.

---

## [Unreleased] — Access that looks after itself once it's granted

### Added

**Hear before your access ends, and ask to keep it.** Time-limited access to a workspace is
announced in your Inbox before it ends — a week ahead for access granted for more than two weeks,
two days ahead for shorter access, once per end date; a day or two of cover isn't announced. On
**My access**, **Ask to keep it** beside the grant sends its admins and stewards a request tied to
it; they choose how much longer (30 days unless they pick 7, 90 or no end) and the same grant is
extended. An admin can also move a grant's end from the **Members** tab — **Change** beside its
**Expires in …** badge — which answers such a request.

**People hear about changes to their access.** Your Inbox tells you when someone adds you to a
workspace (at which level, until when, and whether as an exception), removes you (and whether
that leaves you any way in), or changes when your access ends.

**Requests don't sit unanswered.** After three days a waiting request is brought up again with the
workspace's admins and stewards; after a week it goes to the Org Admins. The **Requests** tab says
**Waiting N days**, and **Sent to the Org Admins** once it has.

**Open and closed workspaces.** A workspace's admins choose how people ask, under **How people get
in → How people ask**: **Approvers decide** (as before), **Open to everyone** — anyone joins as a
Viewer at once, and more is still asked for — or **Closed to requests**, where admins add people
themselves. Find a workspace offers **Join** on open workspaces and says **Not taking requests** on
closed ones; **Request access** starts with **Join now** or says who to ask. A joined grant reads
**Joined** wherever access is listed. A workspace its identity provider controls can't be open.

**Access reviews.** On the **Members** tab, an admin starts a review of the grants made in the
workspace — people's and teams' — due in 7, 14 or 30 days, and keeps or removes each, seeing how
it came about, when it ends and when the person last signed in. Removing takes the access away at
once and tells the person why; people let in by the identity provider or an organization-wide role
are counted, not reviewed. A review completes once everything is decided, downloads as a CSV, and
one past its due date is flagged to the workspace's admins. Nothing is ever removed automatically.

**Join a workspace, in Getting started.** Someone who can't create a workspace now starts with
**Join a workspace** — Find a workspace while it's on, My access while it's off — ticked off once
they're in one.

### Changed

- **Exceptions end on their own** once the identity provider grants the same access, at the
  person's next sign-in. An exception for the role a group grants becomes that group's grant —
  no gap — and one the groups' roles already cover is ended. The person and whoever granted it
  hear about it, and a request to keep it closes as approved.
- `GET /access-requests/requestable-roles` returns `{roles, requestPolicy, joinRole}` instead of a
  bare list.
- **Exceptions are the admins', and they always end.** Only a workspace's admins let someone in
  around its identity provider — stewards point people to the group — and an exception needs an
  end date, 90 days away at most. Keeping one going, from a request to keep it or with **Change**,
  confirms it as an exception again with a new end; those requests, and their reminders, go to the
  admins only.
- **Letting someone in says what it opens.** Answering a request and **Add member** list the
  workspace's data sources, restricted ones first: any role reads all of them. Choosing **Open to
  everyone** says the same — a joiner reads restricted sources too — and, for a workspace hidden
  from Find a workspace, that anyone with a link can still join. These warn; the admin decides.

### Security

- **Only a workspace's admins change whether a data source is restricted.** The mark is what
  stops members publishing views over a source to everyone, but any member who could edit the
  source could clear it, then publish. Changing it now needs `workspace:admin` (403 otherwise);
  everything else about a source is still a member's to edit.

### Fixed

- An exception that had lapsed no longer keeps the identity provider's grant of the same role out
  for good: the provider couldn't add its own binding while the exception's row held the role.

### Upgrading

- **Run the upgrade job.** Migration `20261019_1600_access_life` adds
  `workspaces.request_policy` (every workspace starts as **Approvers decide**),
  `role_bindings.expiry_reminded_at`, `access_requests.binding_id`, `reminded_at` and
  `escalated_at`, and the `access_reviews` and `access_review_items` tables. It waits at most 5
  seconds for a lock and can simply be run again.
- The reminders run in the control plane (or the all-in-one process), hourly. Time-limited access
  already ending within a week is announced on the first pass, and requests already waiting more
  than three days — or a week — are brought up on it too.
- Downgrading drops the access reviews and every workspace's request policy; requests to keep
  access become ordinary requests for the same role.
- Exceptions granted before this release keep the end they had, or none: find any without one
  with an access review, or give it one with **Change**.

### Known limitations

- Reminders are Inbox messages only; nothing is emailed.
- Requests waiting on the identity provider aren't brought up: IT has them.
- In a workspace its identity provider controls, memberships of teams (groups managed in {brand})
  bound there still aren't policed; an access review is the way to go through them.

---

## [Unreleased] — Find a workspace, ask to join it, and see how every grant came about

### Added

**Find a workspace.** A new tab on **Workspaces** lists your organization's workspaces: what each
is for, how many people and data sources it has, who answers its requests, how people get in, and
its admins' note for people asking — with search, a filter (**All**, **Not yours yet**, **Yours**,
**Requested**) and a summary banner. Each card says where you stand: **Open**, **Waiting for
approval**, **Waiting on your identity provider** or **Request access**. It sits behind a new
switch, **Find a workspace** (`workspaceDirectoryEnabled`, **Administration → Features**), which is
off until an administrator turns it on, and a workspace's admins can keep theirs out of it. Someone
in no workspace who can't create one lands on it from **Workspaces**, and the Dashboard welcomes
them with how to join one instead of onboarding written for administrators.

**Ask to join, in one dialog.** **Request access** — on a directory card, on the page a link to a
workspace you can't open shows, on the **Access denied** card and after your access is removed —
opens a guided dialog: the level you need in plain words (**View**, **Contribute**, **Engineer the
data** or a level your organization defined; ones you hold are marked), why (under the workspace's
note), and what happens next. You hold one open request per workspace; asking again shows it.
Follow it on **My access** — **Waiting for approval**, **Waiting on your identity provider** (with
the group to ask IT for), **Approved** (what you were granted, by whom, and their note),
**Declined** (with the reason) or **Withdrawn** — and withdraw it while it's open. Answers arrive in
your Inbox, and an approval applies at once: your sessions are signed back in with the new access.

**Workspace stewards.** A new built-in workspace role, **Workspace steward** (`workspace_steward`),
is a member who also lets people in: they answer requests and add people as **Workspace viewer** or
**Workspace member** from the **Members** tab. Its permission, `workspace:members:add`, can go on
custom roles too, and `workspace:admin` implies it. Removing people, binding groups and changing
how people get in stay with admins.

**Answer requests in one place.** Approvers get a **Requests** tab on **Workspaces**, with a count,
listing the open requests across every workspace they answer (**All** keeps the history); a
workspace's **Members** tab shows its own above the members. New requests reach the workspace's
admins and stewards in their Inbox, or the Org Admins when it has neither. **Review** offers what
the workspace allows: **Grant a role** — what was asked for, or another level within what the
approver may grant, with no end date or for 7, 30 or 90 days — or **Add to a team** whose every
role the approver could grant. **Deny** takes a reason the requester sees. Nobody answers their own
request.

**Workspaces your identity provider controls.** On the new **How people get in** card (**Members**
tab, admins only), a workspace can say its membership follows identity-provider groups. Its
requests are then answered by **pointing to a group** that an access-mapping rule maps into the
workspace: the requester is told which group to ask IT for, and the request closes itself —
telling them and the approver — when a sign-in brings the access. Letting someone in without the
group is an **exception**: granted for 30 days unless the approver chooses otherwise, and labelled
wherever access is listed; **Add member** asks for it to be ticked too. The same card lists the
workspace in Find a workspace or hides it, and holds the note for people asking.

**How every grant came about.** **People with access**, **My access** and **Administration →
Permissions → By user** mark each grant **Added directly**, **Approved request**, **Exception**,
**Identity provider** (with the groups and provider), **Team** or **Organization-wide**, with who
and when on hover. **People with access** also lists, and counts, the Org Admins and Super Admins
who reach every workspace.

**For integrators.** New: `GET /api/v1/workspace-directory` (behind the switch),
`GET /api/v1/access-requests/requestable-roles?workspaceId=`,
`POST /api/v1/me/access-requests/{id}/withdraw`,
`GET /api/v1/admin/access-requests?status=open|all&workspaceId=`,
`POST /api/v1/admin/access-requests/{id}/route` and
`GET /api/v1/admin/workspaces/{id}/members/grant-options`.
`POST /api/v1/admin/access-requests/{id}/approve` takes `role` or `groupId`, `expiresIn` or
`expiresAt`, `exception` and `note`. Workspaces carry `directoryListed`, `accessMode` and
`accessNote`; access requests carry the decision (`grantedRole`, `grantedGroup`, `idpGroup`,
`idpProvider`, `idpException`, `accessExpiresAt`, `fulfilledAt`); access grants carry
`provenance`. The activity log adds `rbac.access_request.withdrawn`, `.routed` and `.fulfilled`.

### Changed

- **The Members tab opens to stewards** (`workspace:members:add`), as do
  `GET`/`POST /api/v1/admin/workspaces/{id}/members` and `/members/effective`. Revoking, changing an
  end date and the revoke preview still need `workspace:admin`.
- **Add member** picks people from the directory for anyone who isn't a Super Admin — the list used
  to stay empty for them — and offers only the roles the caller may grant. Adding someone whose
  earlier grant had ended gives it back, and in a workspace its identity provider controls, adding
  a person needs `exception: true`.
- **Approve** grants only what the approver may grant, refuses requests for roles that run the
  workspace or let others in, and makes a lapsed grant current — it used to mark the request
  approved and leave the person without access.
- **A workspace's request list** (`GET /api/v1/admin/workspaces/{id}/access-requests`) returns open
  requests by default — waiting for approval or on the identity provider — where it returned
  pending ones.
- **The Access denied card's request form** is the new dialog; the old one couldn't list roles for
  most people.
- **A requester sees a workspace's name** only if they can open it or it is listed in Find a
  workspace while that is on — on the request, in the Inbox and on My access.

### Fixed

- The activity log names the workspace of an access request; it read a key the events never
  carried.
- Analytics' access-friction backlog counts requests waiting on the identity provider as open, and
  leaves withdrawn ones out of the wait.
- Deleting a workspace declines its open access requests ("The workspace was deleted") instead of
  leaving them waiting.
- My access no longer lists grants that have ended.
- A link to a workspace you can't open says so, and offers **Request access**; the page used to
  show its loading skeleton for good, and **Access revoked** could never appear either.
- My access no longer flashes an **Access denied** card at people who can't read the permission
  catalogue — most people — on every visit.

### Upgrading

- **Run the upgrade job.** Migration `20261019_1000_ws_access` adds `workspaces.directory_listed`,
  `access_mode` and `access_note`; the decision columns and the `awaiting_idp` and `withdrawn`
  statuses on `access_requests`; `access_request_id` on `role_bindings` and `group_members`, and
  `role_bindings.idp_exception`; and the `workspace:members:add` permission (granted to Org Admin
  and Super Admin too) with the **Workspace steward** role. Where one person has several pending
  requests for the same workspace, the newest stays and the rest become **Withdrawn**, before an
  index allows one open request each. It waits at most 5 seconds for a lock and can simply be run
  again.
- **Find a workspace is off.** Turn it on when you're ready for everyone who can sign in to see
  every workspace's name, description and approvers — except those their admins hide. Hide
  workspaces whose names are sensitive first.
- Before switching a workspace to **Through your identity provider**, write an access-mapping rule
  that reaches it; without one, every answer is an exception.
- Downgrading turns requests waiting on the identity provider back into pending ones and withdrawn
  ones into denied; the steward role is removed only when nothing is bound to it.

### Known limitations

- Exceptions don't end when the person later joins the group: remove them from **People with
  access** once the group has caught up.
- In a workspace its identity provider controls, memberships of teams (groups managed in {brand})
  bound there aren't policed.
- Pointing to a group needs an access-mapping rule for the workspace and a single sign-on sign-in;
  the approver is warned about someone who has never signed in that way, not stopped.
- Find a workspace lists every workspace that isn't hidden, to everyone who can sign in; it can't
  be narrowed to some groups.

---

## [Unreleased] — Layout templates: reuse a Context View's layers, for yourself, your team or everyone

### Added

**A Templates library.** **Templates** in the sidebar holds every layer layout you can start a
Context View from: the built-ins that ship with {brand}, your organization's, your workspaces', your
own and the ones shared with you. Tabs count each collection (**All**, **Mine**, **Shared with me**,
**Workspace**, **Organization**, **Built-in**); search covers names, descriptions and layer names;
categories and sorting (recently updated, most used, A–Z) narrow the rest. Each card shows the
layout's columns in their colours, who it is for, who made it and how many of the views you can open
were built from it, and offers only what you may do with it. Open one for every layer — its entity
types, rules and groups — who can use it, and the views built from it. A banner at the top sums up
the library, like the ones Explore and Workspaces open with: templates, the views using them, this
week's updates, your favorites and, for managers, the requests waiting on them, each tile one click
from what it counts.

**Make, edit and duplicate in a guided studio.** **New template** starts blank, from another
template or from one of your Context Views; then name it, shape its layers (order, colour, icon,
description, and the entity types each column collects, suggested from your semantic layers),
choose who it is for and check it before saving. A view's layers can also be kept as a template
from the Context View's import/export menu (**This view → Save layers as a template…**), the
Explorer card's menu and the view wizard's Layout step. A template keeps a view's structure and
never the entities it placed: column anchors, hand placements and exact-URN rules stay behind.

**For yourself, a workspace, the organization — and teams.** A **Personal** template is yours; a
**Workspace** template is everyone's in that workspace; an **Organization** template is everyone's,
curated by people with the new **Manage templates** permission (`system:templates:manage`, held by
Super Admins and Org Admins, and delegable). Share a personal or workspace template with
people or groups — a share with a group is how a team gets its own — to use it or also edit it;
they find it under **Shared with me** and hear about it in their inbox. Administrators do not see
anyone's personal templates: a template is a layout, not data, and there is nothing behind it to
audit.

**Built-ins belong to the product.** Seven ship — Data Engineering Flow, Analytics Pipeline, Data
Mesh, ETL Classic, Medallion, Source to target and Data flow — refreshed by every upgrade and
read-only: duplicate one to change it. A template manager can hide one for everyone, and bring it
back with **Show hidden built-ins**.

**Use template.** From a card, a template's details or the Dashboard, **Use template** opens the
view wizard with its layers on the Layout step. That step offers the whole library beside what your
data suggests and says how well each template fits ("Matches 3 of 4 layers"); applying one keeps
every structural field, resolves its entity types to your semantic layer's spelling and names the
types it couldn't match, instead of leaving columns silently empty. The new view records where it
started — its details read **Layers started from …** — and the template counts the views built from
it.

**Delete, with Undo.** Deleting a template first says how many views were built from it (they keep
their layers) and who loses it, and can be undone for a few seconds afterwards: it comes back with
the same shares.

**Versions, and updates that reach the views built from a template.** Changing a template's
layers makes a new version — the studio asks **What changed?** and can tell the people whose views
were built from it — while a rename does not. Every version stays readable: a template's details
list them with their notes, compare any with the current one, and let its editors **Restore** one.
A view records the version it was built from, and each of its columns the template layer it came
from, so when the template moves on, people who can edit the view see **v3 available** and can
**Review update**: what only the template changed is taken, what only the view changed is kept,
both-changed fields keep the view's value unless you choose the template's, and a layer holding
placed entities or edited in the view is never dropped unless you say so. **Apply** saves a version
of the view (*Template update applied*) with **Undo**; **Keep my layers** marks it up to date.

**Featured, favorites and recently used.** Template managers feature built-ins and organization
templates; the library opens on a **Featured** shelf and a **Recently used** one (the templates you
last built a view from), and the Dashboard lists featured templates first. A heart makes a
template one of your **Favorites**, a new tab.

**How well each template fits your data.** **Fit for** puts a ring on every card — how many of its
layers find their entity types in a workspace's data, starting with the active one — and **Best
match** sorts by it. **Recently used by me** is a sort too.

**Offer a template to everyone.** The owner of a personal or workspace template (or anyone who may
change who can use it) can ask for it to become an Organization template. Template managers hear
about it, may read it until one of them answers — from its details or the new **Requests** tab —
and approve it (it becomes theirs to look after) or decline it, with a note for whoever asked.

**A workspace's default template.** A workspace admin can make a built-in, an organization
template or the workspace's own the one its new views start from. The wizard opens with it
applied and offers **Start empty instead**; the template's card reads **Default · Finance**.

**Templates as files.** **Export as file** saves a template's layout — name, description, category
and layers, nothing more — as `<name>.layout-template.json`; **Import** on Templates (or
`/templates?import=1`) reads one, shows its layers and how they fit your data, keeps a name your
library already has apart, and asks who it is for.

**Preview with real data.** The studio's Layers and Review steps can fill each column with a few
real entities from a workspace you can read, placed the way a view built from the template would
place them, with how many there are in all.

**Faster to find and to shape.** On Templates, `/` searches, `n` starts a template, `i` imports
one, the arrow keys move between cards, `Enter` opens one, `u` starts a view from it, `f` makes it
a favorite and `?` lists them all. In the studio a layer moves by its handle — dragged, or
`Alt`+`↑`/`↓`. The command palette offers **New layout template**, **Import a layout template**
and **Browse templates**.

**One switch for all of it.** **Layout templates** (`layoutTemplatesEnabled`), under
**Administration → Features → View Modes**, turns templates on or off for everyone. It ships on.
Off, **Templates** leaves the sidebar, the Dashboard, search and the command palette, the View
wizard offers only the layouts the data suggests, **Save layers as a template** and template updates
disappear from views, and the server refuses every template route and
`PUT /api/v1/views/{id}/template-version` (`403`, `feature_disabled`). Nothing is deleted: views built
from a template keep their layers, and turning it back on brings every template back as it was.

**The API.** `/api/v1/layout-templates` lists the templates you can use (`includeHidden` adds the
hidden built-ins, for managers), reads, creates, edits (partially; changing who can use one needs
rights over its current audience and the new one), deletes and restores them, hides or shows a
built-in, and manages shares. It also lists and restores versions (`/{id}/versions`), features
(`PUT /{id}/featured`), favorites (`POST|DELETE /{id}/favourite`), and handles requests to offer a
template to everyone (`POST|DELETE /{id}/promotion-request`, `…/approve`, `…/decline`,
`GET /promotion-requests`). A template carries `version`, `featured`, `isFavourite`, `lastUsedAt`,
`defaultFor` and, for those it concerns, `promotionRequest`. `PUT /api/v1/views/{id}/template-version`
marks a view up to date with its template; `PUT /api/v1/admin/workspaces/{id}` takes
`defaultLayoutTemplateId`. Every change is recorded in the activity log
(`visualization.layout_template.*`). API keys can't call these routes.

### Changed

- **The Dashboard's template section** shows the library's most used templates, each one click from
  a new view, with **Browse all**. A template in search results opens the template, instead of
  scrolling the Dashboard. The onboarding step **Start a view from a template** opens the library
  and is ticked when a view is created from one.
- **Creating a view keeps `contextModelId` only when its creator can use that template**; any other
  id is stored as none, where it used to fail on the database's foreign key. A view built from a
  template also records `contextModelVersion`.
- **A view's `contextModelName`** no longer names a deleted template, or someone else's personal
  one, and the Explorer card no longer shows a template's name where the view's semantic layer
  belongs.

### Removed

- `GET|POST|PUT|DELETE /api/v1/admin/context-model-templates` and
  `GET /api/v1/{ws_id}/context-models/templates[/{template_id}]` — use `/api/v1/layout-templates`.
  The workspace route returned every template whatever its workspace, and API keys could read
  templates through it; they no longer can.

### Upgrading

- **Run the upgrade job.** Migration `20261018_1200_layout_templates` adds
  `context_models.system_key`, `deleted_at` and `deleted_by` with a unique index on `system_key`,
  lets `resource_grants` hold `layout_template` shares, and grants `system:templates:manage` to
  Super Admin and Org Admin. Every existing template becomes an Organization template, and the four
  the old seeder wrote become built-ins (for each name, its oldest row). It waits at most 5 seconds
  for a lock; if it gives up, nothing has changed and you run it again.
- On start, the server adds the three new built-ins and refreshes the others. A built-in someone
  hid stays hidden.
- Migration `20261018_1300_tpl_lifecycle` adds template versions (`context_models.version` and
  `layout_template_versions`, with version 1 recorded for every existing template), favorites
  (`layout_template_favourites`), the columns for requests to offer a template to everyone,
  `views.context_model_version` (1 for views already built from a template) and
  `workspaces.default_layout_template_id`, and lets a view version's source be `template`. Like the
  migration before it, it waits at most 5 seconds for a lock and can simply be run again.

### Known limitations

- Deleted templates are kept — for Undo, and for the views that name them — and never purged.
- The shares of a deleted workspace's templates stay in `resource_grants`, as a deleted view's do.
- The studio edits layers; rules and logical groups are kept as they were authored on the canvas.
- Entity types match by name: a template written for another semantic layer fits only where the
  type names agree, and the wizard says which ones don't.
- Someone whose share of a workspace template was taken away may still be told about its next
  version; nobody is told about a personal template's.
- Applying an update to a view is two requests. If the second fails, the view has the new layers
  but still offers the update: review it again (there is nothing left to change) or **Keep my
  layers**.
- The live preview shows at most 6 entities of each of 8 entity types.

---

## [Unreleased] — The Dashboard, Workspaces and Administration quote the same numbers

### Added

- **The Dashboard's cards show how their numbers moved.** Each carries a 30-day sparkline and its
  change ("+3 in 30 days"), from `GET /api/v1/admin/workspaces/summary/trend` (the summary's totals
  day by day, a shared graph counted once). A click opens what is behind the number: sources ranked
  by size, with their status and **Refresh stats** for those who run them; the most favorited,
  recently updated and your recent views; workspaces; semantic layers.
- **Needs attention.** For people who can read profiling and turn it on, the Dashboard lists the
  worst open findings — a source far outside its usual movement, a vanished type, a silent source —
  with **Open** and **Mark seen**. It's off by default, because the Dashboard is where business
  users land: **Preferences**, a new page in the profile menu, turns it on for that browser.

### Fixed

- **One set of numbers.** The Dashboard, **Workspaces** and **Administration → Global Overview**
  now read one server summary (`GET /api/v1/admin/workspaces/summary`), so they agree on workspaces,
  data sources, entities, relationships and views. The Dashboard used to count workspaces and
  sources from a list loaded once at sign-in, take every workspace's views from whichever workspace
  was active, and add up graph sizes its own way.
- **A graph used by several workspaces is counted once** in the totals, and the overview says so.
- **Views are the views you can open**, counted exactly as the Explorer counts them — in total, per
  workspace and per data source.
- **A source still being measured** is left out of the sums and shown as *counting…*; the totals
  fill in on their own.
- **Paused sources no longer read as active** ("3 of 4 sources active"), and the hard-coded
  "· 1 active" is gone.
- **"Data Assets" is now "Data Sources"**, with its entities and relationships beneath — the same
  figures as Administration's.
- **Large numbers read the same everywhere**: 1,500 is "1.5k" on every page (the Workspaces list
  said "2k"), and 999,999 is "1.0M", not "1000k". A real zero reads "0"; a dash now means a source
  is still being counted.
- **When the overview can't be loaded**, Administration says its counts are unknown instead of
  showing zeros.
- **Reset to default keeps a built-in role's permissions.** Resetting Super Admin, Org Admin or Org
  Auditor dropped **Analytics**, **Publish views** and (Super Admin) **SSO hosts**, and those roles
  read as **Customized** when nobody had touched them.
- **The workspace list's view counts** are the views you can open; they counted every view.
- **Analytics' "Context models" is now "Layout templates"**, counting the templates people made —
  not built-ins, not deleted ones.

### Changed

- **Org Admins and Org Auditors see every workspace** — in the workspace list, on
  workspace pages and in the totals — not only the ones they are bound to, matching what their roles
  already let them do there.
- **Your business areas shows four workspaces at a time** — one full row on a wide screen, two rows
  of two on a laptop — instead of six that left the last row half empty.

### Upgrading

- A built-in role that was reset to default before this release lacks the permissions above and
  now reads **Customized**: choose **Reset to default** again to restore them.

---

## [Unreleased] — API keys: scripts and services that act as you, limited to what you choose

### Added

**API keys.** Anyone can create a key under **Account → API keys** (or **API keys** in the menu
under their avatar) that lets a script or a service call the API as them — people who sign in
through an identity provider and have no password included. A key reaches everything its owner
can, or only chosen workspaces, views and data sources, and may read, or read and change, views
(with or without publishing to everyone) and data. On anything it reaches it may do what its owner
may do there at that moment, never more: access taken from a person is taken from their keys
within 30 seconds.

**Made in five guided steps.** **Purpose** starts from the job — *Read data for reporting*, *Load
data and signal refreshes*, *Publish views from CI* or *Custom* — and names the key; **Reach**
recommends the narrowest choice; **Permissions** says what each level lets a script do;
**Safety** sets the expiry (shown as a date; never only where the deployment allows it) and
networks, offering the address you are calling from; **Review** shows how exposed the key would be
and what it could do right now, checked by the server exactly as creating it is
(`POST /me/api-keys/preview`, which creates nothing). Creating, rotating or renewing a key asks for
the password, or for a sign-in the identity provider dated within the last 15 minutes — or, through
an Enterprise gateway, the gateway's word that the company sign-in is still live. The key is
shown once, with snippets for cURL, Python, JavaScript and `.env`, and the page waits for its first
call.

**Every key, at a glance.** Each key is a card: its status, what it reaches, when it expires,
when and from where it was last used, and its requests per day over two weeks. Open one for what it
can do right now per workspace, view and data source, 30 days of use with refusals and errors, and
the key it replaced or was replaced by. **Edit** renames a key or says what it is for; **Rotate**
makes a new token with the same access and keeps the old one working for up to a week (a key is
replaced once); **Renew** gives an expired key a fresh token; **Revoke** ends it at once. Ended keys
stay listed for 90 days.

**Scripts send one header.** `Authorization: Bearer nxpat_…` replaces the cookie jar, the CSRF
header and renewal. `GET /api/v1/api-keys/self` says what a key is and when it stops working;
`DELETE /api/v1/api-keys/self` revokes it, for whoever holds it, even when it is paused or expired;
and every answer carries `X-API-Key-Expires-At`. Keys are for the data plane — views, graphs,
version control, data-source signals and jobs. The API reference marks each operation a key may
call, and every other route answers `403 api_key_not_allowed`.

**Paused, not forgotten.** The keys of someone who signs in through an identity provider pause when
they haven't signed in there for 30 days, and resume at their next sign-in, so the keys of someone
who has left stop without anyone remembering them. A suspended account's keys stop at once.

**Administration → API keys** opens on counts that filter the list — active, expiring within 7
days, never expiring, unused for 90 days, paused — with tabs for every status, search by key or
owner, and sorting by name, last use, expiry or creation. Open a key for its owner, access, usage,
lineage and everything it did (**Its activity**); revoke it with a note its owner sees, or all of a
person's; **Export CSV** downloads the list as filtered, up to 10,000 keys. The access drawer on
**Administration → Users** links to a person's keys. Seeing keys needs `system:audit:read`;
revoking needs `system:users:manage`. Four switches under **Administration → Features →
Authentication** govern keys: **API keys**, **Longest an API key may live**, **Pause keys of
people who stop signing in** and **Accept a fresh sign-in round trip for API keys** — off by
default, it lets people on portal connections, which can't date a sign-in, make keys.

**Enterprise gateway users make keys with nothing to switch on.** When this server can reach the
gateway (server exchange with an ambient token), creating or rotating a key asks it, then and
there, whether the company session behind the request is still live: confirmed makes the key, ended
signs in through the gateway again without leaving the page, and no answer makes nothing (`503
gateway_unreachable`; try again). No database connection is held while the gateway answers. Where
only the browser reaches the gateway, a sign-in through it in
the last 15 minutes counts, and an older one signs in through it again the same way. The request is
sent again only if the same person is still signed in. Every key's record says how it was
confirmed.

**Reminders and alerts.** A key's owner hears in their inbox a week before it expires, when an
administrator revokes it (with their note), and when a revoked key is presented again or a key is
used from a network it isn't limited to — even when it only asks about itself.

**Key traffic on your dashboards.** `api_key_requests_total{outcome}` on the API's `/metrics` counts
every request made with a key: accepted, or the code it was refused with. A wave of paused keys, a
stranger guessing tokens or key checks failing can now raise an alert, and Observability suggests
three. The count is never per key, so the series stay bounded; each key's own use is under
**Administration → API keys**.

### Changed

- **The API Guide leads with keys.** It, and the search and versioning references, show the key
  first and say which routes still need a password session. Scripts that sign in with a password
  keep working unchanged.
- **Sign out everywhere** and **End sessions** say that API keys keep working, and where to revoke
  them.
- **`publish_view_library.py` takes an API key.** With `SYNODIC_API_KEY` set, the view library
  publisher checks the key and sends it instead of signing in, so it works where password sign-in
  is off. The key is read only from the environment, never from the command line. Without one, it
  signs in with an email and password as before.

### Security

- **A graph import no longer rewrites a view its caller can't edit.** An import's `?viewId=` made
  the import rewrite that view's layout, while the route checked only that the caller could manage
  the data source — so it reached any view on the platform. The view must now be live, in the
  import's workspace, and editable by the caller (`create_import`, `complete_import_upload`).
- **Everything a key does is attributed.** Every change made with a key is on **Administration →
  Activity** with its owner as the actor and the key named — filter by the key, or open **Its
  activity** on it — including what the control plane does for the request; an aggregation run a
  key starts is recorded as started through the API. The access log records `authMethod=api_key`
  with the key's id. Creating, renaming, rotating and revoking keys, and keys refused or misused,
  are in Activity under Identity and on the owner's **Recent activity**.
- **A search can't read a view its caller can't open.** A view named in a search's body
  (`/graph/search/advanced`, `/graph/search/explain`) was used without checking the caller could
  open it, and `explain` returned its roots, types and layers. It now needs the same access as
  opening the view.
- **A job's event stream belongs to its data source.** `GET /admin/data-sources/{ds}/aggregation-jobs/{job}/events`
  streamed any job named in the path, whatever data source the caller was checked against. A job
  of another data source is now `404`.
- **A draft is reached through its own graph.** A merge preview and a draft's view changes
  (`/versioning/graphs/{graph}/branches/{branch}/merge-preview`, `/view-changes`) did not check that
  the draft belonged to the graph in the path, or that the caller could read it. Both now do.
- **Signing in through an identity provider proves when.** The session records whether the
  provider itself dated the sign-in (`auth_time_proven`), and keeps that through every renewal. A
  sign-in it re-issued silently, or dated too long ago to use, does not count as a fresh one, and
  only OIDC and SAML can prove one: a portal's `auth_time`, which it maps from its own payload,
  never does. The session also names the provider it came from (`idp`), so a confirmation is asked
  of that provider.
- **A password confirms a key only while password sign-in is on.** With **Passwords** switched off,
  a password session — including one opened through the emergency window or the Super Admin
  outage door — can't create, rotate or renew a key: refused before the password is checked
  (`step_up_unavailable`, reason `passwords_off`), so a key never outlives the emergency it was
  made in. The create form says so up front.
- **A break-glass account holds no keys.** Like a cloud account's root user, the account kept for
  when nobody else can sign in shouldn't have anything running as it: a system account can't
  create, rotate or renew a key, however it signed in (`step_up_unavailable`, reason
  `system_account`), and keys it made before it was marked stop while it is one
  (`api_key_owner_inactive`) and work again if the mark is removed. Nothing is revoked. The
  inventory's **Owner suspended** tab is now **Owner inactive**. The seeded administrator is
  marked on a fresh install, so make keys from a personal account.
- **Nothing waits on an identity provider that is down.** While the reachability prober has the
  session's provider confirmed down, creating, rotating or renewing a key through it is answered at
  once — `503 idp_unreachable` with `Retry-After`, and no sign-in link — rather than asking a gateway
  that can't answer (holding the request for up to 10 seconds) or
  sending the person to an error page or the sign-in page's password doors. The create form says so
  up front, and **Sign in to resume** is hidden until the provider is back. A sign-in the provider
  proved in the last 15 minutes still counts.
- **With Passwords off, a password is no way back in.** A key pauses when its owner has no way to
  sign in; an owner with no single sign-on identity now has none while **Passwords** is switched
  off — the emergency window closes, so it doesn't count — and their keys pause
  (`owner_reauth_required`) until passwords come back on or they sign in through single sign-on.
  Nothing is revoked. Requests read the switch from the cached sign-in posture, within 30 seconds;
  a server that can't read the posture and has none cached takes passwords as on. The owner's page
  and the inventory show the keys as paused.
- **Secret scanners can stop a key being committed.** The API Keys guide gives the pattern every
  key matches, `nxpat_[0-9A-Za-z]{38}`, to add to GitHub secret scanning with push protection,
  gitleaks or GitGuardian. A test keeps it matching what the server issues. The guide also says a
  key is read only from `Authorization`, so a proxy that sets or strips that header stops keys.

### Upgrading

- **Run the upgrade job.** Migrations `20261012_1000_api_keys` and `20261013_1000_api_key_usage`
  add the `api_keys` and `api_key_usage` tables; `20261013_1100_merge_api_keys`,
  `20261014_0600_merge_key_filters` and `20261014_1100_merge_sso_keys` join them to `main`'s chain;
  `20261013_1300_api_key_scale` indexes `user_identities (user_id, last_login_at)` and a key's
  successor; and, last, `20261014_1200_aal_api_key` adds `auth_audit_log.api_key_id` and a partial
  index on it (`20261013_1200_activity_api_key` now builds nothing).
- **The upgrade is one transaction, and waits at most 5 seconds for any lock.** If it fails or gives
  up — a long-running reader, such as an activity export, holding a table it needs — nothing has
  changed, servers still on the previous version keep working, and you run it again. Every lock is
  held until it commits. Measured on Postgres 16 with 10 million activity events, 100,000 people
  and a million SSO identities, the whole upgrade took 6.7 seconds: sign-ins (which write `users`
  and `user_identities`) waited up to 4 seconds, and the activity log, changed last, was unreadable
  for 1.5 seconds at the end.
- **Keys are on for everyone.** To hold them back, switch **API keys** off under **Administration →
  Features → Authentication**; people can still see and revoke their keys while it is off.
- **Two optional settings:** `RATELIMIT_API_KEY` (1200 requests a minute per key) and
  `RATELIMIT_API_KEY_FAILURES_PER_IP` (120 lookups of unknown keys a minute per address).
- **Name your proxies.** Behind a proxy, `FORWARDED_ALLOW_IPS` must name exactly it: too narrow and
  a key limited to networks sees the proxy's address; as wide as the shipped Compose and
  Kubernetes settings (every private range) and a client inside them can claim any address.
- The control plane runs one more hourly sweep, for expiry reminders and to drop usage counts
  older than 90 days. Every API process writes its keys' usage counts every 30 seconds.

### Known limitations

- **No service accounts.** A key acts as the person who made it and stops when they leave. An
  integration that must outlive a person waits for service accounts, which this is built to take
  ([ADR-027](/docs/decisions#adr-027-personal-api-keys-scoped-per-resource)).
- **Data sources have no grants of their own.** A key's data access follows its owner's workspace
  roles, or reads a data source through a view its owner can open.
- **Keys can't call** administration, sharing, settings, the inbox, inspecting or importing a view
  file, data-source administration beyond signals and jobs, or creating a version-controlled graph.
  Use a password session for those.
- **Signing out everywhere, changing a password and End sessions leave keys working**, by design:
  revoke a key you no longer trust.
- The refresh audit (`refresh_events`) and graph commits record a key's owner, not the key.
- **Usage counts are best-effort.** A process that stops abruptly loses up to its last 30 seconds
  of counts, and a streamed response is counted when it starts.
- **Portal sign-ins can't make keys** unless an administrator turns on **Accept a fresh sign-in
  round trip for API keys**, and an Enterprise gateway that doesn't answer stops its users making
  keys until it does.
- **The inventory's counts take a moment on a large deployment.** A key's status depends on its
  owner's latest identity-provider sign-in, read for every owner: measured on Postgres 16, the
  counts take about 0.4 seconds at 100,000 keys from 30,000 owners with a million identities.

---

## [Unreleased] — Single sign-on first, with a way in when the identity provider is down

### Changed

**The sign-in page leads with single sign-on.** With a connection live, the first thing on the
page is **Continue with** the primary connection — the first in login-page order (**Priority**,
lowest first), marked **Primary** in Administration → SSO → Providers. Typing an email and pressing
Enter routes it: to the connection whose **Email domains** list its domain, otherwise to the
primary. Enter no longer trips the browser's "please fill in this field" on a password nobody
needed, and **Ask for an email first** no longer answers an unmapped domain with "We don't
recognise that email's domain". Passwords are the deliberate fallback: while **Passwords** is on,
**Can't use single sign-on? Sign in with email and password** opens a password step that carries
the email and works with password managers, and it is offered prominently whenever a single
sign-on attempt fails. Deployments with no connection keep the single email-and-password form.

**Turning Passwords off needs a ready break-glass account.** The switch is refused until an
active Super Admin with a password is marked as a system account — the door that survives an
identity-provider outage. Administrators without an SSO identity — Super Admins and org admins —
are no longer a hard refusal: the confirm lists them by name and role, each with **Make
break-glass**, and **Turn off anyway** proceeds. Both
checks run on the switch-off only, so saving another switch while passwords are off is never
blocked by them. The last ready break-glass account cannot be unmarked while passwords are off.

**A refused password sign-in looks like a wrong password.** While passwords are off, an account
that may not use one now gets `401 "Invalid email or password"`, after a password check that costs
the same, instead of `403 local_login_disabled` — so the form cannot be used to find out which
accounts are break-glass accounts or Super Admins. The activity log still records
`local_login_disabled`. Password sign-up keeps its 403.

### Added

**Automatic fallback when an identity provider goes down.** The control plane checks every OIDC,
SAML and Enterprise gateway connection each minute — the discovery document and signing keys, the
single sign-on URL, or the gateway URL through the back-channel allowlist — and confirms an outage
only for a connection it has seen working, after three minutes of failure on fresh evidence; it
ends after five minutes of health. While one lasts:

- the sign-in page says *We can't reach {connection} right now*;
- Super Admins with a password can sign in with it, through **Administrator sign-in**, so somebody
  can always get in to support everyone else — break-glass accounts always could;
- people already signed in through that connection keep working past their daily
  re-authentication, for up to a day more, instead of being sent to an IdP that cannot answer;
- through an Enterprise gateway, sessions keep their outage grace as before, and the ones that
  end land on the sign-in page with the notice instead of the gateway's own sign-in. The page's
  automatic gateway sign-in, and the app's in-place re-sign-in, skip a gateway that is down
  instead of waiting on it.

Browser reports never count, and when detection is not running nothing opens by itself.

**Emergency password access.** Administration → SSO → Settings opens password sign-in to everyone
for 1 to 24 hours, with a reason; it closes itself, and **Close now** ends it early. While it is
open, **Extend** keeps it open for up to 24 hours from now — as often as an outage needs, never
more than a day ahead, so somebody decides again at least daily; extended before it lapses,
nobody who signed in through it is sent back to a dead identity provider. Sessions opened
through it, or by a Super Admin during an outage, end at their first renewal once single sign-on
is back — usually a brief redirect that lands people where they were — and never last more than a
day. The same page shows **Single sign-on status** (what detection last saw, and when it is not
running), **Break-glass accounts** and their readiness, and the admins a switch-off would affect.

**One command when nobody can sign in.** `python -m backend.scripts.reset_admin_password --email …
--break-glass` sets a password, marks the account as break-glass, clears its failed sign-in count
and signs its old sessions out — then sign in at `/login?password=1`.

**Outages and fallback sign-ins in the activity log, said as what happened.** An outage
confirmed and over (`idp.outage.detected` / `resolved`); the emergency window opened, extended,
closed early or closed by itself at its deadline (`auth.config.password_fallback_opened` /
`_extended` / `_closed` / `_expired`), with who did it and the reason in the log's *why*; each
password sign-in made while passwords are off, by its door — *Signed in with a password through
emergency access*, *…while single sign-on was down (Super Admin)*, *…with a break-glass account's
password* (`via` on `user.logged_in`; the SSO activity tab shows it as the row's reason); each
session kept past its daily re-authentication because its IdP was down, once per session
(`user.sso_reauth_deferred`); each emergency session that ended, and why; and accounts made or
no longer break-glass, including from the command line.

**Settings changes say what changed.** `auth.config.updated` records which switch moved, before →
after (*Passwords turned off — break-glass accounts only*), not only the values after the save. A
connection edit (`idp.provider.updated`) names the settings that changed — names only, never
values — and, before → after, whether it was turned on or off, its linking policy, its rating, and
**Link Super Admin and break-glass accounts too**.

**How to get a connection to Verified, and how to trust your corporate CA.** Running Single
Sign-On → *Getting a connection to Verified* says what decides each connection's rating and walks
an unsigned Enterprise gateway to Verified step by step — including keeping the same subject so
people already linked are still recognised. Deployment → *Corporate TLS trust for SSO* covers
building and checking the PEM bundle, setting it on both services that need it for Compose,
Kubernetes and Helm, rotating it, and what the logs say when it cannot be loaded.

### Security

**An unverified connection can no longer claim a Super Admin's or break-glass account.** Its
claims — `email_verified` included — are whatever the sender wrote, yet under an auto-linking
policy (**Strict**, the default) a hand-written payload naming an existing account's email
linked to that account — the break-glass Super Admin among them — for anyone able to reach the
sign-in endpoint. A connection below verified now never links itself to a system (break-glass)
account or one holding `super_admin` (`unsafe_auto_link`, reason `unverified_connection`);
Super Admins link it from their own account page. Every other account still links — an org
admin's included, since `org_admin` has neither `system:admin` nor user management — new
accounts are still created, and people already linked still sign in, so an unsigned gateway
keeps working as before for everyone it was trusted for: the risk its card states (and can now
fold away once read). An operator who accepts the risk for Super Admins and break-glass accounts
as well turns on **Link Super Admin and break-glass accounts too** on the connection — offered
on any connection below Verified, Unverified or Asserted — and every existing account links as
before.

**Only a Super Admin changes who is in a group that grants Super Admin.** Org admins manage
groups, and a member inherits every binding its group holds, so an org admin could add themselves
— or anyone — to a group bound to `super_admin` and so make a Super Admin. Adding or removing
members of such a group, or deleting it, now needs `system:admin` (403
`group_grants_super_admin`); every other group is managed as before. It matters more now that an
org admin's account links through a connection below Verified.

### Fixed

- **Two first sign-ins for the same person at once** — tabs restored together, each running the
  automatic gateway sign-in, or a double submit — no longer fail with "Database is temporarily
  unavailable" (`duplicate key value violates unique constraint "uq_users_email"` in the log). The
  second reads again and signs in to the account the first created; a conflict that survives the
  re-read is refused as `account_conflict`, with a reference, like any sign-in that cannot complete.
- **`SSO_OUTBOUND_TLS_CA_CERTS` adds your corporate CAs to the public roots** instead of
  replacing them. A bundle holding only the corporate chain — the documented way to use it — used
  to make every public identity provider (Entra, Okta) fail TLS the moment it was set.
- **An Enterprise gateway whose exchange runs in the browser** no longer shows *No gateway_url
  configured; this provider cannot sign anyone in* on its card. That shape has no gateway URL by
  design: the health check now looks at the browser exchange URL and, when the connection verifies
  against one, whether its JWKS URL is an allowed destination.
- **An unverified connection's warning says why, and how to fix it.** Instead of the same sentence
  for every case, the card names the setting to blame — *Trust unsigned*, TLS verification off, an
  unsigned portal payload — and what to change, with **Open its settings** beside it.
- Starting a sign-in against an identity provider whose discovery or metadata cannot be fetched
  lands on the sign-in page with a reference (`idp_unreachable` in the activity log), instead of a
  bare `503` JSON body.
- Turning **Passwords** off showed only a toast when Super Admins had no SSO identity; the list
  of who now reaches the page.
- `POST /auth/resolve` answers whenever single sign-on is on, not only under **Ask for an email
  first**; misses still all look the same.
- The IdP health card no longer claims the signing keys were checked when only the discovery
  document was fetched.

### Upgrading

- **The sign-in page changes for every deployment with a live connection.** It leads with single
  sign-on; people who sign in with a password use the password link. Set **Priority** so the
  connection most people use is first.
- **Super Admins with a password can sign in during a confirmed outage even while passwords are
  off.** If that is not acceptable, remove their passwords and keep break-glass accounts only.
- **Clients that read `403 local_login_disabled` from `POST /auth/login`** now get the `401` a
  wrong password gets.
- **Passwords off without a break-glass account** stays off; the new check applies to the next
  switch-off. Check **Break-glass accounts** on the Settings page.
- **A Super Admin or break-glass account first signing in through an unverified connection**
  (an unsigned portal, a gateway trusting unsigned replies) is now asked to link it from their
  account page instead of being linked automatically. Everyone else, org admins included, links
  as before; a Verified connection links Super Admins automatically too. To keep the old
  behaviour on an unverified connection, turn on **Link Super Admin and break-glass accounts
  too** under its **Identity**. The same holds for an Asserted connection (a portal reading a
  proxy's header).
- **Set `SSO_OUTBOUND_TLS_CA_CERTS` on `aggregation-controlplane` as well as `viz-service`.**
  The outage prober runs there; without the bundle it can never reach a connection behind your
  corporate CA, so it never confirms that connection's outage. A bundle is read once per
  process: after replacing it at the same path, restart both. Deployment → *Corporate TLS trust
  for SSO* has Compose, Kubernetes and Helm steps.
- The migration `20261014_1000_sso_fallback` adds three nullable columns to `app_auth_config`
  and the `idp_provider_reachability` table.

### Known limitations

- Portal and dev connections, and gateways whose exchange runs in the browser, are not probed:
  cover their outages with the emergency window.
- Each Enterprise gateway in server mode receives one request a minute with no session handle;
  a 401 or 405 reads as healthy. The integration contract tells gateway teams.
- Anyone able to make the IdP unreachable from the server can open the password door for Super
  Admins, which is why only Super Admins get in automatically.
- A closed emergency window keeps working on other servers for up to 30 seconds.
- Deactivating or deleting the last break-glass account is not blocked; the Settings page flags
  it.

---

## [Unreleased] — Find views by how their data is kept, when they changed, and who changed them

### Added

**Versioned or External.** The **Versioning** menu in the Explorer's filter row narrows the list to
views whose data is versioned in {brand} (changed through drafts, review and publishing) or kept by
another system. Every card and list row says which it is, and so does the preview's *What this
view is built on*. A view with no data source of its own is judged by its workspace's default
source. The menu and labels follow the **Version control** switch: off, they are hidden.

**Date.** One menu filters on when a view was **Created** or last **Updated** — any change, to its
settings, its layout or its data. Pick a period (Today, Past 7 days, This month, Last quarter…),
type any number of past days, or choose a custom range on a two-month calendar. Days are the
reader's own calendar days, both ends included. The address keeps the period rather than the
dates, so a bookmarked *Past 7 days* means the past seven days whenever it is opened.

**People.** Replaces **Creator**: pick one or more people and say what they did — **Any**
(created it or edited it last), **Created**, **Edited** or **Published** (published the data
behind it last). You are always first in the list, and a bookmark of *views I edited* means the
same to whoever opens it. Old links filtered by creator still work.

**The workspace Views tab filters like the Explorer.** Search, Versioned/External, Date, People
and Source sit in its toolbar, with the same chips underneath. Its People list comes from the
server, so it names everyone, not just the people behind the first 50 views. **Browse in
Explorer** now opens the Explorer with the tab's filters.

**Every filter shows what it would leave.** Each option in the Versioning, Workspace, Source, Type,
Tag, Visibility and People menus shows how many views it would leave given your other filters; a
choice that would leave none is greyed out. The Source menu also marks each source Versioned or
External and names its workspace.

**No dead ends.** When nothing matches, the Explorer and the workspace Views tab list each active
filter with how many views removing just that one would bring back — click one to drop it — instead
of only offering to clear everything. **Clear all filters** now has an **Undo**.

**Counts in the Date menu.** Each period shows how many views it would show, and the calendar
marks the busy days with a dot.

**Who shaped a view.** Cards and list rows show the faces of whoever created a view, edited it last
and published its latest data, each person once; hover one for what they did and when, click it to
show only views by that person. The preview lists them as **Contributors**.

**Type filters into the search box.** `by:ada`, `is:versioned`, `updated:<7d`, `tag:pii`,
`created:2026-09` and the like turn into the same chips their menus make as soon as they are
finished, with suggestions and counts while you type; the rest of what you type stays a search. A
value that matches nothing, or more than one thing, is never guessed. **Backspace** in an empty box
removes the last chip, with an **Undo**. The workspace Views tab takes them too.

**Filter by anything (Shift+F).** One searchable list of every filter value in the Explorer — each
person, tag, source, workspace, type, date period and visibility — with live counts and a check by
those already on. **Ctrl/⌘+Enter** picks several in a row.

**Saved filters.** Save any set of filters (and the sort, if you chose one) under a name filled in
from what it does — *Versioned · Updated past 7 days · By Ada Lovelace* — and it becomes a pill beside
the Explorer's quick filters: one click puts it back, and the pill lights up whenever its filters
are on screen. Rename it, point it at the current filters, copy its link, reorder it or delete it
(with an **Undo**) from its **⋯** menu. Saved filters belong to your account, up to 30 each.

**Since your last visit.** Back after half an hour or more, the Explorer (beside the **All Views**
heading) and each workspace's Views tab say how many views are new or updated since you were last
there, counted with your filters; click a number to see exactly those. Their cards are marked **New since your visit** or **Updated
since your visit** until **Mark as seen**.

API: `GET /api/v1/views/` and `/views/stats` take `sourceKind`, `createdBefore`, `updatedAfter`,
`updatedBefore`, `contributorIn` and `contributorRole`; list items carry `sourceKind`;
`/views/facets` takes every list filter plus `fields`, counts each dimension with the OTHER filters
applied, and adds `contributors`, `workspaces`, `dataSources`, `visibilities` and `sourceKinds`;
`GET /views/count` returns how many views a filter set leaves; `GET /views/histogram` counts views
created or updated per hour (or ten minutes) over a window, with the same filters. Views carry
`createdByAvatarId`, `updatedByAvatarId` and `dataUpdatedByAvatarId`. `/views/saved-filters` lists,
creates, renames, reorders (`PUT /order`) and deletes the caller's own saved filters.

### Changed

- **A failed load says so.** The Explorer used to answer a server error with "No views match your
  search". It now shows the error, with **Try again** — and, when the Versioned/External filter
  can't be answered, a button that removes just that filter.
- **The preview's data-source line names version control.** It said *Managed graph* or *External
  graph* from how the source was first connected, which called many versioned sources external.
- **Clearing every filter keeps your sort and layout.**
- **Sort, Grid/List and density sit on the right of the All Views heading,** beside what they
  change, so the filter row above holds only filters.
- **The workspace Views tab counts the whole workspace.** Its summary counted only the first 50
  views the page loaded, so in a large workspace every number was short.
- An invalid `createdAfter` is now refused with a 422 instead of being compared as text.
- **A version store that goes down is asked again every 30 seconds, not on every request.** The
  versioned-sources lookup kept serving its last answer after a failed refresh but retried on the
  very next call, so with view lists now asking, each request would have waited on a connection.

### Removed

- **Featured Views.** The Explorer's banner of pinned views is gone. Nothing in the app pins a
  view, it looked only at the first page of results, and the same views were in **All Views**
  below it, where a pinned view still says **Pinned**.

### Fixed

- **`f` favourites the focused card with Caps Lock on**, now that **Shift+F** opens the filter list.
- **Recent and a created date now narrow the list together.** Recent's 7-day cutoff used to replace
  a narrower created date instead of combining with it.
- **The bar for selected views sits in the middle of the list.** It started at the middle of the
  window instead, so it hung to the right, further still beside the sidebar.
- **A person's hover card opens above them in the lower half of the screen,** instead of running
  off its foot.
- **A view's tags are the same wherever you look.** The view wizard opened every view with no tags,
  so tags added in the Explorer were missing there, and a tag added in the wizard replaced all of
  them; tags couldn't be cleared from the wizard, and a description changed there was never saved.
  The Explorer's and the workspace tab's preview, the view page, the canvas and the wizard each kept
  their own copy of a view, so a change made in one reached the others only after a reload. A save
  now refreshes them all, and the preview shows what it saved straight away. Emptying the
  description in the preview's **Edit details** now clears it.

### Upgrading

- One migration, `20261013_0116_saved_filters`, adds the `saved_view_filters` table. It only adds;
  run it with the usual `alembic upgrade head`.

### Known limitations

- **Edited** and **Published** match each view's latest change only: a view records who changed it
  last, not everyone who has.
- One role applies to everyone picked in **People**.
- A view with no data source of its own (it reads its workspace's default) is never stamped by a
  publish, so for it **Updated** sees only settings and layout edits, and **Published** never
  matches.
- While the version store can't be reached, views carry no Versioned/External label and that filter
  can't be applied; the rest of the Explorer works.
- Your last visit is remembered by each browser, not your account, so another computer counts from
  its own last visit.

---

## [Unreleased] — Who did what, where and why: one activity log, and analytics that see the data

### Added

**Administration → Activity: one log of what people do across the platform.** The RBAC-only Audit
Log page at `/admin/audit` is replaced by an explorer of every recorded change: sign-ins and access, aggregation
and freshness operations, data sources and providers, version control, group membership and
platform settings. Lenses (Operations, Access, Identity, Data, Content, Platform, Security), a date
range, and filters for a person — as the one who acted or the one it happened to — action, outcome,
whether a reason was given, and free text. An insight band compares the range with the period
before it: events, people active, operations started by hand, the share of changes that said why,
volume by kind, a weekday × hour punchcard (UTC), the most active people, the most hands-on data
sources and how often each is touched, the most frequent actions, and the reasons people give. The
timeline groups by day, folds repeats and offers newer events without moving the page; each event
opens a drawer with who, when, where and why, links to the run, source, group, view or workspace,
and the other events from the same request and on the same target. Every filtered view is a link,
and **Export** downloads it as CSV. Workspaces gain an **Activity** tab with the same explorer,
scoped to that workspace's operations, access and data changes, for its admins.

**Every manual operation names its person.** Aggregation runs record who started them and why
(`aggregation_jobs.triggered_by` and `stated_reason`), through the web tier and across the
control-plane proxy. Job History shows *Manual · by {name} — "why"* on each run and filters by who
started it. Recorded once each, as the person, with the request it came in: re-trigger, resume,
cancel, delete, purge, skip, limits, schedules and fleet settings; Freshness rebuilds, retries, bulk
and provider/fleet refreshes, reconcile runs and automation holds; data sources added (by hand
or from a view package), changed, removed, restored, made primary or switched projection mode;
providers registered, changed or deleted; version control enabled, retried, abandoned or
re-synced, and duplicate copies collapsed; discovery runs and asset statistics refreshes;
dead-lettered messages redriven or deleted, admission limits, graph-store query limits and graph
cache rebuilds; feature flags, the profiling policy and the node-identity default; and group
membership — by hand, or by the identity provider's sync, which now records the memberships it
actually changed.

**Asked, never required: why.** Wherever work is started, stopped or destroyed, the dialog asks
for an optional reason, with one-click suggestions for that kind of change and the person's own
recent reasons, and says who will be able to read it. One-click actions get a prompt that is also
their confirmation, so nothing asks twice. Safe resets, previews, limit tweaks and settings edits
do not ask.

**Activity is kept for two years.** `ACTIVITY_RETENTION_DAYS` (730 unless set; `0` keeps
everything; less than a year counts as a year, so the longest range stays whole) bounds both the
activity log and the outbox it is copied from. A daily sweep on the control plane deletes what
happened before that horizon, oldest first, a batch per short transaction, pacing itself so a first
run that clears years of history shares the database. It never deletes an outbox row the relay has
not copied, nor the password events sign-in reads back. The end of the timeline says how long the
log keeps activity, and a range whose previous period reaches past the horizon shows no change
rather than a comparison with what is left of it, and says why.

**The explorer from the keyboard, and what needs a look.** `j`/`k` (or the arrows) walk the
timeline and Enter opens an event; in an open event `j`/`k` or `←`/`→` step to the next and
previous, and Esc returns to the row you reached; `/` searches and `?` lists the keys. Above the
figures, *Needs attention* says what they suggest, each one click from the events it is about: a
source run by hand at least daily (a schedule could take it over), a source only one person ever
operates, manual operations up by half or more, and changes that mostly gave no reason. Each
hands-on source shows the faces of the people who keep operating it, and picking a person puts
them in focus: who they are, when they are busiest and what they do most.

**Zoom in from the chart, and search that helps.** Drag across *What happened, by kind* — or click
one day or week — and the whole explorer narrows to exactly those days, as a log console's
histogram does; *Back* retraces each zoom. Search is the widest field on the bar: focused, it
offers the searches made here before (kept in this browser) and words the range can answer — the
reasons people gave, the sources and targets acted on most — picked with ↑/↓ and Enter, and what
it matched is marked in each row. A range longer than search reads offers *Search the last 90
days* instead of a disabled box. Under it, a person is picked by face from the people active in
the range and then reads as their name; their part, the actions (several at once), the outcome and
whether a reason was given are pills, each saying what it is set to.

**Analytics → Data: what the platform holds, and how it got there.** Entities and relationships as
they stood at the end of each period — so a pruned graph shows as a fall — overall, by workspace
and by kind of source, with the sources that moved most; sources onboarded, under version control
or external, by provider type, and the wait for a first build; and version-control adoption by how
graphs are kept. When version control cannot be read, that section says so and the rest still
loads.

**Richer Analytics tabs.**
- *Engagement:* who is around (active this week, seen, gone quiet, never signed in) and when
  people use the platform, by weekday and hour.
- *Content:* distinct viewers over time, how far each view reaches, how many new views are read by
  someone other than their author and how soon, and views built against opened, by kind or by who
  can see them.
- *Health:* how ingestion is driven — runs started by hand against automatic and onboarding runs,
  the share started by hand, the run failure rate, and the most hands-on sources.
- *Workspaces:* a pulse of each workspace, period by period, so one that went quiet mid-range shows
  as a gap; and *By hand* and *Access* columns in the table.
- *Workspace drill-in:* what the workspace holds over time, and how its ingestion ran.

**API.** `/api/v1/admin/activity/*` (`system:audit:read`) and
`/api/v1/admin/workspaces/{ws_id}/activity/*` (that workspace's admins), each with `events`,
`events/newer`, `events/{event_id}`, `summary`, `catalogue` and `export.csv`;
`GET /api/v1/admin/analytics/data` and `/usage`; and `GET /api/v1/directory/people?ids=`, which
names up to 100 people for any signed-in reader. Mutating requests may carry an optional
`X-Activity-Reason` header. See `docs/RBAC.md` §Activity log.

### Changed

**`auth_audit_log` is the activity ledger.** Each record stays immutable; beside it sits a
rebuildable projection in indexed columns (category, audience, severity, outcome, actor, subject,
target, workspace, data source, stated reason, correlation id), so every filter runs in SQL.

**Administration's "Audit Log" is now "Activity"**, second in the System group, and holders of
`system:audit:read` (Org Auditors) can open Administration, landing on it.

**The public trigger endpoint accepts only `manual`, `onboarding` and `api`**, so a rebuild started
by a person cannot be recorded as automation.

The analytics document cache moves to schema version 3; documents rebuild on first read.

**A busy replica answers "try again shortly" instead of timing out.** Free-text activity searches,
exports and the first build of a summary each get a fixed share of a replica's read connections.
Past it, a request waits briefly, then gets `429` with `Retry-After` (`"code": "busy"`) rather
than taking the connections the readiness probe needs. Of several replicas missing the same
summary, one builds it and the others wait for its result. The warmer prepares every lens of the
activity explorer for the last 7, 30 and 90 days, not only the unfiltered view.

**A zoom adds up days already counted.** The activity insight band is the sum of whole days. Each day
that is over is counted once and kept, in Redis, until it has gone three days unread. Any range — a
preset, a zoom, or the period it is compared with — adds up the days it covers, so a zoom into days
already counted reads none of the log's rows. The warmer counts each lens's last 180 days before
anyone opens them, and the counts survive a restart. Days not yet counted are read a fortnight at a
time and kept as each fortnight lands, so a long range that cannot be counted within one request
is ready after a few, instead of timing out every time. How often each source is run by hand is
read from a new index that holds the operations (`idx_aal_cadence`), without touching the table.
Measured with 300 people reading the explorer on a ten-million-event log, about one action in
eight a zoom: a zoom's band answered in 96 ms (p95 204 ms). Before, it took 15 s (p95 24 s), and
one zoom in five was refused or timed out. The readiness probe stays at p95 63 ms (was 4.7 s), and
none of the 6,929 requests failed.

**People, times and values, drawn as what they are.** Wherever a record names a person — who
started a run, who changed a running job's limits, who acted in the activity log, who added a group
member or rebuilt a source — they appear with their face (profile picture, the illustration they
picked, or initials) and name, linking to them in User Management, with their email and id on
hover; an id that names nobody stays the id, and a deleted account is still named, and marked.
Times read by age ("12 min ago", "Today 09:41", "Mon 18:02", "12 Oct") and move together on one
shared clock; hovering gives the local time with its zone, UTC and ISO. Job History shows each
run's timeline — created, started, finished — with how long it waited for a worker and how long it
ran, counting up while it runs. In an activity event, a change reads as before → after (several at
once as one per field), every value is drawn by kind — durations and sizes in their units, yes/no,
statuses, links, ids named where the event names them — and the raw payload is a highlighted,
foldable tree that copies as JSON — as is an entity's or a relationship's raw data in its drawer.
`GET /api/v1/directory/people` and the activity API also say
which illustration a person picked (`avatarId`) and whether they have a profile picture
(`hasImage`), so a page of people without pictures asks for none.

**Theme colours take their opacity — an app-wide visual change.** About 1,700 classes asked for a
theme colour at an opacity (`bg-canvas-elevated/95`, `border-glass-border/50`, `text-ink-muted/60`)
and emitted no CSS, because the theme's variables hold whole colours: translucent panels and sticky
headers were see-through, and those borders fell back to the default grey, a bright line in the dark
theme. They now render. A surface takes its alpha; a glass border at an opacity is a divider in the
theme's own ink (subtle in the dark theme, as it always was in the light one); text never fades
below its token, so muted labels stay legible, and `/0` still hides. About 170 tints at in-between
amounts (`/8`, `/12`, `/98`) emitted nothing for a second reason — they are not on Tailwind's scale
— and render too. A source test now fails any such class.

**Redis waits a moment for a free connection.** With all of a role's pooled connections busy, a
command now waits up to `REDIS_<ROLE>_POOL_TIMEOUT` seconds (2) for one instead of failing at once,
which sent every caller of a burst to its fallback together: sign-in checks to the database, cached
graph reads to a rebuild. The cap on connections is unchanged; `0` fails at once, as before.

### Fixed

- The audit page filtered people and targets after the page limit, so a filtered page could come
  back short or empty. Administration → Activity filters in the query. `GET /api/v1/admin/audit`,
  kept as it was for API clients, still filters that way.
- Data sources added through the API recorded no creator; `created_by` is now set.
- In proxy mode — every deployed topology — manual aggregation runs recorded nobody.
- A request that ran out of time could answer `500` instead of `504`, when the deadline fell inside
  a middleware that turns a cancelled handler into "No response returned".
- **Zooming the activity chart crashed the page.** It fell over with "The page hit an unexpected
  error and stopped rendering" (`Cannot read properties of undefined (reading 'slice')`). The
  chart remembered the hovered day by its position, and the zoomed chart has fewer days, so the
  position named none. A chart now lets go of its hover and drag whenever its days change.
- **The activity event lists had no request deadline.** The timeout middleware took any path ending
  in `/events` for a live stream. Streams are now named one by one, so the lists answer `504` like
  any other read.
- **A slow activity export could be cut off mid-file and still look complete.** The 30-second
  deadline closed the download cleanly, so nothing showed it was short. The export now runs to the
  end, like the other streamed downloads: it is capped at 50,000 rows, and each process runs at
  most two at a time.
- **Analytics → Data said aggregation runs are kept for 90 days, whatever the setting.** It now
  reads `AGGREGATION_JOB_RETENTION_DAYS`, the setting the prune deletes by. Time to first build
  says how far back runs reach, or says nothing when every run is kept.

### Security

- A client `X-Request-ID` is honoured only when it matches `^[A-Za-z0-9._:-]{1,128}$`; otherwise the
  server makes one. It is now the correlation id that groups a request's events.
- The control plane trusts the forwarded `X-Activity-*` identity only behind its internal token,
  and re-validates each value. The web tier builds them from the session, never from the client.
- Recorded values are stripped of control, format and lone-surrogate characters, so a hostile
  payload cannot stop the relay.
- The workspace activity routes force the workspace scope on the server, and never return raw
  payloads.
- The CSV export neutralises spreadsheet formulas.

### Upgrading

- **Four migrations:** `20261010_1000_activity_ledger` (DDL on `auth_audit_log`, inspector-guarded,
  no data updates), `20261010_1100_job_provenance` (`aggregation_jobs.triggered_by` and
  `stated_reason`), `20261011_1000_activity_pulse` (a partial index on `auth_audit_log` for the
  workspace pulse) and `20261013_1000_activity_cadence` (a partial index over its manual
  operations: 3.4 s and 171 MB for 1.5 million operations among ten million events; the ledger
  takes no writes while it builds, and the relay waits). Run the upgrade job before rolling out.
- **The activity band's kept counts change shape.** The first band after the upgrade counts its
  days again; the warmer does this for the leading views.
- **`AGGREGATION_JOB_RETENTION_DAYS` is read by both roles now.** The control plane prunes
  finished runs to it, and the web tier says how far back runs reach. Compose, the Kustomize config
  maps and the Helm chart set it on both (90 unless set). If you set it, set it alike on both.
- **Copying the audit backlog** (see the entry below) also classifies each event for the activity
  log, newest first, at roughly 3,000–5,000 events a second — about ten minutes per two million
  events. Administration → Activity says *Importing earlier activity* until it finishes.
- **Event storage roughly doubles:** events are kept both in `outbox_events` and in the ledger, each
  for `ACTIVITY_RETENTION_DAYS`.
- **The first activity retention sweep** deletes ledger events and relayed outbox rows from before
  the horizon — two years unless set. Set `ACTIVITY_RETENTION_DAYS` alike on the control plane,
  which deletes, and the web tier, which tells readers how far back the log goes. The Helm chart
  and the Compose file take one value for both; the Kustomize base sets it in both config maps.
  Set `0` before upgrading to keep everything.
- Browser clients may send `X-Activity-Reason`; it is in the CORS allow-list.

### Known limitations

- The ledger is not partitioned, so retention deletes in batches rather than dropping a partition.
- Who started a run, and why, starts at this release; earlier manual runs show their trigger only.
- Entity history starts when daily profiling began, and aggregation runs are kept for
  `AGGREGATION_JOB_RETENTION_DAYS` (90 unless set), so the Data tab and runs by origin reach no
  further back than that.
- Client telemetry carries no workspace, so the workspace pulse counts view opens, view changes and
  recorded operations only. Punchcards are in UTC.
- A moved data source is attributed to its destination workspace only.
- Version publishes and merges stay in graph history (Reviews); the ledger covers version control's
  onboarding side.
- A stated reason is free text and may contain personal data. Auditors can read it, and so can the
  workspace's admins for a workspace change; the field says so.

---

## [Unreleased] — Exports you can follow from anywhere, and cancel

### Added

**Exports follow you around the app.** An export the server prepares, whether a data source's file
or a view with its data, no longer lives only in the dialog that started it. Close the dialog,
go back to the canvas, change page or reload, and an **Exports** panel at the bottom right keeps
showing it: the step it is on, what it has written, how long it has taken and, when it can tell, how
long is left. The file downloads by itself the moment it is ready, wherever you are, and the panel
says so before it does. With several tabs open, it downloads once. The panel minimises to a pill
showing the overall progress, and a finished export can be downloaded again until it is dismissed.

**Cancel an export.** An export started by mistake can be stopped from its dialog or the Exports
panel, which asks once more first. The person who started it can cancel it, and so can a
data-source manager (`POST …/versioning/graphs/{graphId}/exports/{jobId}/cancel`). A queued export
never starts. A running one stops within seconds, and the part of its file already written is
removed. One that finished just before the cancel reached the server is not downloaded by itself;
the panel offers it instead.

### Changed

**The export dialogs show progress the way the panel does.** Both use one component: a progress
ring with the percent done when the export's size is known, the steps (a spreadsheet's column pass
included), live counts of entities and relationships, the bytes written and the time taken, and
the note that the download starts automatically.

### Fixed

- **Closing an export dialog no longer leaves the file undownloaded.** The dialog stopped following
  the export when it closed, so the file downloaded only if the dialog was opened again.
- **A spreadsheet export reports progress while it reads its columns.** CSV, TSV and Excel read
  every record once for their columns before writing any. That first pass reported nothing, so the
  dialog sat at "Starting…" for half the export.

### Upgrading

- Nothing to run. Exports started before the upgrade don't record who started them, so only a
  data-source manager can cancel those.

### Known limitations

- A view package's export shows live counts and its steps, but no percentage: its total isn't
  counted up front.
- A hidden browser tab doesn't check on its exports. The download starts when the tab is shown
  again, or from another open tab of the app.

---

## [Unreleased] — View packages at 100k+ entities, new data sources from a package, and duplicate-safe version control

### Added

**Import a view package into a new data source.** The view wizard's import can now target *a new
data source* instead of an existing one. You pick the FalkorDB provider, a label and a graph name,
and the name is checked as you type. The semantic layer is matched for you: the package's own one
when it exists in this environment (a changed one is shown as drift), otherwise the best match by
entity and relationship types, the same scoring the Add data source wizard uses. You can also pick
another, *Create from this package* or *No semantic layer*. The package's data is written as the new
source's first version, keeping its entity ids, with no draft and nothing to publish. The
platform's rollup connections, when the package carries them, are rebuilt rather than copied, and
the check report says how many. Every view in the package is imported afterwards. Opening the same
package again follows the copy it made; *Make another copy* makes a further, independent one.
Needs `viewImportEnabled`, `versioningEnabled` and permission to manage data sources
(`POST /views/transfer/packages/{uploadId}/new-source`).

**Duplicate identifiers no longer fail "Enable version control".** Before copying anything, the job
now lists every urn that more than one node in the graph carries, and it pauses until a manager
decides. The page shows the counts (same type and across types), a sample and a full CSV, and warns
when other data sources read the same graph. *Collapse N duplicates and continue* keeps one copy
per urn (the latest `lastSyncedAt`, then the lowest internal id), moves the other copies' edges to
it and deletes those copies from the FalkorDB graph, then rebuilds the rollups. Nothing is deleted
until the decision, and *Give up* after it does not bring the copies back
(`GET /graph/bootstrap/duplicates[?format=csv]`, `POST /graph/bootstrap/decision`).

**An optional S3-compatible store for import and export files.** `OBJECT_STORE_BACKEND=s3` keeps
them in a bucket on Amazon S3, MinIO or Google Cloud Storage (through its HMAC interoperability
keys), with optional presigned URLs so browsers upload and download straight from the bucket.
It is off by default, and boto3 is only installed from `backend/requirements-s3.txt`.

**`python -m backend.scripts.bench_versioning`** generates a package or a FalkorDB graph of any
size and times export, inspect, import, publish, seeding a new source and enabling version control.

### Changed

**Large view packages import, and fast.** Importing 100k nodes and 100k edges took 7–12 minutes on
a worker, and inside a web server it was killed at 120 s. Two integrity checks grew with the square
of the graph; they are now linear and give the same answers. Measured at 100k + 100k: import into an
empty source 85 s, publish of the 200k changes about 28 s (it was 23 minutes at a tenth of that),
package export 15 s, a new source from the package 49 s, and enable version control with 1,000
duplicates pauses within 3 s and finishes 42 s after the decision.

**Exporting millions of entities takes minutes, not hours.** An export read the version store a
page at a time, and Postgres planned each page on its own. Without statistics for the partitioned
table it expected a few hundred entities, so for every page of 2,000 it sorted every version row
left: about 500 entities a second on a 2M-node graph, around seven hours for 7M items. Each part of
the graph is now read by one query, streamed, and the next page is read while the last is written.
On 2M nodes and 2M edges the whole package takes about three minutes, at full speed from the start.
An export's plan counts and a replace import's read of the graph stream the same way.

**Imports look entities up with one array, not thousands of parameters.** Each import window looked
up the entities its rows name with IN lists of up to 20,000 bind parameters, compiled one at a time
on the worker's event loop and planned again by Postgres for every length. They now go as one array:
a 100k + 100k import takes 62 s instead of 80 s, and 1M + 1M takes 592 s instead of 772 s.

**Version-control jobs run only on the versioning worker, and resume.** Imports, exports, publishes,
package checks, enabling version control and purges never run in a web server any more. The worker
runs them on three lanes, `projection`, `transfer` and `bootstrap` (`GRAPHVER_WORKER_LANES`), which
Helm, the Kubernetes base and compose now deploy. A job holds a lease: if its worker dies it is
taken over within about two minutes and resumes from its last committed window, and a worker that
was taken over cannot write any more. A job's status request no longer changes it. A failed job
says whether to resume it or start again.

**View package files move without copies.** A package is uploaded in resumable 16 MiB parts and
checked by a job (`POST /views/transfer/packages/uploads`, `PUT …/parts/{n}`, `POST …/complete`).
Its data is imported straight from the upload, which is kept while a job still needs it. Export is a
job that writes the zip once (`POST /views/transfer/packages` now returns 202 with the job).
`POST /views/transfer/packages/inspect` also returns 202. `/packages/{id}/data` answers 409
`not_inspected` before the check finishes and 410 `upload_expired` once the upload is gone.

**Drafts with 100k+ new entities open without loading them all.** The first read of a large draft
loaded every created entity's payload. It now reads them page by page.

### Upgrading

- Three graphver migrations (`20261008_1000` to `20261008_1200`). They also run from
  `create_schema_and_partitions` for a separate `GRAPHVER_DB_URL`.
- **Cut over in one release.** Apply the migrations, scale the old `versioning-worker` to 0 (on Helm,
  roll the web tier first, so nothing still runs jobs in-process), then start the three lanes. Jobs
  the old worker left running are taken over once they go silent; an import that had already staged
  rows fails with "Start it again". A deployment without the transfer lane queues imports, exports
  and publishes that never start; system status shows the backlog per lane.
- `GRAPHVER_TRANSFER_INPROCESS` is no longer read (a WARNING says so) and `JOB_STALE_AFTER_SECS` is
  gone. `IMPORT_COMMIT_WINDOW` now defaults to 10000. New, all optional: `GRAPHVER_BOOTSTRAP_SLOTS`,
  `GRAPHVER_BOOTSTRAP_PER_PROVIDER`, `GRAPHVER_JOBS_PER_WORKSPACE`, `GRAPHVER_DRAIN_SECS`,
  `GRAPHVER_JOB_WEDGE_SECS`, `GRAPHVER_PACKAGE_SEED_WINDOW`, `GRAPHVER_PACKAGE_PROJECT_WINDOW`,
  `GRAPHVER_BOOTSTRAP_BACKFILL_MAX_WRITES`, `GRAPHVER_BOOTSTRAP_BACKFILL_PAUSE_MS` and the
  temporary `GRAPHVER_NARROW_SQUASH` kill switch. See `docs/versioning/08-import-export.md`.
- With `OBJECT_STORE_S3_PRESIGN=1`, add the bucket's origin to the site's `connect-src`
  (`CSP_CONNECT_SRC` or `frontend.cspConnectSrc`) and a CORS rule to the bucket.

### Known limitations

- Publishing holds the whole draft in worker memory: about 420 MB for 200k changes and 3.2 GB for
  2M, which took 3.6 minutes under the graph's lock, with one 8.5 s stall of the worker's event
  loop. A draft of several million changes needs a worker sized for it.
- A worker's event loop can stall for 120–170 ms (p99) during the heaviest windows. Leases are kept
  alive by a separate thread, so jobs are not lost, and the web servers run no jobs.
- Exports still write package format 1. This release reads both 1 and 2; the next one writes 2.
- Giving up a new data source while its data is being written into FalkorDB can leave the new graph
  behind.

---

## [Unreleased] — A guide and docs for every reader, checked against the product

### Added

**Six new User Guide pages.** *Requesting Access* explains each "you can't do that" message and
which way of asking works; *Editing in a Draft* and *The Review Center* cover changing data and
publishing it; *Feature Switches* describes all 28 switches by the names Administration → Features
shows; *Data Freshness & Ingestion* covers keeping lineage current; *Analytics* explains who sees
what. Administration → Features' **Learn more** opens the new page — it used to open one that
didn't exist.

**Help shows the guide pages for the screen you're on.** The Help panel opens with **For this
page** on every signed-in screen, above the quick start.

**Three new ways into the docs.** The docs hub has cards for Integrators (a new *API Guide*),
Security Reviewers (a new *Security Overview*) and Data Engineers (a new *Onboarding a Data
Source*), alongside New Engineers, Architects and Operators. New pages: *Contributing*, *Testing &
CI*, *Kubernetes*, *Observability*, *Runbooks* and a *Configuration Reference* generated from every
environment variable the backend reads. Pages that existed but weren't in the reader now are:
*Property Storage*, *Database Domain Ownership*, *Feature Switch Lifecycle*, *Top-Level Nodes
Performance*, the *Back-channel SSO Contract*, the *Production Cluster Overlay* and the
2026-09-10 upgrade note.

**Reading paths that keep your place.** Each persona's pages — in the docs and in the guide — are
a path you can follow: the page shows the step you're on, its end offers the next page, the sidebar
ticks off what you've read, and the hub picks up where you left off. Progress stays in your
browser.

**The docs and the guide work on a phone.** The table of contents opens as a drawer, search fills
the screen, and "On this page" folds into the top of the article.

### Changed

**Search finds the part of a page that answers.** *Search everything* (⌘K / Ctrl+K, or "/")
searches every section of every page and every FAQ answer, matches a word in any form, forgives a
typo and ignores filler words. Results are grouped by page with the sections that matched, the best
page first whichever reader it is in, and choosing one opens the page at that section. *Filter
pages* in the sidebar uses the same index, and both hubs' search boxes open *Search everything*.

**The User Guide teaches the product as it ships.** The pages people start with described an
Explorer that was an open canvas, a "Save as View" button, renamed visibility tiers, a five-step
wizard and favourites in the sidebar. Every page was checked against the code and rewritten where
it had drifted; each task page now says what to have ready, what you should see after each step,
what to do if you don't, and where to go next. The guide's "Before you start", "If …" and
"Admins" notes render as callouts.

**The engineering entry points match the code.** *Developer Setup* follows the real `dev.sh`, a
seed command that works and the first sign-in's password change; *Backend* is a router map;
*Architecture*, *Frontend* and *Data Architecture* drop the mock provider, the Web-Worker layout
and the session in local storage; *RBAC* and *Feature Flags API* list every permission and switch;
the ADRs record what superseded what.

### Fixed

- A link to a section of a page opened the top of the page, and a new page opened as far down as
  the previous one had been scrolled.
- *Filter pages* matched only titles and descriptions — and only the exact phrase — so most
  searches found nothing; on the hubs, "share a view" found nothing at all.
- "On this page" links for headings that contain the product name went nowhere.
- Code blocks' **Copy** buttons were invisible on touch screens.
- Wizard help links opened the guide in the same tab, unmounting the wizard and throwing away what
  you had entered. They open a new tab.
- Four deep links into the docs pointed at headings that don't exist.
- Guide reading times were typed by hand and had drifted; they are computed from each page.
- Identity-provider health — reachability and certificate expiry — on the SSO admin pages was
  empty in every container deployment. Every API process checks it now.

Guards keep this from drifting again: every link the app shows into the guide or docs must open a
page, every guide page must end by pointing the reader on, every seeded switch, permission and role
must be documented, every signed-in page must offer help, and the configuration reference must
match the code.

### Security

- **A password someone else chose has to be replaced.** The first administrator chooses its own
  password at its first sign-in, whatever `ADMIN_PASSWORD` it was created with; before, only three
  published values asked for that. The same holds for a password an administrator sets for someone
  else, when creating the account or with **Reset password**. While the change is pending, the
  server refuses every request except the change itself, on every route, from a session signed in
  with that password. Signing in through SSO is unaffected: someone who signs in through the
  identity provider and also has a local password keeps working, and can replace the password on
  **Account settings**.
- **Sign-in events reach the audit table in every deployment.** The relay that copies them into
  the append-only `auth_audit_log` — with the refresh-token and product-event retention sweeps and
  the analytics warmer — never ran in Docker Compose, Kubernetes or Helm. The control plane runs
  them now, one copy at a time. The activity log also shows changes to the SSO back-channel host
  list, and **Recent activity** on Account settings shows password resets, reset links, role
  changes and suspensions done to your account.

### Upgrading

- **The first administrator may be asked for a new password.** At the first start after upgrading,
  a system account still signing in with its starting password (`ADMIN_PASSWORD`), or with one
  published in this repository, must choose a new one at its next sign-in. Scripts that sign in
  as it need the new password afterwards. An administrator who already chose its own password —
  on **Account settings**, with a reset link, **Reset password** on its own row, or the host's
  reset script — isn't asked again, even if `ADMIN_PASSWORD` has since been set to it, unless it
  is one of the published ones.
- **The product-event retention sweep runs for the first time.** It deletes product events —
  views opened, traces and searches, which Analytics counts — older than
  `PRODUCT_EVENT_RETENTION_DAYS`, 400 days unless you set it. Raise it before upgrading if you
  want to keep more.
- **The control plane copies the audit backlog.** On an install where the relay never ran, its
  first pass copies every event since installation into `auth_audit_log`, continuously until it
  has caught up.

### Known limitations

- **Request access** on the Access denied card can't load its list of roles for most accounts, so
  the request isn't sent; and **Add member** on a workspace's Members tab works fully only for
  Super Admins. *Requesting Access* and *Workspace Admin* describe the routes that work today.
- Two screens still have a placeholder rather than a screenshot: a semantic layer's **Health** tab, and
  Administration → **Infrastructure** on the Observability page.

---

## [Unreleased] — Docs that stay inside the deployment, and a debt register that matches the code

### Changed

**The in-app docs no longer send readers to GitHub.** Wherever a doc linked to one the reader did
not carry, the link was an absolute URL into the public repository, which on a deployment that cannot
reach it led nowhere. Those links are relative now, and the pages they pointed at — versioning
chapters 02–05 and 07–11, the versioning suite guide and glossary, and the draft-lineage notes — are
in the reader under **Versioning**. A relative link with an `#anchor`, or one that climbs out of its
folder (`../DATA_ARCHITECTURE.md`), now opens in the reader too; both used to open a new tab on a page
that did not exist. The docs tests check links with the reader's own resolver, and fail if a doc, a
guide or an FAQ answer links anywhere on GitHub again.

**Nothing else points at public GitHub either.** The landing site's GitHub buttons — in the
navigation, the open-source call to action and the footer — open the docs at `/docs`, the way its
other links already route into the app. `SECURITY.md` describes private vulnerability reporting
without a URL and links the known-issues list in the repository. The Helm chart no longer names a
home page, the FAQ no longer sends readers to GitHub, and the ingress-nginx chart repository and the
FalkorDB module download in the deploy notes are variables you point at a source your cluster can
reach.

**The technical-debt register, the roadmap and the status pages were re-verified against the code.**
`docs/TECHNICAL_DEBT.md` was last checked on 2026-08-25 and had drifted: four of its items had
closed, four had changed shape, and eleven risks were missing. `PLAN.md`, the overview's roadmap and
maturity sections, the canvas book of work, the scaling plan (the three-tier split it called
deferred is deployed), and the versioning chapters' status and roadmap sections now say what the
code does. `SPEC.md` is marked as the historical design it is.

### Known limitations

- **No shipped deployment config sets `ENV=production`**, so the production-only safeguards — the
  15-minute token cap, shared replay caches, credential encryption, the control-plane token, and
  readiness on shared revocation — only log a warning. Set it yourself until the configs do
  (`docs/TECHNICAL_DEBT.md` §1.1).
- **The zero-config quickstart does not boot.** The README and `QUICKSTART.md` now say so (§2.1).
- **The kustomize manifests apply no schema migrations**; run the upgrade by hand before rolling out
  a release that carries one (§1.5).
- Repository files outside the in-app reader, such as `QUICKSTART.md` and `loadtest/README.md`, are
  named rather than linked from the docs it carries.

---

## [Unreleased] — One placement rule for every view surface (preview)

### Added

**One placement contract, behind the `placementContractEnabled` flag (off by default).** Which layer
of a view an entity is in used to be decided separately by the server compute, the canvas, the
wizard, Layer Studio, the trace overlay, search badges, Build Mode and import, and they disagreed:
entities jumped columns when the server answer arrived, the wizard preview contradicted the canvas,
and property and condition rules placed nothing. With the flag on, all of those surfaces use one
contract — a Python reference and a TypeScript twin held equal by a shared corpus of 140+ cases in
required CI. Rules are the AND of their criteria and finally work for tags, URN globs,
`propertyMatch` and conditions; the first layer wins a tie; types match whatever their case; a child
whose own type a layer claims is shown in that layer with the *Placed* path tag, while hand
placements still carry their subtree. Creating a view, or saving its layers, with a new or changed
rule that can never match is refused with a message naming it (`PUT /views/{id}`, which the wizard
uses to save a view's details, does not check rules). See `docs/services/ASSIGNMENTS.md`.

**`python -m backend.scripts.placement_dry_run`** reports, per saved view, what turning the flag on
would change and why, before anyone sees it.

**Orphaned entities, for power users.** An orphan is an entity whose type the ontology says sits
inside another (a Table inside a Schema) but which has no parent in the data. Most people just want
to see the data, so nothing changes on the board, in the default lists or in the status chips.
Power users find orphans in two places:

- In the wizard's and Layer Studio's entity browser, the **⋯ More filters** button after *Unassigned
  only* has an **Advanced** section with **Orphans only**. It lists every orphan, with the server's
  exact count (or "many" when the count could not finish in time), and they stay assignable like any
  other entity.
- On the Context View canvas, the **Display** menu has an **Advanced** section with **Orphaned
  entities…**. It opens a side panel with each orphan's name, type and layer in this view, a
  **Reveal** button, and **Place in layer** on a draft.

`GET /graph/nodes/top-level` takes `orphansOnly=true` (see `docs/TOP_LEVEL_NODES_PERFORMANCE.md`).
Orphans work the same with `placementContractEnabled` on or off.

### Fixed

- **The entity browser's total.** Its "N top-level · M orphan" line counted only the last page
  loaded. It now shows the true total ("N total").
- **Paging the stored top-level list.** On large data sources, paging skipped same-named entities at
  a page boundary. It now pages by name and URN like the live query, and old cursors still work.
- **Moves in a draft.** An existing entity given a new parent in a draft was not listed under that
  parent until the draft was published, and a top-level one stayed at the top level. It is now
  listed under its new parent.
- **Totals from version history.** Reads served from version history (just after a merge, or as-of)
  reported a too-low top-level total when they had not scanned everything. They now report none, so
  there the browser may show no total and its coverage bar counts only loaded rows until the count
  is known, as it already does when the live count times out.

### Upgrading

- Nothing changes until an admin turns the flag on. Before that, run the dry run and follow the
  runbook in `docs/services/ASSIGNMENTS.md`. Turning the flag off again rewrites no view.

### Known limitations

- With the flag on, the canvas, trace and search still read containment as source = parent, so
  `BELONGS_TO` children can be placed differently there than on the server.
- Export, scoped replace, the search Layer filter, open-view type feeds and column totals keep
  today's rules until server-side membership (the next phase).
- The browser cannot tell a whole-number float from an integer, so a text rule on a whole-number
  float from 1e15 up to 2^53, or a rule value stored as an integer of 2^53 or more, can place an
  entity differently on the canvas than on the server.
- Reads served from version history (just after a merge, or as-of) still page the top-level list by
  name, so same-named entities at a page boundary can be skipped there.
- On those reads, *Orphans only* can be slow on very large graphs: it scans every containable
  entity.
- In a draft that deletes top-level entities that are not orphans, the orphan total is low by that
  number.
- A top-level entity given a parent in a draft (an orphan being fixed, for example) moves under that
  parent, but top-level totals, the default list's included, still count it until the draft is
  published.
- An entity moved from one parent to another in a draft is still listed under its old parent too
  until the draft is published.
- An entity orphaned only inside a draft (its parent link removed there) is not listed until the
  draft is published.

---

## [Unreleased] — Every page scrolls

### Fixed

**The sign-in page, and every page like it, scrolls when the window is shorter than the page.**
On a window shorter than the sign-in card, the single sign-on buttons and everything under the
form (*Forgot your password?*, *Sign up*, *Documentation*, the version line) were out of reach,
and nothing showed there was more. The app shell never let the document scroll and clipped
whatever a page drew below the window. The same happened on sign-up, both password-reset pages,
the invitation page, the dev and portal sign-in pages, and the forced password change, where the
submit button is the only way forward. These pages now scroll, and a page opened from a scrolled
one starts at its top.

**Signed-in pages that clipped instead of scrolling.** The Review Center had no scroll area at
all, and the Administration menu ran off the bottom of a 1080p screen with no way to reach Single
Sign-On, Audit Log or its footer. On short windows, landscape phones and at 200% zoom, Ingestion
(including its Jobs tab), Analytics and Semantic Layers squeezed their content to nothing under
their pinned headers. They now keep at least 10rem for it and scroll the whole page when the
header does not leave that. The access-denied and feature-off panels, the 404 page, the error
screens and the access-revoked notice now scroll instead of cutting off their top or bottom.

**On phones, the app fits the visible screen.** The shell used `100vh`, which on a phone is the
height with the browser's toolbar hidden, so the bottom of every page sat behind the toolbar. It
now uses the dynamic viewport height where the browser supports it.

### Known limitations

- Dialogs and drawers were not part of this sweep. A few with no height cap (the docs search, the
  permissions dialog, the sign-in account-collision notice) can still run off a very short window.
- On narrow screens (a phone held upright, or a small laptop at 200% zoom), the main navigation
  stays expanded and takes most of the width. Pages with their own side rail (Administration,
  Semantic Layers) then push content off the right edge, Ingestion → Freshness wraps its sticky
  filter bar over the table, and on a phone the top bar's search box wraps over the page.
  Collapsing the navigation fixes this. It is a width problem, which this change does not
  address.
- The list in Admin → Features sets its maximum height from the window, not from the space left
  under the banners, so while a banner shows its last row can sit below the fold.

## [Unreleased] — Branding that saves, combined traces, and time for very large graphs

### Added

**Select several entities and trace them together.** On the Context View canvas, ⌘/Ctrl-click
adds an entity to the selection and Shift-click adds a range (also across columns); Space or
⌘/Ctrl+Enter toggles the focused row. Every selected entity's incoming and outgoing lineage lights
up at once, their upstream and downstream partners stay at full strength instead of dimming, and
the selection bar counts how many entities feed the selection and how many it feeds. **Trace N
entities** (or `T`) traces them as one picture: every selected entity is an origin, each partner is
measured from its nearest origin, and the dock says "Tracing N entities" and lists them, each with
a remove button that narrows the picture without fetching again. Up to 25 entities are traced at
once. `F` opens the Lens on the whole selection.

**A guide to scaling for hundreds to thousands of users** (`docs/SCALING_CONCURRENT_USERS.md`,
in-app under Operations). It starts from the real ceiling (FalkorDB query threads on the shard that
holds a data source) and works through every tier: replicas and workers per service, a Postgres
connection worksheet for the per-process pools against `max_connections`, FalkorDB and Redis
sizing, the timeout ladder, metrics and alert thresholds, a load-test procedure, and ready-to-apply
profiles for ~100, ~500 and ~1000+ concurrent users.

**Guides for Advanced Search and Display Rules, a developer reference, and examples.** Two user
guides (in-app under Viewer and Builder), `docs/features/search-and-rules-reference.md` (every
predicate, operator and endpoint, the library pack format, curl and Python recipes) and
`docs/examples/search-and-rules/` (ready-made queries and two library packs).
`backend/scripts/publish_view_library.py` publishes a library pack to one view, or to every view of
a data source (a dry run unless `--apply`), and `backend/common/schema/view-library.v1.json` is a
JSON Schema for the pack format. The Advanced Search **Library** menu can now export the view's
library and import one.

### Changed

- **Loads and searches on very large graphs get the time they need.** Per-query budgets that cut
  10-60 s queries off are raised: canvas reads 15→30 s, nodes 20→45 s, top-level 30→60 s,
  edges-between 40→80 s, aggregated reads 30→60 s per step, an Advanced Search unit 15→45 s and its
  request 40→100 s, the default soft deadline 30→60 s. The API's graph and trace tiers go 60→120 s
  (aggregation 45→90 s), and the browser waits up to 150 s. Each layer still outlasts the one inside
  it, and every per-query budget stays under the production cluster's `TIMEOUT_MAX` of 120 s. Env
  overrides still apply.
- **A failed search no longer counts as a graph outage.** Three in a row used to open the circuit
  breaker for every graph read on that data source for 30 s; it is now answered as a
  `SEARCH_FAILED` rejection. Hydrating a page of hits after a long scan gets 5 s instead of 0.5 s.
- **The Branding page keeps what you type.** A save that loses a race opens a panel listing the
  fields both sides changed, with **Keep my changes** or **Discard mine**, instead of asking you to
  reload and type it again. A refresh in the background never overwrites a form you are editing,
  and a save sends only the fields you changed, so the rest keep following the `APP_BRAND_*`
  defaults. The description now reaches the page's meta description and the sign-in screen, and
  the support email shows as **Contact support** in the Help panel.
- **Helm:** Postgres `max_connections` (400) and Redis `maxmemory` / `maxmemory-policy` (2gb,
  `volatile-lru`, with the pod's memory raised to fit) are values, matching compose and the k8s
  manifests, instead of the server's 100 connections and 256mb `noeviction`.

### Fixed

- **Branding could not be saved.** On every database built by the installer or the baseline
  migration the branding row was never seeded, so each save answered "Someone else updated branding
  while you were editing" and nothing was stored. The first save now creates the row. The SSO
  settings page had the same fault and the same fix.
- **Tracing a multi-selection showed only the first entity**; the others and their lineage were
  dropped from the picture.
- **The production anti-affinity patch matched no pods**, so replicas could all land on one node.
- **`kustomize build` panicked on the production and production-cluster overlays.** Each
  `$patch: delete` is now its own patch; all four overlays build.

### Upgrading

**Full detail:** `docs/RELEASE_NOTES_2026-09-30_branding-traces-timeouts-scaling.md` — what was
wrong behind each report, every value that moved and every knob that tunes it, rollout order,
verification, and how to go back.

No migration. The new timeouts are defaults: a deployment that pins `HTTP_TIMEOUT_*`,
`FALKORDB_*_TIMEOUT` or `DEEP_SEARCH_CHUNK_TIMEOUT_MS` keeps its own values. `VITE_TIMEOUT_*` are
baked in at build time, so rebuild the frontend image. A load balancer or gateway in front of the
app with an idle timeout under 150 s (60 s is a common default) cuts the longest requests off
before the app can answer: raise it.

### Known limitations

- **Searches and display rules are shared per view.** There is no data-source-level library;
  publishing a pack to a data source means importing it into each of its views, which the publish
  script does.
- **Scripts sign in with a session cookie.** There are no API tokens or service accounts.
- **A share link carries one entity**, so Share is not offered for a combined trace.
- **Slow queries now hold a graph slot, a FalkorDB thread and a database connection longer** before
  they give up; see the scaling guide's trade-offs.

---

## [Unreleased] — SSO sessions that still work the next day

### Fixed

**After signing in with SSO, every graph could say "Taking a little longer than usual" and never
load.** Signing out and back in with a password fixed it; for gateway users, signing in with SSO again
did not. Four causes, each fixed where it starts:

- **The page did not know which cookie held its CSRF token after an SSO sign-in on the page.** With
  `AUTH_ENVIRONMENT_ID` set, the CSRF and expiry cookies carry the environment in their name
  (`nx_csrf_production`), and the page learned it only from `GET /auth/me` on load or from a password
  sign-in. The Enterprise Gateway's button and automatic sign-in, a portal sign-in, an invited signup
  and the gateway's silent re-sign-in all started a session without it — so every write went out
  without its CSRF token and was refused, graph reads included (they are POSTs), the CSRF repair could
  not help, and renewal ahead of expiry was off. Every response that starts, renews or repairs a
  session already named the environment in its body; the page now takes it from each, and the CSRF
  repair (`GET /auth/csrf`) names it too, so a repair can always finish itself. This is also the
  "CSRF token missing or invalid" that came and went.
- **A gateway session could start already past the daily re-authentication limit.** The limit counts
  from when the identity provider says the person signed in, and a gateway reports the corporate
  portal's original login (`lastLogin`) — days old for many people. The session was refused at its
  first renewal, minutes after sign-in, every time. No session now starts past the limit: OIDC and SAML
  ask the identity provider for a fresh sign-in once (`prompt=login`, `ForceAuthn`); gateway, portal
  and custom connections, which have no way to ask, and an identity provider that ignores the request,
  count the limit from that sign-in. `user.logged_in` records `auth_time_anchored`.
- **Loading permissions could renew the session by a route of its own**, missing the handling of the
  re-authentication answer, so a session that could have been renewed silently ended at the sign-in
  page instead. It now goes through the same renewal as everything else.
- **The canvas showed a session problem as a slow graph**, retrying forever. A sign-in the page could
  not repair now reads "Reconnecting your session", with a Reload button, and keeps retrying.

**Coming back the next day ended an SSO session at the sign-in page.** An SSO session past the idle
(12 h) or absolute (7 d) limit now goes back through its identity provider — silently for a gateway,
and without forcing a password prompt for OIDC or SAML — instead of a dead end. Password sessions are
unchanged.

**A busy moment could sign gateway users out.** The gateway's silent re-sign-in treated a 429, a 5xx
or a dropped connection as a refusal, which a 9am rush behind one corporate address produces. It now
retries once; if the corporate side really says no, the sign-in page opens with the reason.

**Signing out did not stick for gateway and portal users.** The automatic sign-in waited only a
minute, in that tab only, so a new tab signed the person straight back in. It now waits, in every tab,
until someone signs in.

**A gateway whose sign-in runs in the browser could not sign anyone in behind the shipped frontend
image.** The page's Content-Security-Policy allows only its own origin (`connect-src 'self'`), so the
browser refused the sign-in trigger and the browser-side translate call before they were sent — the
button, the automatic sign-in and the silent re-sign-in all failed, and nothing reached either
server's logs. The frontend container now takes the gateway's origins in `CSP_CONNECT_SRC`, and a
call the policy blocks says exactly that, naming the origin to add. The connection form names it too.

**A failed renewal could land on "You're already signed in".** A refused renewal cleared no cookies —
the framework drops a response's headers when the route raises — so the sign-in page found the
still-valid access cookie and, since `GET /auth/me` did not consult revocations, reported a live
session. A refused renewal now clears the session cookies, and `/auth/me` and `/auth/csrf` refuse a
revoked session, so the page shows why sign-in is needed instead.

**Re-authenticating now keeps your place.** A session that ends mid-task — renewal refused, or
signed out by the server — returns to the page and query it was on after signing in again, through
the identity provider or on the sign-in page, instead of the home page.

**More gateway renewals finish without anyone noticing:**

- **A gateway with no browser half renews in place.** Its corporate cookie rides every request, so
  renewal now redeems it with one call instead of navigating the page away and back.
- **Re-authentication goes back to the session's own connection**, not to whichever connection the
  person used most recently.
- **A gateway token stamped a few seconds in the future is accepted.** Its issue and not-before
  times now get the same clock-skew allowance (`JWT_CLOCK_SKEW_LEEWAY_SECONDS`) as everything else.
- **A failure that was only the network is retried.** The browser's own call to the corporate host
  timing out, answering 429 or 5xx, or not answering at all (a VPN still connecting) is retried once
  and is not held against the next attempt; the sign-in page also tries again once its one-minute
  hold lapses and when the network comes back.
- **A slow gateway cannot outlast the renewal.** The renewal re-check gives up after 10 seconds and
  counts that as an outage (the connection's grace applies); a connection's per-call timeout is
  capped at 30 seconds; the browser gives up on a renewal after 20, inside the server's 30-second
  rotation grace, so its retry is never mistaken for a replayed token; and name lookups for the
  gateway no longer hold up other requests while they wait.

**A session found dead by the background renewal left the tab signed in**, on a page whose every
request would fail, until something else noticed. The renewal now signs the tab out itself, as a
failed request does.

**When the gateway was down, the sign-in page gave no reason.** A renewal that failed only because
the corporate side did not answer now lands on the sign-in page saying so, and that the page will
try again — which it does, at once and after a minute — instead of a bare form.

**Gateway sign-in in the browser, with several tabs and on a laptop:**

- **A silent re-sign-in gives up after 45 seconds.** It holds every tab's requests while it runs,
  and a corporate host that never answered could hold them for over two minutes.
- **Every tab shows why sign-in is needed**, and none re-runs the call to the corporate host while
  a refusal is being honoured. Only the tab that tried used to know.
- **Renewal cannot call the gateway every two seconds.** It renews at half the token's life when
  that is under two minutes, and schedules by the server's clock rather than the laptop's, so a
  short token or a clock running fast no longer renews on a loop — each renewal being a call to
  the corporate gateway. It also catches up after a laptop wakes or the network comes back.
- **A gateway that reads the corporate cookie on the server signs people in automatically too**,
  like the other kinds, instead of waiting for the button.
- **SSO diagnostics blamed passwords for gateway failures.** A refused gateway sign-in — the button,
  the automatic attempt on the sign-in page, the silent re-sign-in — and a refused portal sign-in were
  written only to the server log. What reached the audit log was what the person tried next: typing
  their corporate password into the password form, recorded as `invalid_credentials` against an
  account that has no password to type. Those refusals are now recorded with their reference, reason
  and underlying error, and the password attempt says `no_local_password`.
- **The "Failed sign-ins (24h)" tile counted every warning in the log**, sign-outs and configuration
  changes included. It now counts failed sign-in attempts.
- **A revoked session kept working on some routes until its token expired.** Signing out, a password
  change or reset, and a role change are refused on the next request by routes that authenticate
  through the user — but the view, graph and view-version routes authorise on the token's claims
  alone and never checked, so a signed-out or demoted session kept its old access there for up to
  one access-token lifetime. Every route now refuses a revoked session.
- **Unlinking an SSO identity ended none of the sessions it had started**, including an admin's
  unlink of an identity believed compromised. It now ends the sessions that identity minted; the
  person's other sessions carry on.

### Added

**Sign-in problems, in Admin → SSO → Diagnostics.** Everyone who could not sign in over the last
day, week or month, one row per person with the people still failing first: why (the reason code in
words, and what to do), how often, whether they have signed in since, the connections their account
can use and whether it has a password, why their session ended before it, and each attempt's network
address, browser, reference and underlying error. Failures that happened before anyone could be named
— no corporate session on the request, a gateway that could not be reached — are shown beside the
person whose attempt followed from the same browser. Filter by reason or connection, or find a person;
built on the server from a bounded read (`GET /api/v1/admin/sso/failures`, `system:audit:read`).

**An Activity tab in Admin → SSO.** Every sign-in, failure, session ending, sign-out, identity link
and SSO configuration change as a table: when, person, connection, outcome, reason and the error
behind it, reference, and network address and browser, each its own column. Outcome chips carry their
counts; filter by connection and window; one search finds a person, an email, a reference or an
address; click a person or a connection to narrow to them; open a row for the whole record. Every
filter runs on the server (`GET /api/v1/admin/sso/activity`), so pages are full and paging continues
where it left off. Diagnostics keeps the problem list and the person lookup, and its *Given a
reference?* card opens Activity with the reference searched.

**End one person's sessions, in Admin → Users**, without suspending them — a lost laptop, a session
you do not trust. They are signed out everywhere and can sign straight back in
(`POST /api/v1/admin/users/{id}/sessions/revoke`, recorded as `user.sessions_ended_by_admin`).

**When each person last used the platform, in Admin → Users.** A sortable **Last seen** column, and an
**Activity** block in the user drawer: Joined, Last signed in (any kind of sign-in), Last seen (had
the app open) and Last activity (what Activity analytics counts). Last seen and last activity are
recorded to five minutes, one conditional row update per person per window.

### Changed

- **A daily-limit expiry ends only that session.** The user's other browsers carry their own limits;
  ending them all made every expiry on one device force a renewal on every other. An enterprise
  identity provider withdrawing a session still ends all of them.
- **A gateway reply with no sign-in time is never refused.** The *Require an authentication time*
  setting is retired: one renamed field on the corporate side locked out everyone on the connection.
  The daily limit counts from each sign-in instead, and the gateway still governs the session.
- **`user.sso_session_expired` carries a `reason`** — `reauth_ceiling`, `idle` or `absolute`.
- **A failed sign-in says who, why and from where.** `user.sso_login_failed` adds `email`, `user_id`
  and `external_id` when the attempt got far enough to know, the error behind the reason in its own
  `detail` field, and `client_ip`, `user_agent` and `path`. The reason itself is a code again:
  `bad_flow_cookie`, `token_or_idtoken`, `saml_validate`, `envelope_invalid`, `payload_rejected` and
  `idp_error` no longer carry the error text after a `:` or `=`.
- **`user.login_failed` says which refusal it was** — `user_not_found`, `no_local_password`,
  `account_inactive` (with `status`), `invalid_credentials`, `throttled`, `local_login_disabled` —
  with `user_id` and where the attempt came from. The person is told the same thing as before.
- **A renewal refused for a reason nothing recorded is recorded**: `user.session_refused` with
  `reuse_detected`, `no_record`, `family_revoked`, `user_inactive`, `sessions_revoked`,
  `session_idle` or `session_expired`.
- **A refused gateway sign-in shows the person a reference** to quote, as the redirect sign-ins do.

### Upgrading

- **A gateway connection with a sign-in trigger or a browser-side translate call needs its origins in
  the frontend container's `CSP_CONNECT_SRC`** (space-separated `https://` origins, e.g.
  `CSP_CONNECT_SRC="https://sso.corp.example"`): `env` in the k8s frontend Deployment,
  `services.frontend.cspConnectSrc` in Helm, the environment in docker-compose. Unset, the policy is
  exactly as before. A value that is not a bare `https://` or `wss://` origin stops the container from
  starting.
- A gateway connection's per-call timeout above 30 seconds is used as 30.
- A migration adds `users.last_login_at`, `last_seen_at` and `last_active_at`, and backfills
  `last_login_at` from each person's identity sign-ins. Password-only accounts fill in at their next
  sign-in; the other two as people use the platform.
- `require_auth_time` on existing gateway connections is ignored from now on; nothing to do.
- A migration indexes `outbox_events` on `(event_type, created_at)`. The build holds a write lock on
  that table for its duration — seconds on most installs; on a very large audit trail, run the
  upgrade in a quiet window.
- Audit rows for failed sign-ins now hold the network address and browser of the attempt. They are
  readable only with `system:audit:read`, like the rest of the audit log.
- **The server refuses to start with an SSO session limit that ends every SSO session**:
  `SSO_SESSION_MAX_AGE_HOURS` at or under one access token (`JWT_EXPIRY_MINUTES`). Unlike the idle and
  absolute limits, `0` does not switch it off. The shipped value is 24.
- **In production, the server refuses to start with `SESSION_ABSOLUTE_MAX_HOURS` longer than the
  refresh-token lifetime** (`JWT_REFRESH_EXPIRY_DAYS` × 24), a limit that could never fire; elsewhere
  it logs a warning. The shipped values (168 and 7) are equal and start normally.
- Size `RATELIMIT_LOGIN_PER_IP` for your largest corporate egress address: the gateway's sign-in and
  silent re-sign-in share that bucket.

### Known limitations

- A 403 for a missing permission still shows on the canvas as slow.
- Disabling or deleting a connection stops new sign-ins through it but ends no existing session;
  use the connection's **End sessions**. A disabled back-channel connection also stops re-checking
  its sessions with the gateway, so they run to their time limits.
- A role or workspace-access change ends the access token only; the session renews with the new
  access, by design. There is no receiver for an identity provider's own logout notifications
  (OIDC back-channel logout); an IdP sign-out reaches us at the next re-check or time limit.
- The Helm chart's `expiryMinutes` default is 60; the other deploy configs use 15. Against 60-minute
  tokens, a gateway connection's default 15-minute outage grace ends sessions at the first renewal
  that finds the gateway down: set it to at least twice the token lifetime.
- Tabs left open across the upgrade run the previous page until they are reloaded.

---

## [Unreleased] — Exports up to 50 GB, with downloads that resume

### Added

**Exports of up to 50 GB, prepared on the server, with downloads that resume.** The Export dialog no
longer streams a data source with version control from the web server while it downloads. The
versioning workers write the file, the dialog shows its place in the queue and then how far it has
got, and the browser downloads it once it's ready, with its size known. A download that breaks off
picks up where it stopped: the download answers `Range` and `If-Range`, which is what a browser's
Resume and `curl -C -` send. Close the dialog while the file is being prepared and it opens on that
export again; the file is kept for a day. A data source without version control still streams its
live graph as before.

**Clicking a relationship opens its details, the way clicking an entity does.** A line on the canvas
opens the relationship drawer. It shows the relationship's type and what it means, the two entities
it joins, its confidence, its properties, and who created and last changed it and when, with its
full revision history. Either end is one click away, on the same Back and Forward trail as the
entity drawer, so a walk can go from an entity to a relationship and on to the next entity. In a
draft, a lineage relationship's properties can be edited (staged with the rest of the canvas's
changes and saved in Review & Save) and the relationship deleted. A line that stands for several
relationships (a bundle, or one rolled up from children) opens as a connection that lists them at
the entities they really join, and each opens on the same trail. Combined flows, hierarchy links and
relationships on the published graph are read-only, and say why.

### Changed

- **The relationship drawer tells relationships from roll-ups.** Opening a line lists its
  relationships first, and says why the line joins those two cards when its relationships are
  between entities inside them. Roll-ups (the summaries the aggregation job computes, read-only) are
  listed apart, with what they are. When a line holds both, "All · Relationships · Roll-ups" narrows
  the list to either, with counts. The canvas draws what it did before. Hovering a line says whether
  it is a roll-up or how many relationships it stands for.
- **A roll-up lists the relationships it stands for.** Open a roll-up line (REPORTING → Executive
  Board Dashboard, "Stands for 14 flows") and the drawer lists the real relationships between
  everything inside the two cards, at any depth, by name — each opens like any other, and can be
  changed in a draft. They are read from the data source (a draft sees its own), up to 1,000;
  when there may be more it says so. New: `POST /graph/edges/beneath` (`{sourceUrn, targetUrn}` →
  `{edges, total, truncated}`).
- **The selected entity's partners scrolled out of a column are named, with which way they
  flow.** The tray at the column's edge now reads "Off-screen above" or "Off-screen below", and
  each entry names the entity the line really reaches, not the card it lands on: "order_key —
  feeds order_count · in GOLD › fact_orders". A line that stands for several entities reads "3
  consumers · in SILVER". A click opens the card down to the partner, scrolls to it and pulses
  it; the selection stays. Lines to the tray or its pill are drawn like any other line, with
  their arrowheads and motion, and leave the row on the side Marker sides says. × and Esc fold
  the tray into its pill whether trays are on or off. A selection scrolled away shows as
  "order_count (selected)", and a click goes back to it. The Display switch is now "Off-screen
  partners". While the relationship drawer is open on a line, its two end cards are lit and tagged
  **From** and **To** as the drawer names them (**Two-way** for a line both ways); nothing else
  dims, and the tags go when the drawer closes. An end scrolled out of view keeps the line drawn,
  docked to that end's entry on the rail, which carries its tag too.
- **One export can be 50 GB** (`GRAPH_EXPORT_MAX_BYTES`, was 20 GiB).
- **A running export says how far it has got.** Its job's `summary` holds the records read or written
  so far, the passes (a spreadsheet reads everything once for its columns, then writes it), and the
  bytes, until the finished summary replaces it; a finished one says whether its file is still
  `kept`. `POST …/exports` takes a `filename` for the download.
- **A stored export downloads uncompressed**, so that the browser knows its size and can resume it.
- **A click on a line opens the relationship drawer instead of the Edge Explorer.** The Explorer is
  one click away from the drawer. Its cards gain an "Open details" button, and their pencil opens the
  drawer in Edit.
- **Entities and relationships are edited in a draft only.** On the published graph the entity
  drawer and the Edge Explorer offer no edit controls; the drawer offers "Edit in a draft" instead,
  and on a data source without version control its Edit tab is disabled and says why. The drawer's
  JSON tab is read-only. A staged edit says it still needs Review & Save, with the way there.
- **A save answers with what it stored.** `POST /graph/changes` returns `entities`: each entity the
  save touched as a reader returns it now, with its `version` (`entitiesTruncated` past 500), and the
  canvas takes it — so editing the same field again is not a conflict with your own last save.
- **An entity's summary and its history, bounded.** New `GET …/entities/{id}/summary` says who
  created the entity and who last changed it on the line you are reading (in a draft: main at the
  draft's branch point, then the draft's own edits), how many revisions each line has, whether main
  changed it after the draft began, and — `include=value` — its value and token. `…/history` now
  pages newest first (`limit`, `before`/`nextBefore`, `scope=all|draft|published`, `branchId`), reads
  only main and the draft you name (403 for a draft you cannot read), and says what each revision
  changed, property by property. The drawers use these instead of downloading every revision.
- **The entity and relationship drawers share one frame, and keep their keys to themselves.** Keys
  typed in a drawer no longer reach the canvas: Backspace in a drawer does not delete the selected
  entity, and the canvas's letter shortcuts do not fire. Esc leaves a field first, then closes the
  drawer; ⌘S (Ctrl+S) stages an edit. When the drawer changes to another entity while you are working
  in it, focus moves to the new title. When it closes, focus goes back to where it came from. An edit
  in progress shows a stage bar, with Cancel and "Stage changes", on every tab. "Updated" names who
  made the change.
- **Both drawers end on the same two cards: Updated and Synced.** The cards fill the footer row
  (Synced no longer floats in the middle of it). Updated says when, and who (with their avatar), and
  marks a draft's own change. Its tooltip has the exact time, when and by whom the entity was
  created, and its revision counts. A change made on the published graph after your draft began is
  called out above the cards. The relationship drawer's Provenance section is gone; the cards and
  their tooltips say the same. Its Details say what the relationship means (in plain words, even
  when its type has no description of its own) and name each end and its type first, with the
  identifiers as a detail you can copy. An entity that isn't loaded on the canvas (the real end of a
  relationship inside a collapsed card) is named by the data source, not shown as its id.
- **The drawers stay fast on large canvases.** They read their own entity rather than the whole
  graph, so a pan, a pulse or a page of children arriving elsewhere no longer re-renders them. The
  list of places to move an entity is built only when you open it, and is searchable. Reading the
  relationships between a few known entities binds both ends in FalkorDB, so a relationship on a hub
  no longer walks every edge the hub has.
- **An update removes a property only when told to.** `POST /graph/changes`, the draft
  `…/changes` (stage) route and `PATCH /edges/{id}` take `unsetProperties: [name, …]` beside the
  payload. `properties` in an update merges key by key everywhere, including the stage route, which
  used to replace the whole bag. Naming a property both in `properties` and in `unsetProperties`, or
  `unsetProperties` on anything but an update, is a 422 (`invalid_patch`).

### Fixed

- **Some of a selected entity's lines could not be clicked.** A line to a partner scrolled out of
  the same column runs to its "Off-screen" tray entry or "↓ N connected" pill. It was drawn but
  took no clicks, and on the pill it ran diagonally across the rows. It now opens the relationship
  drawer like any other line, and it runs down the column's gutter to the pill instead of crossing
  the rows. In "On Hover" density, a hovered entity's lines vanished as soon as the
  pointer left the entity to reach one. They now stay while the pointer crosses over, and for as
  long as it rests on a line.
- **The line you clicked disappeared while you read about it.** In the default "On Hover" density a
  line is drawn only for the selected entity, and clicking the line took the selection, so the line
  vanished as its drawer opened. Now the line a drawer is open on stays drawn, whatever the density,
  and glows, and the board scrolls just enough to keep both ends clear of the drawer. Nothing else
  dims: every other line and card stays in view. The Graph canvas shows it as selected. The card
  that appears when you hover over a line names both ends and their types (it could show ids) and
  gives each relationship type its readable name.
- **An unstaged edit in a drawer could be lost without a word.** Esc, starting a trace, opening the
  Hierarchy Builder or following a lineage row closed or swapped the drawer and dropped the edit, and
  a canvas click selected the other entity while the drawer still showed the first. Now anything
  that would move the drawer waits, selection included, and asks: stage the edit and go on, discard
  it, or keep editing. Leaving the page asks too.
- **A stored export's download could be cut short.** It was held to the API's two-minute deadline,
  which ends a response cleanly, so a large file (a view package's, say) could arrive incomplete while
  looking whole, and nginx buffered it to disk. It now runs as long as it takes, as the streamed
  export does.
- **Anyone who could read a workspace could download its export jobs.** Listing a graph's exports,
  reading one and downloading it checked only workspace access, so another user's export of their
  private draft, or of a view you can't read, was yours to download. Each now checks again what
  creating the export checked: an export you may not read is a 404, and missing from the list.
- The download of an export whose file was swept now says so (404) instead of failing once started.
- **Editing an edge's properties in the Edge Explorer crashed** before anything was staged, and
  would have saved the canvas's own fields (`version`, `label`) as if they were properties. Edge
  properties are now edited in the relationship drawer and saved as the properties the edit changed,
  added or removed — so removing a property now removes it.
- **History for an entity or relationship whose id holds a `/` returned 404.** The versioning routes
  now keep an encoded `/` inside the id, as the graph routes already did — which covers a
  relationship id made from two URNs with paths.
- **Deleting an entity's property never persisted.** The save said "Saved" and the property came
  back on reload: the drawer sent the whole property bag, and an update keeps every property it
  doesn't mention. An edit now saves only what changed, and names each removed property. Around it,
  every other write path removes a property the same way: two edits of one entity in one save no
  longer lose the first one's removal; the stage-and-commit path no longer wipes the properties an
  edit doesn't mention; a new entity never stores the removal marker; and `PATCH /edges/{id}` no longer
  replaces a relationship's whole property bag with the few it names.
- **Edits made on the published graph were dropped while Save reported success.** Save there now
  keeps them, says they need a draft, and offers to open one.
- **An entity's schema fields and business label were never saved.** Both are now stored as the
  entity's properties, where the drawer reads them from.
- **A rename and an edit of the same entity were two changes**, and discarding one put the other's
  stale copy back on the canvas. They are one change now.
- **Saving the same entity twice conflicted with yourself.** The canvas kept each entity as first
  read, token included, so the second save merged against a value the draft had moved past.
- **A conflicting save failed with "Main has moved".** The conflict now names each field someone else
  changed, with the value it had, theirs and yours; Review & Save lets you keep yours or take theirs,
  field by field, and saves only what you changed on top of their version. A 409 `merge_conflict`
  from `/graph/changes` carries `current` (each conflicting entity as it is now) and each conflict's
  `entity_kind`.
- **In a draft, an entity's "Updated" could be a change the draft doesn't have** — the newest edit on
  any branch, including main after the draft began. It is now the last change on the draft's own
  line, and a note says when main has changed it since.
- **The Hierarchy Builder lost a new entity's description** — it was filed among the properties,
  where the save strips the name as reserved. It is saved as the entity's description.
- **A removed property named like one of the platform's own (`id`, `weight`, `confidence`, …) stayed
  on the live graph** — still shown, still matching search filters. The projection now removes any
  property except the node's own reserved fields and its identity property.

### Upgrading

No migration. To clear properties the projection left behind on the live graph before this release,
run `python backend/scripts/heal_native_leftovers.py` (a dry run, which lists what it would remove)
and then with `--apply`; it removes only a property the entity's published version no longer has.
A client that removed a property through the stage route by leaving it out of `properties` must now
name it in `unsetProperties`. The pod nginx's streamed-export location now also covers `…/exports/{job}/download`
(no buffering, an hour between reads): an nginx config of your own in front of the API needs the
same. Exports are kept in the object store for a day: keep it on a mount
(`OBJECT_STORE_BACKEND=local`) rather than in the database for exports of many gigabytes.

### Known limitations

- **Preparing a 50 GB export takes hours.** One export runs on one worker, at about 10 MB a second as
  NDJSON and 3.5 as CSV, which reads everything twice. Nothing splits an export across workers yet,
  or cancels one being prepared: "Export something else" leaves it to finish, and its file is swept.
- **A download longer than the load balancer allows one response is cut** (an hour, on the GKE
  manifests), and has to be resumed: the browser's Resume, or `curl -C -`.
- **Exports aren't compressed**, on the server or on the way: a 50 GB CSV is 50 GB to download.
- **A change on the main line names whoever published it**, not whoever made it in their draft.
- **Only a relationship's properties are edited**; its confidence and type are shown, not changed.
- **A line summarising a trace, or a combined flow drawn between two containers, lists no
  relationships** — it says what it stands for. Expand either end to see them.

---

## [Unreleased] — Imports up to 10 GB

### Added

**Imports of up to 10 GB, uploaded in parts that resume.** A CSV, TSV or NDJSON file can now be
10 GB (a JSON or Excel file, which is read whole, stays at 100 MB). The Import dialog sends the file
in 16 MB parts, three at a time, retries a part that failed, and shows how much is up. If the upload
stops (a dropped connection, a closed tab), choosing the same file again sends only what the server
doesn't hold yet. A file too large for its format is refused before any of it is sent. Scripts can
use the same routes (`…/imports/uploads`), or still send a file of up to 100 MB as one request.

### Changed

**Imports use a fraction of the memory, and run three to four times faster.** The importer held the
data source's whole graph in memory (about 4.4 KB per entity) and every row of the file. It now
works a window of 50,000 rows at a time, looking up only what the window names: 200,000 rows into a
200,000-node graph peaked at 490 MB instead of 1.4 GB, and memory no longer grows with the graph.
Rows, resolutions and entity versions are written in bulk rather than one statement each: that
import took 2 to 3 minutes instead of 8½. Every commit writes its entity heads in bulk too, so
large publishes, merges and reverts gain as well.

### Fixed

**An import's staged rows are cleared.** Every row of every import stayed in the database forever:
the retention setting was never used. The versioning worker now deletes the rows of imports finished
more than `IMPORT_STAGING_GC_DAYS` (7) ago.

### Upgrading

One migration, `20260927_1000_import_indexes`: an index on `node_versions (graph_id,
qualified_name)` and one on `import_rows (job_id, matched_entity_id)`. It builds them with a plain
`CREATE INDEX`, which holds writes to the table until it is done: on a large installation, run it in
a quiet hour. New settings, both optional: `IMPORT_MAX_BYTES` (10 GiB) and
`IMPORT_WHOLE_FILE_MAX_BYTES` (100 MB). The parts are kept in the object store: for multi-GB files,
keep that on a mount (`OBJECT_STORE_BACKEND=local`) rather than in the database.

### Known limitations

- **A 10 GB import takes hours.** It writes about 1,500 to 2,500 rows a second, and a 10 GB NDJSON
  file holds around 40 million rows. It runs on the worker, not in the web servers. The dialog shows
  the upload's progress and the job's place in the queue, but not yet the import's own progress.
- **An interrupted import starts over**, and an upload has a day to finish before its parts are
  swept.
- **A large import's staged rows take about the file's size again in Postgres** until they are swept.

---

## [Unreleased] — Imports and exports off the web servers

### Changed

**Imports and exports run on the versioning worker, not the web servers.** An import or export job
ran inside the web server that took the request, sharing its CPU and memory with every other
request. The web server now only queues the job, in Postgres, and the versioning worker runs it:
two at a time per worker process (`GRAPHVER_TRANSFER_SLOTS`), oldest first, each job taken by one
worker only. A job waiting its turn says so, with how many are ahead of it, in the canvas's Import
dialog, a view package's export and a view package's data import. The compose and Kubernetes
manifests run this way (`GRAPHVER_TRANSFER_INPROCESS=0`). Without a versioning worker (a single
process, the Helm chart), jobs run in the web server as before.

**Import and export files can live on a mount.** `OBJECT_STORE_BACKEND=local` keeps them as files
under `IMPORT_STORE_ROOT`, and that can now be any directory every server mounts: a shared volume,
or an S3 or GCS bucket through its FUSE driver (Mountpoint for Amazon S3, Cloud Storage FUSE). That
keeps multi-GB files out of the database. A file is written once, front to back, and a write that
fails now deletes what it wrote instead of leaving half a file.

### Upgrading

Nothing to migrate. The compose and Kubernetes manifests set `GRAPHVER_TRANSFER_INPROCESS=0` on the
web tier, so imports and exports start only while their versioning worker runs. On stop the worker
gives running jobs 40 s to finish, within its 60 s grace (compose now sets `stop_grace_period`).
New settings, all optional: `GRAPHVER_TRANSFER_INPROCESS` (on unless set), `GRAPHVER_TRANSFER_SLOTS`
(2 per worker process; an export job also takes one of its pod's `GRAPH_EXPORT_CONCURRENCY` turns,
so raise the two together), `GRAPHVER_TRANSFER_POLL_SECS` (1) and
`GRAPHVER_TRANSFER_QUEUE_TIMEOUT_SECS` (6 hours; a job no worker starts in that time reads as
failed).

To keep import and export files on a mount, set `OBJECT_STORE_BACKEND=local` and `IMPORT_STORE_ROOT`
to its path on the web servers and the versioning worker alike. Mountpoint for Amazon S3 needs
`--allow-delete` and `--allow-overwrite`. Files already in the database store aren't moved, so jobs
in flight when you switch need starting again.

### Known limitations

- **An interrupted job starts over.** A worker that stops mid-job (a deploy, a crash) takes the job
  with it: the job reads as failed, and running it again redoes it from the start.

---

## [Unreleased] — Views that travel between environments, and remember their versions

### Added

**A view can move to another environment.** Export any view, or any version of it, to a
`.view.json` file, and import it wherever the same data source is onboarded: the View wizard has a
new **Import a view** journey, the Explorer and each workspace's Views manager have **Import view**,
and a file dropped anywhere on the Explorer opens it. The import suggests where the view belongs,
measured on a sample of its own entities ("49 of 50 found here"), then looks up every entity the
view places and shows the match percentage. Anything not found is kept and marked, and goes live
if the entity appears later; you can also drop it, remap it to another entity, or map a missing
type to one that exists. Then the usual wizard steps let you change anything before it writes.
On the canvas, a chip counts the placements not found here and lists them with their layers.

**Importing a view that is already here updates it.** Each view carries an identity that crosses
environments and the hashes of its whole history. So a newer file of the same view becomes its next
version, and the import says how the two stand: the file is newer, the view here has moved on, or
both changed. **Replace** takes the file's design; **Merge** keeps what changed here, and the file
wins where both changed the same thing. A file can also create a new view, import as a separate
copy, or overwrite another view you can edit (its design is saved as a version first).

**Round trips lose nothing, and prove it.** The server writes a view's design (everything but its
ids, owners and label) in one canonical form and hashes it. The file carries that hash, and the
import re-reads what it stored and says whether it is exactly what was sent. When this environment
had to change something, such as custom node order where node sorting is off, the import says what
and why. Export, import, export and import again gives byte-identical designs. Name, description,
icon and tags travel beside the design, so renaming never breaks the view's identity, and settings
this release doesn't know are carried through untouched.

**Views have versions.** Every view keeps numbered, immutable versions of its design: v1, v2, …
Saving in the wizard, importing, restoring, a draft going live and exporting unsaved changes each
keep one, and **Save version** keeps one with a note. The view header's **Versions** opens the
history: compare any two versions (or one with the current design), restore one (the current
design is saved first, and sharing is left alone), or export it. An imported version shows how
much of its file matched. Canvas autosaves show as "unsaved changes since vN" rather than a
version each. A view that predates this gets its first version the first time it is needed.
Anyone who can read a view can export it; someone who can't edit it exports its latest version
as it stands, and nothing is written for them.

**A file of several views imports in one go.** Export several views from the Explorer's (or Views
manager's) selection bar. On import, map each source to a data source, check every view at once,
and review them in one table: create, update, copy, overwrite a view picked here, or skip; name;
visibility. A type missing where the views land is mapped once for every view from that source.
Each view then imports as its own request under one batch, so one failure doesn't stop the rest,
and **Retry failed** is safe to press.

**An import can wait in a draft.** On a data source under version control, a new view or an update
can go into a draft and go live when the draft is published or its review request merges. This is
the default where you can open drafts. Until then a new view is private and appears in no list,
count or search. The draft's Changes tab, its review request and the publish dialog show its
views, and a draft that changes only views can now be published. **Submit for review** is offered
as soon as the import finishes; a file's views each wait in their own draft, and are submitted
together, one review each.

**A view can travel with its data.** **View + data** in the export dialog packages the view with
its data source's own export (the view's entities or the whole source, published or from your
draft) as a `.view-package.zip`. Importing one brings the data into a new draft of the target
(adding and updating only, never deleting), checks the view against that draft so the entities the
data brought count as found, and puts the view in the same draft, so the two go live together.
If the data import fails, **Try again** runs it again into the same draft.

**Wherever a view is, so are these actions.** The view header has **Versions** and **Export**. A
view's card menu in the Explorer has **Export…**, **Versions** and **Update from file…**. The
canvas's **Import / Export** menu has a new **This view** section: export the view, export it with
its data, or update it from a file.

**All of this is a preview, off until an admin turns it on**: Admin → Features → **View versions,
import and export** (`viewPortabilityEnabled`). While it is off, none of the actions above appear
and the server refuses their requests. Versions are recorded all the same, so turning it on shows
each view's whole history. Two more switches, **Export views** (`viewExportEnabled`) and **Import
views** (`viewImportEnabled`), are on by default and decide which directions are allowed once the
preview is on. Exporting a view with its data also needs **Export graph data**; importing one needs
version control.

The formats, rules and API are in `docs/features/view-portability.md`. The file format's JSON
Schema is `docs/features/view-bundle.v1.schema.json`, rendered from the importer's own model.

**Graph data exports stream, at any size.** The export dialog first asks what the export will
hold, then the browser downloads the file while the server writes it: the first byte arrives at
once and nothing is built or stored first. The server reads the graph a page at a time from one
pinned commit, so memory stays flat whatever the size, and any pod can serve the download. A
3-million-node, 3-million-edge graph exported as 4.5 GB of NDJSON in under six minutes, with the
server at about 200 MB throughout. An export keeps about one CPU core busy while it runs, so each
server (a pod, across all of its worker processes) streams two at a time
(`GRAPH_EXPORT_CONCURRENCY`). Another waits for a turn, for up to 15 minutes, then gets 429 with
`Retry-After`; an export job waits its turn the same way. An export that would hold nothing says
why instead of downloading an empty file, and one too large for Excel's 1,048,575 rows per sheet
offers CSV before anything downloads.

**A data source without version control can be exported**, in View mode as in Edit mode: a cold
copy of its live graph, in any of the five formats. Its rows carry URNs, so importing it into a
data source with version control matches them there. The same is true while version control is
still being set up for a data source.

### Fixed

**Some exports downloaded empty files.** A view-scoped export only matched a view's placements by
URN, so a view on a version-controlled source (whose placements can be keyed `gv:<entity id>`)
exported nothing. The export job also ran inside its request, which the 120-second timeout ended,
and wrote to disk local to one pod, so its download could come from a pod that didn't have it.
Exports now stream (above), match every placement key the canvas writes, and never download an
empty file.

**Every format re-imports what it exported.** A list property written to CSV, TSV or Excel came
back as the text `['a', 'b']`; it is now written as JSON and read back as the list. A CSV cell
holding a line break (a description, say) split its row in two. A JSON array was taken for NDJSON
when its first line was valid JSON on its own. Parsing a large NDJSON or JSON file took time that
grew with the square of its size; it is now linear. Exporting then importing each format into the
same data source now reports every row unchanged.

**Import and export jobs outlive their request, and never read "running" once stopped.** They ran
as the request's background tasks, which the request's timeout cancelled after 120 seconds, and a
cancelled job read "running" forever. They now run as tasks of their own, a running job reports
in every 15 seconds, and one silent for 15 minutes (`JOB_STALE_AFTER_SECS`) — its server restarted —
reads as failed: "The job stopped before it finished … Start it again."

**Import and export files are kept where every server can read them.** Uploads and export artifacts
were written to disk local to one pod, so a download or an import could land on a pod that didn't
have the file. They now live in the database, in 1 MB chunks, swept after a day
(`OBJECT_STORE_TTL_HOURS`). A download whose file was already swept is a 404, not a broken file.

**Large uploads reach their routes.** The 100 MB body cap for uploads only matched paths no upload
route used, so a bulk import, a view package, or a view file over 8 MB was refused at 8 MB. Those
routes, and checking and importing a view file's designs, now take up to 100 MB; everything else
keeps 8 MB.

**Imports larger than 100 MB are refused before they upload**, with how to split them, instead of
an opaque error from the proxy. An import the server cancelled no longer shows as finished.

**The projector's node fingerprint showed as a property.** Every node projected from version
control carried `gvHash`, the projector's own bookkeeping, among its user properties in the canvas
and in exports. It is now reserved like the projector's other fields.

**A request that allocated a lot stalled every other request on its worker.** Each full garbage
collection walked the whole heap the server builds at startup (about 300,000 objects, 140–180 ms
on the event loop), and a large export set one off about once a second. That heap is now frozen
once startup finishes, and those collections take a few milliseconds.

**Saving a view from the wizard deleted its display rules**, and anything else its reference
layout carried beyond layers and placements, because the layout write replaced the reference
layout wholesale. The wizard now carries them through, as the canvas already did.

**Publishing a draft dropped layout fields the layout merge didn't know about.** Any
`referenceLayout` field beyond layers, placements, display rules and default sort was lost when a
draft's layout went live. Such fields are now merged three ways like the rest.

### Security

**Views waiting in a draft stay private until it goes live.** Every query that lists, counts or
facets views now goes through one live-view filter, and a structural test fails the build if a
new query of the views table skips it. That includes the analytics, popularity, search-facet and
workspace-count paths. Such a view can't have its visibility changed, or be put up for
publication, until its draft goes live.

**An uploaded file is untrusted input, and is treated as such.** View files are capped at 64 MB,
200 views, 250,000 placements and 64 levels of nesting. Packages are capped at 100 MB, and their
data at 2 GB decompressed however the archive describes itself. Every part is checked against the
package's checksums, and a part changed after export is reported. An upload is kept for 24 hours,
for the person who uploaded it only. Imports pass the same gates as building a view.

### Upgrading

Three migrations, all additive: `20260923_1000_view_versions` adds `views.portable_id` (stamped on
existing views in batches) and the `view_versions` table, and widens the view-activity actions.
`20260925_1000_view_draft_stage` adds `views.draft_branch_id` and the staged-import columns on
`view_layout_overlays`. `20260926_1000_object_store` adds the two tables that hold import and
export files (`object_store_objects`, `object_store_chunks`). Existing views get no versions up
front; each gets its first the first time it is needed.

Nothing changes for users on upgrade: the feature is a preview and ships off. To try it, turn on
Admin → Features → **View versions, import and export**.

The transfer routes run under a new 120-second timeout tier (`HTTP_TIMEOUT_VIEW_TRANSFER_SECS`),
below nginx's 180 s. Package uploads wait in the object store under `transfer-uploads/` and the
versioning worker prunes them after a day. nginx's `client_max_body_size` (100 MB) already matches
the package limit.

Import and export files now live in the database: `OBJECT_STORE_BACKEND=database` is the new
default (`local` keeps the old per-pod directory, for a single-instance setup), and the versioning
worker's daily pass sweeps files older than `OBJECT_STORE_TTL_HOURS` (24).

Streamed exports need their proxies to let a long download run. The frontend's nginx has a new
location for the two export stream routes (`proxy_buffering off`, `proxy_read_timeout 3600s`);
every other API route keeps its 180 s. The GKE BackendConfigs' `timeoutSec` goes from 180 to 3600
(frontend and viz-service), and the Helm ingress's `proxy-read-timeout` from 180 to 3600: the app's
own tiers still end every other request first. The export stream routes are exempt from the
request timeout, like server-sent events. New settings, all optional: `GRAPH_EXPORT_CONCURRENCY`
(2 per pod, shared by its worker processes through lock files in the temp directory; size it to
the CPU cores a pod can spare), `GRAPH_EXPORT_SLOT_WAIT_SECS` (900), `GRAPH_EXPORT_MAX_BYTES`
(20 GiB, the most one export may stream), `GRAPH_EXPORT_PLAN_BUDGET_SECS` (20, how long a plan
counts before answering without exact counts) and `GRAPH_EXPORT_PAGE_SIZE` (2,000 rows per read).

### Known limitations

- **Entity identifiers are not rewritten between environments.** A view matches where the
  environments use the same URNs; anything else shows as not found and can be remapped by hand.
- **Files are not signed.** The hashes prove a file wasn't changed after export, not who exported it.
- **A package brings its data with one of its views**, because a draft belongs to one view. Import
  the package's other views afterwards with **View only**.
- **An import is one file of at most 100 MB.** An export has no such limit, so a large one is
  imported back in parts.
- **A live export isn't a snapshot.** A data source without version control has no commit to pin,
  so a change made while its export downloads may or may not be in the file.

---

## [Unreleased] — The cluster window, and the names a graph can hold

### Fixed

**A rebuild's writes were budgeted against the wrong ceiling, and the cluster voted the
master out.** Writes ran under a 60-second default raisable to 600, on the reasoning that
"the server clamps every query at its own `TIMEOUT_MAX` anyway" — true for a standalone
instance, and the wrong limit in cluster mode. `TIMEOUT_MAX` says how long FalkorDB will
let a query run (120 s as shipped); `--cluster-node-timeout` says how long the OTHER
masters wait before voting this one out (15 s as shipped), and the second is eight times
smaller. FalkorDB blocks the client for a query's duration, and Redis force-unblocks a
blocked client when the instance changes role — so a long write raced the election and
returned `-UNBLOCKED force unblock from blocking operation, instance state changed (master
-> replica?)` with no pod having restarted. Every query budget is now derived from the
failure detector (40% of it, floor 2 s) and clamped at the boundary, so the pipeline's
batches, the bulk loader's, the versioning projector's and a `writeTimeoutS` raised on a
running job are all bounded. An operator cannot raise past it. A batch that needs longer is
aborted by the server, halved by the pressure ladder and re-issued — an ordinary in-run
retry where it used to be a failover. The ceiling is a WRITE ceiling and nothing else:
FalkorDB dispatches `GRAPH.*` to a module thread pool while the main thread keeps answering
the cluster bus, so a long read cannot cost a vote — only a write, which holds the write
lock, can. Clamping reads to it cut the canvas's own 15-second children query, the 30-second
stats scan and the aggregated ladder's 36 seconds down to 6, turning ordinary slow reads
into errors. Reads run on their own budget, and the generic read default is 15 s to match
the canvas.

**The clamp depended on an environment variable that was set nowhere.** A production
cluster running nine nodes at a 15-second failure detector had a ConfigMap that predated
`FALKORDB_CLUSTER_NODE_TIMEOUT_MS`, so the deployment that needed the clamp most silently
did not get it — and the client used its 3-second fallback for every failover wait, park
and `Retry-After`. A safety limit that disappears when a variable is missing is not a
safety limit. The window now comes from `CONFIG GET cluster-node-timeout` read off the node
itself (the smallest any node reports, since the clamp must hold for every shard), with the
env as a mirror until a node answers, and an assumed 15 s announced once at `WARNING` when
`FALKORDB_MODE` says cluster and neither has. No clamp at all now applies only to a
standalone or sentinel deployment. The cluster overlay declares the value, and a test fails
the build if it disagrees with the shards' own `--cluster-node-timeout`.

**A demotion was retried into rather than waited out, and cost the whole run.** There is no
redis-py class for `-UNBLOCKED`; it arrives as a bare `ResponseError`, and the role-changed
check matched only on class name — so the one branch that fixes a demotion in under a
second was skipped for exactly the case it exists for. The branch was also too short to
reach one: three retries with NO WAIT AT ALL, never reading the backoff schedule its own
cap came from, then the raw error, which spent a job retry. A retry re-runs EXTRACT and
COMPUTE from zero, and the attempt budget only resets when `processed_edges` passes its
high-water mark, which a from-zero re-run never does — so one routine shard rotation became
three hours of repeated work and then a failed job. `-UNBLOCKED` is now matched by message
on the verb alone, and a write waits on the same ladder a refused connection gets (17.5 s
in cluster mode) before raising `ProviderFailingOver`, so the job parks with its checkpoint.
A read keeps the short path deliberately — its wall clock is sized for the transient window
only, so an escalated ladder there would surface as `asyncio.TimeoutError`, which nothing
reads as a failover.

**The idle reaper closed a provider underneath a running rebuild.** "Idle" was measured
from the checkout stamp and nowhere else, and a worker checks out once per job — so any run
longer than `PROVIDER_CACHE_IDLE_TTL_SECS` (900) read as untouched since minute zero.
`inflight_ops()` did not save it: that answers "busy this instant", and Compute is the one
stage that issues no graph I/O at all. The reaper now takes the later of the checkout stamp
and the provider's last completed operation, and the worker ConfigMap raises the TTL to
7200 — the code fix alone cannot cover a Compute that exceeds the TTL with nothing in
flight. The web tier keeps 900.

**A graph filled all 65,534 of its property names with source metadata keys, and the first
rollup write found room for none of the nine it needs.** FalkorDB numbers property names
with a 16-bit id per graph and never frees one — ids are minted in
`GraphContext_FindOrAddAttribute`, the only removal is an undo-log rollback, and the RDB
encoder saves every key, so only `GRAPH.DELETE` discards the map and a purge frees nothing.
The raw data did not land fine WHILE the rollups failed; it landed FIRST and took every id.
Nothing staked a claim on the platform's behalf: `ensure_indices` would register five of
the nine as a side effect of its edge-index DDL, but it is dispatched fire-and-forget so a
bulk loader racing it wins, and its failures are collected and swallowed by contract. Both
writers now reserve all 38 platform-owned names before their first data write, via one
`:_PropReserve` carrier node deleted in the same pass — the name is registered by being
written and never freed, so the property that causes the problem is the one that solves it.
The carrier's label costs no attribute id, and the attribute map is shared between node and
edge properties, so a node reserves the rollup EDGE names too. The reserve reads what is
registered first and no-ops when the platform is covered, so it is self-healing across a
drop or an out-of-band recreate rather than latched to a provider instance.

**Reconcile scanned a 7.8M-edge cube under the write lock while its index was still
building.** FalkorDB populates indexes in the background and a graph read back off disk
rebuilds them the same way; the readiness wait gave up after sixty seconds and proceeded,
so every keyed delete was a full pass over the cube — which the cluster's failure detector
reads as a dead node. Reconcile now asks `db.indexes()` and, above 100,000 existing rollup
edges, waits for what is left of the job's wall clock (never less than one hold) and then
stops with `MaterializationStoreUnstable`, checkpoint kept, rather than scanning. An absent
index stops the same way. A small cube still proceeds after the sixty-second wait. The wait
heartbeats and `run_stats.index_wait_s` records it.

**A missing replica had the same answer as a sick one, and every node drain killed the
run.** A rebuild harms replication by outrunning an attached replica or by writing through
the fork that streams one back — neither needs a replica to be away. The shipped cluster
overlay is 3 shards × (1 master + 1 replica), so every drain, rolling upgrade and OOM kill
took out the only replica a shard had and the rebuild held, then died. The hold could not
buy what it claimed: a partial resync needs the master's backlog to still hold every byte
written while the replica was away, and a rebuild writes past that in seconds. Absence now
gets a five-minute grace and then the run carries on, recording `replicas_forgone`. The
grace is judged on how long the replicas have been MISSING, never on the age of the hold —
an episode can begin as lag, and a run holding twenty minutes for a replica that is behind
would otherwise forgive an absence it had watched for one turn. Replicas fully back re-arm
it, and an absence this run caused by pushing a replica toward the drop limit is not
forgiven at all.

**Cancel was not noticed during Compute.** Every other cancel check sits on a query and
Compute issues none, so a Cancel was not seen until the stage ended — on a large cube,
fifteen minutes of the UI showing a job the operator had already stopped, with the clock
running. Both merge loops already yielded every 1024 / 4096 pairs and simply never asked.

**A node that refused the index DDL made every reader re-issue all 128 statements.**
`ensure_indices` is on the interactive read path, calls the graph handle directly (so the
semaphore, the breaker and the admission controller apply to none of it), and nothing
serialised concurrent readers. When the NODE refused rather than the statement — no in-sync
replica, a dataset still loading, a shard mid-failover — every statement failed, the
success memo was never written, and the next cache miss ran the whole set again for as long
as the condition lasted. The sweep now stops at the first statement the node refuses,
writes a short-lived backoff key (`FALKORDB_INDEX_BACKOFF_S`, 120) where every pod looks,
and admits one sweep per pod with later arrivals skipping rather than queuing. A per-query
memory ceiling and a SERVER-aborted deadline stay deterministic for that statement and keep
running the set; only the CLIENT deadline defers.

**Every versioning read went out write-flagged and was refused during a node restart.**
`-NOREPLICAS Not enough good replicas to write` is a per-command refusal and `GRAPH.QUERY`
is write-flagged whatever the Cypher inside it says, so reconcile counts, the bootstrap
copy's reads and `/graph/neighbors` — all pure `MATCH`/`RETURN` — were refused alongside
the writes, with the raw text reaching the UI. They go as `GRAPH.RO_QUERY` now. This is not
a routing change: no `GRAPH.*` command is in redis-py's read table, so these still go to
the primary that owns the key. The projector's pre-drop probe and the bootstrap's phase-1
count stay write-flagged deliberately, each pinned by a test, and the one real behavioural
gap is closed — a read-only call that meets `Invalid graph operation on empty key` re-sends
the same statement as `GRAPH.QUERY` rather than guessing an empty result, because an
aggregate answers `[[0]]`, not `[]`.

**A full-cube rebuild was OOM-killed at 4Gi.** The accumulator is one dict entry per
DISTINCT rollup cell at roughly 100 bytes and the cube grows as edges × depth², so a few
million cells costs over a gigabyte. The memory-aware flush bounds that INSIDE the merge
loops; the end of a run builds a second full copy of the key set to report and reconcile
what it wrote, where no flush can fire, so the peak is not the flush line. The production
aggregation worker goes to 2Gi requests / 12Gi limits.

**Refresh counted one more data source than the tab lists.** Ingestion → Data Sources
reported "Refreshing all 129 sources" over a list of 128. Each provider's discovery cache
holds one empty-string row — the list-all sentinel, whose payload is the inventory of graphs
rather than a graph — and `jobs_queued` added it to the per-asset fan-out, so the toast was
the asset count plus one on EVERY refresh, for every provider. It now counts assets; the
sentinel's job id is still returned for callers that track it. The same row was also filtered
after the capped query rather than in it, so a provider at the 200 cap returned 199 assets and
`truncated` could never be true. Two other outcomes had been rendering as one: a provider with
nothing cached yet now says its sources are being looked for, and a queue that is down says so
instead of claiming a refresh it never queued.

**A newly created graph stayed invisible after a refresh.** The asset list re-fetched only
while the backend reported `computing`, which is the cold-cache state — a provider that
already has a list is served its previous one as `fresh` or `stale` with `refreshing` set,
never `computing`. So nothing polled while the inventory job ran: the re-list at the end of
a refresh raced that job and usually landed on the same stale payload, and the new graph did
not appear until the 30-second staleness lapsed with a remount or the window regained focus.
The list now also polls on `refreshing` — the worker's own dedup claim, released on success
and on failure — so it follows the inventory job to its result and stops there.

**Refresh skipped the very sources it had just discovered.** The per-asset fan-out was built
from the discovery cache's per-asset rows, and a graph that had only just appeared in the
provider's inventory has none — so "Refresh all N sources" queued nothing for it, on that
click and every later one, until something else happened to give it a row. It now fans out
over what the provider currently LISTS, unioned with the rows that exist, listed first so a
new graph is never pushed past the 200 cap by a stale row for one that has since been
deleted. An explicit `assetNames` request is still intersected against that set, so
arbitrary names cannot seed stub cache entries.

**The control plane's copy of the graph-store limits route could not be called.** It passed a
registry argument that `apply_graph_store_limits` does not take, so every PATCH against it
raised `TypeError: takes 3 positional arguments but 4 were given` — which neither of the
route's two excepts catch, so it surfaced as a 500. The web tier's copy of the route was
always correct; the endpoint tests monkeypatch the function away, so they only ever pinned
that one. A stub carrying the real signature now pins both.

### Security

**A `PATCH` body could forge an entry in the audit log it writes.** `GraphStoreLimitsPatch.actor`
is written verbatim into `graph store limits on X set by ACTOR`, and a CR or LF in it would
append a second, fabricated line. The web route overwrites `actor` with the authenticated
admin, but the control plane's copy of the route takes the body as given. Refused at the
schema, which both routes share.

### Changed

**The native property budget default goes from 8,000 to 50,000, and can be raised per graph
store.** With the platform's names reserved the budget no longer protects the platform; its
only remaining job is to stop a graph becoming un-ingestable, and a registered name on few
nodes costs almost nothing because attribute sets are sized by PRESENT attributes rather
than registered names — which makes a generous default strictly safer than a tight one. A
graph store whose sources carry unusually wide key sets can set `nativePropertyBudget` on
its PROVIDER config. Not per data source: that is a lower privilege, and every name the
budget admits is permanent, so a data-source-level setting would let that role pin a graph
to a hundred names and make nearly every key on it unsearchable for good. Both merge paths
drop a data source's attempt to set it, with the same guard as `cacheConnection`.

**The attribute pre-flight refuses only a graph that cannot register the names the run
writes.** A fixed 500-name margin refused any graph within 500 of the ceiling — including
one already holding rollups written by this pipeline, where every name the run writes is
registered and the rebuild would have completed. The pre-flight now reads the registered
names and asks the one question that decides it, naming the missing names and the room when
it refuses. A graph at the ceiling that can still be rebuilt carries an
`attribute_names_exhausted` advisory instead. A drift test pins the hand-kept name sets to
the Cypher the pipeline issues and to the declared edge indexes.

**A re-trigger can put the last run's settings back — as a control, not a default.** The
dialog still opens on the configured defaults, because replaying a job's frozen tuning is
how a graph that failed under bad settings kept failing under them. But a run dialled in by
hand and WORKING had to be re-entered knob by knob from a screenshot. `overridesFromRun`
reads what the run actually recorded and the dialog offers it beside a line saying why it
is not already loaded. Rollup storage comes across too, because a run forced to full detail
must come back forced rather than resolved against today's default. The control is absent
when there is nothing to put back.

**A manual trigger opens on Balanced and states the replica acknowledgement.** With nothing
stored, every profile knob was undefined, no profile matched, and the operator was shown
"Custom" over settings that were exactly Balanced. Nothing about what runs changes —
Balanced's knobs ARE the server's environment defaults. It deliberately does not write
`materializeFinePairs` (that would overrule a fleet that had chosen Auto) and does not seed
through a missing settings fetch.

### Added

**`attribute_limit` is a typed, terminal failure with its own guidance.** The category is
unresumable, has a drawer explanation and a fleet facet, and the store refusing a name
mid-run is classified the same way instead of entering the pressure ladder. It is
registered as a logical exception: as a bare `RuntimeError` the circuit breaker counted it,
so three ingest attempts into a full graph would have opened the breaker and taken the data
source offline for reads, which work perfectly well on such a graph. The guidance names the
two recreate paths — Data health → Rebuild for a versioned source, and `GRAPH.DELETE` plus
the loader plus `signal_data_changed` for a direct load — instead of Purge, which frees no
name.

**The property-name count is on screen.** The capacity card and chip show
`N of 65,534 property names` from the last completed rebuild, and the drawer's technical
block gains a Property names row. New `run_stats` fields: `attribute_names`,
`attribute_names_room`, `index_wait_s`, `write_timeout_s`, `replicas_forgone`.

**The `propidx` schema and its client, wired to nothing.** Phase 1 slice A of
`docs/PROPERTY_STORAGE.md`: a Postgres schema holding the complete user property bag with
one LIST partition per physical graph and an expression GIN over a case-folded copy, plus
`PostgresPropertyIndex` — identity, digest, the unnest upsert with a content-hash skip
guard, the epoch sweep, the load lifecycle and the read side a predicate router will use.
Nothing imports it on any request path and the graph's behaviour is unchanged. The design
record itself is the substantive part: it weighs four architectures, states the invariant,
the write-ordering contract, routing, the read path per capability, the migration modes (a
graph at the ceiling flips with zero graph writes), the cost model at a million nodes, and
what is honestly lost.

### Upgrading

**Full detail:** `docs/RELEASE_NOTES_2026-09-15_falkordb-cluster-and-property-names.md` —
what was wrong at each layer, the value table, rollout order, verification, and the knob
that turns each piece off.

**Confirm `TIMEOUT_MAX` is configured on every shard.** FalkorDB honours a per-query
timeout on WRITES only when `TIMEOUT_MAX` is set; without it the server keeps executing
after the client gives up, still holding the write lock — and the derived ceiling then
bounds only what the client waits for, not what the node does. This is the one prerequisite
the clamp cannot check for itself.

**Apply the cluster ConfigMap and check the shards agree.**
`FALKORDB_CLUSTER_NODE_TIMEOUT_MS: "15000"` must equal the shards' own
`--cluster-node-timeout`. A test fails the build if the overlay and the StatefulSets
disagree, but a hand-edited ConfigMap in a live namespace is outside its reach. If the
deployment runs a different node timeout, set this to that value — the clamp is a share of
whatever is real.

**Apply the worker ConfigMap** for `PROVIDER_CACHE_IDLE_TTL_SECS: "7200"`. Worker only — do
not add it to `viz-config`. **And the production resource patch** for the aggregation
worker's 2Gi/12Gi, after confirming the node pool can still schedule it.

**A graph already at the ceiling has to be recreated.** No code in this release can fix it:
ids are never freed and a purge frees none. Versioned source → Data health → Rebuild, which
drops the graph and re-seeds from the version store under the budget. Direct load →
`GRAPH.DELETE` on the shard that owns it, run the loader again, then `signal_data_changed`.
The second ingest spends its ids differently because of the budget and the reservation, so
the recreate is correct by construction. Runbook in `docs/AGGREGATION_PIPELINE.md`.

**Nothing requires the `propidx` schema.** The Alembic revision creates it; no code imports
it.

### Known limitations

- **A key past the native budget is stored as a value in `propertiesRaw` and shown in the
  Properties panel** — it is unreachable only by search, sort and predicates. This was
  described as "silently dropped" in code and two documents and is corrected everywhere;
  the engine does not drop a name either, it refuses the write.
- `backend/scripts/migrate_native_properties.py` writes native properties without
  consulting the budget, so running it on a graph near the ceiling can still exhaust it.
- `backend/tests/integration/test_property_index_live.py` runs nowhere in CI — it needs a
  live Postgres 16 via `PROPIDX_TEST_DATABASE_URL`, and it is the suite that found all
  three `property_index.py` defects.
- Phase 1 slices B and C of `PROPERTY_STORAGE.md` are paused, on the evidence of one
  source. The reservation plus a 50,000-name budget make a graph un-exhaustible in
  practice; check `db.propertyKeys()` on the other sources before building the rest. Until
  that is decided, `propidx` is dead weight.
- The cube estimator over-counts on a DAG: `_anc_count` sums over parents instead of
  unioning, so it counts shared ancestors once per path, and leaf closures stop being
  memoised past 400,000 nodes. `maxCubeEdges` is inert for a forced cube — the forced branch
  returns before the ceiling is read. All documented; none fixed here.

---

## [Unreleased] — Analytics, and measuring value rather than attention

### Added

**The capacity harness runs distributed in Kubernetes, and stops
under-measuring.** Two faults made a run's number untrustworthy. Every
scenario fired each request once and counted a non-200 a failure, so at
saturation the harness's offered load went *down* — a real client retries a
429 or a `Retry-After` 503, and the real system's load goes *up*. It reported
a ceiling below the real one and could not reproduce retry amplification at
all; `loadtest/lib/retry.py` now mirrors the frontend's retry model, filing
retries as their own stat rows so amplification is visible rather than
averaged away. And a generator co-scheduled with what it measures reports its
own ceiling as the system's, so `deploy/k8s/loadtest/` schedules one worker
per node (required, not preferred — a plausible wrong number is worse than a
pod stuck Pending), away from `viz-service` and `falkordb`, with CPU requests
and not only limits.

**A load test can now fail because the limits stopped holding, not only
because it was slow.** The write-admission cap is fail-open by design, so the
state immediately before a node is over-admitted looks from outside exactly
like a healthy run: latency fine, failure rate fine, cap not capping. A sweep
gated on the CSV alone passes it. `make sweep` brackets each tier with a
counter snapshot when `SYNODIC_METRICS_URLS` is set and fails on any increase
in `aggregation_slot_fail_open_total`, so a failure names the concurrency at
which the cap stopped capping. Governor holds, slot waits, read-pressure
yields and write-budget refusals are reported and never failed — those are
the protection working, and a gate that goes red when the system defends
itself is a gate somebody switches off.

**Job History says where a run failed, how far it got, and what earlier
attempts did.** A run that died in APPLY showed `edgeCoveragePct` on the list
— `processed / total`, which is ~100% the moment EXTRACT finishes — so a
failure read as a hundred percent success, in emerald. It says the stage and
the overall percent it stopped at now. The failed stage draws how far into
itself it got rather than drawing empty, and the error block carries the
typed cause the server had already classified and nothing rendered.

**Resuming a failed job no longer erases why it failed.** A job row is a run
and a run has many attempts, but every per-attempt field was overwritten in
place: resume cleared the error, reset the retry count, and a fresh ledger
replaced the sealed one. `run_stats.attempts` keeps the attempts that did not
succeed — stage, progress, typed cause, error, writes, and a trimmed ledger —
archived at the next attempt's start so a worker that died without reaching a
terminal block is captured too. A successful attempt is never stored (it is
the run record), so a healthy row is unchanged; `AGGREGATION_ATTEMPTS_KEPT`
(default 20) bounds a troubled one.

**Resume says what it will redo.** What it skips depends on the cursor's
phase: nothing if the run died scanning, the ranges already compared if it
died comparing, and every aggregated edge already written if it died writing.
The scan and the rollup computation always re-run first, so the bar starts
from zero and climbs back — the resume working, not failing, which is what it
used to look like.

**A run's progress bar tells the truth about resumes and retries, and the
estimated finish stops lying on them.** `progress` was floored at the row's
previous value so the bar never moved backwards. That put it in permanent
disagreement with `processed_edges`, which was never floored and does reset:
a resumed run showed a bar at 75% beside "0 / 500,000 edges scanned". The
floor was covering for a bug — `resume_processed` / `resume_created` were
passed by the worker, forwarded by the provider, accepted by the pipeline's
entry point and then **discarded**, so the documented "a resumed job's
progress continues from its last checkpoint" never happened. All three
layers of dead plumbing are deleted and both copies of the floor (the
worker's and the API live-state overlay's) are gone: progress is the current
attempt's position and can move down, which the stage rail already explains
with "restarted ×1".

`estimatedCompletionAt` — what the explorer banner, Freshness and the
workspace dashboard show — no longer extrapolates `elapsed × (100 − pct) /
pct` from one percentage. That is only right if every stage runs at the same
rate, which is exactly false, and on a resumed run it was wrong twice over:
the percentage was held up by the floor and `elapsed` ran from the FIRST
attempt's start, so a job redoing two hours of work reported forty minutes
left. It projects off the step ledger against the previous completed run
now, the same rule Job History already used, with the baseline pre-fetched
once per page for the running rows only. **A run with no comparable previous
run gets no estimate at all** — the honest answer, and the running stage's
own "3 of 12 scan ranges, 9 left" is better than a clock time nobody can
stand behind.

**What changed since the last run, and a run you can paste into a ticket.**
Both runs record every knob AND where its value came from, so *Run settings*
now lists what moved — and says whether the pipeline tuned itself (`Learned
from last run`, the previous run hit pressure and carried the narrower value
forward) or a person did. And **Copy record** puts a run's whole record on
the clipboard as text: the node it wrote, every stage with its state,
duration, share and how far it got, the result, the settings, what the ladder
adapted, the advisories and the error. All of it was already on the page,
across four disclosures, which is why attaching it to a ticket used to mean a
screenshot.

**Where a run's wall clock went, and whether one stage is growing.** A
finished run shows each stage's share of the run under its rail — the
durations were already there, the share is what reads at a glance, and it is
where the surprise usually is: on a graph with a slow fingerprint, Prepare
and Finish together can be most of the run. The data-source card draws the
same split as one column per run beside the sparkline, each scaled to its own
duration, so a stage that is growing shows as a band widening across the
columns instead of as one number in one expanded row.

**Job History answers "what else is writing this shard right now".** The
first question during the memory incident, and no page could answer it: the
Graph store page knew nodes, Job History knew jobs, and the two never met. A
run now records the node it writes (`run_stats.node`) from its first
checkpoint with a measured reading, re-read every checkpoint so it follows a
failover. Job History groups the running rebuilds by it and flags a master
more than one is writing — bounded by the reservation ledger, two write slots
per node and the pacing floor neither of them gets, but each still slower
than it would be alone, which is usually the answer to "why is this run
slow".

**Job History compares a run to the last one, stage by stage.** Per-stage
durations answered "how long did this take"; the question an operator has is
"is this getting worse", and both runs carry the same ledger. A finished run's
segments now carry an arrow against the same stage on the last completed run
(only when the change is big in percent AND in seconds — a stage that went
from 1s to 2s doubled and means nothing). A running stage well past its own
last time says so outright, which is the "stuck or just slow" question the
overall percentage cannot answer. And a data-source card names the stage its
recent runs keep dying in: a source failing in Apply is out of room on its
shard, one failing in Extract has a scan it cannot finish — the same red rows,
two different problems.

**Two rebuilds on one master no longer both decide the node is theirs.**
`writePacingMinRatio` is the floor a run drops to when the graph store node
has room to spare. It was decided from the node's own reading, which two
rebuilds on two graphs of one shard read identically — so both took the floor
and the master got twice the write rate either of them believed it was asking
for. That is the memory incident's shape reached from a second direction, and
neither the per-graph lease (different graphs) nor the reservation ledger
(memory, not rate) closed it. The floor is now only for a node this run has to
itself: the governor reads the node's reservation ledger on its own cadence,
and any other holder puts the run back on the configured ceiling. The running
job says so on its Steady load line, because a run that is not at the floor
otherwise just looks slow.

**Interactive-read pressure on one shard slowed rebuilds on every shard.**
The web tier stamps a key when a read starves and the writers stretch their
pause while it lives. It was keyed by the connection config's host:port — a
seed address on a cluster — so a queue-full on shard-0 made a rebuild on an
idle shard-2 yield for thirty seconds, for nobody's benefit. Both halves key
by the node that owns the starving graph now, resolved from the client's
current slot map at no round-trip cost.

**None of the protections could be seen in production.** The metrics façade
had been no-op since it was written — nothing ever called `set_backend` — and
there was no scrape endpoint anywhere. So every counter in the codebase went
to a DEBUG log, and the write governor, the admission slots, the pacing model
and the write budget were observable only per run, after the fact, one job at
a time in Job History. That answers *did this run go badly*. It cannot answer
*are we trending toward the incident*, which is the version of the question
that leaves time to act.

A real backend now installs in every process that emits — web tier, control
plane and the aggregation worker, which raises most of them. No new
dependency: `prometheus_client` is not in requirements and this does not add
it, because the text exposition format is a few lines and a metrics layer is
a poor place to take on supply-chain risk. Cardinality is capped at 500 label
sets per metric and the overflow is itself counted, because the classic way
an observability layer takes a service down is one unbounded label — which,
in a file whose whole purpose is preventing that class of failure, would have
been its own punchline.

Six signals, at points that already existed:
`aggregation_slot_fail_open_total` (**the one to alert on** — a rebuild
waited out the full slot deadline and proceeded anyway, so the cap has
stopped capping, separated by `reason` into contention and a dead bus),
`aggregation_slot_waits_total`, `aggregation_governor_holds_total` with hold
seconds by reason, `aggregation_write_budget_refusals_total`, and
`aggregation_read_pressure_yields_total`.

The endpoint is **off until an operator turns it on** (`METRICS_ENABLED`,
optional `METRICS_TOKEN`). It reads internal state — node endpoints, hold
reasons, fleet load — and this deployment has been bitten before by a surface
that was open because nobody chose to close it. The backend installs
regardless, so switching the endpoint on shows real numbers immediately
rather than starting from zero at the moment you most want history. The
worker gets a small server of its own on `METRICS_PORT`: it has no HTTP
surface otherwise, and counted in a registry nobody can reach is the same as
not counted. Every part of it fails safe — a worker that cannot bind its
metrics port still processes jobs, and no emit can raise into a caller.

**The identity stamp was the last thing hammering a node flat out.** For any
source whose nodes are keyed by something other than `urn` — an onboarded
third-party graph keyed by `id`, say — the conformance stamp is a write pass
over the *whole node ID space*, on every run. It is the heaviest single thing
a rebuild does, and it went out at full speed: no pacing, no slot, no
governor, in a preamble that ran **before the admission controller was
attached**. Every other write path on this branch was rebuilt to stop exactly
that shape of load taking a master down; this was the one place nothing was
watching.

The controller is now attached before the preamble rather than after it, which
gates the ~131 index statements too and changes nothing else — nothing there
reads it until it writes. Each stamp chunk takes the per-node write slot, and
the gap after it is a share of the time that chunk took
(`AGGREGATION_IDENTITY_STAMP_PACING_RATIO`, 0.5; set 0 to restore the old
flat-out timing exactly). What it writes is untouched: same query, same
params, same 50,000-wide slices, same per-batch tolerance, same return — pinned
by tests in both directions, because a change to the slicing would silently
skip nodes and only surface months later as a lineage edge that never
attached.

It also heartbeats now. Nothing between a job flipping to `running` and the
pipeline's first checkpoint touched `last_checkpoint_at`, and the stuck-job
reconciler reads 300 seconds without one as a dead worker — so pacing this
pass without a heartbeat would have reaped healthy jobs on precisely the large
graphs the pacing protects. As a side effect *Preparing* now shows real
numbers, where an onboarded graph used to sit at nothing for minutes.

**The live pipeline test runs in CI against a real FalkorDB.** Every backend
job ran `-m "not integration"` and no workflow started an engine, so the whole
rebuild pipeline was proven against in-memory fakes — our control logic, never
FalkorDB's actual behaviour. A new job stands up the same engine version
`docker-compose.yml` ships and runs the live suite: case-fold matching against
real per-label URN indexes, an unchanged re-run writing nothing rather than
wiping good edges, a resume past every computed key still creating every
missing pair, and the `db.indexes()` shape the readiness probe reads.
Informational until it has a track record, then promote it.

**A run whose worker died left two records lying.** Every terminal path
inside the worker passes through one `finally` — seal the step ledger,
release the source on both mirrors, emit the terminal event. Nothing reaches
it when the worker itself is gone: an OOM-killed pod, an evicted node, a lost
dispatch. Those rows are reaped from another process, and those reapers wrote
`job.status` and little else.

So the **ledger** kept a step marked `running` forever, and both readers of
"where did this die" — `failed_stage` on the server, `stoppedStage` in Job
History — look for `failed` or `cancelled`. A crash-killed run therefore
reported NO failure stage anywhere, and the data-source card's "this source
keeps dying in Apply" tally skipped it entirely: exactly the runs worth
counting, invisible. And the **source row** kept `aggregation_status` at
`running`, which the freshness column reads straight off and the stale-marker
reconciler treats as in flight — so a source reaped this way was deferred on
every tick, forever, and never retried. `cancel()` already documented that
rule and followed it; six other paths did not (the reconciler's four, the
scheduler's watchdog, and crash recovery's cancelled branch).

All six now close a run the way the worker's own `finally` does. The sealed
stage keeps its own counters, so the rail still draws "9,000 of 12,000" for
the stage it stopped in, and the rest of the run record — the writes the
breaker's converging check reads — is untouched. Every read fails open: a
reaper that raises would leave the row `running`, which is the state it
exists to clear.

**"Rebuild failed" is no longer the answer for a dead pod.** Two new failure
categories, keyed off stable message prefixes rather than prose, in the
convention `write budget:` established. **Worker died** says the process
running the rebuild vanished — the run was healthy, everything it wrote is
durable, the checkpoint is intact, and Resume continues from it. **Never
started** says nothing ever claimed the queued row, so the fix is the worker
fleet and re-triggering first just queues another row nothing will claim.
Both used to read as `unknown`, the least actionable bucket there is — or,
for the watchdog's old wording, as `timeout`, which sends an operator to
raise a stall window that was never the problem. No time limit brings back an
evicted pod.

**A failed run now teaches the next one.** `observed_tuning` — the narrowest
scan width a run needed, whether it had to read serially, the reconcile
strategy it switched to — was written only when a run COMPLETED. So a rebuild
that spent an hour halving its scan width down to 500 under memory pressure
and then died taught the retry nothing, and the retry started wide and hit
the same wall. It is the run with the most to teach. The two paths still
differ where they should: a clean run writes `{}` and clears the previous
lesson, because it proves the narrowing is no longer needed; a failed run
writes only a non-empty lesson, so a failure for an unrelated reason — a dead
node, a missing ontology — cannot erase a valid one.

**The control plane stopped fingerprinting every graph, every minute.**
`AggregationScheduler._tick` held a second, older drift detector beside the
probe lane: for every ready source, every 60 seconds, serially, it fetched a
provider and fingerprinted the live graph. Its docstring said "for each due
schedule" but the SQL had no due predicate — `aggregation_schedule` was stored
on the row and never consulted — so a source scheduled daily was probed every
minute like all the rest. That is the constant-time counters, `4 + labels +
types` round trips per source, a few thousand queries a minute across a few
hundred of them on the very threads that serve the canvas, in a tick that then
cannot finish inside its own period; and it falls back to three unbounded scans
(nodes, edges, and a full pass over every node's tags) on any graph whose
counters cannot answer, where the client gives up after 5 s while the query
keeps its own 30 s server budget and the node burns a query thread on a result
nobody will read. None of it bought anything the two lanes built for this do
not already do on a per-source cadence — the probe (the same constant-time
counts, deduped by a claim window) and the reconcile sweeper (those cached
counts against a baseline that excludes `AGGREGATED`, capped at 200 sources and
a bounded number of actions per tick, where the deleted loop signalled every
drifted id in one uncapped pass). The loop is gone; nothing in the tick touches
a graph now. The cost, stated plainly: a change that leaves every entity- and
edge-type count identical is no longer seen as drift — the scan fallback was
the only thing that could see it, and only on the graphs it could finish — and
waits for the next real change or a manual rebuild. Rollups are idempotent, so
that means slightly stale rollups, never wrong ones.

**Nothing capped what a rebuild READ from a graph store node.** Write slots
bounded the writes; the scans were unbounded — and a rebuild reads far more
than it writes (EXTRACT scans every lineage edge, RECONCILE the whole stored
cube). All of it runs under read-from-master-only, deliberately, because the
pipeline reads what it has just written, so none of it lands on the replicas
that absorb interactive reads: it lands on the master, against the same small
`THREAD_COUNT` the canvas queues behind. With `WORKER_CONCURRENCY` jobs per pod
across an autoscaled fleet that is tens of concurrent range scans on one
master, and the read-pressure signal only reacts once users are already
starving. A per-node scan semaphore (`FALKORDB_ENDPOINT_READ_SLOTS`, default 4,
separate from the write slots so neither queues behind the other) is the
preventive half. It is taken around the leaf query only — not the retry loop, so
a node failing over holds no slots, and not the sub-range walk, so a scan never
queues for its next slot while holding the last — and keyed by the node the
run's own shard reading names, taken before the first scan rather than the first
write, since every scan-heavy phase runs before any write.

**The per-node write-slot cap was per CLUSTER.** The semaphore that keeps
aggregation writes from taking every query thread on a node was keyed by the
connection config's host:port — a seed address on a cluster, shared by all
three shards. One semaphore covered the whole cluster: two rebuilds on two
different masters contended with each other while nothing bounded either
master on its own. It is keyed by the node the caller's shard reading names
now, the same identity the reservation ledger already used.

**A rebuild says which of its six stages it is on, what each one got through,
and how much is left.** A run reported one pair of counters and one
percentage, and both only ever meant "lineage edges scanned during EXTRACT" —
so past the halfway mark the bar moved with its denominator nowhere on the
page. Every stage already computed that denominator and folded it into the
percentage; it is kept now, in the stage's own units (lineage edges, scan
ranges, aggregated edges). Two stretches of a run had no stage at all: the
indexes, the identity stamp and the fingerprint before the pipeline's first
checkpoint, and the fingerprint and state rows after its last — minutes at
each end of a large graph, during which the row said nothing. Both are stages
now. The run keeps an ordered ledger of all six in `run_stats.steps` — state,
duration across every visit, how many times it was entered, what it is
waiting for — so the same record is the live view and the run's history. A
retry backoff, a quiesce park and a failover park say they are waiting and
what for, instead of reading like a hang. A failed or cancelled run keeps its
ledger: it names the stage the run died in. The stepper in Job History is
unchanged in shape — each segment now fills with its own stage's progress,
carries its duration while the run is still going, and explains what the
stage does; `est. finish` projects from the previous run's ledger, the two
new stages included.

**A rebuild never writes through a fork, and holds for the replicas it started with.**
Before every write batch the pipeline reads the node it writes to — RSS, BGSAVE and
AOF-rewrite state, attached and resyncing replicas, the furthest replica's lag, what
replication holds, and the container limit the pod is killed at — and holds, heartbeating,
while the node is outside the envelope a rebuild may write inside: a fork in flight, fewer
replicas than the run started with, a replica further behind than a quarter of the limit
the master drops it at, or RSS past what the container could survive a fork at. Each hold
is bounded (`AGGREGATION_HOLD_MAX_SECS`, 30 minutes); past it the run stops with its
checkpoint intact and a message that names the node and what it was doing. The write
budget counts the container too, and the deployment guide's sizing rule now counts
replication buffers. The run record keeps every hold by reason, and the run settings panel
says so.

**One dead shard no longer opens the circuit breaker for every other shard.**
The breaker is per provider, and on a cluster a provider is every shard, so an
error counted while one shard was being replaced refused every graph on the
healthy ones too. A refused connection to a cluster node was already reported as
a logical failover for that reason; the branch where the reconnect itself failed
still raised the raw error and counted it. It reports a failover now — unless
the reconnect failed on credentials, which is a real provider fault and belongs
to the breaker.

**The graph store stops forking on its own schedule, and a replica frees in
the background.** Three of the four steps in the incident were settings the
pipeline's governor cannot reach. The hourly `save 3600 1` forked every master
every hour whatever else it was doing, for an RDB that is a floor rather than a
recovery path — it is six-hourly now, which the documented reasons for keeping
it (a missing appendonlydir, an engine upgrade) are entirely indifferent to.
`auto-aof-rewrite-min-size` stops a small AOF being rewritten for nothing; the
rewrite percentage stays at its default deliberately, because lowering it shortens
replay only in proportion and buys that by forking more often. And
`replica-lazy-flush` means a replica following a promotion or a full resync frees
what it held in the background rather than on its main thread: doing that
synchronously on 13 GB is minutes of answering nothing, which is how a replica
that was merely catching up failed its health probe and was restarted, turning
one node's trouble into two. A guard test parses the manifests, including all
three duplicated shard blocks.

**An empty rollup answer is an answer, and a refused one says so.** Two more
reasons the aggregated cache could not hold. An answer with no aggregated edges
took the 5-second negative TTL, and on a container canvas most requests are
exactly that — the fan-out asks about chunks of containers, most of which have
no lineage between them — so most rollup reads were recomputed every five
seconds. The aggregated endpoint is the one with a dedicated invalidation choke
point that fires on every event rewriting the layer, so an empty answer there
cannot go stale unnoticed and now keeps the full TTL; the outage mirror still
excludes it, because "no lineage" as a fallback is indistinguishable from real
data. And an answer larger than `GRAPH_CACHE_MAX_PAYLOAD_BYTES` is computed and
never stored, which made every repeat miss with nothing to point at — it is
counted as `too_large` now, beside its own miss and outside the ratio, and shown
in Admin → Graph store.

**A graph that cannot be fingerprinted is no longer treated as one that
changed.** `compute_graph_fingerprint` returns an empty string when the fast
label/relation counters cannot answer for a graph and the fallback scan fails or
runs past its five-second budget. That empty string compared unequal to
everything, so on any graph too large to scan in five seconds every automatic
check asserted a change: the scope-wide read generation was bumped each time, so
no cached read of that source could survive to be hit — an aggregated-lineage
cache hit ratio pinned at 0% is exactly what that looks like — and a rebuild was
queued, which made the next probe slower still. Unknown is now its own answer:
the automatic origins do nothing with it, a caller who watched the write
(external loader, API signal, forced refresh) still converges, and a failed
post-run probe no longer overwrites the stored fingerprint with an empty one,
which used to poison the gate permanently.

**Densely connected graphs aggregate, and full detail is never truncated.**
Half a million lineage edges over a few thousand containers used to be the
pathological case, for three reasons that were not about the graph store. A
leaf's ancestor closure was evicted from the memo the moment it was computed,
so an endpoint shared by ten thousand edges had its ancestry walked ten thousand
times; closures and container rep-sets are now kept, bounded, and the walk is
paid once per node. Forced full detail with no measured cell ratio read every
lineage edge a second time for an estimate it was not allowed to act on; the
count now happens during the real extract scan, so the source still calibrates
and the store is read once. And `maxCubeEdges` — an 8M cell count chosen before
any of the measurement existed — was what actually decided whether a graph got
full detail; it now defaults to its bound and does not bind, while Auto stores
the full cube for as long as the write budget says the shard can hold it and the
apply projection (estimated cells over the rate this source measured last run)
says the job can finish writing it. Only Auto ever degrades, and only to the
depth-diagonal with the rest served on demand: forced full detail stores every
ancestor combination at any depth and any size, and a cube too large for one
wall clock converges across runs from its checkpoint rather than being
truncated. The run says so up front, with the projected hours and the three ways
to make it one run.

**The pacing ratio became a ceiling, not a fixed cost.** A rebuild that idles
half the time on a node with no fork in flight, every replica attached and in
sync, and a quarter of its container free is not protecting anyone — it is
just slow, and a rebuild that never finishes protects nobody. The governor now
reads the node before every batch anyway, so that reading picks where between
`writePacingMinRatio` (0.25) and `writePacingRatio` (1.0) the pause sits.
Starving readers still override both, the batch size — the stall a reader
actually waits for — is unchanged, and a node that is working still gets the
full configured pause.

**Steady load: smaller, settled write batches, tunable and visible.** A write batch holds
the graph's write lock from its first change to its end, so one batch is the longest stall
every reader of that graph sees. The batch ceiling (`writeBatchMax`, 500 rows) and the batch
target (`writeBatchTargetS`, 1.0 s — the sizer halves a batch that ran longer and grows one
that stays well under) are knobs, fleet-wide, per job and live on a running job ("Smaller
batches" halves the ceiling); a batch is settled — the node read, the query returned, the
replicas acknowledged — before the next; the pause after it never drops below
`writeMinGapMs` (100 ms); and short of a hold the run eases, halving the ceiling and doubling
the pause while the node nears a hold line. A running job shows a *Steady load* line — batch
rows, seconds per batch, the pause, the rolling duty cycle and rate, whether it is holding
or eased and why, the replicas' lag and the node's measured headroom — and the run record
keeps the batch figures. `docs/CONCURRENCY_TUNING.md` §6 is the load model behind it.

**One card per graph store, named by the providers that use it.** Grouping is
settled by asking the nodes, not by comparing connection settings: two provider rows can list
disjoint seeds of one cluster, or name one node by its service name and by its address, and
overlapping cluster node ids — or, off a cluster, the same Redis run id — mean one store. They
fold onto one card, which says how many rows point at it, and the fleet totals count the store
once instead of once per row. The graphs stay attributed per provider through the fold, where
the second row's sources previously read as orphans nobody claimed. And there is no default graph store: a data
source's provider is required, so every graph the page accounts for belongs to a provider's
store, and the connection named by `FALKORDB_HOST` is no longer swept, counted into the fleet
totals, or presented as a store an operator has no way to act on.

**The replication picture, drawn.** Opening a graph store now lands on a Replication view:
every master it owns on a tile coloured by its health — slot range, memory against its ceiling,
room left for rollups — with its replicas on a line beneath it, each naming the master it
follows, its link status and how far behind it is. A master with no replica standing behind it
says so, because that is the shard that cannot be promoted out of trouble; a master that is not
answering says its replicas are carrying the reads. The shard and node views are one click away,
and every surface that lists a replica — the shard cards, the flat node table — now names the
master it follows rather than leaving the pairing to the order of the rows.

**Admin → Graph store: every node of every graph store, and what lives on it.** On a
nine-node cluster the app showed three. The Infrastructure probe counted masters from the
environment's own topology and the capacity card read only the nodes that owned an aggregated
graph, so every replica was absent — and a node missing from a list is indistinguishable from a
node that does not exist. The new page reads one snapshot of the whole fleet: masters and
replicas with their memory, health, uptime and limits; slot coverage with the missing ranges
named; how memory and graphs are distributed across shards; replication as it actually is
(replicas online, worst lag, full resyncs) with each finding written as a sentence carrying its
fix; and every graph on each shard with the data source that owns it, searchable. Deep links
focus a shard, open a node's limits, or switch to a flat all-nodes view; a "How to read this
page" glossary defines every term on it. A guide (*The Graph Store: Shards, Replicas &
Placement*) is one click away.

**Where a data source lives, on the data source.** Its profile now says which node holds its
graph, which shard and slot, that node's health and memory, its replicas and their lag, and how
many other graphs share the shard — and, in dedicated projection mode, that the rollups have
their own graph key which can land on a different shard. Provider cards say what the connection
actually reaches (mode, master shards, replicas, nodes up, slot coverage) and list every node
when expanded. Job history rows carry a shard chip, from one batched call per page.

**A rebuild never writes faster than its replicas can absorb.** After every rollup batch the
pipeline asks the master how many replicas have acknowledged it. Acknowledged, and the wait
joins the write's latency so a replica-bound shard paces itself like a slow master; not
acknowledged, and the run holds — heartbeating, re-reading replication state, retrying — until
they catch up, releasable live by setting replica acknowledgement to 0. This exists because
FalkorDB replicates a write below its effects threshold by RE-RUNNING the query on every
replica, on the replica's main thread and with no timeout: a large rebuild could drive replicas
past their health probes, get them restarted, and take the shard with them. The run also warns
at the start when a master has replicas and an effects threshold above 0, which is the setting
that decides this.

**Read-only queries are served by a shard's in-sync replicas.** The master took every write
AND answered every read, so on a cluster with two replicas per shard two thirds of the hardware
sat idle while one master's query threads were the bottleneck for everyone opening a canvas.
Reads are now offered to a replica under four gates, any of which sends the query to the master
instead: the provider allows it (*Read queries* in its connection settings, default on), the
replica is online and owes the replication stream no more than 8 MiB, this process has not
written to that graph recently, and the replica has not just failed a read. Lag is measured in
bytes and never in the `lag` seconds `INFO` reports — a replica acknowledges the stream about
once a second whatever it has actually applied, so those seconds sit near zero for one that is
a gigabyte behind. A rebuild reads only from the master for its whole run, because it reads
back what it has just written. A replica that refuses a read for a reason of its own — a
connection fault, a `MOVED`, a dataset still loading — sends the same read to the master once;
a query the store refused for its size is raised as it stands, since running it again on the
master would fail the same way and double the load the routing exists to shed. Each provider's
topology line says what share of its reads replicas actually answered.

**Reads outlive a master.** The lag gate asks the master how far behind its replicas are, so a
master that could not answer produced an empty reading, no replica qualified, and every read was
sent to the node that had just failed — while its replicas held the only copies of the graph.
Three gates pointed the same way, and all three now yield: the lag reading falls back to the
replicas the master vouched for when it last spoke; the failing-over memo, a verdict about the
master, no longer fast-fails a read already addressed to a replica; and the settle window that
pins a freshly written graph to its master gives way when that master is the node that went
away. What comes back may be a little behind, and what would otherwise come back is nothing.
Rebuilds are untouched — they pin themselves to the master for the whole run.

**A node restarting is a pause, not an outage.** A refused connection inside a rebuild is now a
wait: the run heartbeats, re-resolves the owner (finding the promoted replica), and retries the
same work at the same width from the same checkpoint, for up to fifteen minutes per outage —
each one measured from when it began, so a rebuild running for hours rides out one rolling
restart after another. If it does give
up, the failure names the node, how long it waited, and what to check — where the circuit
breaker's "Circuit open; will probe downstream again in ~28s" used to overwrite it. For readers,
a node being replaced is its own signal that never opens the breaker: reads fail fast with a
three-second retry hint, the canvas keeps its last answer behind a *Reconnecting to the graph
store* line and retries itself, and the node's restart is recorded as evidence on the run.

**Rebuilds that always complete under the graph store's per-query limits.** A rebuild that
meets the store's per-query memory ceiling (`QUERY_MEM_CAPACITY`) or a per-query timeout no
longer fails — it goes slower until every query fits: the first refusal of a run drops read
concurrency to 1; the reconcile scan (the pipeline's widest projection) switches to a keys-only
two-pass strategy; scans halve down to a scan floor that now defaults to **one row**, re-growing
after sustained successes and never straight back into a width that failed; write and delete
batches halve the same way; a narrowest scan that keeps timing out is retried with backoff and
heartbeats before the run reports the store as unreachable and keeps its checkpoint. The only
terminal outcome is a single row larger than the ceiling, and its message names the scan, the
row and the ceiling. What a rebuild learned is remembered per source and seeds the next rebuild
of that source (never wider than its settings; *Ignore last run* opts out).

**Every run shows what it ran with, and what it adapted to.** Job History's stat grid gains a
*Settings* cell — the profile the run matches, or *Custom* — with a *Run settings* disclosure:
every knob with where its value came from (*Job override*, *Fleet default*, *Learned from last
run*, *Environment*), including the stall window and wall clock, and plain sentences for what
the pressure ladder changed; written at the first checkpoint, so a failed or cancelled run has
it too, and read from the live stream while a job runs. A running row shows an amber *Going
slower to fit the graph store* state; the Freshness badge reads *narrowing*.

**Every time limit is a knob.** *Time limits* in the Defaults dialog and Advanced tuning: scan
timeout and write timeout per query (the graph store's own `TIMEOUT_MAX` caps them, and the
editors say so), the stall window as a fleet default that machine-queued rebuilds now honour,
and the wall clock (never below the stall window). Bounds lifted to seven days. Plus a **Gentle**
profile in the re-trigger dialog — narrow scans, serial reads, generous pacing, a longer scan
timeout — pre-selected, with the reason, after a per-query memory or timeout failure; the canvas
banner offers the same retry. The capacity card shows each node's per-query limit.

**More time for a job that is still going — one, or all of them.** A pending or running job's
stall window, wall clock and per-query timeouts can be raised without cancelling it:
`PATCH /admin/data-sources/{id}/aggregation-jobs/{job}/limits` (the same gate as cancel and
resume; the actor is always the authenticated user), an *Adjust this run* control in the
running row — what the job is running under, what is left of it, one-click +1/+3/+6/+12 h,
a wall-clock doubling, the per-query budgets, and who raised what — an *Extend all by +3 h*
strip when several jobs are running, and *Give it more time* on the canvas banner. The worker
re-reads the row every thirty seconds through a fresh session; per-query budgets apply to the
next query. The history lives on the job row, shown in Job History.

**Go gentler on a job that is still going.** The same `PATCH …/limits` now takes the scan shape:
a pacing ratio (from the next write; 0 = no pacing), a cap on read concurrency (from the next
wave) and a cap on the scan width (from the next scan — a ceiling the pressure ladder may still
narrow below on its own), plus `reset` to clear live values back to the job's settings. The
worker's watchdog re-reads them with the time limits every thirty seconds — a failed read changes
nothing, and an absent key clears — and the pipeline reads them per write, wave and scan. *Adjust
this run* in Job History gains a **Go gentler** group — the shape in force, *Pace ×2*, *Pace ×4*,
*Serial reads*, *Halve scans*, *Back to settings* — and the run's record and the live row show
*Changed while running*.

**The canvas narrows its reads instead of dropping them.** The aggregated-edge read — the
canvas's rollup reads, on-demand pair synthesis and the raw mirror — gets the same treatment as
a rebuild's scans under the store's per-query limits: a refused page is halved and re-read from
the same keyset position down to a floor (`AGGREGATED_EDGE_PAGE_FLOOR`, 500 rows), a refused URN
batch is split in halves down to a single URN, a floor-width timeout is retried once, briefly. A
read that completes after narrowing is a complete answer. What is still refused at the narrowest
page or batch is lost and SAID: `staleReason` `query_memory` or `timeout`, with a `degradedDetail`
(kind, how far it narrowed, the node and its ceiling) on the result, the canvas bootstrap and
expand freshness; the canvas shows *The graph store refused part of this read at its per-query
memory limit — showing what it could read after narrowing* with the way to the node's limits for
a system administrator, in place of the generic truncation advice, and never asks the projector
about it. One pressure classifier now serves both ladders.

**The rebuild worker flushes on real memory pressure.** The pipeline samples the worker's RSS
against its cgroup memory limit (at most once a second, from the merge loops) and flushes its
accumulator early — the same exact-weight flush the pair cap triggers — when RSS crosses
`AGGREGATION_FLUSH_MEM_PCT` (60%) of the limit with at least `AGGREGATION_FLUSH_MIN_PAIRS`
pending; the extract phase's base map rolls up early under the same pressure. Fail-open when
either reading is unknown (the pair cap still bounds memory). *Memory flush* is a fleet knob in
the Defaults dialog; a run that flushed on memory says so in its record and on the live row
(*Flushed 3× on worker memory (peak 2.9 GB of 4.0 GB)*). The readers moved to
`providers/process_memory.py` (`MemoryGauge`); the fleet's claim deferral shares them.

**Two rebuilds cannot both pass on the same headroom.** A rebuild that passes a budget check
now enters what it still has to write in its node's reservation ledger (on the job-bus Redis,
beside the write lease), and every other rebuild's budget takes that off the node's free
memory as if it were already in use — the whole growth before the apply, one wave for an
overflow flush, the remainder at each mid-apply recheck, released with the lease. The
capacity card, a source's Capacity block, Infrastructure's memory headroom and the Defaults
dialog's what-if all show *held by N running rebuilds* and subtract it; a refusal names it. The
ledger fails open like the rest of admission: without the bus, the node is measured alone.

**Auto's cube ceiling and the estimate margin are fleet knobs.** Both sit in the Defaults
dialog's Capacity group, resolved like every other knob (stored Defaults over the environment,
clamped to the pipeline's bounds, labelled by source in the capacity API) and recorded in every
run's settings. The run warns when the cube ceiling sits above an explicit edge ceiling. Only
the apply's re-measure interval remains the deployment's.

**The graph store's own limits, from the UI.** `TIMEOUT_MAX` and `QUERY_MEM_CAPACITY` no longer
live only in the deployment. Infrastructure → Memory headroom shows each node's per-query memory
ceiling, query time cap and thread count (read with the capacity sweep), and system administrators
get *Adjust graph store limits*: the node is read fresh; the change is checked — a cap never below
the node's `TIMEOUT_DEFAULT`, raising the ceiling needs the container memory limit and is refused
with the shortfall when the deployment guide's sizing formula says the container cannot back it,
`0` refused, lowering needs nothing; set with `GRAPH.CONFIG SET` on the node or every primary; read
back, verified, and logged with the actor (`PATCH /admin/graph-store/{endpoint}/limits`). The
dialog hands over the `FALKORDB_ARGS` fragment that makes a runtime change permanent. The
application now clamps per-query timeouts to the cap it reads from each node — the write budget
and the capacity sweep teach every provider — with `FALKORDB_SERVER_TIMEOUT_MAX_MS` as the
fallback until a node has been read (the socket timeout is floored above the knobs' maximum), so
a raised cap reaches the next query without a restart; the editors' timeout notes show the cap
read from the store; a failed source's guidance and the Gentle pre-selection link straight to the
node's limits. `FALKORDB_CONTAINER_MEMORY_BYTES` (optional) prefills the container field;
`AGGREGATION_SLOT_STALE_SECS` defaults to 660 so a write allowed a raised cap keeps its slot.

**Rollup capacity you can see, and every limit you can set.** Ingestion → Freshness gains a
*Graph store capacity* card: one row per shard with a meter of memory in use, the fleet reserve
marked on it, what is free after that reserve, how many more rollup edges that is, and the
sources whose rollups live there — each a way into its drawer. A shard the budget cannot govern
says why and which rule applies instead; a *would not fit* count filters the table to the
sources whose last rebuild was refused. A source's drawer gains a *Capacity* block (footprint,
shard headroom, last decision, and a pre-flight for Full detail versus Auto) and a per-source
**Rollup storage** control in ③ Act — the control the "would not fit" guidance always named —
settable before a large source's first build and honoured by automation and manual rebuilds
alike. The re-trigger dialog answers whether *this* run would fit before it is queued,
re-deciding as the form changes. Behind all of it: `GET /admin/aggregation/capacity` and
`GET /admin/data-sources/{id}/capacity`, the write budget's own reading and arithmetic
assembled for people, one `INFO` per shard, under a deadline, never raising.

**A Defaults dialog on the house shell.** Every tuning knob in one place, grouped (Capacity,
Reading, Writing, Rollup storage), each value labelled *Set here* or *Environment default*
from the server's live env defaults (`envTuningDefaults` on the settings GET, so the editors'
placeholders can no longer drift from the deployment), a Reset that sends the explicit null the
merging server needs, a dirty guard, and a live what-if: as the reserve or bytes per edge is
edited, the dialog restates how many more rollup edges each measured shard would take, before
Save. Reachable from the workspace dashboard and from the capacity card.

**The apply re-measures the shard.** Every `AGGREGATION_BUDGET_RECHECK_EDGES` (1,000,000)
first-touch edges written, a rebuild re-reads the shard that owns its graph and refuses, with
the numbers, when the remainder would not fit — after the chunk's checkpoint, so it can be
resumed from its cursor once memory is freed, and never as the write that fills a shard shared
with another graph. `run_stats.budget_rechecks` says it happened.

**An operator guide, in the app.** *Rollup Capacity & Large Graphs* under For Administrators,
linked from every new control; the automatic-reconciliation and external-change-notification
feature docs are registered in the docs viewer for the first time, so the ordered "graph too
big" runbook is finally reachable from the product.

**A top-level Analytics section at `/analytics`.** Six tabs — Overview, Growth,
Engagement, Content, Health, Workspaces — under one range control (7d/14d/30d/90d/6m/1y
or any custom range) that every chart, figure and table on the page re-renders against,
so the numbers always agree with each other. Every number carries a definition saying
what it counts, how it is computed, and what to do if it moves.

**The product's own value moments are now instrumented.** Seven new product events —
`lineage.trace`, `lineage.trace_empty`, `graph.search`, `graph.search_miss`,
`graph.export`, `version.published`, `ontology.published`. The `_empty`/`_miss` variants
are separate event *types*, not payload flags, so "how often did someone ask the core
question and get nothing back?" stays a `GROUP BY` on an existing index rather than a
payload scan. Activation is now scored on tracing lineage rather than on creating a
view: authoring is a later, heavier commitment, and scoring activation on it measured
investment rather than value.

**Usage figures on the content itself.** The view page now shows opens, distinct viewers
and a trend beside the view's name. `GET /insights/views` is deliberately not under
`/admin` and not analytics-gated — it returns counts and dates with no identities, scoped
by the same `readable_views_clause` the catalogue lists with, in three queries whatever
the batch size. Ids the caller cannot read come back absent rather than refused, which is
also what a non-existent id gets.

**Server-computed narrative insights** above the Overview charts, ranked by significance.
Every rule is a pure function of the finished summary document — so an insight can never
contradict the chart beneath it — and every rule is guarded, so a young install gets
silence rather than five findings manufactured from three users.

**A first-run panel** on new deployments, in place of six empty charts and four zero
tiles, linking the steps that fix it and gating each on whether this reader can take it.

**A custom range calendar** — two months side by side, Monday-first, UTC, with named
periods (this/last month, this/last quarter) and full keyboard navigation, replacing two
`<input type="date">` boxes that could not show the shape of a range.

**A visual harness** — `npm run harness:analytics` — rendering the real components against
one fixture per privacy posture. The postures cannot be checked by hand: seeing the strict
view needs a second account with no workspace bindings and two flags set a particular way.

**`system:analytics:read`**, seeded on `super_admin`, `org_admin` and `org_auditor`.
Analytics had been piggybacking on `system:audit:read` — "read the platform audit log" —
so growth dashboards came bundled with every login and RBAC mutation.

**Four feature flags in a new Analytics category:** `analyticsPrivacyMode` (strict /
internal / full, default `internal`), `analyticsPublicEnabled` (off), `analyticsWorkspaceVisibility`
(off), `analyticsShowEmailAddresses` (off). See **Upgrading**.

**Retention for `product_events`.** A daily sweep on the scheduler-owner role keeps 400
days (`PRODUCT_EVENT_RETENTION_DAYS`, clamped to ≥ 365 so a year-long chart cannot be made
to lie). The table had no horizon because its contents used to be rare; it now takes a row
per view open, lineage trace and graph search.

**The cache tells you what it is absorbing, per view and per source.** Admin → Graph store
now shows the hit ratio for each cached endpoint over the last two hours, named by what the
user did rather than by its route, with a control to rebuild a source's cached views — one
view or all of them. The ratio is `hit / (hit + miss + stale)`: a stale serve kept someone
moving but the provider could not answer, so folding it in would make an outage read as a
cache win, and a bypass (endpoint disabled, or Redis unreachable) is not a cache outcome at
all and must not dilute the denominator. Counters are five-minute buckets written
fire-and-forget on the coordination role — telemetry may never delay or fail a request.

### Changed

**Graph indexes are declared in one place, with the query that justifies each one.**
`index_policy.py` already owned which node labels and properties get indexed; it now owns the
`:AGGREGATED` edge indexes too, and every entry carries the query shape that ENTERS through it.
The provider and the materializer read that one list — they used to keep two copies, three of
whose entries duplicated each other. An index that cannot name a query it serves does not
belong in the list, and tests enforce both halves of that: no declared index may be
single-column on a property only ever queried as a pair, and every declared index must name
its entry query. "The DDL was accepted" was mistaken for "the planner uses it" once already,
and that is exactly how the retired four came to exist.


**The capacity view is built on one reading of the whole graph store**, so it stopped
churning. It used to resolve a provider per source and ask it who owned each graph, which meant
a node appeared only if some source's provider could be built and dialled inside a deadline,
every failure was cached wholesale, and rows re-sorted by live utilisation. Placement is now
arithmetic over the topology snapshot: every master is a row whether or not anything sits on it,
a node that could not be read is a row with the reason, "cannot govern" is told apart from
"unreachable", the order never moves, and a failed refresh keeps the figures on screen with a
note instead of blanking the card. `AGGREGATION_CAPACITY_DEADLINE_S` is gone with the sweep, and
both capacity routes are served in-process in every mode.

**A graph store node's limits are adjusted from Admin → Graph store**, which is where the node
is looked at. Any node can be targeted — including one holding no rollups yet, and every node of
an instance at once, so a promoted replica already carries the change. The Infrastructure page
still answers its old `?limits=` deep link. The dialog gains the **effects threshold**, the
setting that decides whether replicas apply a change log or re-run every write.

**The container sizing rule now counts replication, and the production manifests are sized by
it.** The rule had three terms — dataset, query memory, overhead — and the replication buffers
were charged to the same container without appearing in it. Raising those buffers (below) is a
memory decision, and the pairing that looked right without them (32 GiB with a 1.5 GiB per-query
ceiling, 52.7 GiB) needs **57.7 GiB** with them, over the 56 GiB limit. The shipped values are
now 32 GiB and a 1 GiB ceiling: **53.8 GiB**, with the whole table in the manifest comment and
the guide. For scale, the pairing before any of this (40 GiB and 2 GiB) needed 66.6 GiB, so a
shard under load could be OOM-killed while every figure inside Redis looked healthy. Note the
in-app *Adjust limits* guard computes dataset + query memory + overhead only: on a master with
replicas, subtract the replication terms from the container figure you give it. Also: `EFFECTS_THRESHOLD 0` and `OMP_THREAD_COUNT 1` on every
FalkorDB deployment, a 1 GB replication backlog and 2 GB replica output buffers (256 MB overflows
in seconds under a rebuild and forces a full resync), `repl-timeout 300`,
`cluster-node-timeout 15000`, and a liveness probe that allows 10s × 6 rather than 3s × 3 — a
node busy applying replication is not a dead process. **Check what each shard currently holds
before applying the `maxmemory` change.**

**Memory headroom on the Infrastructure page shows every measurable node, always**, with
the rollup reserve marked and what still fits at the fleet bytes-per-edge. It used to appear
only once a node was 85% full — after the one number that decides whether a rebuild fits had
already stopped mattering.

**The per-job Advanced tuning form and the fleet Defaults share one knob catalogue.** A knob is
described once; an empty per-job field says which value it inherits and from where. The
onboarding wizard's tuning step now shows the Rollup storage the fleet actually resolves instead
of assuming Full detail.

**The aggregation write budget measures the graph store instead of counting to a
number.** "Writing this would risk exhausting the FalkorDB instance's memory" was a static
edge cap (25M, hard-bounded at 50M) that never read the instance, so adding memory to every
shard changed nothing — and every UI preset pinned that cap onto the job. A rebuild now reads
`INFO memory` on the one shard that owns the graph before it writes, allows the write while
the *new* edges fit under a reserve (`AGGREGATION_SHARD_RESERVE_PCT`, 20%), and refuses with
the whole record — the shard, the edges and bytes needed, what was free of what `maxmemory`,
the shortfall, what governed, and the ways out — as a new *Would not fit* failure category
with its own guidance. Forced Full detail is checked on the up-front estimate, so a cube that
cannot fit is refused with nothing computed and nothing written; the exact count is re-checked
after compute and before every overflow wave. Bytes-per-edge is calibrated per graph from each
fresh rebuild's own before/after usage (recorded on the source's state row) and a planning
figure (512 B) until then. Operators set the limits in Defaults or per job: *Shard memory
reserve*, *Bytes per rollup edge*, and an optional *Edge ceiling* (`maxMaterializedEdges`, bound
lifted to 500M) layered over the measurement. Where the shard cannot be measured — no
`maxmemory`, or the read failed — the static cap governs as before, and the message says so.
`run_stats.write_budget` records the decision on every successful run.

**Analytics now follows the app's permission model instead of re-deciding it.** It was
*stricter* than the product it reports on in four places — ignoring `system:org-viewer`,
hiding `enterprise`-visibility view names, denying a creator reach to their own work, and
withholding email addresses that `GET /views/{id}` has always returned. Being over-cautious
is not the harmless direction to be wrong in: a dashboard that hides what the rest of the
app shows teaches people its numbers are unreliable.

**Analytics documents are cached once per window and redacted per reader.** The cache key
was a fingerprint of the caller's visible workspaces, so readers with different access never
shared an entry — a few hundred concurrent users meant a few hundred full recomputations per
TTL, and the cache worked hardest exactly when it needed to help most. The audience was in the
key because the *redacted* document was in the value; the unredacted one is now cached and
`_serve` is the only way anything leaves it, deep-copying before applying a redactor.

**The standard windows are precomputed off the read path.** A warmer on the scheduler-owner
role recomputes the six presets every 300 s (`ANALYTICS_WARM_INTERVAL_SECONDS`) with a TTL
three passes long. Purely an optimisation — a cold key, a custom range, a drill-in, or a
deployment with no scheduler role still works through read-through. Documents are minutes old
by design, so the header says so relatively with the exact instant on hover.

**Event counts are grouped in SQL instead of decoded in Python.** `product_events.subject_id`
denormalises what an event is *about* out of its JSON payload, indexed
`(event_type, subject_id, created_at)`. Measured on 200k opens across 2,000 views over 90
days: the full-window fold 1345 ms → 401 ms, and one view's usage 1345 ms → 2.4 ms. The
second number is what makes usage-on-the-content affordable at all.

**Comparison charts place both periods on one continuous time axis**, every bar on the date
it happened, with a dashed divider, a wash over the earlier half and in-plot captions naming
each. The previous period is a paired column that differs by texture (hatched), fill (outlined)
and tint — not opacity alone, which reads as "disabled" rather than "earlier" — and the
tooltip names the delta with an arrow, never a colour, since the chart does not know whether up
is good. The cost is stated rather than hidden: a 30-day window draws a 60-day axis.
`TimeSeriesChart` deliberately keeps index alignment; a ghost *line* is unambiguous as an
overlay, and it is a *bar* sitting on a date that invites the reader to trust the axis about it.

**Withheld content is locked and explained rather than removed.** A synthetic silhouette in
the real geometry, the heading and description kept for everyone, and a locked workspace row
that offers to request access — asking first, saying what is being requested and who will see
it, and taking a note. Frosted glass over the real thing was rejected as a security bug: CSS
blur is a paint effect and every value stays one view-source away.

**`reference` renders as "Context View" everywhere.** The mapping had been hand-written in
four places and Analytics was the fifth surface, rendering the raw enum; `lib/domainLabels.ts`
is now the single source. **"Active users"** is one name for one measure across Overview, the
drill-in, the KPI tile and the Engagement chart.

**The Workspaces tab opens with what the estate is made of** — existing vs visible, quiet,
unconnected, and two ordered distributions — rather than with a sortable table, which only
answers a question nobody arrives with. Locked rows collapse behind a summary; they still
exist, because the table has to keep agreeing with the totals above it.

**The default Overview window is 14 days** rather than 30 — long enough that a quiet Tuesday
does not swing the trend, short enough that "what changed" is still about now.

**A view is cached for an hour, because freshness here is an event and not a clock.**
`children`, `aggregated`, `top-level`, `layer-assignment` and both canvas endpoints move from
900 s to 3600 s. Every write bumps the scope's generation, which changes the cache key, which
invalidates instantly — so the TTL was never the freshness mechanism, only the backstop
against drift the platform cannot see. Fifteen minutes made an unchanged graph re-pay the
full provider cost four times an hour for identical bytes. The trace endpoints stay at 300 s:
they are cursor-shaped and cheap to recompute.

**One process in the fleet computes a cold key.** The in-process singleflight coalesced
callers inside one worker; the fleet runs twelve, so a cold view still meant twelve identical
computes arriving at one shard at the same moment — the moment it is least able to absorb
them. The pod-leaders now elect one of themselves through the bus with a single `SET NX` on
the cache role; the winner computes and the losers take its answer. Every part fails OPEN — no
bus, a dead leader, an expired wait all end in "compute it yourself", which is exactly the
prior behaviour. Deliberately on the cache role and not the coordination role: losing this key
costs one duplicate compute, which is the definition of cache-role state.
(`GRAPH_CACHE_CROSS_PROCESS_SINGLEFLIGHT`, `GRAPH_CACHE_LEADER_TTL_S`,
`GRAPH_CACHE_LEADER_WAIT_S`.)

**An expiry with no write since it is served from the mirror, not recomputed.** The
last-known-good snapshot is now stamped with the generation it was taken at, and a miss asks
for it at the *current* generation. A match means nothing has been written since, so a
recompute would return identical bytes — it is promoted back under the primary key and served
with no provider work at all. No match means a rebuild has landed, and it declines: serving it
there would show users the pre-rebuild graph at exactly the moment they asked for the new one.
Promoting never rewrites the mirror, so no answer can outlive `GRAPH_CACHE_LKG_TTL_S` from
when it was actually computed, however many times it is promoted — that is the bound on drift
nobody signalled. Mirrors written before the stamp existed have no generation to compare and
are never promoted; they remain the outage fallback, where an out-of-date snapshot still beats
an error. (`GRAPH_CACHE_PROMOTE_UNCHANGED`.)

**The replica read-settle window is 10 seconds, down from 30.** It is a backstop behind
`_replicas_in_step`, which measures the bytes a replica still owes the stream — a real
freshness check. What the window has to cover is that check's own staleness, and the verdict
is cached for five seconds, so the floor is one sample period and ten is two. Thirty was six,
chosen before the in-step check existed to back it up, and this is the gate that decides
whether the replicas do any work at all: every process that wrote to a graph sent ALL its
reads of that graph to the master for the window's duration, so on an edit-heavy workload it
quietly erased most of the read capacity the replicas exist to provide.

### Fixed

- **The bigger the graph, the more completely it switched its own cache off.** A result was
  read as degraded — and so given the 5-second negative TTL instead of the full one — whenever
  it carried a `truncated` flag. But a cut the REQUEST determines (`max_nodes`, `degree_cap`,
  `orphan`) is a pure function of graph and request: every anchor it ships is whole and the
  cursor names exactly where the next page starts. That is THE answer to that request. So page
  one of every wide focus and every capped aggregate was re-read on a five-second cycle, on
  precisely the graphs where a read costs the most. Only a probe that gave up part way
  (`degraded_detail`, an unprobed frontier) is degraded now.

- **The urn→label cache was filled by a path that no longer ran.** It was populated only at
  warmup; the read side, where the misses actually happen, never wrote to it. Every read
  re-derived the label. Misses now schedule a warmup, and the cooldown is stamped BEFORE the
  task is created so a burst of misses coalesces into one warm rather than one per miss.
  (`FALKORDB_LABEL_WARMUP_COOLDOWN_S`.)

- **A shed leader stranded every request waiting on it.** Followers attach to an in-flight
  compute with `await asyncio.shield(existing)`, and shield means their own cancellation does
  not end that await — so a future nobody resolves leaves every one of them hanging until its
  request tier fires, 45 to 60 seconds later. Shedding is precisely when a key HAS followers,
  because a cold-cache stampede is what the gate sheds. The future is now resolved on every
  exception path before the raise.

- **...and then the fix for that became a stampede.** Resolving the future let followers fall
  through and compute their own copy — measured at nine computes for nine callers on one key.
  `ProviderBusy` and `ProviderLoading` are flow control, not a failure to retry: recomputing
  is exactly the load the shed refused. Followers now re-raise them and retry on their own
  `Retry-After`, as the client already knows how to do, while a leader that failed for a
  reason a retry might survive still lets them through.

- **The drift check scanned every graph three times a minute, and the scans outlived the
  caller.** The aggregation scheduler fingerprints every scheduled source on a 60-second sweep,
  and that fingerprint was three unbounded passes over the whole graph — labels with
  `displayName` samples, relationship types, and every node's tags. Each carried a 30-second
  server-side budget while the sweep waited 5 seconds, so past five seconds the sweep walked
  away and the node kept scanning for a result nobody would read. FalkorDB serves queries from
  a small fixed thread count; enough abandoned scans and it stops answering anything at all,
  which is what took whole environments down during aggregation. The digest reads only
  per-label node counts and per-type edge counts — it has never looked at a sample name or a
  tag — so it now reads them from FalkorDB's label/relation counters instead, measured at
  ~1.3 ms against ~514 ms of scanning on a 500k-node graph, falling back to the scan when the
  counters cannot be trusted. **The fingerprint value is unchanged**: both paths share one
  digest body, because a source fingerprinted by a scan yesterday is compared against one
  fingerprinted by the counters today. Where the scan still runs it is cached, and the
  caller's own wall clock is now a deadline shared by all three queries rather than an
  allowance granted to each.
- **A cold process can find a cluster whose masters have all moved.** Seeds are now tried
  last-seen-first: the nodes this process saw, then the nodes ANY process last saw (kept on the
  bus Redis — deliberately not the FalkorDB being described, which would be unreadable in
  exactly the outage it exists for), then the configured `startupNodes`. Role orders that list
  and never filters it, because any node answers `CLUSTER NODES` and a promoted replica is as
  good a seed as the master it replaced. A node that fails to answer is not forgotten — with
  static allocation the address survives its outage, so it sorts below the ones that spoke and
  returns to the front when it answers again. The memory is bounded and self-disarming: it is
  an optimisation, so an unreachable bus arms a cooldown rather than adding a connect timeout
  to every instance of every sweep.
- **The page now says whether the configured startup nodes still describe the cluster.** A
  provider's startup nodes are the masters as they were the day someone wrote the connection
  down, and masters move: a failover promotes a replica, and with it the address a cold client
  must dial. Nothing breaks while they drift — reads follow the cluster, and a sweep that has
  already seen it seeds from the nodes it found — so the drift was invisible. It matters in
  exactly one moment: a process starting COLD, which is every process after a deploy or an
  eviction. Some seeds drifted is a warning naming them and the masters to use instead; none
  of them still a master is critical, because that reading is surviving purely on memory and
  the next cold start would call a healthy cluster unreachable.
- **`/health/deps` reports the graph store's shape.** On-call had provider breaker states and
  nothing about which nodes of which cluster were answering. It now carries, per instance,
  nodes up over total, shard count, cluster state, slot coverage and the findings **by name** —
  "3 findings" sends someone to the page, and during an incident the page is one more thing to
  load. Strictly a read of the reading already in hand: zero I/O, and it never triggers a
  sweep, because dialling a store that IS the incident is the last thing wanted.
- **The pre-compute estimate refused graphs for aggregating well.** It sums, over every raw
  lineage edge, the product of its endpoints' ancestor-chain lengths — cells PRODUCED. The graph
  stores cells DISTINCT: the write is a `MERGE` on `aggKey`, so many raw edges between the same
  pair of containers collapse onto one cell and bump its weight. The two differ by roughly the
  mean weight, and aggregation exists to make that number large — so a graph compressing 50:1
  was estimated at fifty times its real size and refused before it started. A 700k-node graph
  estimated at 30M cells and failed in seconds; the truth was nearer 600k. An upper bound
  supports exactly one inference — *if it fits, the real thing fits* — and "it does not fit"
  says nothing at all. So a source with no measured ratio now proceeds, and the exact
  post-compute check (unchanged, and still refusing before a single write reaches the shard)
  decides. Each complete run records how many cells it actually stored per cell the bound
  counted; the next run corrects by it. The bound, the correction and the truth all ride on the
  run now — nothing compared the first to the last before, which is how an overshoot of fifty
  times stayed invisible. The same arithmetic also pushed Auto off full-cube mode onto the
  degraded depth-diagonal, so graphs were losing detail to it as well as failing.
- **Four `:AGGREGATED` edge indexes existed that no query could ever enter through.** A
  FalkorDB edge index is reachable only when the relationship is the plan's ENTRY POINT — an
  unanchored `MATCH ()-[r:T]->() WHERE r.p = $v`. Every `:AGGREGATED` read this product issues
  anchors a node first, and no query anywhere filters on `sourceLevel`, `targetLevel`,
  `sourceDepth` or `targetDepth` ALONE — every predicate on them is a pair. The four
  single-column indexes were added as a fallback "if the planner does not support composite
  edge indexes", but no fallback was ever implemented: the composite and both singles were
  created unconditionally, on every run, forever. They cost a document per aggregated edge
  three times over — resident memory, an update on every edge write, and a rebuild from
  scratch every time the graph is read back off disk, which is a large part of why restarting
  a node holding a multi-gigabyte graph takes as long as it does. The application no longer
  creates them, and `backend/scripts/cleanup_graph_indices.py` removes the ones already on a
  graph (dry run by default, cluster-aware, and it only ever touches the exact retired pairs).
- **A node loading its snapshot reported its whole shard's graphs as missing.** Kubernetes
  marks a FalkorDB pod NotReady while it replays its RDB into memory, which on a large shard
  is minutes. The node stays dialable and keeps gossiping — it answers PING, INFO and
  CLUSTER NODES — and refuses every `GRAPH.*` command with LOADING. The page read that empty
  graph list as the node's answer rather than as no answer, so every graph the catalogue
  expected on that shard flipped to "not on the node": a routine restart rendered as data
  loss, on the one page an operator opens to check. An unread inventory is now distinguished
  from an empty one, the shard says its list is the catalogue's word rather than the node's,
  and the node carries a "loading snapshot" state of its own. The same mistake through a wider
  door — a master that never answered at all — is fixed with it. A node that DOES answer "I
  hold none" is still believed, so a genuinely missing graph is still reported.
- **The index DDL was a per-run tax rather than a one-off.** `ensure_indices` issues
  `(5 + ontology types) × 5` node indices plus six `:AGGREGATED` edge indices — 131 statements
  for a twenty-type ontology, serially, on the write path — and it ran on every aggregation
  job, every skip, every ontology-cache miss and every provider connect. It ran *before* the
  write lease is taken and before the admission controller is attached, so none of the
  pipeline's pacing applied to any of it. Nothing in the product ever drops a graph index, so
  re-issuing the set could only ever be a no-op costing a parse, a plan and a write-path lock
  per statement, on a graph other people are reading. The set is now recorded per graph
  against a digest of its own statements: a changed ontology re-applies it, a partial failure
  is retried rather than remembered, and a marker store that is down means "do the work".
- **Index DDL for per-label URN indexes went around the guarded query path.** It used the raw
  client, so it carried no write semaphore, no quiesce gate and no server-side deadline —
  firing at a node the rest of the pipeline had already been told to back off from, and
  leaving abandoned statements running with nothing waiting on them.
- **A slow scan escaped the pressure ladder and restarted the run.** Every query goes out with
  a server `TIMEOUT` 500 ms under the client budget, so a slow scan is aborted by the store and
  arrives as its own *Query timed out* error — which the ladder, listening for the client
  deadline only, never saw. Both signals now enter the ladder.
- A rebuild that gave up after its own timeout retries was reported as *Job killed by
  watchdog*; it now says which scan timed out, at what width and budget, and that the job
  resumes from its checkpoint.
- Job History's error hint for a per-query memory failure told operators to lower the scan
  range width, which the rebuild already does by itself.
**Views opened onto "Graph service is unavailable" while FalkorDB was serving fine.**
A slow query was being read as a dead provider, at every layer. On the backend, a query
that ran past its per-operation deadline counted toward the provider's circuit breaker —
three of them opened it for 30s, every read then 503'd, `/health/providers` reported the
provider unhealthy and responses carried `X-Provider-Health: unreachable`. A server
error *reply* (a query over the per-query memory ceiling) counted the same way. The
request-path health PING (1.5s) and the background warmup probe (1.5s) each misread a
busy instance answering late as unreachable, and two such misses gated reads. On the
frontend, every failure that was not the literal warming signal — a 504, a 429 from the
backend shedding the view's own 20-request burst, a 502 during a deploy, a 401 from an
access token that had just expired, a client-side timeout on a slow link — became the
outage overlay, and any three 5xx or timeouts opened the client breaker so later reads
never left the browser. Only a page reload rebuilt it, which is why refreshing sometimes
"fixed" it.

Now a deadline miss is a `ProviderTimeout` (HTTP 504, code `PROVIDER_TIMEOUT`, with
`Retry-After`) that the breaker never counts; only connection-class failures open it.
Error replies are not counted either (a demoted-master `ReadOnlyError` still is). The
request-path probe is skipped for a provider real traffic reached in the last 10s, and a
timeout-class miss — there or in warmup — must persist before it gates. `/nodes/query`,
the canvas hot path, gets its own 20s budget instead of the generic 5s, a deadline miss
inside one URN bucket surfaces instead of silently dropping those entities, and a
request that finds every provider slot busy waits up to 2s for one before being shed.
The canvas has a third state, *slow* — "taking a little longer than usual", calm, still
retrying — and reaches *unavailable* only when the backend confirms the provider is
unreachable. Idempotent graph reads retry in place on 429/502/503/504 and timeouts
(honouring `Retry-After`), the client breaker counts only confirmed outages, the initial
load runs its node batches four at a time, and the schema pill says "Schema unavailable"
(those endpoints read Postgres, never the graph) and stays quiet for a session that is
merely being renewed.

**One unhealthy data source no longer takes the graph down for the others.** Every graph
request holds a database session across its outbound FalkorDB call, and that pool is per
process and shared by every data source. A source that is merely slow is deliberately never
gated — that is what stopped the false "graph is offline" — so its requests kept arriving
and each pinned a session for up to its 20s query budget. With five sources configured and
one slow, it filled every session on a worker, and requests for the four healthy sources
waited ten seconds for a session that never freed and failed with a generic "database is
temporarily unavailable". Admission now runs at the door, before a session is taken: each
source keeps a reserved share it is never refused, one source may burst into the shared
middle while the process is quiet, and nothing is admitted past a hard ceiling that sits
under the pool. The gap between the burst ceiling and the hard one is sized to hold four
neighbours' reserved shares, and all of it derives from the pool size rather than being
hard-coded. A shed request is a 429 the canvas retries in place.

Three more paths from one provider to the others are closed. A wedged `close()` used to
run unbounded on two serial paths — the warmup cycle's idle reap and the cross-process
invalidation listener — so one blackholed host stopped the warmup cycle, staled every
provider's verdict, and blocked every other provider's invalidation; it is now bounded.
Cache writes serialized whole payloads on the event loop twice per fill, once for the entry
and once for the last-known-good mirror, stalling every other data source's requests in
proportion to the largest response any one of them returned; they are now serialized once,
on a thread. The v2 graph dependency took a session from the pool that serves auth and
navigation, which would have been the worst version of the same bug the day that router was
mounted. On the frontend, a failed bulk stats read asserted zero entities for every
workspace — one unhealthy source could fail that single request for all of them — and every
unscoped enveloped fetch shared one circuit breaker, so three failures on a bulk endpoint
fast-failed unrelated ones. A failed refresh is now "we don't know", and unscoped calls are
keyed by endpoint.

Capacity for hundreds of concurrent users: FalkorDB runs eight query threads instead of
four, on eight CPUs and 14Gi (sized for the extra concurrent query memory), with a queue of
256 rather than 64; and the response cache now holds entries up to 4 MiB instead of 1 MiB,
so the largest views — the ones whose queries cost the most — are cached rather than
recomputed on every concurrent open.

**The graph's own capacity replies, the last path to the outage card, and jobs that
never yielded.** FalkorDB answers "Max pending queries exceeded" (its queue cap) and
"Query timed out" (its kill of one query at the deadline the provider sent) as ordinary
error replies; they surfaced as 500s that no client retries. The first is now a 429 with
`Retry-After`, the second a 504 `PROVIDER_TIMEOUT`, and both are retried in place. The
cache-envelope fetch path (data-source stats, the wizard's entity step, ontology helpers)
counted *any* 5xx toward the breaker it shares with the canvas's reads, so three 504s on a
slow afternoon fast-failed the view's next node query as "circuit open" — the one way the
new frontend could still say "Graph service is unavailable" over a graph that was merely
slow; it now counts only a confirmed outage. Aggregation writers paced themselves only on
their own write latency: the web tier now stamps a short-lived read-pressure key on the
job-bus Redis when FalkorDB starves an interactive read, and every write batch on that
endpoint runs at the gentler `AGGREGATION_READ_PRESSURE_PACING_RATIO` (4.0, about a fifth
of the write duty cycle) until it expires. An engine error thrown while a view loads —
`TypeError: Cannot read properties of undefined (reading 'startTime')` was the reported
one — is a fourth canvas state, *error*, named as such and logged with its stack, never an
outage. The children client budget rose to 45s (the server's worst case is 30s), the API
load-balancer timeout to 180s, and the load harness gained the canvas view-open scenario it
never had, with its URN discovery fixed (it sent a body the endpoint rejected).

**A retry no longer takes the data away.** A refresh of a view the user was reading
emptied the canvas and covered it with the state card until the retry succeeded; a load
whose batches partly failed rendered silently incomplete; a schema refetch that failed
unmounted a canvas whose ontology was fine. Now a canvas with data keeps it — interactive,
under a small pill that says what is being retried and how many entities are missing —
and the view schema gate keeps the last good schema mounted. See
`docs/RELEASE_NOTES_2026-09-09_graph-availability.md` for the risk register, rollout
order, the resilience counters on `/api/v1/health/deps`, and the rollback knobs.

**A backend stall could take the whole site down.** The frontend pod's readiness probe
proxied the backend's `/health` with a 3s timeout, so every frontend pod failed readiness
at once when the backend's event loop stalled, and the load balancer pulled all of them —
static shell included. `/readyz` is now nginx-local. The provider slot queue is capped
(`PROVIDER_SLOT_MAX_WAITERS`, 16) so the longer wait for a slot cannot pin the graph-read
DB pool under a burst.

**Opaque edge 504s and sporadic 502s.** The ingress and load-balancer timeouts (120s)
tied the backend's slowest tier, so the proxy's "upstream timed out" won the race
against the app's structured 504; both now sit at 180s like the pod nginx. The
middleware's 504 carries `code: REQUEST_TIMEOUT` and `Retry-After`. The backend's
keep-alive (2s) was shorter than the nginx upstream pool kept connections warm, so nginx
reused sockets the worker had closed; the worker now keeps them 75s and nginx expires
its pool at 30s.

**The Growth tab crashed against any server that had not deployed yet** —
`series.previous.buckets is not iterable`, an unguarded spread of a field the running backend
did not send. Analytics documents are precomputed into Redis and outlive the code that wrote
them, so *every* future field carries this hazard: the cache key now carries a schema version,
`comparedSeries` returns null unless the previous period has a date for every value, and the
shared chart primitive checks rather than throwing.

**Metric definitions never appeared.** `MetricInfo` positioned its panel absolutely inside the
tile, and every anchor sits in a `KpiCard` with `overflow-hidden` — so every definition was
clipped to its tile and the affordance did nothing. Now portalled, viewport-clamped, flipped
when there is no room, and following scroll and resize.

**A previous-period tick was drawn at every bucket, including zeros**, landing on the axis
where consecutive ones merged into a rule that read as a plotted series — a sparse window
looked like a field of floating dashes with one real bar among them. A chart also no longer
calls itself empty when only the *current* window is flat.

**The `views-not-opened` insight was invisible to everyone it was for.** `redact_summary`
fails closed, which is right, but silently — an unclassified rule is simply dropped, no error,
no red test. A test now cross-checks every key any rule can emit against all three allow-lists
in both directions, scanning the source rather than running the rules.

Plus: an all-zero trend no longer draws a sparkline (a flat rule with an end dot reads as
"steady at some level"); the sorted-column meter no longer shades a whole row; future days in
the calendar no longer render louder than pickable ones (an alpha modifier on a bare `var()`
token compiles to a colour the browser drops); a `useId` pattern id no longer begins with a
colon, which an XML name may not and a browser may refuse to dereference.

### Security

**A redacted document was still shipping user ids.** `createdBy` was added to popular-view
rows so the redactor could honour a creator's reach to their own work, and both branches of
`_redact_view_row` then spread `**row` — so every redacted view carried its author's user id
to a reader who could not see the view's name. Rows are now projected through an explicit
allow-list: a column added to a ranking query is withheld until someone names it on purpose.

**The workspace drill-in leaked its contributor roster.** `workspace_detail` returned its
document unfiltered, guarded only by `can_see` — *may Analytics report on this workspace* —
which is an access decision, not a decision about what a document may contain. It shipped
`topContributors` with names and email addresses at every privacy level, including the strict
one whose entire premise is that no individual is ever named, and
`analyticsWorkspaceVisibility` made that reachable for non-members. Fixed with a single exit
through `redact_workspace_detail`, contributors gated on `can_open` plus membership.

**Guards that fail loudly.** A sweep over the serialised redacted document, a second over the
HTTP response body (the repo's return value is not what reaches a browser), a router-walking
sweep that enumerates the mounted routes rather than a list someone must remember to update,
and a fourth that requires the identifiers to be *present* in a privileged document — a guard
that cannot fail proves nothing.

### Upgrading

**Full detail:** `docs/RELEASE_NOTES_2026-09-11_serving-views-at-scale.md` — what was wrong at
each layer, the value table, rollout order, what to look at to verify it, and the knob that
turns each piece off.

**Clear stale view-cache TTL overrides.** A ConfigMap value beats a new default silently.
`GRAPH_CACHE_CHILDREN_TTL_S`, `GRAPH_CACHE_AGGREGATED_TTL_S`, `GRAPH_CACHE_TOP_LEVEL_TTL_S`,
`GRAPH_CACHE_LAYER_ASSIGNMENT_TTL_S`, `GRAPH_CACHE_CANVAS_BOOTSTRAP_TTL_S` and
`GRAPH_CACHE_CANVAS_EXPAND_TTL_S` pinned at 900 keep the old behaviour with no log line
saying so. Same for `FALKORDB_REPLICA_READ_SETTLE_S` pinned at 30.

**An answer can now live up to `GRAPH_CACHE_LKG_TTL_S` (24 h) when nothing bumps the
generation.** For a graph this platform owns that is exact — every write bumps it. For a graph
written to from outside, the generation moves when the change is *noticed*: a
`source-changed` signal from the loader, or the next drift check. Because the drift check now
honours the schedule, on a daily source that window is up to a day, where a 15-minute TTL used
to re-read within fifteen minutes regardless. Loaders that write FalkorDB directly should call
`POST /aggregation/data-sources/{id}/source-changed` — that is what it is for. Where they
cannot, lower `GRAPH_CACHE_LKG_TTL_S` rather than setting `GRAPH_CACHE_PROMOTE_UNCHANGED=0`,
which also gives up the promotion on graphs we do own.

- Migrations `20260909_1000_observed_tuning` (`data_source_state.observed_tuning`, what the
  last rebuild of a source learned under pressure) and `20260909_1100_job_live_overrides`
  (`aggregation_jobs.live_overrides`, limits raised on a running job); both mirrored in
  `init_aggregation_db`, so a control plane that boots first is fine.
- `AGGREGATION_SCAN_SHRINK_FLOOR` now defaults to 1 (was 10,000): a rebuild narrows all the way
  to one row before it concludes. Set the *Scan floor* knob to restore an early stop.
- The stall window and wall clock accept up to seven days; `timeoutSecs` above 86,400 is no
  longer rejected.

**Run the migration.** `20260908_1000_rollup_storage` adds the nullable
`aggregation.data_source_state.rollup_storage` column (inspector-guarded; the Control Plane's
start-up init adds it too, so a Control Plane that boots before the migration is fine).

**Set `maxmemory` where you want capacity measured.** The capacity card, the drawer block and
the fit check read the same `INFO memory` pair the write budget does; a node without a
`maxmemory` shows as *cannot be measured* with the static cap that governs it.

**Presets no longer pin `maxMaterializedEdges`, and a stored one now overrides the shard.**
An explicit ceiling on a job wins over the measured budget — that is what it is for — so a
25M value left in Ingestion → Freshness → Defaults from an earlier preset will keep every
rebuild at 25M however much memory the shards have. Clear that field (empty = the shard
governs) unless you mean it; the refusal names the ceiling when one governed. Jobs re-triggered
from Job History seed from Defaults, so they pick the change up at once.

**Set `maxmemory` where you want the budget measured.** Every top-level deployment already
passes it; the `deploy/topologies/docker-compose.falkordb-*.yml` files do not, and run on the
static edge cap until they do.

**Run the migration.** `20260907_1000_bytes_per_edge` adds the nullable
`aggregation.data_source_state.observed_bytes_per_edge` column (inspector-guarded; the
Control Plane's start-up init adds it too, so a Control Plane that boots before the migration
is fine).

**Run the migration.** `20260821_1200_event_subject` adds `product_events.subject_id` and its
index, then backfills in Python — SQLite and Postgres spell JSON extraction differently. It is
inspector-guarded, because `0001_baseline` `create_all()`s the current ORM and a bare
`add_column` would make a brand-new environment unbuildable while every migrated database kept
working.

**Nothing turns on by itself.** Analytics is visible to `super_admin`, `org_admin` and
`org_auditor` on deploy and to nobody else.

**Two settings widen disclosure — decide them deliberately.** `analyticsWorkspaceVisibility`
lets Analytics *report on* workspaces RBAC hides from a reader (reporting only; it grants no
access and renders no link they cannot follow). `analyticsShowEmailAddresses` adds addresses
beside colleagues attached to something the reader can already open, never on the
platform-wide activity ranking, and cannot read past `analyticsPrivacyMode`. Both default off
and both changes are recorded in `feature_flag_changes`. `analyticsPublicEnabled` fails closed:
an unreadable flag means privileged-only, because failing open would publish headcount and
workspace existence over a database hiccup.

**Run the scheduler role somewhere** if you want warmed documents and event retention. Neither
is required for correctness, but without it readers pay the aggregation on the read path and
`product_events` grows with no horizon.

**Graph availability: check what you already set.** No migration and no new required
variable — but almost every value the graph-availability fix changed is an environment
knob, and an explicit override beats the new default silently. A deployment that pinned
`FALKORDB_NODES_QUERY_TIMEOUT=5`, or copied the old `.env.example` line
`HTTP_TIMEOUT_GRAPH_SECS=15`, runs the new image and keeps producing the outage the
release removes. The FalkorDB thread count and the client-side deadlines are baked into
the pod args and the frontend bundle, so they need a restart and a rebuild respectively.
`docs/UPGRADE_2026-09-10_graph-availability.md` is the checklist: what arrives on its own,
which overrides to delete, what needs an image, a manifest, or the one restart with
downtime, and how to confirm on `/api/v1/health/deps` that it landed.

### Known limitations

- A single row larger than the graph store's per-query memory ceiling is still terminal for that
  rebuild — the message names which, and the ceiling is now adjustable from Infrastructure. A
  runtime change to the store's limits lasts until the store restarts (the dialog hands over the
  `FALKORDB_ARGS` fragment); the container-memory guard trusts the figure entered or
  `FALKORDB_CONTAINER_MEMORY_BYTES`, since the application cannot read the container limit;
  `THREAD_COUNT`, `OMP_THREAD_COUNT` and `CACHE_SIZE` remain load-time only.
- The scan floor, the chunk sizes and rollup storage change on the next Resume or Re-trigger,
  not on a running job; the time limits, pacing, read concurrency and the scan width are live.
- The read-side ladder covers the aggregated-edges family; trace drills, children and
  top-level pages keep their current behaviour under the store's per-query limits.
- The memory-aware flush reads the worker's cgroup limit; on a host without one only the
  pair cap (`AGGREGATION_MAX_PENDING_PAIRS`) bounds worker memory, as before.
- The status probe and the topology reading can name the same node differently under an address
  remap (the probe reads the env topology, the reading dials each node from the provider's own
  settings); the Infrastructure page unions the two by endpoint rather than joining them, and
  Admin → Graph store shows the announced address beside the dialled one when they differ.
- Replication backpressure protects the replicas of the shard a run writes to. A replica that is
  detached (the master reports none attached) is not waited for — it is flagged on the Graph
  store page instead.
- A node restart is detected from its run id and uptime when it answers again. Why it restarted
  comes from the orchestrator, which the application cannot read; the guide gives the command.
- Per-graph sizes are sampled and refreshed with the topology reading, not live, and are capped
  per node so one snapshot cannot become a load generator.
- Replica reads are eventually consistent within the lag threshold and the settle window. A
  provider whose readers cannot accept that can be pinned to master-only reads. The window
  covers this process's own writes; a write from ANOTHER pod is only bounded by the lag
  threshold.
- The read router reaches past the public API of both redis-py and the FalkorDB client (a
  shard's replicas come from the client's slot map, the READONLY handshake from the load-
  balancing strategy, and a pinned read from rebinding the graph object's own
  `execute_command`). Both are ceilinged below their next major for that reason, and the
  provider's topology line reports the replica share, which is what would show a silent
  regression.
- The topology reading enumerates every data source of every provider each time it is built,
  capped only in what it renders. On a very large catalogue that is work thrown away; capping
  the query instead would make a source past the cap indistinguishable from one whose graph is
  missing, so it is left uncapped until it can be paged.
- A snapshot that fails part way replaces the previous one as a whole or not at all: there is
  no per-node carry-forward, so a node that misses one sweep loses its last good figures until
  the next one reaches it.
- The failing-over memo that makes a restarting node fail fast is per provider, not per shard.
  For the two seconds it holds, a read of this provider's other graph — on a healthy node — is
  told the endpoint that is failing over rather than its own.
- The Full-detail pre-flight is *unknown* until a source has one successful rebuild: the cube
  estimate it needs is recorded on success only.
- A custom role granted **only** `system:analytics:read` gets no nav item: the catalogue spec
  is `["system:admin", "system:org-admin", "system:audit:read"]`, so the client hides what the
  server would serve. The three seeded roles each also hold one of those, so this does not bite
  them.
- Custom ranges are never warmed and pay the read-through cost on first request. Warming an
  unbounded key space is how a warmer becomes a load generator.
- Usage history starts from this release — opens are counted from `product_events`, and
  `view_visits` is an upsert keyed `(view, user)` that only ever held each user's *last* visit.
- Workspace distribution bands cover the workspaces this reader is shown, which for most people
  is a subset; the header says how much of the estate is in view rather than calling two of ten
  "the estate".

---

## [Unreleased] — View sharing that means what it says

### Changed

**Rollups are stored in full detail by default.** Every ancestor-pair
combination is now pre-created — leaf-involving and mixed-level included — so
no canvas granularity can come back thin. This closes a real gap on
self-nesting ontology types (`Node ⊃ Node ⊃ Node`), where the boundary mode's
on-demand reader still reasons in ontology type levels and could return
incomplete mixed-granularity drill answers. The previous default, `auto`,
stored the full cube only while it fit the cube ceiling and fell back to the
depth-diagonal above it.

It applies everywhere without new plumbing, because every automatic rebuild
already resolves its configuration server-side: reconciliation drift and first
builds, the cron drift sweep, the stale-marker reconciler, Refresh rollups, the
projector heal hook, and the Ingestion re-trigger dialog.

**Rollup storage is now a fleet-wide setting an operator owns.** Ingestion →
Freshness → Automation → ③ Act → Advanced switches the whole fleet between
Auto and Always full detail, and every subsequent run picks it up. The
workspace Defaults dialog gained the same control in place of its
"Materialize fine pairs" checkbox.

**Machine-queued rebuilds get the same stall window as a hand-started one.**
`AGGREGATION_STALL_TIMEOUT_SECS` moves 900 → 10800 (3h), matching what every UI
trigger path already sent explicitly. Only the machine paths leave a job's
`timeout_secs` NULL, so they were the only rebuilds being killed for making no
progress for fifteen minutes — on exactly the graphs large enough to do that,
with nobody watching. A progressing job was never affected; this is a
no-forward-progress window, not a runtime cap.

### Fixed

**"Auto" could not turn full detail back off.** Rollup storage had three
meanings but only two wire values: "Auto" was expressed by omitting the field,
and an omitted field means *inherit*. So once a global default of full detail
was stored, the trigger dialog showed "Auto (recommended)" while the job it
queued ran the full cube. `materializeFinePairs` now accepts `"auto"` as a
value, and the dialog resolves an absent field against the default the server
reports rather than assuming Auto.

**Saving one aggregation default no longer erases the others.**
`aggregation_settings.tuning_json` has two editors now, and it was written by
replacement — so whichever saved last wiped the other's fields. It is merged,
like `cadence_json` already was; clearing a value means sending it explicitly
as `null`.

**Picking a performance profile no longer discards the rollup-storage
choice**, and a profile again reads as active once one is set.

### Upgrading

**Rollup storage changes behaviour on upgrade.** A graph whose full cube
exceeds `AGGREGATION_MAX_MATERIALIZED_EDGES` (default 25M, ~12.5GB at ~0.5KB
per edge, sized against ONE shard) now fails its rebuild terminally on
`MaterializationBudgetExceeded` where `auto` would have degraded to the
depth-diagonal and served finer granularities on demand. A forced cube skips
the up-front estimate, so that failure lands part-way through and leaves a
partial cube until the next successful rebuild reconciles it; reconciliation's
breaker suspends a source after three such passes.

Check your largest graph against the budget before upgrading. To keep the old
behaviour fleet-wide, set Rollup storage to **Auto** in Ingestion → Freshness →
Automation (③ Act → Advanced), or set
`AGGREGATION_MATERIALIZE_FINE_PAIRS=auto`. Note that a value stored from the UI
beats the environment variable.

Deployments pinning `AGGREGATION_STALL_TIMEOUT_SECS` should raise it to 10800
to pick up the watchdog change (`deploy/k8s/base/configmaps/worker-config.yaml`
is updated); keep it below `2 × AGGREGATION_JOB_TIMEOUT_SECS` so the control
plane's stale-job backstop stays the backstop.

### Security

**Private views were not private.** The view-access evaluator checked
workspace membership before the visibility tier, so every workspace member —
and every org-level reader — could open any private view in their workspaces.
Worse, `GET /views/facets` had no authentication at all and served every
private view's tags and creator identity to the open internet-facing API, the
popular list leaked workspace-tier views across workspaces, and the stats
endpoint counted views the caller could not read. Visibility now gates first
(private = creator + explicit grantees + workspace admins), every list and
aggregate read filters inside SQL, and the unauthenticated endpoints require
sign-in.

**Sharing state had side doors.** The generic view-update endpoint accepted a
`visibility` field under mere edit rights, and creating a view straight as
`enterprise` skipped visibility authorization entirely. Both are closed: the
dedicated visibility endpoint is the only path, and it now demands the new
`workspace:view:publish` permission for any transition to or from
`enterprise`. Favouriting no longer works on views you cannot read, and two
graph mutations that had shipped under the read gate
(`vocab-alignment/confirm` and the atomic draft-commit path) require
`workspace:datasource:manage` like every sibling write. A request naming a
`dataSourceId` outside the path workspace now 404s — the binding was never
verified before.

### Added

**Enterprise visibility now actually opens.** Any signed-in user can open a
published view from its `/views/{id}` link and the canvas loads, read-only —
expand, trace, and search included. The data plane accepts a view-capability
context (`?viewId=`) pinned to the view's resolved data source; mutations stay
membership-gated. The single-view read returns a per-caller `access` envelope
(capabilities + `dataAccess`) plus the resolved data source and provider so
the canvas can boot without workspace membership.

**Sharing with people and groups is complete.** A signed-in-user directory
(`GET /directory`) replaces the admin-only picker source, grant roles can be
edited in place (`PUT /views/{id}/grants/{grant_id}`), and the Explorer's
"Shared with me" is a real server-side category (explicit grants, not a
visibility approximation).

**Publishing is a journey, not a wall.** A member who can't publish can ask:
the Enterprise option opens a request (with an optional note) that a
publish-permission holder approves or declines with a reason, both recorded on
the view's timeline. Workspaces that prefer no ceremony set their publication
policy to *open*, where anyone who may change a view's visibility may publish
it directly.

### Fixed

**Views stopped claiming their sources were deleted.** View health was
computed in the browser against the workspace list, which only contains
workspaces you belong to — so every view you could see but weren't a member of
(anything shared, published, or seen as an admin) was branded "Source deleted".
Health is a server fact now, from the same predicate the "needs attention"
filter uses, so the badge and the filter can't disagree.

**Layer assignment stopped being denied to people allowed to read.**
`assignments/compute` is a cached read, but it required *manage* — which
silently 403'd every read-only workspace member's canvas, and every visitor to
a shared view. It is gated as the read it is.

**Access-denied messages say something useful.** Inside a view shared with
you, the card now explains that you're exploring read-only and offers to
request edit access, instead of reciting `Missing permission:
workspace:datasource:read`.

### Security

**Break-glass admin access is visible to the owner.** A platform admin opening
someone else's private view records an `admin_viewed` entry on that view's
timeline (deduped hourly). The reach is unchanged and deliberate; it is no
longer silent.

### Upgrading

Pre-upgrade sessions may carry a collapsed `workspace:view:*` wildcard that
satisfies publish checks until they refresh (bounded by the access-token TTL);
force re-login via session revocation if that window matters. Clients that
sent `visibility` through the generic view PUT now receive 422 — use the
dedicated visibility endpoint.

## [Unreleased] — Invite links that actually work, and can be taken back

### Security

**Signing someone out did not sign them out.** Revoking a user's sessions —
whether an admin killing a compromised account or a role change forcing new
claims — wrote the session id to a Redis tombstone list that `/auth/refresh`
never consulted. Worse, a refresh does not reuse the session id; it mints a
fresh random one. So the sequence was: access token rejected once, the browser
silently refreshes (which it does automatically), a brand-new session id comes
back that was never on the list, and the session continues. The only thing that
ever really ended a session was suspending the account, which `refresh` happens
to re-check for other reasons.

Revocation now also stamps `users.sessions_valid_from`, and a refresh token
minted before that instant is refused and its family killed. The Redis
tombstone still covers the minutes until the access token would have expired;
the cutoff covers everything after. Tokens issued before this release carry no
mint claim and are honoured, so upgrading does not sign the estate out.

### Added

**You can manage your own account.** Every account action in this product was
something an administrator did to somebody else — Admin → Users could rename
you, reset your password, suspend you — and there was no screen where you could
do any of it yourself. For the sole System Administrator that meant editing your
own row through a table built for managing other people, and changing your own
password through a form that never asked what the old one was.

**Account settings**, in the profile menu, now covers:

- **Your name**, including an optional **display name** for people whose name
  is not simply their first and last. Clearing it goes back to the derived one.
- **Your password**, which asks for the current one — the only password entry
  point in the product that does, because it is the only one not already behind
  an admin or a one-time token. Changing it signs out every session, including
  the one you are using, which is now true rather than merely claimed.
- **Sign out everywhere**, for when you think somebody else has your session.
- **Recent activity** — password changes, resets and revocations on your
  account, and whether an administrator did them. Nothing previously showed
  these events to the person they were about.
- **Your avatar**, which is now stored on the account. It was a browser-local
  preference, so it silently reset on a new machine and nobody else ever saw it.

**Single sign-on is now genuinely the source of truth for the profile.** It
previously seeded a name at just-in-time provisioning and never looked at it
again — so a rename in the directory never reached the product, and the profile
drifted from the directory permanently. Groups and mapped attributes have always
re-synced on every sign-in; names simply never did.

They do now, and the fields the provider asserts are shown locked and attributed
on the account page rather than as editable boxes whose values quietly revert.
Writes to them are refused for administrators too: being an admin does not make
the edit survive the next sign-in, and an override that silently disappears is
worse than a clear refusal.

Three details make it usable rather than obstructive. It is **per field** — a
directory that releases `given_name` and no `family_name` owns only the first,
because locking whatever an account happens to have linked would hand people a
blank name they could never fill in. It follows **what the provider actually
sent**, so a claim removed from the mapping hands the field back at the next
sign-in instead of staying locked on the strength of an old login. And
**display name is never owned**, which is what keeps the page worth opening for
an SSO account. Where two providers are linked, the one you most recently signed
in with wins — the rule group memberships already followed.

**The account page was rebuilt around identity rather than around a form.** It
opens with who you are — avatar, name, role, and the methods that can sign you
in — instead of a stack of equally-weighted input cards. The password form is
collapsed until asked for (expanded, it was the largest thing on the page),
Save appears only once something has changed and follows you down the page,
and signing out everywhere moved into its own zone rather than sitting beside
an ordinary Save button.

**The default administrator password cannot be kept.** A fresh deployment seeds
an admin from `ADMIN_PASSWORD`, and a log line asking the operator to change it
was the only control — while the value itself is printed in the README, the
quickstart compose file, and every setup doc. When the seeded password is one of
those published defaults the account must now choose a new one at first
sign-in, enforced by the API rather than by a redirect the client could decline
to follow. Supplying your own password skips the prompt entirely. Admin → Users
badges any account still in that state.

**A locked-out sole administrator can get back in.** `Forgot password` sends
nothing — this deployment has no email infrastructure — it flags the request for
an administrator, which for the only administrator is themselves. There is now
`python -m backend.scripts.reset_admin_password --email …`, which prompts for
the password rather than taking it as an argument and revokes every existing
session. Host access is the authorisation model, which is why it is not an
endpoint.

**Reset password is a labelled button.** It was an unlabelled key icon in a row
of unlabelled icons — the single action people come to that screen for, findable
only by hovering things.

### Known limitations

**Account activity starts at upgrade.** The events behind it were always
written, but without the subject columns needed to find them by account without
scanning the table. Only events recorded after this release appear, so an empty
list means "nothing since you upgraded", not "nothing ever happened". The page
says so.

**"Sign out everywhere" includes the device you are on.** Keeping the current
session alive would mean re-issuing its cookies past the revocation cutoff,
which needs session-minting surface on the auth service that is deliberately
being kept thin ahead of extracting it. The button says what it does.

**Email is still not self-editable.** It is the identity-provider key, so
changing it is a re-link, not a text field.

### Fixed

**The admin profile edit returned stale data.** Saving a name change wrote it
correctly but answered with the values from before the edit, because the write
went around SQLAlchemy's identity map while the response read through it. The
database was always right; the screen just did not show it until a reload.
**Signing into one environment logged you out of another, and no session survived a
redeploy.** Users bounced straight back to `/login` after signing in, got logged out on
clicking any section, and saw `Refresh rejected: Signature verification failed` in the
backend log. Moving between two deployments — `dataviz-dev.local` and `dataviz-uat.local`,
even on separate clusters — logged them out of whichever one they left.

Three causes, all in the app layer:

* **Environments were indistinguishable.** Every deployment wrote the same cookie names
  (`nx_access`, `nx_refresh`) and stamped tokens with the same issuer, so a token from one
  was structurally identical to a token from another — only the signature differed. Since
  cookie jars are keyed by *domain*, not by cluster, signing into one deployment simply
  overwrote the other's cookies, and the receiving side could only report an opaque
  signature failure. `AUTH_ENVIRONMENT_ID` now scopes the session cookie names
  (`nx_access_uat`) and binds the environment into the JWT issuer, so the jars are disjoint
  and a cross-environment token fails as a recognisable issuer mismatch. `nx_csrf` is
  deliberately left unscoped — it is read from JavaScript by name, and the double-submit
  check only ever compares it against the header on the same request.
* **Verification accepted exactly one key.** Any change to `JWT_SECRET_KEY` invalidated
  every live session the instant it landed, and because updating a Secret does not restart
  pods, replicas on the old and new key served traffic side by side — with no session
  affinity, the same user flipped between authenticated and 401 request-to-request. That is
  the "click any section and get logged out" symptom. `JWT_SECRET_KEY_PREVIOUS` now holds
  retired keys for verification only, and tokens carry a `kid` header so the right key is
  selected directly.
* **A rejected token was never evicted.** `get_current_user` answered 401 and left the bad
  cookie in place, so the browser re-presented it on every request — and `clear_session_cookies`
  only ever deleted using the *current* process's cookie domain, which cannot match a cookie
  written under a different `AUTH_COOKIE_DOMAIN` or by a sibling environment sharing a parent
  domain. That combination is what made the login loop permanent. Cookies that can never
  verify here are now cleared across every plausible scope (configured domain, host-only, and
  the parent domain), including the pre-scoping names, and the 401 carries a `session_foreign`
  marker so the frontend stops retrying and starts one clean login instead of looping.

Ordinary expiry is explicitly *not* treated this way, so the silent five-minute refresh is
unchanged.

### Added

**`GET /api/v1/auth/diagnostics`** — unauthenticated and secret-free, because it is most
needed exactly when nobody can authenticate. Reports the environment id, issuer, expected
cookie names, active and accepted key fingerprints, whether the request actually arrived over
TLS (honouring `X-Forwarded-Proto`), and for each session cookie presented whether it is
valid, expired, or foreign. The backend also logs an auth fingerprint at startup, so two
deployments can be compared from one `kubectl logs`.

It warns at startup when `AUTH_COOKIE_SECURE=true`, which is worth checking on any `.local`
host: browsers silently discard `Secure` cookies sent over plain HTTP, so login returns 200,
nothing is stored, and the next request is anonymous — indistinguishable from this bug.

### Upgrading

Both new settings are optional and default to today's behaviour.

* Set `AUTH_ENVIRONMENT_ID` per environment (`dev`, `uat`, …) if users can have two
  environments open in one browser. The k8s overlays and the Helm chart now carry it. It must
  be unique and stable — changing it logs that environment's users out once, by design.
* To rotate `JWT_SECRET_KEY` without logging everyone out: copy the current value into
  `JWT_SECRET_KEY_PREVIOUS`, set the new key, deploy, then drop the old entry after
  `JWT_REFRESH_EXPIRY_DAYS`.

### Known limitations

Every k8s overlay still deploys into the same namespace with the same object names and the
same static IP (`deploy/k8s/overlays/*/kustomization.yaml` set no `namespace`/`namePrefix`),
so deploying one environment overwrites another's `app-secrets`, `viz-service`, and ingress.
`deploy.sh setup` also re-mints `JWT_SECRET_KEY` into a per-operator `.env.deploy`, and
applying a Secret does not restart pods. The key ring makes those survivable rather than
session-ending, but they remain worth fixing separately.

### Fixed

**Shareable signup links were unusable.** Anyone who clicked one landed on the login page
instead of the signup form, and the invite was discarded on the way. The `/signup` route was
gated on the `signupEnabled` flag, which knows nothing about invitations — so in the default
invite-only posture (`signupEnabled` off, which is what the flag's own admin copy recommends)
*every* link was dead, for everyone, deterministically. The gate also fired before the flag had
loaded, so it bounced first-time visitors even where self-registration was on. The decision now
lives in the signup page, which can see both the invite and whether the flag has actually
arrived: an invite is never turned away, and nothing is decided on a seeded guess.

**Invited accounts claimed to be self-registrations.** `signup_source` was documented to carry
`'invite'` and never did, which made the column useless for the one question it exists to
answer.

**A team sharing one link hit the rate limiter.** Signup was capped at 5/minute per IP, so the
sixth person behind an office NAT was refused — indistinguishable from a broken link.

### Added

**Invite links are now revocable, countable, and auditable.** They used to be fire-and-forget
tokens with no server-side record: a link pasted into the wrong channel worked for every reader
for up to 90 days, and nobody could tell it had happened. Every link now has a row behind it, so
you can:

- **Revoke** one instantly from **Admin → Users → Manage links**, whatever its expiry.
- **Cap** it to a number of people — the link closes itself once the seats are gone. Enforced
  atomically, so two people clicking a one-seat link at the same moment cannot both get in.
- **See who used it**, and when.
- **Restrict it to an email domain** (`company.com`) — the middle ground between a link anyone
  can use and one pinned to a single address, which is what makes a link safe to post in a team
  channel.

**Invited users are signed straight in.** They were already approved and activated by the
invite; sending them to a login form to retype the password they had just chosen bought nothing.

**Workspace admins can invite into their own workspaces.** Previously only platform admins
could invite anyone at all. The rule that keeps it safe is that you cannot grant what you do not
hold: non-privileged roles only, no organisation-wide groups, and only into workspaces you
administer. Each person sees and revokes only the links they created.

**`inviteLinksEnabled`** — a switch for the invite-link capability, separate from
`signupEnabled` so the two doors can be opened independently. Turning it off is a kill switch:
links already in circulation stop working immediately, not just new ones. The confirmation
dialog tells you how many live links that will kill before you flip it.

**Links say why they failed.** "Invalid or expired" covered four situations with four different
remedies. A recipient is now told whether the link was revoked, ran out of seats, expired, or
whether invite links are switched off entirely.

**Accept an invite with single sign-on.** An invite meant one thing: choose a password. In an
SSO-only deployment that asked the invitee to invent one that login would then refuse. The
invite page now offers **Continue with &lt;your IdP&gt;**, and the invitation is applied once the
handshake has proved who they are. An invite is only applied to an account with no access yet —
somebody already set up has already been onboarded, and a forwarded link must not add grants to
an established account.

**Invite several people at once.** One list of addresses, one set of settings, one
email-pinned link per person — pinned rather than shared, so each is separately revocable and
each redemption is attributable. Partial success is reported per row: one address already
having an account does not cost the others their invitations.

**Extend or replace a link without losing its history.** **Extend** buys another 30 days (and
more seats on a capped link) while the URL you already shared keeps working. **New URL** issues
a fresh link and stops every URL already sent, keeping the role, groups, seat count and the
record of who has joined on the same invitation. Previously both meant minting a replacement,
which split one invitation across two rows and stranded its history on the dead one.

**A capped link says so.** "2 spots left · Expires in 3 days" on the signup page, so the person
who clicks one too late is not the only one who ever finds out there was a limit.

**Invited users land somewhere useful.** Redemption opens the Getting Started hub once instead
of dropping a brand-new person onto a cold dashboard.

**The notification bell does something.** Its first real content is invite activity: who signed
up through your links, and when. Sending an invitation and never hearing whether it worked left
you with no idea whether to follow up or let it expire.

**Admins can add people directly, one at a time or from a list.** Until now the only way
in was a link somebody had to click — which does not help when there is nobody to hand a link
TO yet: someone starting Monday, an account migrated from another tool, a shared operations
login. **Add people** in Admin → Users creates the accounts outright, with the same role,
workspace and group choices an invite carries, because the account that comes out is the same
account either way.

Three ways the new account can first sign in. The default, **a setup link**, leaves no
password on the account at all — the person chooses their own, so nobody, including the admin
who created it, ever knows it. You can also **set a password yourself** (quick, but you will
know it, and nothing sends it for you), or leave it **SSO-only**. A shared password across a
batch is refused outright: a password twenty people know is not a credential.

A pasted list accepts `Name <a@b.com>` as well as bare addresses, drops repeats, and fills in
missing names from the address — `grace.hopper@` becomes Grace Hopper — with the derived names
shown on the review step rather than discovered afterwards in the user list. Every row reports
its own outcome, so one address that already has an account does not cost the others theirs.

**Creating a link is a wizard, not a wall.** "Invite by Link" asked seven questions at once
— role, workspace, groups, recipient, expiry, seat cap, domain — with no starting point, and
parked the sentence describing the whole invite below the fold, under the fields it was meant
to check. It is now a four-step wizard built to the same pattern as the view and asset
onboarding wizards: its own overlay, a header stating which step you are on, a progress rail
whose completed steps carry a one-line summary of what you chose and can be clicked to go
back, directional transitions, keyboard navigation with a focus trap, and a guard against
closing with work in progress. The steps are *who it's for → what they get → safety →
review*, in that order because the first question is the only one that constrains the others
— and the one the inviter can already answer before opening the dialog, so it carries the
defaults for everything downstream.

**The link itself gets a proper hand-off.** Generating one used to drop a result card into
the same modal shell. It now ends on a success screen: the URL as the hero, monospaced and
copyable in one press, with what the link grants, who it is for, its seats and its lifetime as
tiles beneath — and a plain statement that this is the only time the URL is shown, because the
links list deliberately never returns it again.

**A link's reach is visible before it is minted.** The safety step shows how far the invite
actually reaches — audience, seat cap, lifetime and role, as a single meter with the reasons
written beside it — so "anyone · unlimited · 90 days · org admin" feels different from "one
person · 1 seat · 7 days" at the point of creation rather than in an audit later.

**An open link arrives bounded.** Picking "anyone with the link" used to be the *default*
state, at unlimited uses for 30 days — the widest invite the product can mint, reached by
touching nothing. It now arrives capped at 5 people for 7 days and says so on the way past.
Unlimited is still one click away; the difference is which direction you have to move to get
there. A link pinned to one address defaults to a single seat and no longer offers a seat cap
at all, because it cannot use one.

**Privileged role descriptions are readable.** They were clamped to one line, so every one of
them was cut mid-sentence — "Platform owner. Carries system:admin; implies every permission,
…" — on exactly the choices where knowing what you are granting matters most.

**The email-pin rule explains itself.** Attaching a privileged role or a group to a shareable
link used to grey out the submit button with the explanation in a different column. It now
names the conflict against the audience already chosen and offers both resolutions: pin it to
one person, or take the documented override.

**The links panel leads rather than lists.** It opens on what needs doing — how many links are
live, how many people have joined, and how many are about to expire or run out of seats — and
sorts by urgency so the link you came to deal with is at the top. You can create a link from
the panel that manages them, which previously meant closing it to find a different button.
Search and sort appear only once there are enough links to need them, and a single contextual
tip surfaces things worth knowing (an uncapped link with no restriction on who can use it, for
instance) and disappears when they stop being true.

### Security

Auto sign-in makes the signup endpoint's enumeration-safe response distinguishable for someone
holding a valid invite (the created path sets cookies, the already-exists path does not). This
is an accepted trade, not an oversight: it requires a live invite, every probe is bounded by
that invite's seat cap, and the ledger records who held it. Documented at the call site.

**Node sorting is now enforced by the server.** `nodeSortingEnabled` had no backend half at
all: an admin could switch node sorting off, the canvas would hide the sort menu, and anyone
posting to the view-layout endpoint directly would still set sort modes and custom orders — the
exact "toggle that only hides a button" the feature registry's drift guard exists to prevent.
View-layout writes now strip `nodeSortMode`, `orderKey` and `defaultNodeSortMode` when the flag
is off. It strips rather than refuses, because the canvas rewrites the whole layout on every
gesture and a 403 would block someone for dragging a node; orders already stored are untouched
and still render, exactly as the flag's admin copy promises.

### Fixed

**The feature registry was under-reporting itself.** `nodeSortingEnabled` had no wiring entry
at all and `toursEnabled` declared no UI surfaces despite being read in six components, so the
admin Features page reported both as "not implemented" and two drift-guard tests failed on
`main`. Both now declare what actually exists. The end-to-end registry test has also been taught
the `stage` exemption that `feature_wiring.py` documents and its sibling test already applied —
experimental flags are not required to have a server gate yet, which is the whole reason the
stage exists. Active flags are still checked in full.

**Nothing in the invite dialog had an edge.** Every unselected chip, role row, group row and
text input used the house `border-glass-border` recipe, which in light mode is a *white*
hairline — so inside a dialog that is itself `bg-canvas-elevated`, the form rendered as
floating text and only whichever option happened to be selected looked like a control. Same
root cause as the rows below, fixed the same way, and limited to this flow.

**Invite rows had no edges.** They used the house `border-glass-border` recipe, which in light
mode is a *white* hairline — it works everywhere else because those cards sit on the page
background and take their edge from the fill, but this list lives in a drawer that is the same
colour as the cards, so the rows dissolved into one stream. They now draw a real hairline.
Separately, `bg-accent-lineage/10` and friends emit no CSS at all — Tailwind cannot apply an
opacity modifier to a variable holding a full hex — so every tint in the panel was silently
invisible, including the seat meter's track. This panel now uses the palette colour the token
resolves to, which renders. The same class is used ~850 times elsewhere in the app and is
untouched here; worth a separate look.

---

## [0.2.0] — 2026-07-19 — Versioned Graph: rollback, admin flag, and enable-VC at scale

Version control for a data graph becomes usable on a *real* graph: you can turn it on for a
data source you already have, undo a change you already published, and switch the whole feature
off for a deployment that doesn't want it.

Verified end to end against a live **7.7M-entity** graph (2,083,216 nodes / 5,009,794 edges).

### Added

**Roll back a change you already published.** Two different operations, because they answer two
different questions:

- **Undo this change** — reverses one published revision and *keeps* everything that came after
  it. If later work touched the same items, it can't be undone in isolation; the dialog says so,
  names how many items collide, and offers the way out.
- **Restore the graph to this point** — resets the graph to how it looked at a chosen revision.
  It cannot conflict, by construction, which is exactly why it's the escape hatch when an undo
  can't proceed. Shows the exact impact before you commit to it.

Both add a **new revision**. History is never rewritten, and nothing is destroyed. Available
from the history timeline and from a merged pull request.

**Turn on version control for a data source you already have.** Previously this had to happen
in a single request and was not viable on a large graph. It is now a background job:

- Runs asynchronously — you keep working while it copies.
- **Resumable.** A killed worker picks up exactly where it stopped; it does not start over.
- **Proves itself.** When it finishes you get an integrity report — every item and connection
  counted against the source, every item type and relationship type checked for survival, no
  duplicate identifiers, no dropped connections, and a random sample re-read from the source and
  compared byte-for-byte. On the 7.7M graph: *"scanned 2,083,216 of 2,083,216 items · 5,009,794
  of 5,009,794 connections · 64 of 64 re-checked items match exactly · zero data loss."*
- **Invisible until proven.** Nothing becomes live until the checks pass, so a failed copy leaves
  your data source reading exactly as it did before. There is nothing to undo.
- Live progress with a time-remaining estimate, and — if something goes wrong — a plain-language
  reason plus Resume / Start over / Give up, and a downloadable report.

**An admin switch for the whole feature.** `Admin → Features → Version control`. Turn it off and
the versioning UI disappears and the server refuses versioning writes. Existing versioned graphs
stay **viewable, read-only** — nothing is deleted and nothing is hidden from you permanently.

**Enable-version-control jobs are visible to operators.** `/admin/infrastructure` gains a panel
for copies that are running, stalled, or failed. This matters more than it sounds: a graph being
copied deliberately parks its projection watermark, which made it read as *healthy and in sync*
to every other probe — so a copy that failed days ago, while silently blocking writes to its data
source, showed up as green.

### Changed

**Breaking — API.**

| Endpoint | Before | Now |
|---|---|---|
| `POST /{ws}/graph/bootstrap` | synchronous; returned the result | **`202` + `{jobId, graphId, status}`**; poll `GET /{ws}/graph/bootstrap/status` |
| `POST /{ws}/graph/bootstrap` | no permission check | requires **`workspace:datasource:manage`** |
| `POST /{ws}/graph/resync` | `workspace:datasource:read` | requires **`workspace:datasource:manage`** (see *Security*) |
| canvas write-through | silently enabled version control for you | raises a typed **"enable version control first"** error |

**New endpoints:** `GET /{ws}/graph/bootstrap/status`, `POST /{ws}/graph/bootstrap/retry`,
`POST /{ws}/graph/bootstrap/abandon`, `POST /{ws}/versioning/graphs/{gid}/commits/{cid}/restore`,
`GET  /{ws}/versioning/graphs/{gid}/commits/{cid}/restore-preview`, and the public
`GET /api/v1/features/values` (UI booleans only — no schema, no admin hints, no secrets).

**A data source on a non-FalkorDB provider is now refused up front** with `422
provider_unsupported`, instead of being accepted with a `202` and failing later. The copy is
FalkorDB-shaped end to end; accepting it and failing afterwards left the data source **write-
blocked behind a job that could never succeed**.

**New commit kind `restore` and new job type `bootstrap`** — both require the migrations below.

### Security

**`POST /{ws}/graph/resync` was a write gated on read.** The graph router's blanket dependency is
`workspace:datasource:read`, and that route added nothing on top — so anyone who could merely
*look* at a data source could commit a `sync` to its main branch, overwriting source-authoritative
fields across the whole graph and, with `strategy=external_wins`, deliberately clobbering other
people's edits. It now requires `manage`, like every other write on that router.

Tenant isolation was already sound here (cross-workspace requests already 404'd), so this is a
privilege bug, not a cross-tenant one.

*Also noted, not fixed:* `POST /{ws}/graph/vocab-alignment/confirm` is in the same state — a write
with no permission dependency beyond the router's read.

### Upgrading

**Migrations are mandatory.** Run `alembic upgrade head`. The runtime's `create_all` never ALTERs
an existing table, so an existing database will **not** self-heal:

- `20260713_1200_restore_kind` — allows `commits.kind = 'restore'`.
- `20260713_1400_jobs_bootstrap` — allows `jobs.job_type = 'bootstrap'`. **Widen-only**
  (`required ∪ present`): `graphver.jobs` is a shared, multi-producer table, and a CHECK rebuilt
  from a hard-coded allow-list has wedged Alembic on it before.

**The worker must be running.** Enabling version control is now a job, claimed by the versioning
worker (`python -m backend.app.services.versioning`, or `GRAPHVER_PROJECTION_INPROCESS=1` in dev).
Without it, jobs sit in `pending` forever.

**New tuning knobs** — all optional, all sized for a 10M-entity graph. Full table with defaults and
rationale in [`docs/VERSIONING_E2E.md`](/docs/versioning-e2e#tuning-all-optional-defaults-are-sized-for-a-10m-entity-graph):

`GRAPHVER_BOOTSTRAP_SCAN_WIDTH`, `_SCAN_MIN_WIDTH`, `_EDGE_TARGET`, `_WINDOW`, `_SAMPLE_K`,
`_MERKLE_MAX`, `_RETRY_BUDGET_SECS`, `_RETRY_MAX_DELAY_SECS`, `GRAPHVER_INGEST_POLL_SECS`,
`_STALE_SECS`, `_HEARTBEAT_SECS`, `GRAPHVER_RESYNC_MAX_ENTITIES`.

### Known limitations

**Re-sync holds the whole graph in memory, several times over.** Measured: **2.03 GB of RSS to
compute 808 changes** on a 478,430-entity graph — in one HTTP request, on the web tier. It scales
linearly, so a 7.7M-entity graph would ask for roughly **30 GB** and take the API process down,
along with every request in flight on it.

This is **pre-existing** and untouched by this work. But this release is what makes graphs that
large versionable in the first place, so it now ships behind a guard rather than a crash: re-sync
**refuses** above `GRAPHVER_RESYNC_MAX_ENTITIES` (default 250,000) with `422
graph_too_large_to_sync`, quoting the item count and the memory it would need. Refusing beats an
OOM on every axis — an OOM kills unrelated requests and explains nothing.

The design that removes the guard entirely is written out in
[`docs/versioning/11-resync-at-any-scale.md`](docs/versioning/11-resync-at-any-scale.md).

**Enabling version control is FalkorDB-only.** Other providers are refused with a clear `422`.

**The integrity fingerprint (Merkle root) is deferred above 1,000,000 entities** rather than built
in memory. The integrity checks still run in full, and the report says when it was deferred.

### Verification

The 7.7M-entity run, end to end:

| | |
|---|---|
| copied | 2,083,216 nodes / 5,009,794 edges — **exact match to source** |
| containment (`HAS`) | 2,083,200 → 2,083,200 |
| lineage (`FLOWS_TO`) | 2,926,594 → 2,926,594 |
| duplicate rows | **0**, across a SIGKILL and three resumes |
| sampled items re-read and hash-compared | 64 / 64 identical |
| peak worker memory | **468 MiB** — sized by the window, not the graph |
| projection | fast-forwarded; the source graph was never dropped or reseeded |
