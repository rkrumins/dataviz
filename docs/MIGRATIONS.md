# Migrations

How this database gets built, and the rules a new migration has to follow.

## The thing to know first

`0001_baseline` is not a frozen snapshot. It is `Base.metadata.create_all()` against the **live**
ORM:

```python
# backend/alembic/versions/0001_baseline.py
Base.metadata.create_all(bind=bind)
```

46 of the ORM's tables — `users`, `workspaces`, `views`, `providers` among them — are created
there and by no migration at all. So a database built today from baseline is born holding
*today's* schema, not the schema of April 2026 when baseline was written.

That single fact explains every migration failure this project has had. Replaying the rest of the
chain on top of a baseline that already produced the final schema means re-applying ~70 revisions
of `ALTER`s that are already there, and every one of them has to survive that or the upgrade dies.

## The two install routes

**Fresh install — `upgrade` on a virgin database.** Runs `0001_baseline`, seeds reference data,
stamps head. The chain is not replayed.

```
synodic-upgrade upgrade
  └─ virgin?  ──yes──►  0001_baseline (create_all)  ──►  seed_reference_data  ──►  stamp head
        │
        no
        ▼
     alembic upgrade head
```

"Virgin" means no `users` / `workspaces` / `providers` table and no non-empty `alembic_version`.
The check lives in `backend/scripts/upgrade.py`, deliberately **not** in `alembic/env.py` —
`env.py::_ensure_wide_alembic_version_column` creates `alembic_version` as a side effect of being
imported, so anything asking after env.py loads sees a table env.py just made.

**Existing database — `upgrade` on anything else.** The normal chain, unchanged.

The consequence that matters: **a migration now only ever runs against a database that predates
it.** That is the contract Alembic is built around, and it is what makes the rule below possible.

`create_all` writes tables and not one row, so the RBAC rows that have only ever existed as
`INSERT`s inside migrations are seeded from `backend/app/config/rbac_seed.py` instead. A database
with no permissions and no roles comes up looking perfectly healthy and authorises nobody.

## A fresh install is only as new as the image that ran it

The fast path builds the schema from **the ORM inside the image**, then stamps head. Both halves
come from that image, so they always agree with each other — and neither is checked against the
repository. An out-of-date `upgrade` image therefore installs an out-of-date schema and marks it
fully migrated, silently.

`docker-compose.yml` pins `image: synodic-upgrade:local`, and `docker compose up` used to **reuse
an existing tag rather than rebuild it**. A machine with wiped volumes but stale images is
"brand new" in the only sense that matters to `_is_virgin` — so this is the normal way it happens,
not an exotic one. Helm did the same: the default `latest` tag with `IfNotPresent` keeps a node's
cached copy. So the upgrade image is now always fresh:
- **Compose** rebuilds it on every `up` (`pull_policy: build`, from cached layers).
- **Helm** pulls it on every run (`upgrade.pullPolicy: Always`), for the upgrade Job and for each
  pod's wait-for-schema check.

Both ways of building images build the upgrade image too: `deploy/build-images.sh` and the
`build-images` workflow, which had both left it out. Each image records the commit it was built
from (`SYNODIC_BUILD_*`, and the OCI revision label).

The Job's first line after the lock names that commit and its chain's head
(`This build: <ref> at <sha> (on main); its migration chain ends at […]`), so an old image shows
itself at once. The other images are still only as new as the copy a machine has.

It surfaces as the application failing on schema its own ORM declares —
`column workspaces.identity_property does not exist` — or as 404s from a frontend calling routes
the older backend image does not serve. `check` cannot see it, because it compares the image's
script directory against the pointer that same image wrote. **`verify-schema` is the probe**: it
compares the live database against the ORM and names what is missing.

Recovery is to rebuild and re-run — the database moves forward on the normal chain from whatever
revision it was stamped at:

```bash
docker compose build --no-cache upgrade viz-service frontend
docker compose up -d --force-recreate
docker compose run --rm upgrade upgrade
docker compose run --rm upgrade verify-schema
```

Verified on 2026-08-18: a database installed by an image nine days stale (stamped
`20260802_1000_open_publish`, missing `providers` / `workspaces.identity_property`) took six
revisions to head under a current image and came out `verify-schema`-clean.

Built-in reference data reaches existing databases too. `seed_reference_data` writes the RBAC rows
on the virgin install. After every upgrade, `reconcile_reference_data` adds the permissions, system
roles and grants from `backend/app/config/rbac_seed.py` that the database hasn't had yet, and
records each in `reference_data_applied`, so it is added once:
- **An admin's removal stays.** An admin can remove a grant from a built-in role (Admin →
  Permissions). Once recorded, an entry is never added again, so the removal survives every upgrade.
  Re-running the seeder instead would put it back.
- **The first run on an existing database** can't tell a grant that was never made from one an admin
  removed. It adds a missing grant only when its role or permission is new in that same run, and
  reports the rest. Admin → Permissions → Reset to default restores a role's built-in grants.
- **A built-in role whose name a custom role already has** gets none of its grants, with a warning.

Anything it adds or reports is logged, and recorded in `alembic_history` as `seeded`.

## Writing a migration

**Guard the DDL; never guard the data.** `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`, `if not sa.inspect(bind).has_table(...)` around a `create_table`.
Every `UPDATE`/`INSERT`, and every `alter_column` that fixes a default or nullability, stays
**unconditional**.

This rule replaces an earlier one ("plain forward DDL, no `if_not_exists`"), which was written on
the assumption that the fast path made replay impossible. It does not: the `chain-replay` gate
still runs the whole chain over a `create_all` baseline, and so does any database whose
`alembic_version` trails its schema. Three migrations written under the old rule —
`20260801_1200_publish_flow`, `20260801_1500_notifications`, `20260802_1000_open_publish` — failed
that gate from 2026-08-01 until 2026-08-18, when they were guarded.

The cost the old rule was reacting to is real and the split above is what avoids it: **a guarded
migration silently no-ops against a `create_all` baseline**, so whatever it guards is never
exercised. `invites.token_version` is the example — its migration sets `server_default="1"`, and
on any database where `create_all` had already made the column, the guarded `add_column` did
nothing and the default was never applied. Guard the `ADD COLUMN` and leave the `alter_column`
outside the guard and both routes end up identical, which is what the three fixed migrations were
verified against: a database built at the revision immediately before them ends up with exactly
the columns, indexes, nullability and defaults the unguarded versions produced.

Two rules that are not optional:

- **The ORM and the migration must agree.** If you add a column to a model, add a migration for it
  too. A column that exists only in the ORM reaches databases through `create_all` alone, so it is
  present on installs newer than the change and missing everywhere else — with both reporting
  themselves at head. `context_models.visibility` lived like that until
  `20260731_1200_ctxmodel_vis`. CI fails on this now.
- **Revision ids are ≤32 chars.** `alembic_version.version_num` is `VARCHAR(32)` by default.
  A longer id fails alembic's own post-migration `UPDATE` and rolls the whole chain back.
  `backend/tests/test_alembic_revision_lengths.py` enforces it.
- **The chain ends in one head.**
  - Two pull requests, each green on its own, can each add a revision on the same parent, and once both merge the chain has two heads. #674 and #675 did this, off `20261117_1500_gv_mr_sendback`.
  - Join them with a merge revision that runs nothing: `alembic merge -m "merge …" <head> <head>` from `backend/`, with an id of 32 characters or fewer, like `20261119_1300_merge_member_sets`.
  - `backend/tests/test_alembic_single_head.py` fails a pull request, or a push to `main`, that leaves two heads.
  - The upgrade Job reaches every head regardless (`upgrade` means `heads`, and it warns when there are several), so a missed merge revision shows up as a red check, not a deployment that won't start.
  - Commit the merge revision. One made by hand in an environment, and never committed, leaves that database stamped with a revision no build has. Dev's `20261119_1200_merge_members_set` came about that way.
