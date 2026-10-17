# production-cluster — FalkorDB Redis Cluster overlay

*For platform operators.*

Move the production graph store from one FalkorDB pod to a Redis Cluster of
**3 shards × (1 master + 1 replica) = 6 pods** on a dedicated node pool, then prove it holds
up. This implements [Infrastructure: Launch Scale §7](/docs/infra-launch-scale#7-falkordb-in-redis-cluster-mode-self-managed-on-gke).
Everything else is inherited from `overlays/production`, which stays deployable unchanged —
this overlay is the opt-in cutover. The rest of the Kubernetes setup is in
[Deploying on Kubernetes](/docs/kubernetes).

From the repository root:

```
kubectl kustomize deploy/k8s/overlays/production-cluster          # render
make -C deploy/k8s apply OVERLAY=production-cluster TAG=<tag>     # deploy (same envsubst flow)
```

`./deploy.sh deploy` doesn't accept this overlay; use `make` as above.

## Prerequisites

1. **Node pool** ([Launch Scale §3](/docs/infra-launch-scale#3-gke-cluster)) — must exist
   before deploying, or all 6 pods sit `Pending`:

   ```
   gcloud container node-pools create falkordb-pool \
     --cluster <CLUSTER> --region us-central1 \
     --machine-type n4-highmem-8 --num-nodes 2 \
     --node-taints dedicated=falkordb:NoSchedule \
     --node-labels dedicated=falkordb
   ```

   (2 per zone × 3 zones = 6 nodes; n4 requires Hyperdisk — the PVCs use
   `hyperdisk-balanced`.)

   **The node count is not a recommendation, it is the pod count.** The anti-affinity is
   `requiredDuringScheduling` and spans every shard (`app.kubernetes.io/part-of:
   falkordb-cluster`, `topologyKey: kubernetes.io/hostname`), and the pods request about their
   limits, so one pod owns one node and there is no sharing to fall back on. `--num-nodes` is
   per zone: **`--num-nodes N` gives 3N nodes, and the cluster needs one per pod.** Short by
   one and that pod sits `Pending` for ever — no eviction, no warning, just a shard
   permanently short of a replica.

   To run 3 shards × (1 master + 2 replicas) = 9 pods, provision 9 nodes (`--num-nodes 3`)
   BEFORE raising `replicas:` to 3 in `resources/falkordb-cluster-statefulsets.yaml`, and
   extend `resources/falkordb-cluster-init-job.yaml` — its `$PODS` list and its
   `add-node --cluster-slave` loop both name `falkordb-shard-$i-1` explicitly, so the `-2`
   pods have to be added to each. Note what the third pod actually buys: a shard survives
   losing a master AND a replica. It doesn't make writes safer — one in-sync replica is
   already enough for that (see
   [FalkorDB Deployment: "If you do set it, set it to 1"](/docs/falkordb-deployment#if-you-do-set-it-set-it-to-1))
   — and it doesn't make rebuilds safer, since the aggregation pipeline waits for one
   acknowledgement by default and carries on without a replica that is merely absent.

2. **Managed cache** — `CACHE_REDIS_URL` must point at Memorystore (the production
   `managed-data-tier` patch). Cluster mode can't host the provider cache
   ([ADR-020](/docs/decisions#adr-020-dedicated-redis-decoupled-from-falkordb-by-construction),
   [Launch Scale §7.3](/docs/infra-launch-scale#73-mandatory-application-settings-in-cluster-mode)).

3. **Provider rows declare their own topology.** Every FalkorDB consumer (read path,
   versioning registry, projector, workers, `GRAPH.LIST`) resolves the connection from the
   instance's own config through one shared topology-aware client, so a standalone, a Sentinel
   and a Cluster instance can coexist. For graphs pinned to a provider, set on the provider
   row:

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

   Keep `row.host` pointing at a seed node (it is still used for host resolution + preflight
   fallback). Unrouted (env-default) graphs need no row: they follow `FALKORDB_MODE=cluster` +
   `FALKORDB_CLUSTER_NODES` from `common-config`, which this overlay sets.

4. **Eviction budgets** ([Launch Scale §7.3](/docs/infra-launch-scale#73-mandatory-application-settings-in-cluster-mode)):
   set `GRAPHVER_FALKOR_BUDGETS` / `GRAPHVER_FALKOR_MAX_RESIDENT` ≈ 0.8 × the shard
   `maxmemory` (32gb) per provider, so cold-graph eviction keeps residency inside it.

5. **The shards' data must land on their volumes.** Like the base StatefulSet, the shard
   StatefulSets mount their volume at `/data`, while the FalkorDB image writes its AOF and RDB
   under `/var/lib/falkordb/data`. Add the mount for each shard before cutting over:
   [Keep FalkorDB's data on its volume](/docs/kubernetes#keep-falkordbs-data-on-its-volume).

6. **NetworkPolicies, if your cluster enforces them.** The base `default-deny-ingress` policy
   also applies to the shard pods, and no shipped policy admits traffic to them. Add allow
   rules for the app's pods and the init Job on 6379, for the shards themselves on 6379 and the
   cluster bus on 16379, and for the backup Job — see
   [NetworkPolicies on clusters that enforce them](/docs/kubernetes#networkpolicies-on-clusters-that-enforce-them).

## What deploying does

1. Creates the headless `falkordb-cluster` Service (stable per-pod DNS — pods announce these
   names via `cluster-announce-hostname`, so a rotated pod rejoins under the same address).
2. Creates `falkordb-shard-0/1/2` StatefulSets (config per
   [Launch Scale §7.2](/docs/infra-launch-scale#72-per-pod-resources--redis-config-configmap)),
   PDB `maxUnavailable: 1` across all six pods.
3. Runs the idempotent `falkordb-cluster-init` Job: 3-master create, then each shard's `-1` pod
   attached as the replica of its own `-0` pod.
4. Deletes the single-node `falkordb` StatefulSet/Service and flips `FALKORDB_MODE=cluster` +
   seed nodes in `common-config`; re-derives the aggregation slot budget for the shards'
   `THREAD_COUNT 6`; and points the graph-store backup CronJob at each shard's replica.

Cutover doesn't migrate data. Once the cluster is green, rebuild every version-controlled
source from Postgres, and load directly loaded sources again — they have no copy in Postgres.
Both are in the [FalkorDB DR Runbook](/docs/falkordb-dr).

## Acceptance drill (run once after first deploy)

1. `kubectl -n synodic exec falkordb-shard-0-0 -- redis-cli cluster info` →
   `cluster_state:ok`, 3 masters, 3 replicas, hostnames (not IPs) in `cluster nodes` output.
2. Rebuild or load a few graphs; verify reads across all three shards.
3. **One-shard rotation:** `kubectl -n synodic delete pod <current master of any shard>` → the
   cluster notices after `cluster-node-timeout` (15s) and promotes a replica. The app holds
   through it rather than erroring: a read fails fast with a 3s retry hint while the canvas
   keeps showing its last answer behind a "Reconnecting to the graph store" line, and a
   running rebuild waits for the node and carries on from its checkpoint. Other shards' graphs
   are unaffected and app pods are untouched. Watch it on **Administration → Graph store**:
   the node goes Unreachable, then Restarting, then Up.
4. **Rebuild under replication:** trigger a rebuild of the largest, most connected source and
   watch the same page. Replicas should stay Up with lag returning to zero between batches,
   the run settings should show it waiting for acknowledgement rather than a shard
   restarting, and
   `kubectl get pod <replica> -o jsonpath='{.status.containerStatuses[0].lastState.terminated}'`
   should stay empty through the run.
5. **Node drain:** `kubectl cordon <node> && kubectl drain <node> --ignore-daemonsets --delete-emptydir-data`
   → PDB serializes the eviction, same observations as (3).

## Clients in ANOTHER cluster (cross-GKE)

Everything above serves in-cluster clients: the shards announce per-pod hostnames
(`--cluster-announce-hostname $(POD_NAME).falkordb-cluster.synodic.svc.cluster.local`), which
resolve only inside this cluster. A client in a DIFFERENT GKE cluster that follows the slot map
/ `MOVED` redirects lands on unresolvable names and times out — the classic "provider keeps
flapping offline cross-cluster" symptom.

Two pieces make cross-cluster work:

1. **A reachable path per shard pod.** Expose each `falkordb-shard-N-0` pod individually
   (Multi-Cluster Services exporting the `falkordb-cluster` headless Service, or one internal
   LB per shard). A single LB in front of the whole cluster is NOT enough — redirects name
   individual nodes.
2. **`addressRemap` on the client side**, mapping each announced hostname to its reachable
   endpoint. Per-provider (survives wizard edits) or env-wide:

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
   `FALKORDB_ADDRESS_REMAP="<announced>=<reachable>,..."` (host-only entries preserve the
   port). `connectTimeout` / `probeDeadlineS` raise the dial and warmup-probe budgets for the
   extra cross-cluster latency without fleet-wide env changes.

   The remap applies to every DISCOVERED address (slot map, MOVED/ASK, sentinel
   discover-master); operator-configured startupNodes are dialed as written. Validation
   harness: `deploy/topologies/docker-compose.falkordb-cluster-remap.yml` reproduces the
   unreachable-announce shape locally — the integration run fails without the remap and
   passes with it.

## Deferred (tracked in Launch Scale §8 and §11)

- 3×3 topology (spare replica through a full zone outage).

Backups are not deferred: the production overlay's 6-hourly snapshot CronJob is inherited, and
`patches/dr-backup-cluster.yaml` runs one backup pod per shard against that shard's replica.

## Where to next

- [FalkorDB DR Runbook](/docs/falkordb-dr) — restoring a shard, and rebuilding after cutover.
- [FalkorDB Deployment](/docs/falkordb-deployment) — memory sizing and replication under heavy writes.
- [The Graph Store](/guide/graph-store-topology) — what **Administration → Graph store** shows.
