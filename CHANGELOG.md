# Changelog

Release history for {brand}. Notable changes, newest first. Dates are release dates.

Sections follow [Keep a Changelog](https://keepachangelog.com): **Added**, **Changed**,
**Deprecated**, **Removed**, **Fixed**, **Security**. Anything that requires action on upgrade
is called out under **Upgrading**, and anything we know is still wrong is under **Known
limitations** — a changelog that only lists good news is not worth reading.

---

## [Unreleased] — Invite links that actually work, and can be taken back

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

### Security

Auto sign-in makes the signup endpoint's enumeration-safe response distinguishable for someone
holding a valid invite (the created path sets cookies, the already-exists path does not). This
is an accepted trade, not an oversight: it requires a live invite, every probe is bounded by
that invite's seat cap, and the ledger records who held it. Documented at the call site.

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
[`docs/versioning/11-resync-at-any-scale.md`](https://github.com/rkrumins/dataviz/blob/main/docs/versioning/11-resync-at-any-scale.md).

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
