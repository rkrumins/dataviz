# Enterprise FalkorDB Architecture & Disaster Recovery Specification

**Document Version:** 1.0
**Target Environment:** Google Kubernetes Engine (GKE)
**Workload:** Multi-Tenant Enterprise Graph Service (Heavy Reads, Spiky Writes)

---

## 1. Executive Summary

This document outlines the architecture for a highly resilient, multi-tenant FalkorDB deployment on GKE. To accommodate hundreds of distinct tenant graphs with strict high-availability requirements (cost-agnostic), we utilize **Redis Cluster Mode** (no Sentinels) configured with a **9-Pod Bulletproof Zonal Topology**.

This architecture guarantees that even in the event of a complete GCP Availability Zone failure, every graph shard maintains at least one active Master and one active Replica, preventing read-workload cascading failures.

---

## 2. Infrastructure Specification

| Component | Specification | Description |
| :--- | :--- | :--- |
| **Cloud Provider** | GCP (e.g., `us-central1`) | Multi-zonal region required (Zones A, B, C). |
| **Compute Nodes** | `n4-standard-16` | 16 vCPUs, 128GB RAM for high concurrency and memory buffering. |
| **Orchestration** | GKE + Kubernetes Operator | FalkorDB Operator or KubeBlocks for StatefulSet management. |
| **Storage** | Premium SSD Persistent Volumes | Critical for low-latency AOF (Append-Only File) background disk I/O. |

---

## 3. Pod Topology & Distribution (The 9-Pod Rule)

The cluster is divided into 3 Shards. Each Shard owns a subset of the 16,384 hash slots.
To achieve multi-zonal resilience, each Shard is configured with **1 Master** and **2 Replicas**. 

Kubernetes `topologySpreadConstraints` and strict `podAntiAffinity` are used to distribute these 9 pods perfectly across the 3 GCP zones.

### Logical/Physical Layout Map

| GCP Zone | Host Node (Example) | Pod ID | Cluster Role | Shard Assignment |
| :--- | :--- | :--- | :--- | :--- |
| **Zone A** | `gke-node-a-1` | `fdp-0` | **Master** | Shard 1 |
| **Zone A** | `gke-node-a-1` | `fdp-1` | Replica | Shard 2 (Replica B) |
| **Zone A** | `gke-node-a-1` | `fdp-2` | Replica | Shard 3 (Replica C) |
| **Zone B** | `gke-node-b-1` | `fdp-3` | **Master** | Shard 2 |
| **Zone B** | `gke-node-b-1` | `fdp-4` | Replica | Shard 3 (Replica B) |
| **Zone B** | `gke-node-b-1` | `fdp-5` | Replica | Shard 1 (Replica B) |
| **Zone C** | `gke-node-c-1` | `fdp-6` | **Master** | Shard 3 |
| **Zone C** | `gke-node-c-1` | `fdp-7` | Replica | Shard 1 (Replica C) |
| **Zone C** | `gke-node-c-1` | `fdp-8` | Replica | Shard 2 (Replica C) |

---

## 4. Routing & Data Distribution

Because this is a multi-tenant environment, entire tenant graphs are distributed across the cluster.

1. **Deterministic Placement:** An application creates a graph (e.g., `tenant_A_data`).
2. **Client Routing:** The cluster-aware application client hashes the graph name to a specific hash slot (e.g., falling in Shard 2).
3. **Zero-Hop Writes:** The client routes write commands directly to the Master of Shard 2 (Zone B).
4. **Read Scaling:** Analytical read queries (`GRAPH.RO_QUERY`) are automatically load-balanced by the client to the Replicas in Zone A and Zone C.

---

## 5. Auto-Healing & Recovery Scenarios

### 5.1 Single Node Hardware Failure (e.g., Zone B Node Crashes)

**Impact:** Loss of `fdp-3` (Master, Shard 2), `fdp-4` (Replica), and `fdp-5` (Replica).

