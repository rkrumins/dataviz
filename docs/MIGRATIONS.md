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
- **The chain ends in one head.**
  - Two pull requests, each green on its own, can each add a revision on the same parent, and once both merge the chain has two heads. #674 and #675 did this, off `20261117_1500_gv_mr_sendback`.
  - Join them with a merge revision that runs nothing: `alembic merge -m "merge …" <head> <head>` from `backend/`, with an id of 32 characters or fewer, like `20261119_1300_merge_member_sets`.
  - `backend/tests/test_alembic_single_head.py` fails a pull request, or a push to `main`, that leaves two heads.
  - The upgrade Job reaches every head regardless (`upgrade` means `heads`, and it warns when there are several), so a missed merge revision shows up as a red check, not a deployment that won't start.

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

## When a database was migrated by a build this one doesn't know

`alembic_version` can name a revision this image doesn't have, and Alembic then stops with *Can't locate revision identified by …*. Two things cause it:
- **A branch's build** was deployed to the same environment, ran its own migrations, and they never reached `main`.
- **A newer release** migrated the database, then the image was rolled back.

**First choice: give `main` the revisions.** When an environment has run a branch's migrations and the branch isn't merging soon, take those migrations into `main` unchanged, with whatever ORM columns and startup steps they need, and join them with a merge revision. Alembic then knows the stamp, and nothing is guessed.
- `20261113_1000_gv_ps_served_fill` … `20261113_1400_gv_ps_candidate` came into `main` this way, from #670.
- `20261119_1400_merge_ps_build` joins them.

**Otherwise `upgrade` rewinds the stamp** to where the two chains most likely parted, and upgrades from there:
- **Where it rewinds to:** walking this image's chain down from its head, the first revision whose id is older than the foreign one. It walks in chain order, not by sorted id, because a revision moved onto a newer parent keeps its older id.
- **What runs after that:**
  - For another branch's database, those are this image's migrations it never ran.
  - For a newer release's, the rewind lands at this image's head, so nothing runs.
  - Only a foreign line whose ids are older than revisions it already contains causes a replay. Its DDL is guarded, as `chain-replay` requires, but its data statements run again: see the rule above.
- **What it leaves:** the other build's tables and columns stay as they were.
- **How it ends:** head is claimed only if `verify-schema`'s comparison finds nothing missing. Otherwise `alembic_version` goes back to what it was and the Job exits 1, naming what's missing.

The guess fails when this image has migrations written while the other branch was open. In that case, name the revision both chains share:

```bash
synodic-upgrade upgrade --rewind-to <revision>
```

This is not the old recovery. `env.py` used to "recover" by stamping back to `0001_baseline`, which left the schema untouched and replayed the whole chain over live data. That was the single most destructive line in the migration path, and it stays gone.

## Commands

```bash
synodic-upgrade upgrade                    # to every head (fast path on a virgin database)
synodic-upgrade upgrade --no-fast-path     # force the chain even on a virgin database
synodic-upgrade upgrade --rewind-to REV    # a database another build moved on: rewind to REV first
synodic-upgrade repair                     # reconcile a pointer that trails the schema
synodic-upgrade verify-schema              # exit 0 iff the schema structurally matches the ORM
synodic-upgrade check --wait 60            # exit 0 iff alembic_version is at head
synodic-upgrade current | heads | history
```

Locally: `docker compose run --rm upgrade <subcommand>`.
