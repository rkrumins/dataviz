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

2. **Managed cache** — `CACHE_REDIS_URL` must point at Memorystore (the
   production `managed-data-tier` patch). Cluster mode cannot host the provider
   cache (ADR-020, doc §7.3).

3. **Provider rows route through cluster config.** The `ProviderManager` read
   path is fully cluster-aware, but the env-default **registry/projection
   factories build standalone connections** — in cluster mode a standalone
   connection only reaches graphs whose slots live on that one seed node.
   Before cutover, production FalkorDB provider rows must carry
   `extra_config.falkordbConnection = {"mode": "cluster", "cluster":
   {"startupNodes": [["falkordb-shard-0-0.falkordb-cluster.synodic.svc.cluster.local", 6379], ...]}}`
   so reads resolve the owning shard — and graphs pinned to a provider project
   through `resolve_falkordb_target(row.host, row.port)`, so keep `row.host`
   pointing at a seed node. Unrouted (env-default) versioned graphs are the
   remaining standalone-only path — treat closing that as a pre-cutover code
   task if any production graph is unrouted.

4. **Eviction budgets** (doc §7.3): set `GRAPHVER_FALKOR_BUDGETS` /
   `GRAPHVER_FALKOR_MAX_RESIDENT` ≈ 0.8 × shard `maxmemory` (32gb) per provider
   so cold-graph eviction keeps residency inside the 40gb ceiling.

## What deploying does

1. Creates the headless `falkordb-cluster` Service (stable per-pod DNS — pods
   announce these names via `cluster-announce-hostname`, so a rotated pod
   rejoins under the same address).
2. Creates `falkordb-shard-0/1/2` StatefulSets (config = doc §7.2 verbatim),
   PDB `maxUnavailable: 1` across all six pods.
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
   → replica promotes in <5s (`cluster-node-timeout 5000`), reads on that
   shard's graphs blip once and self-heal (client re-resolves on retry 2),
   other shards' graphs unaffected, app pods untouched.
4. **Node drain:** `kubectl cordon <node> && kubectl drain <node>
   --ignore-daemonsets --delete-emptydir-data` → PDB serializes the eviction,
   same observations as (3).

## Deferred (tracked in doc §8/§11)

- BGSAVE→GCS DR CronJob (RPO backstop; effective RPO is Cloud SQL's).
- 3×3 topology (spare replica through a full zone outage).