1. **Quorum:** 6 pods remain. The remaining Masters retain quorum.
2. **Detection:** Gossip protocol marks `fdp-3` as dead.
3. **Failover:** Shard 2's remaining replicas (`fdp-1` in Zone A, `fdp-8` in Zone C) hold an election. The cluster promotes `fdp-8` to Master.
4. **Traffic Update:** Clients attempting to hit `fdp-3` receive a `MOVED` redirect and update their routing tables to hit `fdp-8`.
5. **Restoration:** GKE automatically reschedules missing pods to a healthy node in Zone B, reattaches PVs, and instances perform a differential sync.

*Downtime: < 1 second for Shard 2 writes. No data loss.*

### 5.2 Full Zonal Outage (e.g., Zone C Datacenter Drops)

**Impact:** Loss of `fdp-6` (Master, Shard 3), `fdp-7` (Replica), and `fdp-8` (Replica).

1. **Quorum:** Zones A and B survive. Masters 1 and 2 retain quorum. 
2. **Detection & Failover:** Shard 3's Master is dead. Its surviving replicas are in Zone A and Zone B. One is promoted to Master.
3. **Cluster State:** After failover, **every single Shard (1, 2, and 3) still has exactly 1 Master and 1 Replica active in the surviving zones.**
4. **Read Preservation:** Because replicas still exist for every shard, the heavy read workload does not fallback onto the Masters, preventing a cluster-wide CPU bottleneck.

*Downtime: < 1 second for Shard 3 writes. Slight read latency increase as capacity drops from 6 replicas to 3 across the cluster.*

---

## 5a. Memory Sizing Rule (read this before raising maxmemory)

`maxmemory` must fit INSIDE the machine that runs the container, with
headroom — it is a Redis-level ceiling, not a reservation, and setting
it above the host/VM capacity converts graceful `OOM command not
allowed` write errors into host-level OOM kills of the whole instance
(observed live 2026-07-11: `maxmemory 12gb` on a 12GB Docker Desktop VM
shared with 8 other containers — the instance died repeatedly under
load and each restart paid a multi-minute AOF replay, presenting as
"the stack blew up and is not recovering for hours").

Rule of thumb:

- `maxmemory ≤ host_memory − 4GB` (other services + OS + page cache);
- expected dataset ≤ ~60% of `maxmemory` — BGSAVE/BGREWRITEAOF fork
  copy-on-write can spike usage well above the resident dataset while
  writes are in flight;
- if the dataset legitimately needs more, grow the HOST first
  (Docker Desktop → Settings → Resources → Memory), then `maxmemory`.

Recovery time is part of sizing: an AOF *incremental* replays
command-by-command (minutes per GB) while the *base* RDB bulk-loads
fast — keep the incremental small (see the auto-rewrite thresholds in
the compose files) or restarts of a large instance take tens of
minutes, during which liveness MUST NOT kill the process (see below).

## 5b. Local Durability: AOF Is Mandatory

Every shipped topology (compose files, k8s manifests) runs FalkorDB with
`--appendonly yes --appendfsync everysec --aof-load-truncated yes`.

Snapshot-only persistence is NOT sufficient: a restart reloads the last
RDB and silently drops every write since it. Observed live (2026-07-11):
a stack restart minutes after a graph import resurrected the graph with
its containment edges but WITHOUT its lineage edges (the RDB save fired
mid-import), after which every aggregation run correctly produced zero
cells — presenting as "aggregation is broken" when the data layer had
lost the input. AOF `everysec` bounds the loss window to ~1 second;
`aof-load-truncated` tolerates a torn AOF tail after a crash instead of
refusing to start. Keep RDB snapshots enabled alongside AOF — they
remain the fast-restart and DR-export mechanism.

## 5c. Engine Version Upgrades: Reload From RDB, Not AOF

