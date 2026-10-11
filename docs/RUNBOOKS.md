# Runbooks

*For platform operators.*

One short procedure for each task that comes up while running {brand}: when to use it, the
commands, what you should see, and how to confirm it worked. Pick the task from the index;
each section links to the page with the full background.

> **Before you start:** the scripts below run inside a backend container, which already has
> the database and service settings. On Docker Compose, run them from your checkout with
> `docker compose exec viz-service python -m backend.scripts.<script>`. On Kubernetes, use
> `kubectl -n <namespace> exec -it deploy/viz-service -- python -m backend.scripts.<script>`
> — the kustomize namespace is `synodic`.

## Pick a runbook

| Task | Use it when |
|---|---|
| [Back up and restore](#back-up-and-restore) | Before every upgrade, on a schedule, and after data loss |
| [Upgrade to a new release](#upgrade-to-a-new-release) | A new release is out |
| [Reset an administrator's password](#reset-an-administrators-password) | The only administrator can't sign in |
| [Rotate the signing key](#rotate-the-signing-key) | `JWT_SECRET_KEY` may be exposed, or is due for rotation |
| [Tell the platform a source changed](#tell-the-platform-a-source-changed) | You loaded data straight into the graph store and want it picked up now |
| [Rebuild lineage rollups](#rebuild-lineage-rollups) | Rolled-up lineage is wrong or stale, or a rebuild failed and the cause is fixed |
| [Check what the placement switch would change](#check-what-the-placement-switch-would-change) | Before you turn on **One placement rule for every view surface** |
| [Recover the graph store](#recover-the-graph-store) | FalkorDB lost data, won't start, or a shard or region is gone |
| [Fix slow or timed-out graphs](#fix-slow-or-timed-out-graphs) | Users report slow canvases, `429`s or timeouts |

## Back up and restore

Postgres holds everything the platform can't rebuild: users, workspaces, views, settings, and
the version history of every source under version control. FalkorDB holds the graphs; Redis
holds job queues, caches and session-revocation records.

### On Docker Compose

1. Stop the stack, so the copy is consistent: `./deploy.sh down`.
2. Back up: `./deploy.sh backup <name>`. It writes `backups/<timestamp>-<name>/` with one
   archive per volume — Postgres, FalkorDB and Redis.
3. Start again: `./deploy.sh up`.
4. Copy the directory off the server, and keep `.env` safe and separate — it holds the
   database password and the credential encryption key.

To restore, check out the release the backup was taken with (or a newer one), run
`./deploy.sh restore backups/<timestamp>-<name>` and type `yes`. It stops the stack, replaces
the three volumes and starts the stack again.

**Verify:** `./deploy.sh status` shows the services healthy; sign in and open a few views.
More, including a nightly schedule:
[Back up and restore](/docs/deployment#back-up-and-restore).

### On Kubernetes

- **Postgres** — use your managed service's backups: for the production overlay, Cloud SQL's
  automated backups and point-in-time recovery. The `dev` and `staging` overlays run Postgres
  in the cluster with no backup job; take a dump when you need one:

  ```bash
  kubectl -n synodic exec postgres-0 -- pg_dump -U synodic -Fc synodic > backup-$(date +%Y%m%d).dump
  ```

  Restore it with `pg_restore` into an empty database before the backend starts.
- **FalkorDB** — the production overlay's CronJob streams a snapshot to a multi-region GCS
  bucket every six hours. Recovery is the [FalkorDB DR runbook](/docs/falkordb-dr).
- **Redis** — holds job queues, caches and session-revocation records rather than data you'd
  restore. Give the coordination instance persistence, as `.env.deploy.example` recommends;
  the cache can be recomputed.
- **Secrets** — keep `.env.deploy` (kustomize) or your Secret's values in your secrets store,
  above all `CREDENTIAL_ENCRYPTION_KEY`: without it, restored provider credentials can't be
  read.

**Verify:** for Cloud SQL, the console lists recent backups; for a dump, the file isn't empty.

## Upgrade to a new release

1. Back up first — [Back up and restore](#back-up-and-restore).
2. If the release has an upgrade note, read it first. For example
   [Upgrading for graph availability (2026-09-10)](/docs/upgrade-2026-09-10) lists the
   overrides to remove for that release.
3. Upgrade:
   - **Docker Compose** — `./deploy.sh update`. It pulls, rebuilds every image and restarts;
     the one-shot `upgrade` service migrates the schema before any backend service starts.
   - **Kubernetes** — follow [Upgrade and roll back](/docs/kubernetes#upgrade-and-roll-back):
     with kustomize you run the schema upgrade yourself before applying the new tag; Helm runs
     it as a pre-upgrade hook.
4. Verify on Docker Compose:

   ```bash
   docker compose ps -a upgrade
   docker compose logs upgrade | tail -n 3
   docker compose run --rm upgrade verify-schema
   ```

   `upgrade` shows `Exited (0)`, its log ends with a line containing `Upgrade complete`, and
   `verify-schema` reports `Schema matches the ORM`.

**If it goes wrong:** the backend services don't start until the schema step succeeds. Read
its log, then [Migrations](/docs/migrations) — `current`, `heads`, `repair` and
`verify-schema` run the same way (`docker compose run --rm upgrade <command>`). To go back,
restore the backup with the previous release checked out.

## Reset an administrator's password

Use this when the only administrator is locked out. The app can't help then: resetting a
password from the app needs an administrator who is signed in, the forgot-password flow sends
people to their administrator rather than issuing a reset link, and restarting doesn't
recreate the first administrator once any account exists. Running the script needs access to
the server or cluster, which is the authorisation.

1. Run the script with the account's email address:

   ```bash
   docker compose exec viz-service python -m backend.scripts.reset_admin_password --email <admin-email>
   ```

   On Kubernetes:
   `kubectl -n <namespace> exec -it deploy/viz-service -- python -m backend.scripts.reset_admin_password --email <admin-email>`.
2. Type the new password at `New password:` and again at `Confirm new password:`. Use at
   least 8 characters. The script never takes the password as an argument, so it stays out of
   shell history.
3. Expect `Password set for <admin-email>. Sessions revoked as of <time>.`

**Verify:** sign in with the new password. The script also cleared any forced password change
and signed out every session the account had.

**If it goes wrong:**

| Message | Fix |
|---|---|
| `No account found for '<email>'.` | Check the address — it's matched in lower case |
| `Account '<email>' is deleted.` | Use another administrator account |
| `Note: the account is '<status>', so the new password will not sign in until it is activated.` | Activate the account first |
| `Aborted: the two entries did not match.` or `Aborted: use at least 8 characters.` | Run it again |

## Rotate the signing key

`JWT_SECRET_KEY` signs every session. Rotate it through `JWT_SECRET_KEY_PREVIOUS`, a list of
retired keys that are still accepted for verification, so nobody is signed out.

1. **Docker Compose only:** add `JWT_SECRET_KEY_PREVIOUS: ${JWT_SECRET_KEY_PREVIOUS:-}` to the
   `viz-service` `environment:` block in `docker-compose.yml` — the shipped file doesn't pass
   it to the container.
2. Copy the current `JWT_SECRET_KEY` into `JWT_SECRET_KEY_PREVIOUS`, and set a new
   `JWT_SECRET_KEY` with `openssl rand -hex 48` — in `.env` (Compose), `.env.deploy`
   (kustomize) or your Secret (Helm).
3. Apply it: `./deploy.sh up`, or deploy and restart the pods
   (`kubectl -n <namespace> rollout restart deployment`).
4. **Verify:** `curl -s https://<host>/api/v1/auth/diagnostics` — `acceptedKids` lists two
   fingerprints and `activeKid` is the new one.
5. After `JWT_REFRESH_EXPIRY_DAYS` (7 days by default), empty `JWT_SECRET_KEY_PREVIOUS` and
   apply again.

Background and diagnostics:
[Running several environments side by side](/docs/multi-environment-sessions).

## Tell the platform a source changed

Use this after loading data straight into FalkorDB — an ETL job, a connector, an import
script — when you want caches cleared and rollups rebuilt now. Usually you don't need it: the
platform notices external changes by itself within about two minutes, and the repository's
own loaders send this signal when they finish. Background:
[Telling us an external data source changed](/docs/feature-external-change-notification).

1. Identify the source by its FalkorDB graph name or its data source id.
2. Send the signal:

   ```bash
   docker compose exec viz-service python -m backend.scripts.signal_data_changed --graph <graph-name>
   ```

   Use `--data-source-id <id>` instead of `--graph` if you have the id. On Kubernetes, run it
   with `kubectl exec`, as shown at the top of this page.
3. Expect the control plane's JSON answer: `gate` says `changed` or `unchanged`, `actions`
   lists what ran, and `jobId` names the rebuild it queued, if any.

| Option | Does |
|---|---|
| `--scope auto` (default) | Acts only if the graph's counts changed: invalidates caches and queues a rebuild |
| `--scope read-caches` | Clears the read caches; no rebuild |
| `--scope rollups` | Queues a rollup rebuild, every time |
| `--scope full` | Both |
| `--reason <text>` | Recorded in the audit trail |
| `--force` | With `auto`, acts even when the counts didn't move (a re-parent or property-only change). Don't add it to routine loads — [here's why](/docs/feature-external-change-notification#do-not-use-force) |

**Verify:** **Ingestion → Freshness** shows the source **Recomputing**, then **Up to date**.

**If it goes wrong:** `error: no live data source found for graph '<graph-name>'` means the
name doesn't match a data source; an HTTP `401` from the control plane means the container's
`AGGREGATION_INTERNAL_TOKEN` doesn't match the control plane's.

## Rebuild lineage rollups

Use this when a source's rolled-up lineage looks wrong or stale, after a failed rebuild once
the cause is fixed, or after recovering the graph store.

1. Open **Ingestion → Freshness**.
2. On the source's row, choose its main action — **Rebuild now**, **Retry rebuild** or
   **Build lineage**, depending on its state — or **Rebuild lineage** from the row's menu.
   - For every source of one provider, use **Refresh provider…** and choose **Rebuild lineage**.
   - For every source at once, administrators can use **Refresh all sources**, choose
     **Full refresh**, and confirm with **Run full refresh**.
3. From the command line instead:
   `signal_data_changed --data-source-id <id> --scope rollups`, as in the previous runbook.

**Verify:** the row shows **Recomputing**, then **Up to date**; the run's detail is in Job
History. Guide: [Data Freshness & Ingestion](/guide/data-freshness).

> **Note:** `backend/scripts/rematerialize_all_graphs.py` is a one-time backfill for graphs
> whose rollups were built before rollup cells carried depth stamps — not a routine rebuild.
> It works only against a standalone graph store and calls the control plane without its
> token, so on a deployment with `AGGREGATION_INTERNAL_TOKEN` use it only to list what needs
> work, then rebuild those sources as above:
> `docker compose exec viz-service sh -c 'DATABASE_URL="$MANAGEMENT_DB_URL" python -m backend.scripts.rematerialize_all_graphs --dry-run'`.

## Check what the placement switch would change

Use this before an administrator turns on **One placement rule for every view surface**
(**Administration → Features → Experimental**), a preview that ships off. For every saved view
with layers, the dry run reports which entities would move to another layer, rules that can
never match, explicit entries that name a layer that no longer exists, and views whose
configuration the server refuses today. It's read-only and doesn't read the switch.

1. Run it:

   ```bash
   docker compose exec viz-service python -m backend.scripts.placement_dry_run
   ```

   Narrow it with `--view <view-id>` (repeatable) or `--workspace <workspace-id>`. Add
   `--json <path>` to also write the full report — inside the container.
2. Read the result: a block for each view that would change, then a last line like
   `3 view(s) would change, of 41 with layers.` The counts come from a sample of each view's
   entities, so read them as estimates.

**Next:** review the listed views with their owners, then turn the switch on —
[Feature Switches](/guide/feature-switches). While it's on, creating a view or saving its
layers refuses a new or changed layer rule that can never match. It's safe to turn off again.

## Recover the graph store

Version-controlled sources rebuild from Postgres; every other source is loaded again from its
source, or restored from a snapshot. The [FalkorDB DR runbook](/docs/falkordb-dr) covers
Kubernetes snapshots, clusters and region loss.

**On Docker Compose,** restore just the graph store from a backup:

1. Put only its archive in a directory of its own:

   ```bash
   mkdir backups/graph-store-only
   cp backups/<timestamp>-<name>/synodic_falkordb_data.tgz backups/graph-store-only/
   ```

2. Run `./deploy.sh restore backups/graph-store-only` and type `yes`. It warns that the
   Postgres and Redis archives are missing, skips them, restores the graph store and starts
   the stack.
3. Bring back what changed after the backup. For each version-controlled source, open a view
   of it and use **Rebuild fast read layer** on the **Data health** tab of its versioning
   panel (shown to people who manage the source). Load directly loaded sources again from
   their source systems.

**Verify:** views open with their graphs, and **Ingestion → Freshness** shows the sources
**Up to date**.

## Fix slow or timed-out graphs

Start from what users report, not from a setting:
[Concurrency and Timeout Tuning](/docs/concurrency-tuning) has a troubleshooting guide by
symptom and the order in which to raise each limit. First, read the API's own report:

```bash
curl -s https://<host>/api/v1/health/deps
```

In it, `resilience.breaker` shows whether slow queries are being counted as outages (the
healthy shape under load is `deadline_timeouts_not_counted` rising while `breaker_opens`
stays flat), and `dependencies.event_loop` says whether one process is wedged. For trends,
use the metrics in [Observability](/docs/observability).

## Where to next

- [Observability](/docs/observability) — to be warned before users report a problem.
- [Self-Host Deployment](/docs/deployment) — the Compose commands these runbooks use.
- [Deploying on Kubernetes](/docs/kubernetes) — the cluster equivalents.
- [Migrations](/docs/migrations) — when a schema step fails.