- **A revision keeps its parents once it is pushed.** A database stamped at a revision is taken to have run everything below it. So moving a revision onto new parents, after a branch's build may have run it, has the Job skip whatever the new parents bring.
  - To put a branch's line on `main`'s newer head, join the two with a merge revision.
  - If a revision really must move, give it a new id. The old id stays in the lineage record, where the Job finds it (see below).
  - #556's `20260815_1200_announce_poll_60s` was pushed with seven different parents.
- **A revision `main` has stays, with its parents.** Dropping one strands every database stamped there.

`.github/workflows/alembic-guards.yml`'s `merge-chain` job (`backend/scripts/check_migration_chain.py`) fails a pull request, or a push to `main`, that breaks either of the last two rules.

Writing for a live database at scale:
- **Keep the old code working.** The Job runs before the new pods replace the old ones, so a
  migration has to leave a schema the running release can use: add first, and drop only in a later
  release, once nothing reads what goes.
- **Bound the wait for a lock.** A migration waiting for a table's lock queues every query behind it.
  The Job sets `lock_timeout` to 10s (`MIGRATION_LOCK_TIMEOUT`), and a migration that needs another
  bound sets its own, as `20261118_1100_review_rules` does with `SET LOCAL lock_timeout = '5s'`.
  One that gives up rolls back, and the Job tries again (below).
- **Build an index on a large table `CONCURRENTLY`**, outside the migration's transaction
  (`with op.get_context().autocommit_block():`), so writes to it don't stop while it builds.
- **Backfill large tables in batches**, or in a job of its own, not in one `UPDATE`.

`forward-migrate` runs squawk over the SQL a pull request's migrations ran, which flags most of
these. It reports and doesn't fail yet; see below.

## What CI checks

`.github/workflows/schema.yml`, one job per way a database comes into existence, and one for the
upgrade Job itself:

| Job | What it does | What it catches |
|---|---|---|
| `fresh-install` | Virgin fast path on an empty Postgres | A new deployment that cannot be built, or comes up with no reference data |
| `forward-migrate` | Builds a database at the base branch's head, then applies this PR. Every step is required. Then lints the SQL the PR's migrations ran with squawk (report-only for now) | A migration that is broken against a database that predates it. **The real gate** |
| `chain-replay` | `upgrade --no-fast-path` from empty | A migration that cannot tolerate the state `create_all` left behind — the legacy route live databases are still on |
| `upgrade-paths` | `tests/test_upgrade_foreign_stamps.py` against Postgres | The Job placing, refusing or recovering a database another build stamped wrongly; a stopped Job's placement left unchecked; lock retries; checksums; a branch's build migrating a shared database |

Guards' `merge-chain` job (`.github/workflows/alembic-guards.yml`) fails a merge that drops or
re-parents a revision, and warns when it changes the file of a migration `main` has.

The first three then run `verify-schema`, which fails when the ORM declares a table or column the
database lacks, and warns on the known `server_default` differences catalogued in
`docs/TECHNICAL_DEBT.md` §3.1.

`forward-migrate` is the one worth understanding. A green "upgrade head on an empty database"
proves the chain does not crash — not that any migration in it does anything, because on a
`create_all` baseline most of them no-op. Building the database the way the *base branch* builds
it and then moving it forward is what production actually does.

## When a database and its version pointer disagree

`synodic-upgrade repair`.

A pointer can end up behind its own schema — a partially-recorded run, a restore, a hand-edited
`alembic_version`, an image whose script directory lacked revisions the database had already
applied. `upgrade` then replays migrations whose work is done and dies on `DuplicateColumn`, and
because every service gates on the upgrade Job completing, the deployment stays down.