**The AOF *incremental* is NOT portable across FalkorDB engine versions; the
RDB *base* is.** FalkorDB persists graph mutations to the AOF incremental as a
binary `GRAPH.EFFECT` opcode stream that is specific to the engine build. After
bumping the `falkordb/falkordb:vX` image tag, replaying an incremental written
by the PREVIOUS engine can NULL-deref (`AttributeSet_Update` → SIGSEGV) *during
the startup AOF load*, before the server accepts a single query. With
`restart: unless-stopped` this becomes a permanent crash loop, and because the
healthcheck treats the `-LOADING` reply as healthy, `docker ps` can even show
"(healthy)" while it loops. `--aof-load-truncated` does NOT help — it only
forgives a torn tail, not a well-formed-but-incompatible effect. (Observed live
2026-07-12 upgrading v4.16.0 → v4.18.11.)

The RDB base decodes cleanly across versions, so migrate persistence through
RDB whenever the engine tag changes on a topology that persists a volume:

1. **Before** bumping the image tag, on the OLD running engine, compact and
   confirm the write is durable:
   ```
   redis-cli BGREWRITEAOF
   redis-cli INFO persistence | grep aof_last_bgrewrite_status   # want :ok
   ```
2. Boot the NEW image once with **AOF off** so it loads the portable RDB
   (the AOF base RDB, or a standalone `dump.rdb`), then re-enable AOF to mint a
   fresh, engine-native AOF (empty incremental + a base written by the new
   engine):
   ```
   # temporary container / args: drop `--appendonly yes`, add `--appendonly no`
   redis-cli CONFIG SET appendonly yes
   redis-cli INFO persistence | grep -E 'aof_enabled|aof_rewrite_in_progress|aof_last_bgrewrite_status'
   # wait for aof_enabled:1, aof_rewrite_in_progress:0, aof_last_bgrewrite_status:ok, then clean-stop
   ```
   > Gotcha: with `--appendonly yes` and NO `appendonlydir` present, Redis starts
   > **EMPTY** — it does not fall back to `dump.rdb`. Load the RDB with
   > `--appendonly no`, or keep a valid base RDB + a base-only manifest.
3. Validate the RDB before trusting it: `redis-check-rdb <file>` (envelope/CRC
   pre-filter; the definitive check is a boot that loads the graph module).

In **dev**, the `scripts/falkordb-dev-entrypoint.sh` guard performs this
recovery automatically: it detects a startup crash loop and quarantines the
incompatible incremental (moving it to `appendonlydir.poison-*`, never deleting)
so the next boot loads clean from the base RDB. In **prod**, this is a manual
runbook by design — quarantining data should be a human decision made against a
known-good backup, and a crash loop should surface as CrashLoopBackOff and page
an operator, not silently discard writes.

## 6. Disaster Recovery (Cross-Region)

In the event of a total GCP Region loss (e.g., `us-central1` goes completely offline), standard HA mechanisms fail. The following DR strategy must be implemented proactively:

1. **Automated Snapshots:** Configure FalkorDB to generate RDB snapshots every 4-6 hours.
2. **Multi-Region Bucket:** Export snapshots automatically to a GCP Cloud Storage Bucket configured with **Multi-Region Replication** (e.g., replicating to `europe-west1`).
3. **Cold Standby / Active-Passive:** Maintain a scaled-down GKE cluster in the secondary region. 
4. **Recovery Protocol:** In a disaster, scale up the secondary GKE cluster, deploy the FalkorDB operator, and initialize the cluster using the latest RDB file from the replicated storage bucket.

---

## 7. Application Client Configuration

The application's FalkorDB provider is topology-aware and selects how to
connect from configuration — **standalone**, **Sentinel**, or **Cluster**.
Because a single FalkorDB graph key lives entirely on one node, Cluster
mode does not split a single graph; it routes the client to the node that
**owns** the graph key (§4) and provides HA + spreads *different* graphs
across shards.

### Topology support matrix (verified live)

Every service — viz-service, **aggregation-worker**, **versioning projection
worker**, insights, control plane — reaches FalkorDB through the *same*
topology-aware factory (`build_graph_client` / the graph-client cache), so
none of them carries topology logic of its own. Verified against a live
3-master cluster (v4.18.11) and a live Sentinel quorum (1 master + 1 replica +
3 sentinels, quorum 2):

