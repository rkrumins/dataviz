# production-cluster — FalkorDB Redis Cluster overlay

Implements `docs/INFRASTRUCTURE_LAUNCH_SCALE.md` §7: replaces the single-replica
FalkorDB StatefulSet with **3 shards × (1 master + 1 replica) = 6 pods** on the
dedicated node pool. Everything else is inherited from `overlays/production`,
which remains deployable unchanged — this overlay is the opt-in cutover.

```
kubectl kustomize deploy/k8s/overlays/production-cluster   # render
make apply OVERLAY=production-cluster                      # deploy (same envsubst flow)
```

## Prerequisites

1. **Node pool** (doc §3) — must exist before deploying or all 6 pods sit Pending:

   ```
   gcloud container node-pools create falkordb-pool \
     --cluster <CLUSTER> --region us-central1 \
     --machine-type n4-highmem-8 --num-nodes 2 \
     --node-taints dedicated=falkordb:NoSchedule \
     --node-labels dedicated=falkordb
   ```

   (2 per zone × 3 zones = 6 nodes; n4 requires Hyperdisk — the PVCs use
   `hyperdisk-balanced`.)

   **The node count is not a recommendation, it is the pod count.** The
   anti-affinity is `requiredDuringScheduling` and spans every shard
   (`app.kubernetes.io/part-of: falkordb-cluster`, `topologyKey:
   kubernetes.io/hostname`), and the pods request ≈ their limits, so one pod
   owns one node and there is no sharing to fall back on. `--num-nodes` is
   per zone: **`--num-nodes N` gives 3N nodes, and the cluster needs one per
   pod.** Short by one and that pod sits `Pending` for ever — no eviction, no
   warning, just a shard permanently short of a replica.

   To run 3 shards × (1 master + 2 replicas) = 9 pods, provision 9 nodes
   (`--num-nodes 3`) BEFORE raising `replicas:` to 3 in
   `resources/falkordb-cluster-statefulsets.yaml`, and extend
   `resources/falkordb-cluster-init-job.yaml` — its `$PODS` list and its
   `add-node --cluster-slave` loop both name `falkordb-shard-$i-1`
   explicitly, so the `-2` pods have to be added to each. Note
   what the third pod actually buys: a shard survives losing a master AND a
   replica. It does not make writes safer — one in-sync replica is already
   enough for that (see `FALKORDB_DEPLOYMENT.md` §5a, "If you do set it, set
   it to 1") — and it does not make rebuilds safer, since the aggregation
   pipeline waits for one acknowledgement by default and carries on without a
   replica that is merely absent.

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
   `GRAPHVER_FALKOR_MAX_RESIDENT` ≈ 0.8 × shard `maxmemory` (32gb) per provider
   so cold-graph eviction keeps residency inside the 40gb ceiling.

## What deploying does

1. Creates the headless `falkordb-cluster` Service (stable per-pod DNS — pods
   announce these names via `cluster-announce-hostname`, so a rotated pod
   rejoins under the same address).
2. Creates `falkordb-shard-0/1/2` StatefulSets (config = doc §7.2;
   `podManagementPolicy: Parallel`, `updateStrategy: OnDelete` — see *Rotating
   pods* below), PDB `maxUnavailable: 1` across all six pods.
3. Runs the idempotent `falkordb-cluster-init` Job: 3-master create, then each
   shard's `-1` pod attached as the replica of its own `-0` pod.
4. Deletes the single-node `falkordb` StatefulSet/Service and flips
   `FALKORDB_MODE=cluster` + seed nodes in `common-config`.

Cutover does NOT migrate data — FalkorDB is a disposable projection (doc §7.4);
reseed graphs from Cloud SQL after the cluster is green.

## Acceptance drill (run once after first deploy)

1. `kubectl -n synodic exec falkordb-shard-0-0 -- redis-cli cluster info` →
   `cluster_state:ok`, 3 masters, 3 replicas, hostnames (not IPs) in
   `cluster nodes` output.
2. Seed/reseed a few graphs; verify reads across all three shards.
3. **One-shard rotation:** `kubectl -n synodic delete pod <current master of any shard>`
   → the cluster notices after `cluster-node-timeout` (15s) and promotes a
   replica. The app holds through it rather than erroring: a read fails fast
   with a 3s retry hint while the canvas keeps showing its last answer behind
   a "Reconnecting to the graph store" line, and a running rebuild waits for
   the node and carries on from its checkpoint. Other shards' graphs are
   unaffected and app pods are untouched. Watch it on **Admin → Graph store**:
   the node goes Unreachable, then Restarting, then Up.
4. **Rebuild under replication:** trigger a rebuild of the largest, most
   connected source and watch the same page. Replicas should stay Up with lag
   returning to zero between batches, the run settings should show it waiting
   for acknowledgement rather than a shard restarting, and
   `kubectl get pod <replica> -o jsonpath='{.status.containerStatuses[0].lastState.terminated}'`
   should stay empty through the run.
5. **Node drain:** `kubectl cordon <node> && kubectl drain <node>
   --ignore-daemonsets --delete-emptydir-data` → PDB serializes the eviction,
   same observations as (3).
6. **Recreation keeps the data:** `kubectl -n synodic delete pod <replica of any
   shard>` → the pod returns with RESTARTS 0 and replays *its own* AOF from the
   claim (`INFO persistence` shows `loading:1`; `kubectl exec … -- ls
   /var/lib/falkordb/data` shows `appendonlydir/`), then full-syncs once
   (`sync_full` on the master +1, then flat).
   `kubectl -n synodic get events --field-selector reason=Evicted` stays empty.

## Rotating pods

`updateStrategy: OnDelete`: `make apply` changes the template and restarts
nothing; a pod picks the new template up when *you* delete it. That is
deliberate — a fresh replica answers `PONG` (Ready) while the RDB is still
streaming in and only turns `-LOADING` once it starts loading, so a
RollingUpdate would read that first PONG as done and delete the master while
the replica is still receiving. A rotation also costs hours: with `appendonly
yes` a restarted replica first replays its own AOF (~1 h for 15 GB, then
discarded — an AOF-restarted replica cannot partial-resync) and then full-syncs
from the master (another ~1 h). Per shard, replica first, with
`D=falkordb-cluster.synodic.svc.cluster.local`:

1. Roles: `redis-cli -h falkordb-shard-N-0.$D role | head -1` (and `-1`).
2. On the master: no `rdb_bgsave_in_progress` / `aof_rewrite_in_progress`,
   replica `state=online`, no rebuild running. `CONFIG SET repl-backlog-size 8gb`
   if the committed value does not cover an hour of writes
   (`FALKORDB_DEPLOYMENT.md` §5aa).
3. Optional, to skip the replay the full sync is about to discard:
   `kubectl -n synodic exec <replica> -- rm -rf /var/lib/falkordb/data/appendonlydir`
   immediately before step 4.
4. `kubectl -n synodic delete pod <replica>`. Watch `INFO replication`
   (`master_sync_in_progress:1`), `INFO persistence` (`loading:1` → `loading:0`),
   then `master_link_status:up` and `aof_rewrite_in_progress:0`. On the master
   `sync_full` goes +1 — a *second* full sync means the backlog is too small;
   stop and fix that first.
5. `redis-cli -h <new replica>.$D CLUSTER FAILOVER` (no FORCE); wait for
   `role:master`.
6. Delete the old master (now a replica); repeat step 4. `CLUSTER FAILOVER` on
   `-0` afterwards so roles match the DR CronJob's `-1`-is-the-replica
   assumption.
7. `kubectl -n synodic get pod -l app.kubernetes.io/name=falkordb-shard-N
   -L controller-revision-hash` matches the StatefulSet's `.status.updateRevision`.

`podManagementPolicy` is immutable: changing it means `kubectl -n synodic delete
sts falkordb-shard-N --cascade=orphan` (pods and claims stay) and re-applying;
with `OnDelete` the re-created StatefulSet adopts the pods and restarts nothing.
GKE node upgrades honour the PDB for one hour and then force-drain, so an
hour-long load inside an upgrade loses the shard's second copy: keep a
maintenance exclusion on `falkordb-pool` and rotate on your own schedule.

## Detecting an eviction

An evicted pod is *recreated*, not restarted: RESTARTS stays 0, AGE and UID
reset, `kubectl logs --previous` has nothing, and the data dir is empty unless
it is on the claim. Look for the event, not the restart count:

```
kubectl -n synodic get events --field-selector reason=Evicted -o wide   # kept ~1h; older: Cloud Logging jsonPayload.reason="Evicted"
kubectl -n synodic get pod -l app.kubernetes.io/part-of=falkordb-cluster \
  -o custom-columns='NAME:.metadata.name,UID:.metadata.uid,START:.status.startTime,RESTARTS:.status.containerStatuses[0].restartCount,NODE:.spec.nodeName'
kubectl get nodes -l dedicated=falkordb \
  -o custom-columns='NAME:.metadata.name,DISK:.status.conditions[?(@.type=="DiskPressure")].status,MEM:.status.conditions[?(@.type=="MemoryPressure")].status'
kubectl -n synodic exec falkordb-shard-0-0 -- sh -c 'redis-cli CONFIG GET dir; df -h /var/lib/falkordb/data; ls /var/lib/falkordb/data'
```

The event names the resource (`ephemeral-storage` or `memory`). `CONFIG GET dir`
must be `/var/lib/falkordb/data` and `df` must show the claim, not the node's
root disk.

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

## Deferred (tracked in doc §8/§11)

- BGSAVE→GCS DR CronJob (RPO backstop; effective RPO is Cloud SQL's).
- 3×3 topology (spare replica through a full zone outage).