`repair` compares the live schema against the ORM. If nothing is missing it stamps head, logging
every revision it marks applied. If anything is genuinely absent it refuses and names it, because
the right answer then is `upgrade`.

```
synodic-upgrade repair
  ├─ already at head                  ──►  no-op
  ├─ schema satisfies the ORM         ──►  stamp head, log what was skipped
  └─ something is actually missing    ──►  refuse, name it, exit 1
```

## When a database was migrated by a build this one doesn't know

`alembic_version` can name a revision this image doesn't have, and Alembic then stops with *Can't locate revision identified by …*. Two things cause it:
- **A branch's build** was deployed to the same environment, ran its own migrations, and they never reached `main`.
- **A newer release** migrated the database, then the image was rolled back.

**`upgrade` places such a database exactly, from its lineage.** Two sources say what a foreign stamp's parents were:
- **The database itself.** Every build that migrates or stamps a database writes its whole chain into `alembic_lineage`: each revision, with its parents (`backend/app/db/migration_records.py`, called from `env.py`). So a database migrated by any build from now on, a branch's or one with a merge revision made by hand, says what its stamp's parents were.
- **The lineage record**, for databases stamped before that. `backend/alembic/other_lines.json` lists every revision any branch, or any pull request's head, had by 2026-11-18 that `main`'s chain doesn't, with every set of parents it was given there. It also holds, by hand, dev's `20261119_1200_merge_members_set`, a merge made in the environment that no commit has, with both sets of parents it can have had.

For each foreign stamp, the Job does the following:
- **It walks the lineage down to this chain.** The database's own rows come first. Otherwise, where a branch's tip still has the revision, it takes the parents the tip has, and failing that, what every recorded version shares.
- **It stamps the last of `main`'s revisions the database ran.** Then `upgrade heads` runs exactly the ones it lacks, in chain order, and none of the other line's.
- **It leaves the other build's tables and columns as they were,** for when its migrations arrive with it.

**A stamp nothing records is refused.** The Job changes nothing, exits 1, and says how to go on:
- **Name the place:** `upgrade --rewind-to <revision>`, the last revision of this build's the database ran.
- **Or let the Job estimate it:** `upgrade --recover`, or `SYNODIC_UPGRADE_RECOVER=true` (Helm: `upgrade.recoverForeignStamps`). For dev and local databases, never production. Each deployment keeps it off by default and has a dev preset that turns it on:
  - **Helm:** add `-f deploy/helm/dataviz/values-dev.yaml`.
  - **Kustomize:** the `dev` overlay sets it in `common-config`, which the schema-upgrade Job reads ([Deploying on Kubernetes](/docs/kubernetes)).
  - **Compose:** on, for a developer's own database moved between branches.

  Guards (`tests/test_upgrade_presets.py`) fails if production's defaults turn it on, or a dev preset loses it.

With `--recover`, the estimate is a guess:
- **Where it lands:** walking this image's chain down from its head, the first revision whose id is from an earlier minute. An id leads with when it was written, `YYYYMMDD_HHMM`. One from the same minute may be newer or older, so it counts as not run.
- **Why chain order:** a revision moved onto a newer parent keeps its older id, so sorting by id would misplace it.
- **What runs again:** any of this image's revisions the database had already run. Their DDL is guarded, as `chain-replay` requires, but their data statements run again (see the rule above).
- **A newer release's stamp** lands at this image's head, so nothing runs.

**Either way, head is claimed only once the schema bears it out.** If `verify-schema`'s comparison still finds something missing, the database never ran some migration it was taken to have run. Without `--recover`, `alembic_version` goes back to what it was and the Job exits 1, naming what's missing. With it, the Job corrects itself, once:
- **It finds those migrations.** Among the revisions the placement took as run, they are the ones whose file names the missing table, or the missing table and column.
- **It places the database below them** and upgrades again. They run, and so does what follows them: each is safe to run twice.
- **If the schema is still short, or nothing of ours names what's missing,** `alembic_version` goes back to what it was and the Job exits 1, naming what's missing. For example, a column only `create_all` makes. Then name the revision both chains share:

