# production-cluster — FalkorDB Redis Cluster overlay

Implements `docs/INFRASTRUCTURE_LAUNCH_SCALE.md` §7: replaces the single-replica
FalkorDB StatefulSet with **3 shards × (1 master + 2 replicas) = 9 pods** on the
dedicated node pool. Everything else is inherited from `overlays/production`,
which remains deployable unchanged — this overlay is the opt-in cutover.

**Roles.** In each shard, ordinal `-2` is the **read replica**: the node the app
prefers for replica reads (`FALKORDB_REPLICA_READ_HOSTS`). The other replica is
a **no-read hot standby**. FalkorDB applies a replicated write under the graph's
write lock on the Redis main thread, so one write arriving during a long read
of the same graph freezes the whole node (measured at ~14 s). A replica that
serves no reads never waits on that lock, so it stays in step with its master,
and Redis Cluster ranks automatic-failover candidates by offset, so it is the
one that wins. Masters take no share of the read rotation
(`FALKORDB_MASTER_READ_SHARE "0"`). On a master, a write queued behind a long
read freezes it the same way, and it was measured at 17.8 s, longer than the
15 s `cluster-node-timeout`. **But `-2` is a shard's only read target, so
whenever it is unusable every read of that shard goes to its master:** while
`-2` is master, down, loading, syncing or more than 8 MiB behind, and for 30 s
after a single read on it fails or misses its deadline (each app process then
benches it). Reads that must see a write (the settle window, the pipeline's
master-consistency reads) always go to the master. Roles move
with failovers. Ordinals are only names, so **read roles from `CLUSTER NODES`,
never from the pod name.** The reasoning and the evidence are in
`docs/RELEASE_NOTES_2026-10-01_falkordb-cluster-stability.md`.

```
kubectl kustomize deploy/k8s/overlays/production-cluster   # render
make build-falkordb-cluster push-falkordb-cluster          # once per registry, before the first apply
make apply OVERLAY=production-cluster                      # deploy (same envsubst flow)
```

`make deploy` builds and pushes only the per-commit tags, never the pinned shard
image (`falkordb:v4.20.6-1`). In a registry that does not have it yet, all nine
shard pods and the init Job sit in `ImagePullBackOff`.

**Applying never restarts a shard pod.** Two things make that true:

* The shard image is pinned (`newTag: v4.20.6-1` in `kustomization.yaml`, a tag
  none of the Makefile's seds rewrite). An app deploy therefore never changes
  the shard template.
* The StatefulSets use `updateStrategy: OnDelete`. A template change you make
  on purpose reaches a pod only when you delete that pod, which you do role by
  role (see [Rolling a change onto the shards](#rolling-a-change-onto-the-shards)).

Before the pin, `make apply` rewrote `:prod-latest` to the git sha, so every
app deploy produced a new StatefulSet revision and replaced every shard pod.
Each replacement showed up as a fresh pod with `restartCount 0`, followed by an
hour-long reload. To change the FalkorDB image deliberately:

1. Bump `newTag` here and `FALKORDB_CLUSTER_TAG` in `deploy/k8s/Makefile`
   together.
2. Run `make build-falkordb-cluster push-falkordb-cluster`.
3. Run `kubectl -n synodic delete job falkordb-cluster-init`. The init Job uses
   the same image, and a completed Job's template is immutable, so the apply
   fails on it otherwise.
4. Apply.
5. Roll the shards.

**Moving a live cluster from a revision older than 2026-10-01 is a one-time
procedure.** Follow `docs/RELEASE_NOTES_2026-10-01_falkordb-cluster-stability.md`
§8, not a plain `make apply`.

## Prerequisites

1. **Node pool** (doc §3) — must exist before deploying or all 9 pods sit Pending:

   ```
   gcloud container node-pools create falkordb-pool \
     --cluster <CLUSTER> --region us-central1 \
     --machine-type n4-highmem-8 --num-nodes 3 \
     --node-taints dedicated=falkordb:NoSchedule \
     --node-labels dedicated=falkordb
   ```

   (3 per zone × 3 zones = 9 nodes; n4 requires Hyperdisk — the PVCs use
   `hyperdisk-balanced`. An existing 6-node pool grows with
   `gcloud container clusters resize <CLUSTER> --node-pool falkordb-pool
   --num-nodes 3 --region us-central1`.)

   **Boot disk.** The data directory is on the PVC (`FALKORDB_DATA_PATH=/data`).
   The node's boot disk holds the image and the container logs. It does not hold
   the dataset, so the pool's default boot disk is enough.
   * Before this change the image default put the RDB, the AOF and every
     full-sync temp file on the container's writable layer, which lives on
     the boot disk. A pod there could be evicted for `ephemeral-storage`, and
     it came back empty.
   * The shard pods now request 2Gi of `ephemeral-storage` with an 8Gi limit.
     That ranks them last under DiskPressure.
   * If the dataset ever lands on the layer again, the limit evicts the pod,
     and the eviction message names `ephemeral-storage`.

   **The node count is not a recommendation, it is the pod count.** The
   anti-affinity is `requiredDuringScheduling` and spans every shard
   (`app.kubernetes.io/part-of: falkordb-cluster`, `topologyKey:
   kubernetes.io/hostname`), and the pods request ≈ their limits, so one pod
   owns one node and there is no sharing to fall back on. `--num-nodes` is
   per zone: **`--num-nodes N` gives 3N nodes, and the cluster needs one per
   pod.** Short by one and that pod sits `Pending` for ever — no eviction, no
   warning, just a shard permanently short of a replica.

   What the third pod per shard buys is **a replica nobody reads from**:
   * A hot standby, in step with its master, that wins the failover (see
     *Roles* above).
   * A shard that survives losing its master AND one replica.

   It does not make writes safer: one in-sync replica is already enough for
   that (see `FALKORDB_DEPLOYMENT.md` §5a, "If you do set it, set it to 1"). It
   does not add read capacity either, because one replica per shard serves
   reads.

2. **Managed cache** — `CACHE_REDIS_URL` must point at Memorystore (the
   production `managed-data-tier` patch). Cluster mode cannot host the provider
   cache (ADR-020, doc §7.3).

3. **Provider rows declare their own topology.** Every FalkorDB consumer (read
   path, versioning registry, projector, workers, `GRAPH.LIST`) resolves the
   connection from the instance's own config through one shared topology-aware
   client, so a standalone, a Sentinel and a Cluster instance can coexist. For
   graphs pinned to a provider, set on the provider row:

   ```json
   "falkordbConnection": {
     "mode": "cluster",
     "cluster": {"startupNodes": [
       ["falkordb-shard-0-0.falkordb-cluster.synodic.svc.cluster.local", 6379],
       ["falkordb-shard-1-0.falkordb-cluster.synodic.svc.cluster.local", 6379],
       ["falkordb-shard-2-0.falkordb-cluster.synodic.svc.cluster.local", 6379]
     ]}
   }
   ```

   Keep `row.host` pointing at a seed node (it is still used for host
   resolution + preflight fallback). Unrouted (env-default) graphs need no row:
   they follow `FALKORDB_MODE=cluster` + `FALKORDB_CLUSTER_NODES` from
   `common-config`, which this overlay sets.

4. **Eviction budgets** (doc §7.3): set `GRAPHVER_FALKOR_BUDGETS` /
   `GRAPHVER_FALKOR_MAX_RESIDENT` ≈ 0.8 × shard `maxmemory` (28gb → ~22gb) per
   provider so cold-graph eviction keeps residency inside the ceiling. The
   4 GiB replication backlog counts against `maxmemory` once it has filled.

5. **A GKE maintenance window or exclusion** for the FalkorDB pool.
   * Node upgrades and auto-repair drain the shard pods one at a time under
     the PDB.
   * A replica in a full sync is NotReady (readiness requires
     `master_link_status:up`). While it is NotReady it holds the PDB at
     `disruptionsAllowed: 0` for the whole cluster.
   * GKE reportedly forces a drain that has waited about an hour. That figure
     was not verified against GKE's documentation.
   * Keep upgrades out of the hours you roll shards in:
     `gcloud container clusters update <CLUSTER> --region <REGION>
     --add-maintenance-exclusion-name … --add-maintenance-exclusion-start …
     --add-maintenance-exclusion-end … --add-maintenance-exclusion-scope
     no_minor_or_node_upgrades`.
   * An exclusion does not stop auto-repair.

## What deploying does

1. Creates the headless `falkordb-cluster` Service (stable per-pod DNS — pods
   announce these names via `cluster-announce-hostname`, so a rotated pod
   rejoins under the same address).
2. Creates the `falkordb-shard-0/1/2` StatefulSets: `replicas: 3`,
   `podManagementPolicy: Parallel`, `updateStrategy: OnDelete`, and the pinned
   image. Also the PDB with `maxUnavailable: 1` across all nine pods, the
   `falkordb-cluster` PriorityClass, and the `falkordb-cluster` NetworkPolicy.
   The policy is inert until NetworkPolicy enforcement is on, and only ever
   adds access, because the base `default-deny-ingress` already selects every
   pod. Each shard pod:
   * keeps its data on the PVC (`FALKORDB_DATA_PATH=/data`);
   * persists by RDB with `--appendonly no` and `--shutdown-on-sigterm save`,
     so a restart resumes by partial resync;
   * holds 45s at start if its `nodes.conf` says it was a master owning
     slots, so a crashed master cannot rejoin before its replica is promoted;
   * in `preStop`, hands a master's slots with `CLUSTER FAILOVER` to the
     shard's online standby, and to `-2` only when no standby is online;
   * is Ready only once its replication link is up (a master is Ready on
     PONG).
3. Runs the idempotent `falkordb-cluster-init` Job: 3-master create, then each
   shard's `-1` and `-2` pods attached as replicas of its own `-0` pod.
4. Deletes the single-node `falkordb` StatefulSet/Service and flips
   `FALKORDB_MODE=cluster` + seed nodes in `common-config`, along with
   `FALKORDB_REPLICA_READ_HOSTS` and `FALKORDB_MASTER_READ_SHARE` (see
   [Knobs](#knobs)).

Cutover does NOT migrate data — FalkorDB is a disposable projection (doc §7.4);
reseed graphs from Cloud SQL after the cluster is green.

## Rolling a change onto the shards

`OnDelete` means a template change waits until you delete each pod. Roll one
pod at a time across the whole cluster, shard by shard, smallest shard first.
Within a shard the order is: the read replica, then the standby, then a
hand-over, then the old master.

1. **Read the roles from the cluster:**

   ```
   kubectl -n synodic exec falkordb-shard-0-0 -- redis-cli cluster nodes |
     awk '{split($2,a,","); split(a[2],h,"."); print h[1], $1, $3, $4}' | sort
   ```

   This prints the pod, its node id, its flags and the master it follows.
2. **Gate every delete on all of the following:**
   * `cluster_state:ok`.
   * The pod's `redis-cli role` is `slave`. **Never delete a pod while it is
     master.**
   * The master shows the shard's other replica as `state=online` and caught
     up: its `master_repl_offset` minus that replica's `offset` is small.
   * No rebuild is running.
3. **Delete the read replica, wait, then delete the standby, and wait again.**
   After each delete the pod is ready when all of these hold:
   * It is Ready (its link is up).
   * `redis-cli config get dir` returns `/data`.
   * The master has not logged a second `Full resync requested by replica` for
     it, and its `sync_full` has not risen again. Either means a resync loop has
     started: stop and pause writes. `master_current_sync_attempts` at 2 or
     more is not enough on its own: it also counts reconnects to a master that
     was briefly unreachable.
4. **Hand the master over:** run `redis-cli cluster failover` on the standby
   you just rolled. Confirm that it now says `master` and the old master says
   `slave`, then delete the old master. It is a replica now, so its `preStop`
   does nothing and it does not hold.
5. **Put the read role back.** If `-2` ended up master, run `cluster failover`
   on the other replica.

A pod that kept its `/data` restarts from its own RDB and resumes by partial
resync. A pod that comes back with an empty `/data` full-syncs, which takes an
hour on a large shard.

**Caveat:** a pod the kubelet evicts (phase `Failed`) is recreated by the
controller at the NEW revision even under `OnDelete`. Roll a template change
promptly once it is applied.

## Changing an immutable field (podManagementPolicy, serviceName, selector, volumeClaimTemplates)

The API server refuses these on a live StatefulSet with `field is immutable`,
and `kubectl apply` fails without changing anything. Re-create the StatefulSet
around its running pods:

```
kubectl -n synodic delete statefulset falkordb-shard-0 falkordb-shard-1 falkordb-shard-2 --cascade=orphan
make apply OVERLAY=production-cluster
kubectl -n synodic get pods -l app.kubernetes.io/part-of=falkordb-cluster \
  -o custom-columns=NAME:.metadata.name,UID:.metadata.uid      # same UIDs as before
```

The new StatefulSets adopt the pods without restarting them. A pod on an older
revision stays on it until you roll it. Nothing recreates a pod that dies
between the delete and the apply, so run them back to back. The PVCs
(`falkordb-data-falkordb-shard-N-M`) are bound by name and are untouched.

## The init Job

`falkordb-cluster-init` exits at once on a formed cluster (`cluster_state:ok`),
so re-running it is safe. A completed Job's template is immutable, though. When
this file or its image tag changes, run
`kubectl -n synodic delete job falkordb-cluster-init` before applying, or the
apply fails on it. The tag is pinned with the shards', so an app deploy changes
neither.

## Knobs

| Setting | Where | Value | Effect |
|---|---|---|---|
| `FALKORDB_REPLICA_READ_HOSTS` | `patches/cluster-config.yaml` | `'^falkordb-shard-[0-9]+-2\.'` | A regex `re.search`ed against each replica's announced hostname. A preference, not a filter: matching in-step replicas take the reads; when none of a shard's matching replicas is usable (because `-2` is master, down, syncing or behind, or was benched for 30 s after one failed or timed-out read), its other in-step replicas take them, and only when none is vouched does the master. Unset or blank means every in-step replica may read. An invalid regex is ignored with a warning. |
| `FALKORDB_MASTER_READ_SHARE` | `patches/cluster-config.yaml` | `"0"` | No read slot for the master in the rotation. The code default is 1. |
| `FALKORDB_REPLICA_READ_MAX_LAG_BYTES` | env (unset) | 8 MiB | How far behind its master a replica may be and still take reads. Measured as the master's offset minus the replica's. |
| `FALKORDB_CLUSTER_TAG` / `newTag` | `deploy/k8s/Makefile` / `kustomization.yaml` | `v4.20.6-1` | The shard image. Change both together. |
| `FALKORDB_BACKUP_TARGETS` / `FALKORDB_BACKUP_REPLICA_ONLY` | `patches/dr-backup-cluster.yaml` | `-1\|-0\|-2` per shard / `"1"` | The DR snapshot SYNCs the first candidate that is a replica, has its link up, is not loading and is not already forking. It never forks a master. |

App pods read these at start. After changing `common-config`, restart the
Deployments that consume it (`kubectl -n synodic rollout restart deployment/<name>`).

## Acceptance drill (run once after first deploy)

1. `kubectl -n synodic exec falkordb-shard-0-0 -- redis-cli cluster info` →
   `cluster_state:ok`, 3 masters, 6 replicas, hostnames (not IPs) in
   `cluster nodes` output, and every `falkordb-shard-N-2` a replica.
2. Seed/reseed a few graphs; verify reads across all three shards.
3. **One-shard rotation:** `kubectl -n synodic delete pod <current master of any shard>`.
   * The pod's `preStop` hands its slots to the shard's standby with
     `CLUSTER FAILOVER` (to `-2` only if no standby is online). The roles swap
     in about a second, with no 15s detection window.
   * The old master restarts as a replica and resumes by partial resync:
     `Successful partial resynchronization with master.` in its log.
   * If the hand-over cannot run (no online replica), the cluster notices after
     `cluster-node-timeout` (15s) and promotes a replica.
   * Either way the app holds through it rather than erroring:
     * a read fails fast with a 3s retry hint while the canvas keeps showing
       its last answer behind a "Reconnecting to the graph store" line;
     * a running rebuild waits for the node and carries on from its checkpoint;
     * other shards' graphs are unaffected, and app pods are untouched.
   * Watch it on **Admin → Graph store**: the node goes Unreachable, then
     Restarting, then Up. `-2` takes the master role only when no standby was
     online; if it did, hand it back (step 5 of the roll above).
4. **Rebuild under replication:** trigger a rebuild of the largest, most
   connected source and watch the same page. Replicas should stay Up with lag
   returning to zero between batches, the run settings should show it waiting
   for acknowledgement rather than a shard restarting, and
   `kubectl get pod <replica> -o jsonpath='{.status.containerStatuses[0].lastState.terminated}'`
   should stay empty through the run.
5. **Node drain:** `kubectl cordon <node> && kubectl drain <node>
   --ignore-daemonsets --delete-emptydir-data` → PDB serializes the eviction,
   same observations as (3). A replica still loading after a full sync is
   NotReady and holds the PDB, so a second drain waits for it.
6. **Crashed master:** follow the release notes §8 phase 4, drill 3. The
   restarted master logs `holding 45s`, its replica is promoted, and the old
   master rejoins as a replica with a full resync and no lost writes. Run it
   on the smallest shard.

## Clients in ANOTHER cluster (cross-GKE)

Everything above serves in-cluster clients: the shards announce per-pod
hostnames (`--cluster-announce-hostname
$(POD_NAME).falkordb-cluster.synodic.svc.cluster.local`), which resolve only
inside this cluster. A client in a DIFFERENT GKE cluster that follows the
slot map / `MOVED` redirects lands on unresolvable names and times out —
the classic "provider keeps flapping offline cross-cluster" symptom.

Two pieces make cross-cluster work:

1. **A reachable path per shard pod.** Expose each `falkordb-shard-N-0` pod
   individually (Multi-Cluster Services exporting the `falkordb-cluster`
   headless Service, or one internal LB per shard). A single LB in front of
   the whole cluster is NOT enough — redirects name individual nodes.
2. **`addressRemap` on the client side**, mapping each announced hostname to
   its reachable endpoint. Per-provider (survives wizard edits) or env-wide:

   ```json
   "falkordbConnection": {
     "mode": "cluster",
     "cluster": {"startupNodes": [["falkordb-shard-0.mcs.example.internal", 6379],
                                  ["falkordb-shard-1.mcs.example.internal", 6379],
                                  ["falkordb-shard-2.mcs.example.internal", 6379]]},
     "addressRemap": {
       "falkordb-shard-0-0.falkordb-cluster.synodic.svc.cluster.local": "falkordb-shard-0.mcs.example.internal",
       "falkordb-shard-1-0.falkordb-cluster.synodic.svc.cluster.local": "falkordb-shard-1.mcs.example.internal",
       "falkordb-shard-2-0.falkordb-cluster.synodic.svc.cluster.local": "falkordb-shard-2.mcs.example.internal"
     },
     "connectTimeout": 5,
     "probeDeadlineS": 6
   }
   ```

   Env-wide equivalent for the env-default instance:
   `FALKORDB_ADDRESS_REMAP="<announced>=<reachable>,..."` (host-only entries
   preserve the port). `connectTimeout` / `probeDeadlineS` raise the dial and
   warmup-probe budgets for the extra cross-cluster latency without fleet-wide
   env changes.

   The remap applies to every DISCOVERED address (slot map, MOVED/ASK,
   sentinel discover-master); operator-configured startupNodes are dialed
   as written. Validation harness: `deploy/topologies/
   docker-compose.falkordb-cluster-remap.yml` reproduces the unreachable-
   announce shape locally — the integration run fails without the remap and
   passes with it.

Under NetworkPolicy enforcement, a cross-cluster client reaching the shards
through Multi-Cluster Services (MCS) or an internal load balancer arrives from
outside the namespace. Add an `ipBlock` rule for it to
`resources/falkordb-cluster-network-policy.yaml`.

## Deferred

- **The master is `-2`'s only fallback.** While `-2` is unusable, its shard's
  reads, long ones included, go to the master (see *Roles*). A freeze on `-2`
  makes its queued reads time out, which benches it in every app pod at once
  and moves those reads onto the master. Falling back to the standby, or failing
  fast, instead is a tradeoff not made here (release notes §13).
- **No cap on replica reads.** A read on `-2` can still run to `TIMEOUT_MAX`
  (120s), and a write arriving meanwhile freezes `-2` for that long. A timed-out
  replica read is deliberately not re-run on a master, where the same freeze
  would outlast `cluster-node-timeout`.
- **`BROWSER=0` on the shards.** The image starts the FalkorDB Browser
  (Node.js) inside every shard container by default.
- **The single-node base StatefulSet** has the same data-directory bug this
  overlay fixed (`FALKORDB_DATA_PATH`). It is not changed here.
