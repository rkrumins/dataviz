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

The provider's ancestor/idempotency cache uses cross-slot SCAN and
multi-key pipelines, which a single node cannot serve. In Cluster mode
set **`CACHE_REDIS_URL`** to a dedicated Redis; without it the provider
runs cache-disabled (correct, slower) and logs a loud warning. In
`dedicated` projection mode on a cluster, `{graph}_proj` may live on a
different shard than `{graph}` and is routed through its own owning-node
client automatically.

### 7.4 Aggregation at scale

For graphs with millions of nodes/edges, enable the constant-memory
streaming rebuild: `AGGREGATION_STREAMING_REBUILD_ENABLED=true`. It pages
leaf lineage edges on an indexed `ID(r)` cursor, flushes per page via
MERGE-on-`aggKey`, and is crash-resumable from `last_cursor` — eliminating
the full-graph count, the non-indexable cursor, and the in-memory pair
accumulation that previously timed out. `AGGREGATION_MAX_PAIRS_PER_PAGE`
bounds high-fan-in hub pages.
5. **DNS Cutover:** Update Multi-Cluster Ingress (MCI) or global load balancer to route application traffic to the secondary region.