```bash
synodic-upgrade upgrade --rewind-to <revision>
```

`repair` (when the schema is already whole) and `current` work on a foreign stamp too. A bare `alembic` command can't: `env.py` refuses, and points to `synodic-upgrade upgrade`.

**The record is frozen.** Databases migrated from now on carry their own lineage, and only builds from `main` migrate a shared database (below), so no new foreign stamps should need it. Regenerate it only to place a database an older build of a branch stamped, and keep any entry made `by_hand`; the generator keeps them:

```bash
git fetch --prune origin '+refs/heads/*:refs/remotes/origin/*' '+refs/pull/*/head:refs/remotes/pull/*'
python -m backend.scripts.other_lines
```

**Or give `main` the revisions.** When an environment has run a branch's migrations and the branch isn't merging soon, its migrations can come into `main` unchanged, with whatever ORM columns and startup steps they need, joined by a merge revision.
- `20261113_1000_gv_ps_served_fill` … `20261113_1400_gv_ps_candidate` came into `main` this way, from #670.
- `20261119_1400_merge_ps_build` joins them.

## Seeing what an upgrade would do first

`synodic-upgrade plan` reads the database and changes nothing: no lock, no writes. It reports what `upgrade` would do, because the decision is the Job's own (`backend/app/db/schema_plan.py`):
- **The verdict:** refused (and why), a fresh install, up to date, or an upgrade.
- **Placement:** for a database another build stamped, where it would be placed, and how.
- **The migrations** an upgrade would run, in the order it would run them.
- **What to know first:** a migration changed since it ran, a placement left unchecked, an unrecorded build on a shared database.

It takes the same `--recover`, `--shared-database` and `--rewind-to` as `upgrade`, reads the same variables, and exits 1 when the upgrade would refuse. `--json` prints the plan for a script or a pipeline.

Super-admins see the same from the app: **Admin → Infrastructure → Database schema**, read live from the database (`GET /api/v1/admin/system/schema`). It shows:
- the applied revisions, against this server's head;
- the build the server was made from;
- what an upgrade with this build would do;
- warnings, and built-in grants the database doesn't have;
- the recent `alembic_history`: what ran or was stamped, placed and checked, changed, or seeded.

## A backup before every migration

`synodic-upgrade backup --dir DIR` dumps the database (`pg_dump`, custom format) before an upgrade changes it:
- **Only when there's something to change:** only when `plan` says the upgrade would run something. `--force` dumps anyway.
- **Never half-written:** the dump is written beside its final name, and moved there once `pg_restore` reads it back.
- **Old dumps go:** it keeps the newest `--keep` (5).
- **A bucket copy:** with `--bucket`, it also copies the dump to an S3-compatible bucket.
- **Failure stops the upgrade:** a failed dump exits 1, so a pre-upgrade hook stops the upgrade instead of migrating without one.

The Helm chart runs it as a hook before the schema Job ([Deploying on Kubernetes](/docs/kubernetes)). Restoring the dump (`pg_restore --clean --if-exists`) is the rollback for a bad migration.

## Only builds from main migrate a shared database

A branch's build that migrates a database others use stamps it with revisions `main` may never have. That is how every foreign stamp above came about. So the Job holds a shared database to `main`:
- **Shared** is `--shared-database`, or `SYNODIC_SHARED_DATABASE=true`. The Helm chart passes it unless `upgrade.sharedDatabase` is false; Compose doesn't.
- **A build recorded as not from `main`** is refused there unless the database is already at its head, so there's nothing to run. `deploy/build-images.sh` and the `build-images` workflow record whether the commit is on `main`, with nothing uncommitted under `backend/`.
- **A build that records nothing**, every image built before builds recorded it, is let through with a warning, so deployments that work keep working. Build with the script or the workflow to be held to `main`.
- **A branch that needs a database** gets one of its own: Helm with `upgrade.sharedDatabase=false` against its own database, or Compose.

