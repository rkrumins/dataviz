# Changelog

Release history for {brand}. Notable changes, newest first. Dates are release dates.

Sections follow [Keep a Changelog](https://keepachangelog.com): **Added**, **Changed**,
**Deprecated**, **Removed**, **Fixed**, **Security**. Anything that requires action on upgrade
is called out under **Upgrading**, and anything we know is still wrong is under **Known
limitations** — a changelog that only lists good news is not worth reading.

---

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