| Operation | Standalone | Cluster | Sentinel |
|---|---|---|---|
| Connect + `ensure_indices` / `ensure_projections` | ✅ | ✅ | ✅ |
| `GRAPH.QUERY` write / `GRAPH.RO_QUERY` read | ✅ | ✅ (routed to the owning shard) | ✅ |
| Dedicated `{graph}_proj` (aggregation projection) | ✅ | ✅ (own client; may land on a *different* shard) | ✅ |
| **Aggregation worker** `materialize_aggregated_edges_batch` | ✅ | ✅ | ✅ |
| **Versioning projection** factory MERGE + read-back | ✅ | ✅ | ✅ |
| `get_schema_stats` (insights / health) | ✅ | ✅ | ✅ |
| `GRAPH.LIST` (keyless) | ✅ | ✅ **union over all primaries** — a single node sees only its own shard | ✅ |
| `drop_graph` / eviction / orphan purge (`GRAPH.DELETE`) | ✅ | ✅ (verified on all 3 shards) | ✅ |
| Hard master crash → promotion | n/a | n/a | ✅ **writes self-heal, no data loss** |

**Cross-slot hazards: none.** An exhaustive audit of every command we issue on
the graph connection found **zero** pipelines, `MULTI`/`EXEC`, Lua/`EVAL`,
multi-key commands, `GRAPH.COPY`, `GRAPH.BULK` or graph renames. Every graph
command is either keyed to a single graph (so it routes by slot) or a keyless
admin command that fans out explicitly. `_bulk_write_batch` is a
LOADING-aware retry wrapper around ordinary single-key `GRAPH.QUERY`, not a
bulk loader.

**Sentinel failover behaviour (measured).** With writes in flight, `SHUTDOWN
NOSAVE` on the master produced: `ConnectionError` → reconnect+retry 1/3, then
`TimeoutError` retries 2/3 and 3/3, worst single write **6.2s** (inside its 15s
budget) — and **zero errors escaped to the caller**. Sentinel promoted the
replica, the client followed it, and pre-failover data survived replication.
The redis-py Sentinel pool re-runs `discover_master` on every reconnect, so a
promoted replica is picked up without rebuilding the client.

**Ops scripts are NOT topology-aware — by design.** The seed / import /
maintenance scripts speak plain standalone Redis. Against a Cluster they would
reach only one node's slots, and against Sentinel they can land on a demoted
replica — so a wipe or `GRAPH.DELETE` would half-apply and a reindex would
silently skip shards. They all call `assert_standalone_env()` and **refuse to
run** outside standalone. Drive the change through the application (which is
topology-aware) or point them at a standalone instance.

### 7.1 Where config lives

Two layers, most-specific wins:

1. **Per-provider** — the provider record's
   `extra_config.falkordbConnection` (preferred when different providers
   use different topologies; flows through the existing provider API and
   into `FalkorDBProvider(connection_config=...)`):

   ```jsonc
   "falkordbConnection": {
     "mode": "standalone | sentinel | cluster",
     "sentinel": { "masterName": "mymaster", "nodes": [["s1", 26379], ["s2", 26379]] },
     "cluster":  { "startupNodes": [["n1", 6379], ["n2", 6379], ["n3", 6379]] }
   }
   ```

2. **Process-wide env fallback** (when the JSON is absent):
   `FALKORDB_MODE`, `FALKORDB_SENTINEL_MASTER`, `FALKORDB_SENTINEL_NODES`,
   `FALKORDB_CLUSTER_NODES` (the `*_NODES` vars accept `host:port,host:port`).

Default/absent mode = `standalone` — identical to the legacy single-host
path, so existing deployments are unaffected.

### 7.2 Behavior per mode

| Mode | Graph client | Failover |
|------|--------------|----------|
| standalone | direct pool to `FALKORDB_HOST:PORT` | breaker + worker resume |
| sentinel | rides the Sentinel master pool (auto-reresolves the promoted master) | transparent |
| cluster | routes to the node owning the graph key; on `MOVED`/connection drop the client is rebuilt against the new owner and the op retried once | transparent (`_run_guarded`) |