## How the Job keeps a live database safe

- **It waits for the database,** up to two minutes, while Postgres starts, fails over, or a proxy sidecar comes up.
- **One Job at a time,** under a Postgres advisory lock.
- **Each migration is a transaction of its own.** One that fails rolls back alone; those before it stand, and the next run carries on from there.
- **A migration that gives up waiting for a lock is tried again,** up to six times, 5s to 60s apart: the traffic it would have held up gets through in between.
- **No statement timeout by default** (`MIGRATION_STATEMENT_TIMEOUT`): a long backfill on a large table is legitimate, and a timeout would fail it on every retry.
- **A history of what ran.** `alembic_history` records each migration as it runs, in its own transaction: the revision, a SHA-256 of its file, when, and which build. The Job warns, once, when a migration's file has changed since it ran on that database: the change never reaches it.
- **A placement is checked even if the Job stops.** Each time the Job places a database another build stamped, it records the placement with the stamps, in one transaction. One stopped before the schema is checked (evicted, out of memory, a node drained) leaves it open, and the next run checks it, putting the stamps back if the schema doesn't bear it out.
- **Settings that survive mixed versions.** The chart passes the Job's settings as environment variables, which an image older than the chart ignores, and its templates default them, since `helm upgrade --reuse-values` leaves keys a newer chart adds empty.

This is not the old recovery. `env.py` used to "recover" by stamping back to `0001_baseline`, which left the schema untouched and replayed the whole chain over live data. That was the single most destructive line in the migration path, and it stays gone.

**A revision renamed after an image shipped it is translated, not refused.** `_RENAMED_REVISIONS`
in `env.py` maps a retired id, such as one shortened to fit `VARCHAR(32)`, to the new id of the
same migration, before the check above; `test_alembic_upgrade_resilience.py` checks every entry
against the chain. A stamp this chain never had is placed from the lineage record instead (above):
`20261112_1700_gv_ps_served`, which an image of 12 November stamped before
`20261112_1700_gv_ps_pressure` was put ahead of the served migration (now
`20261112_1800_gv_ps_served`), is placed at `20261112_1600_import_settings`, the parent both share,
so the pressure column is added and the served one is found in place. Don't rename or renumber a
migration once an image has been built from it.

## Moving the versioned-graph settings into one store

Two revisions, `20261116_1000_setting_values` and `20261116_1100_settings_import`, move every
versioned-graph setting into one store in the management database, where the platform, a workspace
and a graph each keep their own values ([Versioned Graph Settings](/guide/versioned-graph-settings)
explains the settings). Neither alters a table the running release reads.

**`20261116_1000_setting_values` creates the store:**

- `setting_values`: one row per value chosen, keyed `(domain, key, scope, scope_id)`, where
  `scope_id` is `''` for the platform, a workspace's id, or a data source's id for its graph.
  `value` NULL means nothing is chosen there, so the level above decides. `limits`, on platform
  rows only, bound what workspace admins may choose. `version` is the value's own, for optimistic
  concurrency, and `rev` takes the next number of `setting_values_rev_seq` on every write, so each
  process reloads only what changed.
- `setting_changes`: each value's before and after, under the change set of its save, with who,
  why and how (`api`, `legacy_api`, `migration` or `revert`).
- `settings_imports`: the one-time imports that have run.

It adds tables, two sequences and five indexes, each guarded, so it can run again and does nothing
on a `create_all` baseline. It waits at most five seconds for a lock, as the revisions before it.
The downgrade drops all of it.

**`20261116_1100_settings_import` copies in every value saved before the store:** New-version
builds' JSON (`platform_settings.gv_build_policy`), the residency policy's `gv_*` columns and
`gv_draft_retention_days`; each workspace's drafts and reviews policy; each data source's drafts
and reviews policy and import settings; and each graph's own read mode, and its residency class
where it differs from the platform's.

