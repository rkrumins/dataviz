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

`docker-compose.yml` pins `image: synodic-upgrade:local`, and `docker compose up` **reuses an
existing tag rather than rebuilding it**. A machine with wiped volumes but stale images is
"brand new" in the only sense that matters to `_is_virgin` — so this is the normal way it happens,
not an exotic one.

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

One thing re-running does **not** restore: `seed_reference_data` runs only on the virgin install,
and nothing re-seeds afterwards. Permissions, system roles and grants added to
`backend/app/config/rbac_seed.py` after a database was created never reach it, and no migration
inserts them either. The function is idempotent (`ON CONFLICT DO NOTHING`) and reports rows
actually written, so it is safe to call on every upgrade — it simply is not called today.

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

## What CI checks

`.github/workflows/schema.yml`, three jobs, one per way a database comes into existence:

| Job | What it does | What it catches |
|---|---|---|
| `fresh-install` | Virgin fast path on an empty Postgres | A new deployment that cannot be built, or comes up with no reference data |
| `forward-migrate` | Builds a database at the base branch's head, then applies this PR | A migration that is broken against a database that predates it. **The real gate** |
| `chain-replay` | `upgrade --no-fast-path` from empty | A migration that cannot tolerate the state `create_all` left behind — the legacy route live databases are still on |

All three then run `verify-schema`, which fails when the ORM declares a table or column the
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

**A revision id `alembic_version` records but this image does not have is a hard failure.** It
means the database was migrated by newer code, or a branch this image was not built from — deploy
the image that owns that revision. `env.py` used to "recover" by stamping back to `0001_baseline`,
which left the schema untouched and replayed the whole chain over live data. That was the single
most destructive line in the migration path.

**A revision that was renamed or renumbered after an image shipped it is translated, not
refused.** `_RENAMED_REVISIONS` in `env.py` maps each retired id to the revision such a database
resumes from, before the check above:
- A pure rename (an id shortened to fit `VARCHAR(32)`) maps to the new id of the same migration.
- A renumbering that put another migration before it maps to the last revision the old database
  really holds: their shared parent, never the renamed migration. Otherwise the inserted migration
  is marked applied without having run. `20261112_1700_gv_ps_served` became
  `20261112_1800_gv_ps_served` when `20261112_1700_gv_ps_pressure` went before it, so it maps to
  `20261112_1600_import_settings`. Both migrations are guarded and re-runnable, so the pressure
  column is added and the served one is found in place.
- Don't rename or renumber a migration once an image has been built from it. When it can't be
  helped, add the old id to the map; `test_alembic_upgrade_resilience.py` checks every entry
  against the chain.

## While the running release holds a lock

The upgrade Job runs before the new release rolls out, while the old one still serves. A
migration that alters a table the release reads (`projection_state`, `platform_settings`) sets
`lock_timeout = '5s'`. Waiting longer would queue every read of the table behind its `ALTER`, but
a publish or an import window can hold the table longer than that. Each migration commits on its
own, so `upgrade` runs the one that gave up again, after a growing pause (5 s, 10 s, 20 s, then
every 30 s), for up to `--lock-retry-secs` (180). Each time it logs the transactions open longer
than the wait. If it still gives up, the log names them: let them finish, or stop them, and run it
again. Give the Job longer with `--lock-retry-secs`, and keep Helm's `--timeout` above it.

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
synodic-upgrade upgrade                    # to head (fast path on a virgin database)
synodic-upgrade upgrade --no-fast-path     # force the chain even on a virgin database
synodic-upgrade upgrade --lock-retry-secs 600  # wait longer for the running release's locks
synodic-upgrade repair                     # reconcile a pointer that trails the schema
synodic-upgrade verify-schema              # exit 0 iff the schema structurally matches the ORM
synodic-upgrade check --wait 60            # exit 0 iff alembic_version is at head
synodic-upgrade current | heads | history
```

Locally: `docker compose run --rm upgrade <subcommand>`.