A *sustained* routing/connection failure trips the per-provider circuit
breaker (cluster/sentinel error classes are recognized); a single
transient `MOVED` is retried below the breaker and never surfaces.

### 7.3 Cache Redis in Cluster mode

The provider's ancestor/idempotency cache is a **separate role**
(`RedisRole.CACHE`, configured via `REDIS_CACHE_*` / legacy
`CACHE_REDIS_URL` — see
[DATA_ARCHITECTURE.md → Redis Topology & Decoupling](DATA_ARCHITECTURE.md#redis-topology--decoupling)
and [ADR-022](DECISIONS.md#adr-022-central-role-keyed-redis-config-cachestreams-independent)),
with its own host, auth, and TLS/mTLS PKI, completely independent of the
FalkorDB graph connection described above (§7.1–7.2). It uses cross-slot SCAN
and multi-key pipelines, which a single Cluster node cannot serve, so **Redis
Cluster is unsupported for the cache role** — `resolve_redis_config` rejects
it (`RedisConfigurationError`) for the same reasons Cluster is rejected for
the coordination bus: cross-slot `SCAN`/`DEL`, the bus's cross-slot `XADD`
pipelining, and a non-zero DB index (Cluster only supports DB 0). Point
`REDIS_CACHE_*` at a standalone or Sentinel dedicated Redis instead; without a
configured cache the provider runs cache-disabled (correct, slower) and logs
a loud warning. Note that the legacy URL forms (`REDIS_URL` /
`CACHE_REDIS_URL`) can only express a **standalone** endpoint — a URL
pointing at a Sentinel daemon is dialed directly as if it were the data
node; Sentinel topologies must use the structured vars
(`*_MODE=sentinel` + `*_SENTINEL_MASTER`/`*_SENTINEL_NODES`).
**Redis Cluster remains fully supported for FalkorDB itself**
— this restriction applies only to the cache role. In `dedicated` projection
mode on a FalkorDB cluster, `{graph}_proj` may live on a different shard than
`{graph}` and is routed through its own owning-node client automatically.

### 7.4 Aggregation at scale

The single resumable EXTRACT → COMPUTE → RECONCILE → APPLY pipeline is
always on (the legacy bulk/streaming strategies and their
`AGGREGATION_*_REBUILD_ENABLED` flags were removed; rollback is a version
rollback). Sizing, tuning knobs and provider-protection parameters live in
`docs/AGGREGATION_PIPELINE.md`.
5. **DNS Cutover:** Update Multi-Cluster Ingress (MCI) or global load balancer to route application traffic to the secondary region.

---

## Sizing & protection parameters

How the deployed `FALKORDB_ARGS` values are derived:

- **`THREAD_COUNT`** = ceil(pod CPU limit). **`OMP_THREAD_COUNT` = 1** — per-query
  OpenMP fan-out must not exceed the CPU limit; left unbounded, OMP sizes itself to
  the *node's* cores, and on a big node that causes CFS throttling and CPU spikes.
- **`TIMEOUT_MAX`** must be set for FalkorDB to honor per-query timeouts on WRITE
  queries (`TIMEOUT_DEFAULT` alone only covers reads). Client-side query budgets
  must stay below `TIMEOUT_MAX` or the server rejects the timeout.
- **`MAX_QUEUED_QUERIES`** bounds queue depth so stampedes fail fast with an error
  instead of building a doomed backlog behind a slow query.
- **`QUERY_MEM_CAPACITY`** kills runaway queries at the configured byte ceiling
  before the kernel OOM-kills the whole pod.
- **`maxmemory` / `maxmemory-policy noeviction`** (via `REDIS_ARGS`, not
  `FALKORDB_ARGS`): the INSTANCE-level ceiling. `QUERY_MEM_CAPACITY` bounds one
  query; only `maxmemory` bounds the dataset itself, and without it graph growth
  eventually OOM-kills the pod. Size it ~75% of the pod memory limit;
  `noeviction` makes writes fail loudly at the ceiling (FalkorDB data must never
  be silently evicted).