- **Locks.** It reads the old storage and writes only the new tables. It takes the store's writers'
  lock (an advisory lock on `settings:versioned-graphs`), so no save from a process already on the
  new image lands in the middle of it, and, like the revisions before it, waits at most five
  seconds for a lock.
- **Idempotent.** Each value goes in with `ON CONFLICT DO NOTHING`: one already in the store is
  left as it is, and its marker, `legacy`, is written once. Each value it copies is recorded in
  `setting_changes` as a `migration` change, keeping who saved it and when where the old storage
  says. Forks are skipped: a fork has no values of its own.
- **What the old values meant is frozen in the revision**, not read from the registry: NULL, `""`
  and `"inherit"` copy nothing; an old `0` for the largest graph copied is `unlimited`, and for draft
  retention `forever`.
- **A graph database of its own.** When `GRAPHVER_DB_URL` names a database other than the
  management one, the revision can't read the graphs' values, and marks them pending. The versioning
  worker copies them at start-up, once, under the marker `legacy_graph`; several workers starting at
  once copy them once between them. Until then, each process reads a graph's own read mode from
  `projection_state.read_mode`, and each graph keeps the residency class its row holds.
- The downgrade forgets the markers; the values stay, as the store's.

**Rolling back.** For one release, every save through the store writes the old storage too:
New-version builds' JSON, the `platform_settings` columns, a workspace's and a data source's
columns (a data source's forks' as well), and a graph's `projection_state.read_mode`. Each graph's
residency class in force stays on `projection_state.residency`. So the previous image, rolled back
to, runs as configured, except for what the old storage has no place for:

- every value set for a workspace, but its drafts and reviews policy: its read mode, residency
  class, draft windows, fork limit, trash window and import settings;
- the platform's values of the settings that had none before: how far behind a copy may serve, how
  long idle drafts stay open, forks per graph, the trash window, the drafts and reviews policy, and
  the import settings, which go back to their environment variables or built-in defaults;
- a graph's own value of how far behind its copy may serve, its fork limit, its replace guard and
  the refused rows it allows;
- the platform's limits (the old image doesn't show the history of changes either);
- inheritance: a graph keeps the residency class in force on its row, as its own.

Back on the new image, take into the store what was changed through the old endpoints meanwhile;
the import won't, as it has run, and it leaves a value already in the store as it is:

```bash
python -m backend.app.services.settings legacy-diff           # each value the two disagree on, as JSON
python -m backend.app.services.settings legacy-diff --adopt   # save the old storage's values into the store
```

`--adopt` saves them all or none, recorded as `legacy_api` changes; if the store moved while it
read, it saves nothing, and running it again compares afresh. The graphs' own values are compared
when the graph store can be read. A following release drops the old columns and the old
endpoints.

## Commands

```bash
synodic-upgrade plan                       # what `upgrade` would do now, changing nothing (--json; exit 1 if it would refuse)
synodic-upgrade backup --dir DIR           # pg_dump first, when an upgrade would change something (--force: always)
synodic-upgrade upgrade                    # to every head (fast path on a virgin database)
synodic-upgrade upgrade --no-fast-path     # force the chain even on a virgin database
synodic-upgrade upgrade --rewind-to REV    # a database another build moved on: place it at REV first
synodic-upgrade upgrade --recover          # dev: estimate where such a database stands, checked against its schema
synodic-upgrade upgrade --shared-database  # migrate only from a build of a commit on main
synodic-upgrade repair                     # reconcile a pointer that trails the schema
synodic-upgrade verify-schema              # exit 0 iff the schema structurally matches the ORM
synodic-upgrade check --wait 60            # exit 0 iff alembic_version is at head
synodic-upgrade current | heads | history
```

Locally: `docker compose run --rm upgrade <subcommand>`.
