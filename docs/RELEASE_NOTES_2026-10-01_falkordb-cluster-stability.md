# Shard pods that stay, loads that finish, and replicas that are measured — 2026-10-01

The production FalkorDB cluster — FalkorDB v4.20.6 on Redis 8.6.3, deployed from
`overlays/production-cluster` and hand-edited live to **1 master + 2 replicas per shard**
(`replicas: 3`, nine pods) — reported three things:

1. **Shard pods replaced "at random"**, each new pod showing `restartCount 0`.
2. **The 15 GB shard loading for more than an hour, to about 90%, then starting the load
   again.**
3. **Replication lag of up to ~4 GB.**

And one question: is the graph that holds **65,534 property names** — the most FalkorDB
allows — what is crashing it?

It is not. The 65,534 names crash nothing; they make every load of that graph much slower
([§1.6](#16-the-65534-property-names-not-a-crash--a-load-time-multiplier)). The three
symptoms come from five other mechanisms. They are independent of each other, each was
reproduced, and each is fixed here:

| Symptom | Mechanism | § |
|---|---|---|
| Pods replaced, `restartCount 0` | Every app deploy re-tagged the shard image and rolled every shard pod; disk-pressure eviction and node drains replaced more | [1.1](#11-why-pods-are-replaced-with-restartcount-0) |
| Every replacement costs an hour-long reload | The data directory was never on the PVC: a new container starts with an empty dataset | [1.2](#12-the-data-directory-was-never-on-the-disk) |
| The load starts again; ~4 GB of lag | A full-resync loop in the replication buffers, with no pod restart at all. It restarts a load only after the load has finished: one cut off part-way, as at ~90%, is a new pod (§1.1a, §1.1b) | [1.3](#13-the-load-that-starts-again-with-no-restart-a-full-resync-loop) |
| Replicas fall behind; masters fail over | One write arriving during a long read freezes the whole node (FalkorDB's graph lock) | [1.4](#14-one-write-during-a-long-read-freezes-the-whole-node) |
| Lagging replicas kept serving reads | The app's replica lag gate measured a number that is always 0 | [1.5](#15-the-replica-lag-gate-could-not-trip) |

This document is also the investigation report: what each mechanism is and the evidence for
it, what changed and every value that moved, a runbook that shows which mechanisms are live
in production today, the rollout for the running cluster, how to verify it, the alerts to
add, and what is deliberately not in this release.

> **Operator action is required, and a deploy alone does nothing to the shards.** By design,
> a shard pod no longer restarts when manifests are applied. The running cluster moves onto
> this release through the role-aware rollout in [§8](#8-rollout): freeze, runtime relief,
> one apply with an orphan delete, then a roll of one pod at a time by role. **Read §8 before
> running `make apply` against production.** A plain apply is refused for the three shard
> StatefulSets (`podManagementPolicy` is immutable) and for the completed init Job. It
> changes nothing on the shards, but it does change the app's read routing. There is no
> database migration.

> **How this was established.** The live cluster's history was not available: events expire
> after an hour, and a replaced pod takes its logs with it. Instead, every mechanism was
> reproduced on a harness running the production binaries:
>
> * Redis 8.6.3, built from tag `bd3b38d`;
> * the FalkorDB v4.20.6 module (`MODULE LIST` ver 42006);
> * the upstream `run.sh` and `Dockerfile` from tag v4.20.6;
> * a 4-vCPU Xeon 2.1 GHz KVM host;
> * for the Kubernetes behaviour, a real kube-apiserver and kube-controller-manager v1.37.1;
> * the Redis, FalkorDB and Kubernetes sources at those versions.
>
> Every claim below is marked with how it is known:
>
> * **measured**: reproduced, and the figure is given;
> * **source**: read in the code at that version, not reproduced;
> * **inferred**: follows from the measured and source facts, but was not observed.
>
> [§7](#7-diagnostic-runbook-which-of-these-is-happening-now) is the runbook for checking which
> of the mechanisms are live in production.

Companions, each authoritative for what it covers:

* [`deploy/k8s/overlays/production-cluster/README.md`](../deploy/k8s/overlays/production-cluster/README.md)
  covers the topology, rolling a shard by role, the orphan-delete step, maintenance
  exclusions and the new knobs.
* [`FALKORDB_DR_RUNBOOK.md`](FALKORDB_DR_RUNBOOK.md) covers `/data` as the real data
  directory, the cluster PVC names and the cluster restore procedure.
* [`FALKORDB_DEPLOYMENT.md`](FALKORDB_DEPLOYMENT.md) covers persistence (§5b, §5bb), the
  replication limits and the graph lock (§5aa), and the sizing worked example.
* [`RELEASE_NOTES_2026-09-15_falkordb-cluster-and-property-names.md`](RELEASE_NOTES_2026-09-15_falkordb-cluster-and-property-names.md)
  is the previous cluster release. [§1.4](#14-one-write-during-a-long-read-freezes-the-whole-node)
  corrects one of its claims.
* [`../CHANGELOG.md`](../CHANGELOG.md) is the per-change record.

---

## 1. What was wrong

### 1.1 Why pods are replaced with `restartCount 0`

`restartCount` counts container restarts **inside one pod object**. A container can die on
its own in two ways: the kernel OOM-kills it at its 56Gi limit, or the kubelet kills it for
failing its liveness probe. Both restart the container *in place*. `restartCount` goes up,
`lastState.terminated` says `OOMKilled` or `Error`, and the pod keeps its UID.

A pod with `restartCount 0` and a recent `creationTimestamp` is a **different pod**: something
deleted the old one, and the StatefulSet created a new one under the same name. Four things
in this deployment delete shard pods.

**a) Every app deploy** (repo inspection; the Kubernetes behaviour was measured).

* **Every deploy rolled every shard pod.**
  * `make apply` and `make deploy` pipe the whole render through
    `sed "s|:prod-latest|:$(TAG)|g"`.
  * The cluster overlay tagged the shard image `prod-latest`. So every app deploy rewrote
    the shards' image to the new git sha.
  * A changed image means a new pod template and a new ControllerRevision. Under the default
    `RollingUpdate`, the controller then replaces every pod: highest ordinal first, one at a
    time, each after the previous one is Ready.
  * Reproduced on kube-apiserver v1.37.1: `StatefulSet terminating Pod for update` for
    web-2, then web-1 only after web-2 went Ready, then web-0.
  * Ordinal -0 goes last, and it is the pod the init Job made master.
* **The same apply also deleted the `-2` pods.** The repo said `replicas: 2`, while the live
  StatefulSets had been set to 3 by hand. Applying the repo scales each shard back to 2,
  which deletes the `-2` pods. Setting 3 again by hand recreates them, empty (§1.2).
* **The same apply failed, which hid the roll.** `falkordb-cluster-init` carries the same
  image, and a completed Job's template is immutable. The apply therefore failed on it with
  `spec.template: … field is immutable` (reproduced). That error is easy to read as the
  reason the deploy "did nothing", while the StatefulSets beside it were rolling.

**b) Eviction for disk** (source; *inferred* for production).

* **The dataset was on the node's boot disk.** The data directory was on the container's
  writable layer (§1.2). So the boot disk held the 15 GB shard's AOF base and incremental,
  its 6-hourly RDB, and every full sync's temp file. The pods requested no
  `ephemeral-storage`.
* **The FalkorDB pod was first in line.** Under `DiskPressure` the kubelet ranks pods by
  usage over their request first, then by priority, then by usage. This was checked by
  running `rankDiskPressureFunc` against the v1.37.1 source. Over a request of 0, the pod
  using the most disk goes first: the FalkorDB pod.
* **Nothing protected it.** Node-pressure eviction ignores PodDisruptionBudgets and
  `terminationGracePeriodSeconds`.
* **The result is a new pod.** The evicted pod ends in phase `Failed`, and the StatefulSet
  controller deletes and recreates it, so the new pod shows `restartCount 0`.

**c) Node drains** (the Kubernetes behaviour was measured; the GKE timing is unverified).

* **A loading pod blocks drains.** GKE node upgrades and auto-repair drain through the
  eviction API, which honours the PDB (`maxUnavailable: 1` across every shard pod). A pod
  that is loading is NotReady, which holds `disruptionsAllowed` at 0. Measured:
  `{"currentHealthy":2,"desiredHealthy":2,"disruptionsAllowed":0}`. So a drain waits on an
  hour-long load.
* **The NotReady pod itself can still be evicted.** Under the default `IfHealthyBudget`
  policy this was allowed. Measured: HTTP 201.
* **GKE stops waiting.** GKE reportedly gives up after about an hour and deletes anyway. That
  figure comes from search snippets of GKE's documentation, which the harness could not
  reach, so treat it as low confidence.

**d) A pod in phase `Failed`, even under the new `OnDelete`** (measured).

* **What OnDelete still does.** `OnDelete` stops a template change from replacing pods, with
  one exception. A pod in phase `Failed` or `Succeeded` is deleted by the controller itself,
  and recreated *at the new revision*.
* **Reproduced.** A pod set to `Failed`/`Evicted` produced `SuccessfulDelete`, then a new UID
  on the new template. A kubelet eviction is exactly this case.
* **What to do.** Roll a template change promptly once it is applied; do not leave it
  pending.

**Why the evidence is gone by morning.**

* The kube-apiserver keeps events for one hour (the default `--event-ttl`).
* A replaced pod's `kubectl logs` disappear with it; `--previous` only covers a restart
  inside the same pod.
* Both survive in Cloud Logging: 30 days for events and container logs, and 400 days for
  Admin Activity audit entries such as pod deletes and evictions.
* [§7.1](#71-kubernetes-was-the-pod-replaced-or-restarted-and-by-whom) has the queries.

### 1.2 The data directory was never on the disk

**Where the data actually went.**

* Upstream `run.sh` ends with
  `exec redis-server ${REDIS_ARGS} --protected-mode no --dir "${FALKORDB_DATA_PATH}" --loadmodule …`.
* `FALKORDB_DATA_PATH` defaults to `/var/lib/falkordb/data` in the image, which is on the
  container's writable layer. The PVC is mounted at `/data`.
* Only `nodes.conf` reached the PVC, because `--cluster-config-file /data/nodes.conf` is an
  absolute path.

**Measured with a copy of the real `run.sh`:**

* `CONFIG GET dir` returned the image path. The AOF (`appendonlydir/…`) and `dump.rdb` were
  written there, and `nodes.conf` was written to the stand-in PVC.
* After `SHUTDOWN`, the image-path directory was deleted, which is what a new container
  amounts to. On restart the log said `Node configuration loaded, I'm a896900e…` and then
  `Creating AOF base file`. The node reported **`cluster_slots_assigned:16384` and
  `dbsize:0`**: it still owned every slot and held nothing.
* Putting `--dir /data` inside `REDIS_ARGS` does **not** fix it. `run.sh` adds its own
  `--dir` later, and the later one wins with no warning. Setting `FALKORDB_DATA_PATH=/data`
  does fix it, in both the TLS and the plain branch.
* The image's `/data → /var/lib/falkordb/data` compatibility link is created *inside* `/data`,
  and the PVC mount hides it.

So every replacement in §1.1, and every plain container restart too, came back with an
**empty dataset that still claimed its role**:

* **As a replica,** it full-synced: a fork on the master, the whole dataset over the wire,
  and the hour-long load.
* **As a master, it is a hazard.** If it rejoins as master before the cluster has failed it
  over, it serves its own dataset to its replicas, and they full-sync it.
  * **Measured with a stale dataset (case D2):**
    1. The master ran `SAVE`.
    2. 1,000 more writes followed, and the replica fully received them.
    3. The master was killed with `kill -9` and restarted 0.008 s later from the older RDB.

    The master came back as master:
    `Partial resynchronization not accepted: Requested offset for second ID was 20073551, but I can reply up to 19987587`.
    The replica then full-synced the stale set. The 1,000-row marker went to 0 on **both**
    nodes, and 23 of 834 acknowledged writes were lost on both.
  * *Inferred:* an empty master, the container-layer case above, does the same thing with
    nothing in it, and its replicas flush the shard. Graphs rebuild from Cloud SQL, so the
    cost is an outage and a reseed, not lost source data.
* **Held instead (case D3, measured).**
  * The same kill, with the restart held 11 s: 3 × the harness's 3 s node timeout, plus 2 s.
  * The replica won the election 4.953 s after the kill.
  * The old master came back with
    `Configuration change detected. Reconfiguring myself as a replica`, and full-synced in
    5.28 s.
  * **0 of 1,398 acknowledged writes were lost.**

**The AOF made even a surviving data directory useless for a quick restart.**

* **AOF restart (case A, measured).** A replica restarted with `appendonly yes` loads its AOF
  (`DB loaded from append only file`). It then asks for a partial resync with a **new random
  replication ID**, because the AOF stores offsets but not the ID. The master answers
  `Replication ID mismatch`, which means a full resync.
* **RDB restart (case B, measured).** The same replica restarted from an RDB, with
  `appendonly no` and `shutdown-on-sigterm save`:
  * the log said `Successful partial resynchronization with master`;
  * it was sent 17,762 bytes of backlog after 2.1 s down;
  * it was in sync 0.085 s after it started.

### 1.3 The load that starts again with no restart: a full-resync loop

No pod restarts in this loop, which is why `restartCount` never shows it. It lives in the
replication buffers on both ends of a single replica link. Source: Redis 8.6.3
`config.c:3295`, `replication.c:4000-4014` and `:4246-4266`, and the upstream
`replication-rdbchannel.tcl` tests. The defaults were read live.

| Limit (old) | Where | What happens at it |
|---|---|---|
| `client-output-buffer-limit replica 2gb 1gb 300` | master | The replica is **dropped** past 2 GB, or past 1 GB for five minutes. |
| `repl-backlog-size 1gb` | master | A reconnecting replica can be **bridged** across at most 1 GB; beyond that it full-syncs. |
| `replica-full-sync-buffer-limit` unset (`0`) | replica | While LOADING, the replica buffers the master's live stream up to its *own* replica hard limit (**2 GB**), then stops reading. |

1. **The replica falls behind and is dropped.** A rebuild writes faster than one replica
   applies, or the replica is frozen (§1.4). Its buffer on the master passes 1 GB for five
   minutes, or 2 GB. The master logs
   `Client … scheduled to be closed ASAP for overcoming of output buffer limits`.
2. **It reconnects and gets a full sync.**
   * It asks for a partial resync, but the gap is over 1 GB. The master logs
     `Unable to partial resync with replica … for lack of backlog`, then
     `Full resync requested by replica …`.
   * The master forks, streams the RDB, and the replica loads it. On the 15 GB shard that
     load takes over an hour.
3. **Writes keep coming during the load.**
   * The replica buffers them until it reaches 2 GB:
     `Replication buffer limit has been reached (… bytes), stopped buffering replication stream. Further accumulation may occur on master side.`
   * It then stops reading. The master's copy grows to *its own* 2 GB limit, and the master
     drops the link.
   * **2 GB + 2 GB ≈ the ~4 GB of lag seen live.**
4. **The load finishes, and the cycle starts over.**
   * The replica asks for a partial resync from the snapshot plus what it buffered:
     `After loading RDB, replica will try psync with master.`
   * The gap is larger than the 1 GB backlog, so it gets a **full resync** and goes back to
     step 2. The next load starts at 0, with no container restart.
   * That load ran to 100% first: a disk-based load that loses its main channel keeps
     loading (`replication.c:4246-4266`). So this loop explains a load that **starts
     again**, not one that stops at about 90%.

*Status:* source and arithmetic. The loop was not reproduced at production scale; the harness
datasets were megabytes. The figures do match the ~4 GB seen live. §7.2 shows whether the loop
is running now: look at the master's `sync_full` and its `Full resync requested by replica`
lines, and the replica's `replica_full_sync_buffer_peak`.

**A load that stops at about 90% is not explained by this loop.** The ~90% was not tied to a
counter, and nothing in the evidence cuts a load short and starts it again inside one
container. Two of §1.1's mechanisms do, each as a new pod with `restartCount 0` whose load
starts again from 0 (*inferred*):

* §1.1a, a deploy that re-tagged the image while the load ran;
* §1.1b, a disk eviction while the boot disk held the AOF, the RDB and a full sync's temp
  file.

§7.1 tells them apart. A new UID with `SuccessfulDelete` by `statefulset-controller` right
after a deploy is §1.1a. An `Evicted` event that names `ephemeral-storage` is §1.1b. The loop
keeps the pod's UID, and shows on the master as a second `Full resync requested by replica`
for the same replica and a rising `sync_full` (§7.2).

**What the new limits buy, and what they cannot.**

* A load can now absorb about **8 GB** of writes before the link is dropped: 4 GB buffered on
  the replica plus 4 GB on the master.
* A reconnect is bridged across 4 GB.
* A rebuild that writes more than that during one load **still loops**. That is why:
  * §8 holds rebuilds during a resync;
  * the load itself is made shorter (§1.6);
  * §10 alerts on a second full sync to the same replica.

### 1.4 One write during a long read freezes the whole node

**On a replica (measured).**

* FalkorDB applies a replicated write (`GRAPH.EFFECT`, because `EFFECTS_THRESHOLD 0`) by taking
  the graph's write lock with an **untimed `pthread_rwlock_wrlock` on the Redis main thread**
  (`cmd_effect.c:63`, v4.20.6).
* A read holds that graph's read lock through execution *and* reply formatting
  (`cmd_query.c:228 → :323`).
* So a write to graph `g` that arrives during a long read of `g` blocks the main thread until
  the read ends. That stops PING, INFO, every other graph, the replication stream and the
  cluster bus.

| Run | Long read | Replica PING unanswered for |
|---|---|---|
| Read only, no write (control) | 14.6 s | at most **6 ms** |
| One write to a **different** graph | 15.5 s | at most **3.1 ms** |
| One write to **the same** graph (two runs) | 15.0 s / 14.5 s | **13.9 s / 13.5 s** |
| 20 writes to the same graph (two runs) | 15.1 s / 19.8 s | **14.1 s / 18.8 s** |
| One write, 70 s read (`TIMEOUT 115000`) | 70.1 s | **69.1 s**; the master logged `Disconnecting timedout replica (streaming sync)` at 61.5 s, and the replica then resumed by PSYNC in 2 ms |

That last run used the harness's `repl-timeout` of 60 s; production uses 300 s. During a stall,
short reads sent to the replica waited 11.3–12.0 s for 0.08–0.2 ms of work, whether they were
for the same graph or an unrelated one, because the main thread could not dispatch anything.

**On a master (measured).**

* A write queued behind a long read of the same graph takes the module GIL, then waits for the
  graph write lock **while still holding the GIL** (`query_ctx.c`, `QueryCtx_AcquireWriteLock`).
* The master's PING stalled **17.8 s** behind an 18.8 s read.
* The cluster bus runs on that same main thread, and `cluster-node-timeout` is 15 s. A master
  frozen that long is therefore marked failing and **failed over in the middle of the read**.
  *Inferred:* the measurement was on a standalone master and replica, and the failover follows
  from the bus sharing the thread.

**The timeout does not bound it (measured).**

* FalkorDB's `TIMEOUT` is cooperative:
  * a scan with `TIMEOUT 50` stopped after about 56 ms;
  * a single-expression query ran its full 1,728 ms before `Query timed out`.
* Neither plan-time constant folding nor reply formatting is covered by the timeout.
* The lock is released only after the reply. One read with `TIMEOUT 50` held it for 3,499 ms;
  the write behind it waited 3,194 ms, and PING waited 3,147 ms.

**There is no upstream fix.**

* v4.20.7's lock code is byte-identical to v4.20.6.
* v4.22.0 and master still take an untimed write lock in `GRAPH.EFFECT`.
* A v6.0.0 tag could not be fetched.

> **Correction to [2026-09-15 §2.1](RELEASE_NOTES_2026-09-15_falkordb-cluster-and-property-names.md#21-every-query-budget-derives-from-the-failure-detector).**
> That section said a long read "cannot cause that [a failover] at all — FalkorDB dispatches
> `GRAPH.*` to a module thread pool and the main thread goes on answering the cluster bus".
> On FalkorDB 4.20.6 that is wrong. A read on its own does not block the main thread (the
> control row above). But **a read plus any write to the same graph freezes the node for the
> rest of the read**, and on a master that lasts past the failover window. This release does
> not clamp reads to the write ceiling. Instead it takes reads off the masters
> (`FALKORDB_MASTER_READ_SHARE 0`) and off the replica that has to win failovers (§4). The same
> sentence in `AGGREGATION_PIPELINE.md` and in two code comments is corrected by this change.

**A stalled read replica also slipped past the router (measured).**

* The app excluded it only because its 1-second INFO probe timed out.
* A provider that had sampled just before the stall kept routing reads to it until its
  5-second sample expired (observed at a cache age of 4.87 s).
* Those reads block until their budget runs out. A deadline then puts the replica in the
  penalty box for 30 s, and the read is not re-run on the master.

### 1.5 The replica lag gate could not trip

The router vouches for a replica only if it is within `FALKORDB_REPLICA_READ_MAX_LAG_BYTES`
(8 MiB) of its master. It computed that lag from the **replica's own** `INFO`:
`master_repl_offset − slave_repl_offset`. Redis advances both of those offsets in the same step
as it applies each command from the master (`networking.c` `commandProcessed` →
`replicationFeedStreamFromMasterStream`). The figure is therefore 0 by construction.

* **Measured:** 0 in every answered replica sample across all runs.
  * That includes 20,331 polls during a bulk write, while the **master** saw the same replica
    **31,200,314 bytes** behind.
  * It read 0 again the instant a 14 s stall ended.
* **Measured against the old code:** a real provider vouched for a replica that its master
  saw 200 MiB behind (in-process). On the harness it also vouched for a replica 12,583,948
  bytes behind, with its link up.
* **Measured against the new code:** it refuses that replica, routes the read to the master,
  and vouches for the replica again once it catches up.
* The Admin → Graph store topology page used the same figure. It always said "in step" and
  never raised `replica_behind`.
* The test doubles built each replica's self-report from the **master's** offset, which real
  Redis never produces. Once the doubles are honest, three behaviour tests fail against the old
  code.

### 1.6 The 65,534 property names: not a crash — a load-time multiplier

**Not a crash (measured).**

* A 65,535th name is refused, in every form tried: `SET n.x`, `CREATE (:N {x:1})` and
  `SET n += $m`.
* The error is exactly
  `Max number of attributes exceeded, graph does not support more than 65534 unique attribute names`,
  and the graph is left unchanged.
* Nothing restarts.

**The load is single-threaded, and more cores will not shorten it (measured).** An RDB load
runs on Redis's main thread: process CPU at ready was 91.48 s against 91.31 s of wall time.
`THREAD_COUNT` sizes FalkorDB's query pool, which a load does not use, so neither it nor more
vCPUs shortens a reload. What does:

* fewer virtual keys per graph (`VKEY_MAX_ENTITY_COUNT`, below): most of a wide graph's load;
* fewer property names: recreate the wide graph (phase 5);
* `DELAY_INDEXING yes`: the index build moves to a background thread after the load;
* no second load at all: a restart that resumes by PSYNC loads only its own RDB, where a full
  resync then transfers and loads the master's (§1.2);
* *inferred:* a faster core.

**A multiplier on every load (measured).**

* An RDB stores a graph as one *virtual key* per `VKEY_MAX_ENTITY_COUNT` entities (default
  100,000).
* **Every virtual key carries the whole property-name table.** The loader re-parses it with a
  linear `strcmp` lookup per name.
* That is O(N²) per key, on the main thread, with no yield.

| Graph (1M nodes + 200k edges) | Virtual keys | Load time (two runs) | Longest PING silence |
|---|---|---|---|
| 50 names | 12 | **0.42 s** | none beyond the 0.5 s sample interval |
| 65,534 names, default `VKEY_MAX_ENTITY_COUNT` | 12 | **91.3 s / 96.3 s** | **8.2 s / 9.4 s**; the server answers about once per virtual key |
| 65,534 names, `VKEY_MAX_ENTITY_COUNT 100000000` at save time | **1** | **7.96 s / 7.66 s** | 7.1 s / 6.8 s |

**Per-key cost at 65,534 names:**

* mean 7.85 s, median 7.50 s, range 5.9–11.6 s over 74 keys;
* the entities themselves decoded in 0.3 s.

**Cost per key as the name count N grows:**

| N | Header cost per key |
|---|---|
| 4,096 | 31 ms |
| 16,384 | 0.47 s |
| 32,768 | 1.70 s |
| 65,534 | 7.37 s |

Doubling N quadruples the cost.

**Only the writer of the RDB decides the key count.** The setting is read only by the server
that **writes** the RDB:

* a BGSAVE;
* a shutdown save;
* from source, not measured: the RDB a master streams for a full sync.

A loader, whatever its own setting, loads the key count the file has.

**Extrapolation** (*inferred*). Assumptions:

* the cost is linear in the key count (checked only at 1, 12 and 14 keys);
* this CPU;
* names of about 40 characters;
* deleted entities count toward the key count (from source).

| Entities in the wide graph (nodes + edges) | Keys at the default | Name-table cost per load | With `VKEY_MAX_ENTITY_COUNT 100000000` |
|---|---|---|---|
| 1.2M (measured) | 12 | 91–96 s | 7.7 s |
| 5M | 50 | ~6.5 min | ~7.5 s + ~1.3 s of entities |
| 10M | 100 | ~13 min | ~7.5 s + ~2.5 s |
| 25M | 250 | ~33 min | ~7.5 s + ~6 s |
| 50M | 500 | ~65 min | ~7.5 s + ~13 s |

**What that means for the 15 GB shard.** If the wide graph lives on that shard and holds tens
of millions of entities, its name table alone is most of the hour-long load. That hour is
exactly what step 3 of §1.3 needs in order to overflow. Count the graph's entities (§7.4)
before drawing a conclusion.

**`DELAY_INDEXING yes` moves the index build out of the load.**

* On a 3M-node graph with an index, time to ready fell from 14.0 s to 1.36 s.
* The index became OPERATIONAL about 13 s later.
* Queries stayed correct meanwhile, but ran as label scans: 283–290 ms instead of 0.17 ms for a
  point lookup.
* On the wide graph it saved only the ~3.7 s index build, which is noise next to the name
  table.

**What the setting does not do.**

* A single key still parses the table once: about 7.5 s at this N, with PING silent the whole
  time.
* Names are never freed. **The graph at the ceiling still has to be recreated:** see
  [2026-09-15 §8 step 6](RELEASE_NOTES_2026-09-15_falkordb-cluster-and-property-names.md#8-rollout).
* Memory is not the problem: the wide name table added about 3.9 MB to the load peak.

---

## 2. What changed — the shard pods

Everything here is in `resources/falkordb-cluster-statefulsets.yaml` unless noted. The three
shard documents in that file are identical except for the name.

**The repo topology now matches the live one.**

* `replicas: 3` gives 3 × (1 master + 2 replicas) = 9 pods on the 9-node pool.
* The init Job attaches both `-1` and `-2` to their shard's `-0`.
* `-2` is the **read replica**: the only replica the app reads from (§4).
* The other replica is a **no-read hot standby**. It never waits on a reader's lock, so it
  stays in step and wins a failover by offset rank.

**The image is pinned.**

* The tag is set by `newTag: v4.20.6-1` in `kustomization.yaml`. None of the Makefile's seds
  touch that tag.
* It is built and pushed only by the new `make build-falkordb-cluster push-falkordb-cluster`
  (`FALKORDB_CLUSTER_TAG ?= v4.20.6-1`). The `build` and `push` aggregates leave it out.
* An app deploy no longer changes the shard template or the init-Job template.
* The Dockerfile is the same as before: `data/quickstart/Dockerfile.falkordb`,
  `FROM falkordb/falkordb:v4.20.6`. Its baked-in quickstart `dump.rdb` sits in
  `/var/lib/falkordb/data`, and is not read now that the data directory is `/data`.

**`updateStrategy: OnDelete`.**

* No apply restarts a shard pod.
* Each pod takes the new revision only when it is deleted. The README's role-aware roll does
  that one pod at a time.
* The `Failed`-pod exception from §1.1d still applies.

**`podManagementPolicy: Parallel`.**

* `OrderedReady` would not recreate a missing `-2` while `-0` was NotReady. Reproduced:
  `StatefulSet is waiting for Pod to be Running and Ready`. A loading pod is NotReady for up
  to an hour.
* This field is **immutable** on a live StatefulSet. Phase 2 of §8 is the orphan delete that
  changes it without restarting a pod.

**`FALKORDB_DATA_PATH=/data`.** The RDB, the sync files and `nodes.conf` are all on the PVC.

**An entrypoint wrapper** (`command`, in POSIX `sh`). It ends with
`exec /var/lib/falkordb/bin/run.sh`, so `redis-server` keeps PID 1. Before that it does two
things:

1. **The startup hold.** If `/data/nodes.conf` has a `myself,master` line **with slots**, it
   sleeps **45 s** (3 × `cluster-node-timeout`) before starting. This is the D3 hold from
   §1.2. Two cases do not wait:
   * a master that handed over in `preStop` (its line says `myself,slave`);
   * a fresh master with no slots.

   The hold traps SIGTERM, so a stop during it exits at once. The wrapper is PID 1, which
   drops any signal it has no handler for: a bare `sleep` lost the SIGTERM, and Redis started
   anyway, to be killed at the end of the grace period with no shutdown save (reproduced
   with `dash` as PID 1).
2. **`rm -f /data/temp-*.rdb`.** These are partial files from a killed BGSAVE or sync. Each
   can be as large as the dataset, and none is ever read again.

**A `preStop` hand-over.**

1. On a master, it reads `INFO replication` and picks the `online` **standby** with the
   highest offset, whatever `-2`'s offset. It picks the `-2` read replica only when no
   standby is online: a `-2` master leaves its shard no allowlisted replica, so the other
   replicas take its reads and there is no no-read standby until the role is handed back (§13). `INFO` names replicas by `ip:port` and `CLUSTER NODES` by
   hostname; the script joins the two, and matches `-2` with the app's own
   `FALKORDB_REPLICA_READ_HOSTS` pattern. Picked by offset alone, an idle tie went to
   whichever replica `INFO` listed first (reproduced).
2. It sends that replica `CLUSTER FAILOVER`, under `timeout`.
3. It waits up to about 30 s to see itself demoted.

It always exits 0: a failed hand-over still stops, and the cluster then fails over the slow
way. Verified on the harness: the roles swapped in about a second, and `nodes.conf` turned to
`myself,slave`.

**`terminationGracePeriodSeconds: 300`** (was 120). It covers the hand-over, then the shutdown
RDB save that lets the restart resume by PSYNC.

**Probes.**

| Probe | Checks | Timing | Why |
|---|---|---|---|
| startupProbe (new) | `PONG` or `LOADING` | 10 s × 60 | Covers the hold and process start. Liveness waits for it. |
| liveness | `PONG` or `LOADING` | 10 s timeout × **18** = 180 s (was × 6, after a 60 s delay) | Outlasts a graph-lock freeze (§1.4), which can reach the 120 s `TIMEOUT_MAX` and go past it, and outlasts a wide graph's silent virtual keys. |
| readiness | `PONG` **and** either `role:master` or `master_link_status:up` | unchanged | A replica answers PONG all through a full sync. During the RDB-channel handshake `master_sync_in_progress` still reads 0 (measured), so neither was a readiness signal. NotReady also holds the PDB (§13). |

**`priorityClassName: falkordb-cluster`.**

* It is defined in the new `resources/falkordb-cluster-priority-class.yaml`: value 1,000,000,
  `PreemptLowerPriority`, not the global default.
* Priority is the second key in the kubelet's eviction ranking, and it lets the pod preempt
  others when it is rescheduled.
* It ranks below `system-*-critical`.

**`ephemeral-storage`: request 2Gi, limit 8Gi.**

* The container layer now holds only logs.
* The request ranks the pod last under DiskPressure.
* The limit is a tripwire. If the dataset ever lands on the layer again, the pod is evicted
  with a reason that names `ephemeral-storage`.

## 3. What changed — replication and persistence

These are changes to `REDIS_ARGS` and `FALKORDB_ARGS` on the shards. The single-node base keeps
its AOF (§13).

**Persistence is now RDB + PSYNC, with AOF off.**

* `--appendonly no`. The `appendfsync`, `aof-load-truncated` and `auto-aof-rewrite-min-size`
  flags are removed.
* `--shutdown-on-sigterm save`.
* `--save 21600 1` is kept as a floor.
* Measured in a FalkorDB cluster (cases B, C and E1), these all resumed by **partial**
  resync, 0.085–0.117 s after start on 200k-node graphs:
  * a replica restart;
  * a `CLUSTER FAILOVER` hand-over, and the demoted master's restart;
  * a replica killed with `kill -9`, restarting with the RDB of its last full sync.

  In production the RDB load comes on top of that time.
* A master restarted before the cluster failed it over also resumed by PSYNC (case D1).
  On the production cluster the startup hold deliberately gives that up for safety: a master
  that stops without handing over is held, and rejoins through a full resync. The `preStop`
  hand-over is what keeps a planned stop on the PSYNC path.
* A replica keeps the RDB of its last full sync (`rdb-del-sync-files no`). So even an unclean
  replica restart resumes by PSYNC, as long as the 4 GB backlog covers the gap.
* The one RDB that must not be served is a killed master's. The startup hold keeps it from
  rejoining as master.

**Replication limits.**

* `--repl-backlog-size 4gb`.
* `--client-output-buffer-limit replica 4gb 0 0`. The soft limit is off, so a replica is never
  dropped for being 1 GB behind for five minutes during a rebuild.
* `--replica-full-sync-buffer-limit 4gb`, stated explicitly instead of inherited.
* §1.3 covers what they buy.

**`--cluster-allow-replica-migration no`.** With two replicas per master and
`cluster-migration-barrier 1`, a replica could otherwise move itself to another shard's
orphaned master. That would take it away from its PVC's dataset, its DR target and the read
allowlist.

**`--maxmemory 28gb`** (was 32gb). This is what the larger buffers cost inside the same 56Gi
(§6.2).

**Module args `VKEY_MAX_ENTITY_COUNT 100000000 DELAY_INDEXING yes`** (§1.6). Both values were
accepted at startup and read back on Redis 8.6.3 with FalkorDB 4.20.6, through the real
`run.sh` with the manifest's exact args.

## 4. What changed — the read router (app)

**Lag is measured against the master** (`falkordb_provider._vouched_replicas`).

* Lag is the master's `replOffset` minus the replica's `replOffset`. It counts only when the
  replica's `replId` matches the master's `replId` or `replId2`, because offsets from two
  different histories mean nothing together.
* `info_parse.replication_stats` now exposes `replId` and `replId2`. Its replica-side
  `lagBytes` is kept for compatibility, and is documented as *not a lag*.
* **Where the master's offset comes from:**
  * this sample, when the master answered as a master that is not loading;
  * otherwise, the last sample in which it did (`_repl_master_seen`). That figure only falls
    behind the master's real offset, so a lag against it is a lower bound. Past
    `_REPLICA_VOUCH_MAX_AGE_S` (15 s) it can still exclude a replica (over budget stays over
    budget), but no longer admit one: an in-budget lag that old is unknown;
  * otherwise, the lag is unknown.
  * A **busy** master, one that takes the connection and misses the 3 s sample deadline,
    gets none of this. Its probe and the whole sample share that deadline, and the sample's
    fires first and discards the replicas' answers too. Nothing is vouched and the master
    keeps the shard's reads (measured live: `None` after 3.0 s).
* **The strict path** (master present). A replica needs a *known* lag within the 8 MiB budget,
  its link up, and no sync in progress.
* **The relaxed path** (master silent or loading, and the vouch still current).
  * The link and sync requirements are dropped.
  * A known lag still has to fit the budget.
  * An unknown lag is waved through. That is what keeps reads up during a failover.
* The cache is cleared on a failover rebuild.

**`FALKORDB_REPLICA_READ_HOSTS`** (new, optional).

* A regex, matched with `re.search` against each candidate's host as the client addresses it.
* It is a **preference, not a filter.** Every usable replica is still probed and vouched for.
  Reads go to the in-step replicas that match; only when none of them qualifies (it is
  loading, syncing, behind, or benched after a timeout) do the other in-step replicas take
  them: the standby, not the master, because the same lock wait on a master holds the GIL
  (§1.4).
* Unset or blank: every in-step replica may serve reads, as before.
* An invalid regex logs a warning and is ignored, which falls back to today's routing.
* The cluster overlay sets `'^falkordb-shard-[0-9]+-2\.'`.

**`FALKORDB_MASTER_READ_SHARE: "0"`** in the cluster overlay. The knob already existed, and its
code default stays 1. At 0 the master takes no slot in the read rotation.

**No replica read cap, and no re-run on the master** of a replica read that timed out. Both
are deliberate (§13).

**Admin → Graph store** now derives each replica's `lagBytes` from its master's reading, by the
same rule (`topology._lag_from_master`). When the lag cannot be measured it shows nothing
(None), never 0, so `replica_behind` can now fire.

**Two comments corrected.** One called `FALKORDB_REPLICA_READ_MAX_LAG_BYTES` "(seconds)". The
class comment said every replica error is re-run on the master.

## 5. What changed — DR, deploy and network

**The DR snapshot picks a live replica.** The files are
`overlays/production/resources/falkordb-dr-backup.yaml` and the cluster patch.

* Each comma-separated field of `FALKORDB_BACKUP_TARGETS` is now a `|`-separated list of
  candidates.
* The script reads each candidate's `INFO replication persistence` and SYNCs the first one
  that:
  * answers;
  * is not loading;
  * is a replica with its link up, when `FALKORDB_BACKUP_REPLICA_ONLY=1`;
  * has no fork running.

  It logs why it skipped each candidate it passed over.
* The cluster patch lists `-1|-0|-2` for each shard: the standbys first, and the read replica
  last because it may be frozen behind a long read. It sets `FALKORDB_BACKUP_REPLICA_ONLY: "1"`.
* Before, the patch named only the `-1` pods. After any failover a `-1` is the master, which
  the backup then forked.
* If no replica is eligible, the run fails for that shard and lists every reason, rather than
  forking a master.
* The single instance keeps `falkordb:6379`, with the flag unset.

**A new NetworkPolicy, `falkordb-cluster`.**

* The base `allow-backends-to-falkordb` selects `app.kubernetes.io/name: falkordb`, which no
  shard pod carries.
* The new policy admits port 6379 from the api, controlplane and worker components, seed, the
  DR backup, the init Job and the shards themselves.
* It admits port 16379 (the cluster bus) from the shards only.
* It is inert until NetworkPolicy enforcement is turned on. Once enforcement is on, it only
  adds access, because the base `default-deny-ingress` already selects every pod.

**The init Job** attaches both replicas. Its header says a completed Job must be deleted
before a changed one is re-applied.

**The Makefile** gains `FALKORDB_CLUSTER_TAG`, `build-falkordb-cluster` and
`push-falkordb-cluster`.

---

## 6. Values that changed

### 6.1 Shard configuration

| Value | Was | Now | Why |
|---|---|---|---|
| Shard image tag | `prod-latest`, rewritten to the git sha by every `make apply` | **`v4.20.6-1`**, pinned | Every app deploy replaced every shard pod (§1.1a). |
| `replicas` (per shard StatefulSet) | 2 in the repo (3 live, set by hand) | **3** | The repo now describes the running topology, and applying it no longer deletes the `-2` pods. |
| `updateStrategy` | `RollingUpdate` (default) | **`OnDelete`** | A template change never restarts a shard pod. |
| `podManagementPolicy` | `OrderedReady` (default) | **`Parallel`** | A loading `-0` blocked recreating `-2`. Immutable: changing it needs an orphan delete. |
| `FALKORDB_DATA_PATH` | unset, so `/var/lib/falkordb/data` (the container layer) | **`/data`** (the PVC) | §1.2. |
| `--appendonly`, with `appendfsync everysec`, `aof-load-truncated yes` and `auto-aof-rewrite-min-size 512mb` | `yes` | **`no`**, and those flags removed | An AOF restart can never PSYNC. |
| `--shutdown-on-sigterm` | default | **`save`** | The RDB written at SIGTERM is what a restart PSYNCs from. |
| `--save` | `21600 1` | `21600 1` (unchanged) | A floor; each save is a fork. |
| `--repl-backlog-size` | `1gb` | **`4gb`** | Bridges 4 GB of writes instead of 1 GB. |
| `--client-output-buffer-limit` | `replica 2gb 1gb 300` | **`replica 4gb 0 0`** | Drop a replica only past 4 GB, with no soft limit. |
| `--replica-full-sync-buffer-limit` | unset (inherits 2 GB) | **`4gb`** | What a loading replica may buffer, stated explicitly. |
| `--cluster-allow-replica-migration` | `yes` (default) | **`no`** | No replica moves itself to another shard. |
| `--maxmemory` | `32gb` | **`28gb`** | Pays for the larger buffers (§6.2). |
| `VKEY_MAX_ENTITY_COUNT` (module arg) | 100000 (default) | **100000000** | One virtual key per graph, so one name-table parse per load (§1.6). |
| `DELAY_INDEXING` (module arg) | no (default) | **yes** | The index is built after the load, in the background. |
| `terminationGracePeriodSeconds` | 120 | **300** | Room for the hand-over and the shutdown save. |
| `startupProbe` | none | **`PONG` or `LOADING`, 10 s × 60** | Covers the 45 s hold. |
| `livenessProbe` | 60 s delay, 10 s × 6 | **no delay, 10 s × 18** | Outlasts a graph-lock freeze. |
| `readinessProbe` | `PONG` | **`PONG`, and either `role:master` or `master_link_status:up`** | A syncing replica is not ready. |
| `preStop` | none | **`CLUSTER FAILOVER` to the most caught-up online standby; to `-2` only if no standby is online** | A planned stop becomes a hand-over instead of a 15 s outage. |
| Startup hold | none | **45 s**, when `nodes.conf` says `myself,master` with slots | Case D3 (§1.2). |
| `priorityClassName` | none (priority 0) | **`falkordb-cluster`** (1,000,000) | Eviction ranking and preemption. |
| `ephemeral-storage` | none | **2Gi request, 8Gi limit** | Ranked last under DiskPressure; the limit is a tripwire. |

### 6.2 The sizing rule, redone

The rule is `shard_capacity.container_memory_needed`. A test now evaluates it against the
manifest's own arguments (`test_the_shipped_shard_fits_its_own_sizing_rule`).

| Term | Was | GiB | Now | GiB |
|---|---|---:|---|---:|
| Dataset | 1.25 × 32gb | 40.0 | 1.25 × 28gb | **35.0** |
| Query memory | 6 × 1.3 × 1gb | 7.8 | 6 × 1.3 × 1gb | 7.8 |
| Replication backlog | 1gb | 1.0 | 4gb | **4.0** |
| Replica buffers | 2 × 2gb hard | 4.0 | 2 × 4gb hard | **8.0** |
| Server overhead | instance ≥ 32 GiB | 1.0 | < 32 GiB | **0.25** |
| **Needed** | | **53.8** | | **55.05** |
| Limit | | 56 | | 56 (0.95 spare) |

* **Other settings would not fit.** 32gb with the new buffers would need 60.8 GiB, and 29gb
  would need 56.3 GiB.
* **There is no thread of headroom any more.**
  * `THREAD_COUNT 7` would need 56.35 GiB.
  * When a node does not report its thread count, the in-app guard falls back to
    `THREAD_COUNT_ASSUMED` 8. At 8 the figure is 57.65 GiB, so the guard refuses.
* **The backlog counts against `maxmemory`.** Once the 4 GiB backlog has filled, it counts
  against `maxmemory`; only replica-buffer bytes beyond it are exempt (Redis `evict.c`). A
  shard therefore needs `used_memory + 4 GiB < 28 GiB` before this lands.

### 6.3 App and deploy

| Value | Was | Now | Why |
|---|---|---|---|
| Replica lag | The replica's own `master_repl_offset − slave_repl_offset` (always 0) | **The master's offset minus the replica's**, for the same `replId` history only; unknown if there is no master reading from the last 15 s | §1.5. |
| `FALKORDB_REPLICA_READ_HOSTS` | none | Unset means every replica; the cluster overlay sets **`'^falkordb-shard-[0-9]+-2\.'`** | One read replica per shard; the other is a standby. |
| `FALKORDB_MASTER_READ_SHARE` | 1 (code default) | **0** in the cluster overlay; the code default is unchanged | A read plus a write on a master freezes it past the failover window. |
| Admin topology replica `lagBytes` | The replica's own figure (0) | **Derived from the master, or none** | §1.5. |
| `FALKORDB_BACKUP_TARGETS` (cluster) | `falkordb-shard-N-1` | **`-1\|-0\|-2` for each shard** | The role is read live; the master is never forked. |
| `FALKORDB_BACKUP_REPLICA_ONLY` | none | **`1`** on the cluster; unset on the single instance | Makes a master ineligible on the cluster. |
| `FALKORDB_CLUSTER_TAG` (Makefile) | none | **`v4.20.6-1`** | The pinned shard image tag. |

These are unchanged and still binding:

* `FALKORDB_REPLICA_READ_MAX_LAG_BYTES` 8 MiB
* `_REPLICA_SAMPLE_S` 5 s
* the 1 s replica probe
* the 30 s penalty
* `cluster-node-timeout` 15000
* `TIMEOUT_MAX` 120000
* `THREAD_COUNT 6`
* the 56Gi limit

---

## 7. Diagnostic runbook: which of these is happening now

Run these **before changing anything**. Phase 0 of §8 starts by capturing their output.

* The namespace is `synodic`. Every shard pod carries `app.kubernetes.io/part-of=falkordb-cluster`.
* The pods' `REDISCLI_AUTH` env already carries the password if one is set. The helper below
  uses it and guards against an empty value, the same way the probes do.

```bash
NS=synodic
SHARDS=$(kubectl -n $NS get pods -l app.kubernetes.io/part-of=falkordb-cluster -o name | sed 's|pod/||')
rc() { kubectl -n $NS exec "$1" -- sh -c '[ -n "$REDISCLI_AUTH" ] || unset REDISCLI_AUTH; timeout 20 redis-cli '"$2"; }
```

`timeout 20` matters on a node that is loading a wide graph: it answers only between virtual
keys (§1.6).

### 7.1 Kubernetes: was the pod replaced or restarted, and by whom

```bash
# A replaced pod has a new UID, a recent CREATED and RESTARTS 0. A restarted
# container keeps its UID and increments RESTARTS, and LAST names why.
kubectl -n $NS get pods -l app.kubernetes.io/part-of=falkordb-cluster -o custom-columns=\
'NAME:.metadata.name,UID:.metadata.uid,CREATED:.metadata.creationTimestamp,RESTARTS:.status.containerStatuses[0].restartCount,LAST:.status.containerStatuses[0].lastState.terminated.reason,REV:.metadata.labels.controller-revision-hash,NODE:.spec.nodeName'

# One ControllerRevision per template the StatefulSet has had. Many recent ones,
# each with a different image, means every deploy changed the template (§1.1a).
for s in 0 1 2; do
  kubectl -n $NS get controllerrevisions -l app.kubernetes.io/name=falkordb-shard-$s -o custom-columns=\
'NAME:.metadata.name,REV:.revision,CREATED:.metadata.creationTimestamp,IMAGE:.data.spec.template.spec.containers[0].image'
done
kubectl -n $NS get sts -l app.kubernetes.io/part-of=falkordb-cluster -o custom-columns=\
'NAME:.metadata.name,REPLICAS:.spec.replicas,STRATEGY:.spec.updateStrategy.type,POLICY:.spec.podManagementPolicy,CURRENT:.status.currentRevision,UPDATE:.status.updateRevision'

# Events: the apiserver keeps them for ONE HOUR.
kubectl -n $NS get events --sort-by=.lastTimestamp | grep -E 'falkordb-shard' \
  | grep -E 'Evicted|Killing|SuccessfulDelete|SuccessfulCreate|Preempt|Unhealthy|FailedPreStopHook'

# Disk pressure, and nodes that are younger than they should be (an upgrade or repair replaced them).
kubectl get nodes -l dedicated=falkordb -o custom-columns=\
'NAME:.metadata.name,CREATED:.metadata.creationTimestamp,DISK:.status.conditions[?(@.type=="DiskPressure")].status,MEM:.status.conditions[?(@.type=="MemoryPressure")].status'
gcloud container node-pools describe falkordb-pool --cluster <CLUSTER> --region <REGION> \
  --format='value(config.diskSizeGb,config.diskType,management.autoUpgrade,management.autoRepair)'
```

**In Cloud Logging.** Events and container logs are kept for 30 days in the `_Default` bucket,
and Admin Activity audit entries for 400 days. Substitute your project.

```
# Events about the shard pods and StatefulSets (these outlive the one-hour TTL).
logName="projects/PROJECT_ID/logs/events"
jsonPayload.involvedObject.namespace="synodic"
jsonPayload.involvedObject.name=~"^falkordb-shard-"
jsonPayload.reason=("Evicted" OR "Killing" OR "SuccessfulDelete" OR "SuccessfulCreate" OR "Preempted" OR "Unhealthy" OR "FailedPreStopHook")

# Who deleted or evicted a shard pod, and who changed a shard StatefulSet.
logName="projects/PROJECT_ID/logs/cloudaudit.googleapis.com%2Factivity"
resource.type="k8s_cluster"
protoPayload.resourceName=~"namespaces/synodic/(pods|statefulsets)/falkordb-shard-"
protoPayload.methodName=~"pods\.delete|pods\.eviction\.create|statefulsets\.(patch|update|delete|create)"

# GKE operations on the FalkorDB node pool (upgrades, repairs).
resource.type="gke_nodepool"
resource.labels.nodepool_name="falkordb-pool"

# The kubelet's own eviction decisions, if node logs are collected.
logName="projects/PROJECT_ID/logs/kubelet"
"eviction"
```

`protoPayload.authenticationInfo.principalEmail` names the actor:

* `system:serviceaccount:kube-system:statefulset-controller` is a rolling update, a
  scale-down, or the controller replacing a `Failed` pod;
* `system:node:…` is the kubelet;
* a GKE service account is a drain during an upgrade or repair;
* anything else is a person or a pipeline.

`gcloud container operations list --region <REGION> --filter='targetLink~falkordb-pool'` lists
node-pool operations such as `UPGRADE_NODES`, `AUTO_UPGRADE_NODES` and `AUTO_REPAIR_NODES`.
*GKE's log names and operation types were not checked against GKE's documentation here,
because the harness could not reach it. If a filter returns nothing, narrow it to the
resource type and search the text.*

| You see | It is |
|---|---|
| RESTARTS 0, a recent CREATED, several ControllerRevisions with different images, and deletes by `statefulset-controller` right after a deploy | §1.1a, the deploy re-tag |
| RESTARTS 0, and an `Evicted` event: `The node was low on resource: ephemeral-storage … Container falkordb was using …, request is 0` | §1.1b, a disk eviction |
| RESTARTS 0, the node's CREATED is recent or a GKE operation ran on `falkordb-pool` | §1.1c, a drain |
| RESTARTS ≥ 1, LAST `OOMKilled` | The container hit its memory limit. Check §6.2 and the replica-buffer terms. |
| RESTARTS ≥ 1, `Unhealthy … Liveness probe failed`, then `Killing` | A freeze over 60 s under the old probe (§1.4). With the old data directory, the container came back empty (§1.2). |

### 7.2 Redis: data directory, persistence and replication

```bash
for p in $SHARDS; do
  echo "== $p"
  rc $p 'CONFIG GET dir'          # /var/lib/falkordb/data means the container layer: §1.2 is live
  rc $p 'CONFIG GET appendonly'
  rc $p 'INFO persistence' | grep -E '^(loading|loading_loaded_perc|loading_eta_seconds|aof_enabled|rdb_last_save_time|rdb_last_bgsave_status|rdb_bgsave_in_progress):'
  rc $p 'INFO stats'       | grep -E '^(sync_full|sync_partial_ok|sync_partial_err):'
  rc $p 'INFO replication' | grep -E '^(role|master_link_status|master_link_down_since_seconds|master_sync_in_progress|master_current_sync_attempts|master_total_sync_attempts|replica_full_sync_buffer_size|replica_full_sync_buffer_peak|connected_slaves|slave[0-9]+|master_repl_offset|repl_backlog_size):'
  kubectl -n $NS exec $p -- sh -c 'df -h / /data | tail -n 2; ls -la /data /var/lib/falkordb/data 2>/dev/null'
done

# On each MASTER: how far behind each replica is, as the master sees it.
# behind_bytes is the real lag (§1.5). last_ack_s above 1-2 means the replica
# is not acknowledging: it is frozen (§1.4) or gone. Map ip to a pod with
# kubectl get pods -o wide.
rc <master-pod> 'INFO replication' | tr -d '\r' | awk -F'[:,=]' '
  /^slave[0-9]+:/ {n++; ip[n]=$3; st[n]=$7; off[n]=$9; ack[n]=$11}
  /^master_repl_offset:/ {m=$2}
  END {for (i = 1; i <= n; i++) printf "%s state=%s behind_bytes=%d last_ack_s=%s\n", ip[i], st[i], m - off[i], ack[i]}'
```

| Field | What it means |
|---|---|
| `dir` = `/var/lib/falkordb/data` | §1.2 is live: this pod's dataset dies with its container. |
| master `sync_full` (since the process started) | Every full resync this master has served: a fork, the dataset over the wire, and an hour on the other end. |
| master `sync_partial_err` | Partial resyncs refused: the backlog did not cover the gap (§1.3), or the ID did not match after an AOF restart (§1.2). |
| replica `master_current_sync_attempts` ≥ 2 | The replica has retried reaching its master. It counts connection attempts, not full syncs: a master stopped for 4 s showed 5 (measured). It is the §1.3 loop only together with a second `Full resync requested by replica` for it on the master, or the master's `sync_full` rising again. |
| replica `replica_full_sync_buffer_peak` near 2 GB (old) or 4 GB (new) | A load's buffer reached its limit (§1.3 step 3). Never reset while the process lives. |
| `loading:1`, with `loading_loaded_perc` back near 0 | A new load has started. |
| `master_link_status:down` with `master_sync_in_progress:0` | Possibly waiting on the RDB channel for a full sync. This is not "fine" (measured). |
| master's `slaveN … state=wait_bgsave` or `send_bulk_and_stream` | A full sync to that replica is in progress. |

**Log lines.** These are container logs. For a replaced pod they exist only in Cloud Logging,
under `resource.type="k8s_container" resource.labels.namespace_name="synodic"
resource.labels.container_name="falkordb"`, plus the text. Every line below is exact text from
the Redis 8.6.3 or FalkorDB 4.20.6 source:

| Line | Node | Means |
|---|---|---|
| `Disconnecting timedout replica` | master | The replica was silent past `repl-timeout`. It is frozen (§1.4). |
| `scheduled to be closed ASAP for overcoming of output buffer limits` | master | The replica was dropped at the output-buffer limit (§1.3). |
| `Unable to partial resync with replica … for lack of backlog` | master | The backlog did not cover the gap, so a full sync follows. |
| `Partial resynchronization not accepted: Replication ID mismatch` | master | A node came back with a new replication ID: an AOF restart, or a held ex-master (§1.2). |
| `Full resync requested by replica` | master | Logged for every full sync this master serves. |
| `Replication buffer limit has been reached` | replica | The loading replica stopped buffering (§1.3 step 3). |
| `MASTER <-> REPLICA sync: Flushing old data` | replica | A full sync is replacing what the replica held. |
| `Successful partial resynchronization with master.` | replica | The good outcome. |
| `Configuration change detected. Reconfiguring myself as a replica` | ex-master | It came back after its replica had been promoted. |
| `Node configuration loaded, I'm …`, with no `DB loaded from disk` after it | any | The node started from `nodes.conf` with no dataset (§1.2). |
| `Graph '…' processing virtual key: N/M` | any, while loading | M is that graph's virtual-key count (§1.6). |
| `Marking node … as failing (quorum reached).` | any | A node was silent past `cluster-node-timeout`. |
| `Failover election won: I'm the new master.` | replica | An automatic failover. Look for the stall that preceded it. |

```
resource.type="k8s_container"
resource.labels.namespace_name="synodic"
resource.labels.container_name="falkordb"
textPayload:("Disconnecting timedout replica" OR "overcoming of output buffer limits" OR "for lack of backlog" OR "Replication buffer limit has been reached" OR "Configuration change detected" OR "Full resync requested" OR "Failover election won")
```

### 7.3 The graph lock: is anything freezing

```bash
# On replicas: a GRAPH.EFFECT that waited for a reader is a slow GRAPH.EFFECT.
rc <replica-pod> 'SLOWLOG GET 128' | grep -i -B3 -A1 'graph.EFFECT'
rc <replica-pod> 'INFO commandstats' | grep -iE '^cmdstat_graph\.(effect|ro_query|query):'
# The slowest queries of one graph, the reads the writes waited behind. It is a keyed
# command: on the master that owns the graph's slot it answers directly.
rc <master-pod> 'GRAPH.SLOWLOG <graph>'
# On a replica it answers MOVED unless the same connection sent READONLY first (measured).
kubectl -n $NS exec <replica-pod> -- sh -c '[ -n "$REDISCLI_AUTH" ] || unset REDISCLI_AUTH; printf "READONLY\nGRAPH.SLOWLOG <graph>\n" | timeout 20 redis-cli'
```

* `SLOWLOG` keeps the last 128 commands slower than 10 ms (the defaults), with durations in
  microseconds.
* A `GRAPH.EFFECT` lasting seconds is the freeze itself, because the wait happens inside the
  command on the main thread. This is *inferred* from the source: the harness measured the
  stall through PING, not through SLOWLOG.
* Read it together with the master's `last_ack_s` (§7.2) and `Disconnecting timedout replica`.

### 7.4 The property-name table and the virtual-key count

```bash
# Run on the master of the shard that owns the graph (-c follows MOVED). Cheap: it reads the name table, not the graph.
kubectl -n $NS exec <pod> -- redis-cli -c GRAPH.RO_QUERY '<graph>' \
  'CALL db.propertyKeys() YIELD propertyKey RETURN count(propertyKey)'
# The virtual-key count: the M in "processing virtual key: N/M" from that graph's last load
# (Cloud Logging, the textPayload query above with "processing virtual key").
```

* **The predicted name-table cost of a load** is M × 7.5–7.9 s at 65,534 names, on the
  harness's CPU. For N names, scale by (N / 65,534)².
* **Do not count entities with a scan on a master or on the standby.** A long read there is
  the §1.4 hazard. If you need entity counts, use the load log, or run `GRAPH.EXPLAIN` first
  and count only if the plan shows no scan.

---

## 8. Rollout

This rollout is **run by an operator, follows roles, and moves one pod at a time.** Plan for
days, not hours: each pod comes back once with an empty `/data`, because its old files were
on the container layer, and full-syncs. That is nine full syncs, the largest taking about an
hour at today's load time. Do not run `make apply` before phase 2.

### Phase 0 — Evidence and freeze

1. **Capture the evidence.** Do this before anything changes, because events expire in an
   hour.

   ```bash
   REPO=$(git rev-parse --show-toplevel)       # run inside the repo checkout
   EV=$HOME/falkordb-rollout                   # the evidence; every later step uses $REPO and $EV
   mkdir -p "$EV"
   kubectl -n $NS get sts,pdb,job,cronjob -o yaml > "$EV/live-objects.yaml"
   kubectl -n $NS get configmap common-config -o yaml > "$EV/live-common-config.yaml"
   kubectl -n $NS get pods -l app.kubernetes.io/part-of=falkordb-cluster \
     -o custom-columns=NAME:.metadata.name,UID:.metadata.uid > "$EV/pod-uids-before.txt"
   for p in $SHARDS; do rc $p 'INFO everything' > "$EV/info-$p.txt"; done
   rc falkordb-shard-0-0 'CLUSTER NODES' > "$EV/cluster-nodes-before.txt"
   ```

   Also run §7.1–§7.4 and keep their output.
2. **Diff the live objects against the repo.** This catches hand edits beyond `replicas: 3`.
   * Render with `make -C "$REPO/deploy/k8s" dry-run OVERLAY=production-cluster > "$EV/rendered.yaml"`.
   * Compare the three shard StatefulSets in `$EV/live-objects.yaml` with `$EV/rendered.yaml`
     by eye.
   * The fields this release changes are listed in §6.1. Anything else that differs is a hand
     edit: args, resources, probes, node selector, image or schedule. Carry it into the repo,
     or drop it knowingly.
   * Do the same for the DR CronJob's `spec.schedule` and the `common-config` keys.
   * For runtime edits made with `CONFIG SET`, check the §6.1 values with
     `rc <pod> 'CONFIG GET <name>'`.
3. **Add a GKE maintenance exclusion** for the length of the rollout:

   ```bash
   gcloud container clusters update <CLUSTER> --region <REGION> \
     --add-maintenance-exclusion-name falkordb-rollout \
     --add-maintenance-exclusion-start <now, RFC 3339> --add-maintenance-exclusion-end <end, RFC 3339> \
     --add-maintenance-exclusion-scope no_minor_or_node_upgrades
   ```

   * An exclusion does not stop auto-repair.
   * Its length is capped by your release channel; check
     `gcloud container clusters update --help`.
   * These GKE details were not checked against GKE's documentation here.
4. **Suspend the DR CronJob.** Its SYNC forks a replica you are about to roll:

   ```bash
   kubectl -n $NS patch cronjob falkordb-dr-backup -p '{"spec":{"suspend":true}}'
   ```

5. **Pause rebuilds and bulk imports.**
   * Trigger none.
   * Cancel any that is running, from Job History; its checkpoint is kept.
   * A rebuild's burst of writes is what overruns the buffers during a full sync (§1.3).
6. **Stop app deploys until phase 2.** Today, each one rolls every shard pod (§1.1a).
7. **Check whether NetworkPolicy is enforced:**

   ```bash
   gcloud container clusters describe <CLUSTER> --region <REGION> \
     --format='value(networkConfig.datapathProvider,networkPolicy.enabled)'
   ```

   The §5 policy is inert without enforcement. With enforcement it only adds access.

### Phase 1 — Runtime relief, with no restarts

These settings take effect at once on the running pods, and are lost on restart. From phase 3
on, the manifests carry them.

1. **Check memory on every pod.** Once the 4 GiB backlog fills, it counts against `maxmemory`:

   ```bash
   for p in $SHARDS; do
     printf '%s ' $p; rc $p 'INFO memory' | tr -d '\r' | awk -F: '/^used_memory:/ {printf "used %.1f GiB, + 4 GiB = %.1f GiB (must be < 28)\n", $2/2^30, $2/2^30 + 4}'
   done
   ```

   If any pod is at or above 28, stop. Do not raise the buffers on that shard: 32gb with 4 GiB
   buffers needs 60.8 GiB of a 56 GiB container (§6.2). Two things that look like remedies are
   not:
   * Lowering `QUERY_MEM_CAPACITY` or `THREAD_COUNT` shrinks the container budget, not
     `used_memory`, so on its own it does not clear the gate.
   * A graph cannot be moved to another shard: its shard is the hash slot of its name (§12).

   What does work, for that shard:
   * Keep its `maxmemory` above `used_memory + 4 GiB`, and pay for it with a lower
     `QUERY_MEM_CAPACITY` on its pods so that `container_memory_needed` (§6.2) still fits
     56 GiB. For example, 30gb with `QUERY_MEM_CAPACITY 805306368` (768 MiB) needs 55.6 GiB.
     From phase 3 on this is a per-shard value in the manifest, whose three shard documents
     are otherwise identical.
   * Delete data from it: drop graphs on it that are not needed.
   * Move the pool to a larger machine type.
2. **Apply the settings on every pod, in this order.** Set `maxmemory` **first**: raising the
   buffers while it is still 32gb over-books the container.

   ```bash
   for p in $SHARDS; do
     echo "== $p"
     rc $p 'CONFIG SET maxmemory 28gb'
     rc $p 'CONFIG SET repl-backlog-size 4gb'
     rc $p 'CONFIG SET client-output-buffer-limit "replica 4gb 0 0"'
     rc $p 'CONFIG SET replica-full-sync-buffer-limit 4gb'
     rc $p 'CONFIG SET cluster-allow-replica-migration no'
     rc $p 'CONFIG SET appendonly no'
     rc $p 'CONFIG SET shutdown-on-sigterm nosave'
     rc $p 'GRAPH.CONFIG SET VKEY_MAX_ENTITY_COUNT 100000000'
     rc $p 'GRAPH.CONFIG SET DELAY_INDEXING yes'
   done
   ```

   `redis-cli` exits 0 even on an error reply, so read the output. Then verify:

   ```bash
   for p in $SHARDS; do echo "== $p"
     for k in maxmemory repl-backlog-size client-output-buffer-limit replica-full-sync-buffer-limit \
              cluster-allow-replica-migration appendonly shutdown-on-sigterm; do
       rc $p "CONFIG GET $k" | tr '\n' ' '; echo
     done
     rc $p 'GRAPH.CONFIG GET VKEY_MAX_ENTITY_COUNT' | tr '\n' ' '; rc $p 'GRAPH.CONFIG GET DELAY_INDEXING' | tr '\n' ' '; echo
   done
   ```

   Why these values, on the **old** pods:
   * **`appendonly no`.**
     * Their AOF is on the container layer and never survives a restart anyway (§1.2).
     * Turned off, it stops costing fsyncs and rewrite forks.
     * The old `appendonlydir` stays on the boot disk until the pod is replaced.
   * **`shutdown-on-sigterm nosave`, and not `save`, on old pods.**
     * Their data directory is the container layer. A shutdown save would write a whole
       dataset to the boot disk inside a 120 s grace period, for a file the next container
       never sees.
     * With save points configured, the default already saves on SIGTERM.
     * `nosave` also lets a stop finish within the grace period.
   * **`VKEY_MAX_ENTITY_COUNT` and `DELAY_INDEXING` on all nine pods, before any sync.**
     * The server that writes an RDB decides its virtual-key count. From source, that includes
       the RDB a master streams for a full sync.
     * The loader decides `DELAY_INDEXING`.
     * So a replica full-synced in phase 3 then loads one key per graph. That is *inferred* for
       the sync path.
3. **Take the masters out of the read rotation:**

   ```bash
   kubectl -n $NS patch configmap common-config --type merge -p '{"data":{"FALKORDB_MASTER_READ_SHARE":"0"}}'
   kubectl -n $NS rollout restart deployment/viz-service deployment/aggregation-worker \
     deployment/aggregation-controlplane deployment/versioning-worker deployment/stats-service
   ```

   * This restarts app pods only. The app reads its env when it starts, so the restart is
     needed.
   * Until the app deploy in phase 2, the old router spreads reads over both replicas, with no
     allowlist and an inert lag gate. The masters lose only their rotation share. The master
     still serves reads in the settle window after a write, fleet-stamp pins, the pipeline's
     master-consistency reads, and every read of a shard with no vouched replica.

**Gate:** run §7.2 again. Nothing has restarted (the UIDs and RESTARTS are unchanged), and
`CLUSTER INFO` says `cluster_state:ok`.

### Phase 2 — One apply

**Prerequisites:** phase 1 is done, and every `falkordb-shard-N-2` is a replica:

```bash
for s in 0 1 2; do printf 'falkordb-shard-%s-2: ' $s; rc falkordb-shard-$s-2 'ROLE' | head -n 1; done   # want: slave
```

If one says `master`, hand it back first:

* Run `rc <the shard's most caught-up other replica> 'CLUSTER FAILOVER'`, choosing it by the
  master-view lag in §7.2.
* Wait for `ROLE` to swap.

Otherwise the new router finds no read replica on that shard, and the shard's reads land on
its master.

1. **Build and push the pinned image and the app images:**

   ```bash
   make -C "$REPO/deploy/k8s" build-falkordb-cluster push-falkordb-cluster
   make -C "$REPO/deploy/k8s" build push
   ```

2. **Delete the completed init Job.** Its template is immutable:

   ```bash
   kubectl -n $NS delete job falkordb-cluster-init
   ```

3. **Orphan-delete the three StatefulSets.** The pods keep running, unowned:

   ```bash
   kubectl -n $NS delete statefulset falkordb-shard-0 falkordb-shard-1 falkordb-shard-2 --cascade=orphan
   kubectl -n $NS get pods -l app.kubernetes.io/part-of=falkordb-cluster   # nine, Running, unchanged
   ```

   Nothing recreates a pod that dies between this step and the next, so run them back to back.
4. **Apply:** `make -C "$REPO/deploy/k8s" apply OVERLAY=production-cluster`.
   * **The new StatefulSets adopt the nine pods without restarting them.** Reproduced on
     v1.37.1: the same UIDs, a new owner, and old-revision pods left untouched under
     `OnDelete`.
   * **The init Job runs again.** It waits for PONG from all nine pods, then exits with
     `cluster already formed — nothing to do.`
   * **New objects:** the PriorityClass and the NetworkPolicy are created.
   * **The ConfigMap** gains `FALKORDB_REPLICA_READ_HOSTS`.
   * **The app Deployments** roll to the new image.
   * **The DR CronJob** gets its candidate lists. It stays suspended, because apply leaves
     alone a field it never set.
5. **Verify:**

   ```bash
   kubectl -n $NS get pods -l app.kubernetes.io/part-of=falkordb-cluster \
     -o custom-columns=NAME:.metadata.name,UID:.metadata.uid | diff "$EV/pod-uids-before.txt" -   # no output
   kubectl -n $NS get sts -l app.kubernetes.io/part-of=falkordb-cluster -o custom-columns=\
   'NAME:.metadata.name,UPDATED:.status.updatedReplicas,STRATEGY:.spec.updateStrategy.type,POLICY:.spec.podManagementPolicy'
   kubectl -n $NS logs job/falkordb-cluster-init | tail -n 3
   kubectl -n $NS get cronjob falkordb-dr-backup -o jsonpath='{.spec.suspend}{"\n"}'          # true
   ```

   Expect `UPDATED 0`, `OnDelete` and `Parallel`. Until phase 3 replaces them, the old pods
   keep their old spec: priority 0, no ephemeral-storage request, the old probes, and the
   container-layer data directory.

   If the apply fails on the StatefulSets with `field is immutable`, the orphan delete was
   skipped. Nothing rolled. Do step 3, then apply again.

### Phase 3 — Roll each pod, by role, one at a time

**Order:**

* Shards from the smallest `used_memory` to the largest.
* Within a shard: the read replica, then the standby, then a hand-over, then the old master.
* One pod at a time across the whole cluster.

**While `-2` is out, the standby takes its shard's reads.** From the delete of `-2` until
it is vouched again (up to an hour of full sync), no allowlisted replica of that shard
qualifies. The allowlist is a preference, not a filter (§4), so the in-step standby serves the
shard's reads rather than its master: until the hand-over that master is an old pod (no hold,
no preStop, its data on the container layer), and one write behind a long read there freezes it
past the failover window (§1.4). The standby can lag behind a long read meanwhile. The
hand-over gate below (a small `behind_bytes`) and `CLUSTER FAILOVER`'s own offset wait cover
that. Nothing has to be changed for this phase.

Read a shard's roles from the cluster, never from ordinals:

```bash
rc falkordb-shard-0-0 'CLUSTER NODES' | awk '{split($2, a, ","); split(a[2], h, "."); print h[1], $1, $3, $4}' | sort
# pod, node id, flags, id of the master it follows
```

**Gate before deleting any pod.** All of these must hold:

* `CLUSTER INFO` shows `cluster_state:ok`.
* The pod's `ROLE` is `slave`. **Never delete a pod while it is master.**
* Its master shows the shard's other replica as `state=online`, with a small and steady
  `behind_bytes` (§7.2). The shard then keeps a caught-up copy throughout.
* No rebuild or bulk import is running.

**For each replica pod R, in turn:** run `kubectl -n $NS delete pod R`. It comes back on the
new template with an empty `/data`, because its old files were on the container layer, and
full-syncs. Watch it:

```bash
rc R 'INFO persistence' | grep -E '^loading'
rc R 'INFO replication' | grep -E '^(master_link_status|master_sync_in_progress|master_current_sync_attempts|replica_full_sync_buffer_peak):'
```

R is done when **all** of these hold:

* `kubectl get pod R` shows Ready. Readiness now requires `master_link_status:up`.
* `rc R 'CONFIG GET dir'` returns `/data`, and `kubectl -n $NS exec R -- ls -l /data/dump.rdb`
  shows the file. The sync wrote it.
* `GRAPH.CONFIG GET VKEY_MAX_ENTITY_COUNT` returns `100000000`, `CONFIG GET maxmemory` returns
  `30064771072`, and `appendonly` is `no`.
* The master's `behind_bytes` for R is small again.
* `DBSIZE` is close to the master's. Small differences are normal: FalkorDB's
  `telemetry{<graph>}` stream keys are local to each node.

**Abort criterion.** Stop the roll, leave everything as it is, and investigate the write load
if the master logs a second `Full resync requested by replica` for R, or its `sync_full` rises
again for R. R's `master_current_sync_attempts` reaching 2 is not enough on its own: it also
counts reconnects to a master that was briefly unreachable.

That is the §1.3 loop. Pause writes (rebuilds and imports), and let the next attempt finish.

**Then the master M:**

```bash
S=<the new standby>                         # the replica that is not -2, rolled just above
rc $S 'CLUSTER FAILOVER'                    # answers OK at once and finishes asynchronously
for i in $(seq 30); do [ "$(rc $S ROLE | head -n 1 | tr -d '\r')" = master ] && break; sleep 1; done
# Never while M is master: an old pod has no preStop and stops with nosave.
[ "$(rc M ROLE | head -n 1 | tr -d '\r')" = slave ] && kubectl -n $NS delete pod M   # no hold either
```

If nothing was deleted, the switch did not happen: `CLUSTER FAILOVER` gives up after 5 s when
the offsets do not meet (`Manual failover timed out.` in S's log). Check S's `behind_bytes`
and try again.

* M comes back empty and full-syncs, like the replicas did. The same gate and abort criterion
  apply.
* The shard ends with the former standby as master, `-2` still the read replica, and M as the
  new standby.
* `CLUSTER FAILOVER` with no option waits for the replica's offset to match, and pauses the
  master's writes while it does, for up to 5 s (then `Manual failover timed out.`). Measured:
  the roles swapped in 0.006 s, both directions resumed by partial resync, and the writer saw
  one MOVED.

**The empty-master hazard during this phase.**

* **Why it exists.** Until a shard's master has been handed over, it runs on an old pod: the
  dataset is on the container layer, and there is no startup hold.
* **What happens if its container restarts** (OOM or liveness):
  * It comes back within seconds, empty and still master.
  * Its replicas full-sync the empty set within seconds. Measured full syncs of small datasets
    took 4.8–5.8 s, mostly the default 5 s `repl-diskless-sync-delay`.
* **How to spot it:**
  * `DBSIZE` 0 (or an empty `INFO keyspace`) on a master that owns slots;
  * RESTARTS going up on an old-revision master.
* **If a replica still holds the data** (its `DBSIZE` is not 0, and its link is down or its
  sync has not loaded yet):
  * Run `rc <that replica> 'CLUSTER FAILOVER TAKEOVER'` at once. TAKEOVER needs no agreement
    from the dead master and no quorum.
  * The empty node then rejoins as its replica.
* **If the replicas have already flushed,** the shard's graphs are gone from FalkorDB. Reseed
  them from Cloud SQL, per the DR invariant.

This is why masters are handed over as early as each shard allows, why phase 1 takes the masters
out of the read rotation, and why the allowlist falls back to the standby rather than the master.

### Phase 4 — Drills, once all nine pods are on the new template

Run them on the smallest shard, one at a time, and check §7.2 between drills.

1. **A replica restart resumes by partial resync.** Run
   `kubectl -n $NS delete pod <the standby>`. This holds as long as the 4 GB backlog covers the
   writes made while the pod was down, which on a large shard includes the shutdown save and
   the RDB load.
   * In the previous pod's logs in Cloud Logging, expect `Saving the final RDB snapshot before exiting.`
   * In the new pod's logs, expect `DB loaded from disk`, then
     `Successful partial resynchronization with master.`
   * On the master, expect `Partial resynchronization request from … accepted.`
     `sync_partial_ok` goes up by 1, and `sync_full` does not change.
2. **Deleting a master hands over, then resumes by PSYNC.** Run
   `kubectl -n $NS delete pod <the master>`.
   * The roles swap within a second or two (the preStop hand-over).
   * The old master restarts as a replica, with no hold message.
   * Then it logs `DB loaded from disk` and `Successful partial resynchronization with master.`
   * No election runs, because the slots moved by hand-over. Writers see one MOVED. The other
     nodes may still mark the restarting replica as failing while it saves and loads, which is
     harmless.
   * The hand-over goes to the standby. Only if no standby was online does `-2` receive it;
     then hand it back: run `CLUSTER FAILOVER` on the other replica.
3. **A crashed master is held, its replica is promoted, and nothing is lost.**
   * Kill `redis-server` **from the node**. Inside the container it is PID 1, and a signal it
     has no handler for, such as SIGKILL, is ignored when sent from inside its own PID
     namespace. So `kubectl exec … kill -9 1` does nothing.

     ```bash
     kubectl debug node/<the master's node> -it --image=busybox -- pkill -9 -x redis-server
     ```

     A node debug pod runs in the host's PID namespace, and there is one FalkorDB pod per
     node. This command was not run in this investigation.
   * Without node access, `rc <master> 'SHUTDOWN NOSAVE NOW'` leaves the same state behind:
     * the process exits without a hand-over or a save;
     * the kubelet restarts the container in place (RESTARTS +1);
     * `nodes.conf` still says master;
     * the RDB is older than the replica's data.
   * **Expect, in order:**
     1. The restarted container logs
        `nodes.conf: this node was a master owning slots; holding 45s so its replica is promoted before this dataset rejoins`.
     2. The standby logs `Failover election won: I'm the new master.` *Expected* about 15–20 s
        after the kill; measured 4.95 s at a 3 s node timeout.
     3. After the hold, the old node starts **as a master** and loads its own stale RDB, until
        `DB loaded from disk`. That takes as long as any load of the shard, with `-LOADING` to
        every client. A node loading at startup accepts no cluster-bus connection
        (`cluster_legacy.c:1265-1267`, source), so it cannot learn of the promotion before the
        load ends.
     4. Then, in the same millisecond as `Ready to accept connections` (measured in D3), it
        logs `Configuration change detected. Reconfiguring myself as a replica`, and
        full-syncs. A held ex-master always full-syncs; measured: `Replication ID mismatch`.
     5. No acknowledged write is lost (case D3).
   * This drill costs a load of the stale RDB and then a full sync of the shard, so pick the
     smallest.

### Phase 5 — Recreate the graph at 65,534 names

Follow [2026-09-15 §8 step 6](RELEASE_NOTES_2026-09-15_falkordb-cluster-and-property-names.md#8-rollout):

* a versioned source: **Data health → Rebuild**;
* a direct load: `GRAPH.DELETE`, then the loader, then `signal_data_changed`.

Do it after phase 3, when nothing is syncing, because it is a large write load. Then run §7.4
again. The new graph's name count is bounded by `FALKORDB_NATIVE_PROPERTY_BUDGET` (50,000).

### Unfreeze

* Resume the DR CronJob:

  ```bash
  kubectl -n $NS patch cronjob falkordb-dr-backup -p '{"spec":{"suspend":false}}'
  ```

  Check that the next run picks a replica: its log should show `snapshotting … (role slave)`.
* Remove the maintenance exclusion
  (`gcloud container clusters update … --remove-maintenance-exclusion falkordb-rollout`).
* Resume rebuilds and deploys. App deploys no longer touch the shards.

---

## 9. Verifying it worked

* **Deploys leave the shards alone.** After an app deploy, the shard pod UIDs, RESTARTS and
  ControllerRevisions (§7.1) are unchanged.
* **The data is on the PVC.** `CONFIG GET dir` returns `/data` on all nine pods, and `/data`
  holds `nodes.conf` and `dump.rdb`.
* **Restarts resume by PSYNC.** Drills 1 and 2 show `Successful partial resynchronization`,
  and the master's `sync_full` stays flat.
* **The hold works.** Drill 3.
* **Reads go to the read replica.**
  * `INFO commandstats` `cmdstat_graph.RO_QUERY` calls rise on each shard's `-2`.
  * On the standby they stay flat.
  * On the master they stay flat except for the reads the master must serve: the settle
    window after this process's own write, and the pipeline's master-consistency reads.
  * **And every read of the shard whenever `-2` is not usable:** while it is master, down,
    loading, syncing or more than 8 MiB behind, and for 30 s after a single read on it fails
    or misses its deadline. That benches `-2` for the whole app process, and `-2` is the
    shard's only read target. A step in a master's count is one of these; check `-2` first.
  * The same shows on the `graph_store_command_calls{command="graph.ro_query",role}` metric.
* **The lag gate trips.**
  * During a rebuild, Admin → Graph store shows each replica's lag in bytes, and no longer
    "in step" throughout.
  * A replica more than 8 MiB behind stops taking reads, and takes them again once it catches
    up.
* **Loads are one key per graph.** The next load of a node that holds the wide graph logs
  `processing virtual key: 1/1` for it, provided the RDB was written after phase 1.
* **DR picks a replica.** The run logs `snapshotting falkordb-shard-N-… (role slave)`, or
  skips candidates with a stated reason.
* **Suites.** Backend CI-required list:
  `cd backend && <venv>/bin/python -m pytest -q -m "not integration" $(grep -vE '^\s*(#|$)' tests/ci-required-files.txt)`.
  * At the time of writing: **4020 passed, 3 skipped**. Before this change: 3962 passed,
    3 skipped.
  * New: `test_falkordb_cluster_manifests.py` (47 tests) and
    `test_falkordb_dr_backup_targets.py` (7 tests), both in the CI list.
    * The manifest tests run the init Job's and the preStop's real scripts against a fake
      `redis-cli`, and send the entrypoint's hold a real SIGTERM.
    * The DR tests run the snapshot script under `dash`.
  * Updated: `test_graph_store_fork_settings.py`, `test_falkordb_replica_reads.py` and
    `test_graph_store_topology.py`, with honest doubles.

---

## 10. Alerts and SLOs

| Signal | Where | Threshold | Why |
|---|---|---|---|
| A shard pod's UID changed | kube-state-metrics `kube_pod_info` / `kube_pod_created`, or §7.1 | any, outside a planned roll | Every replacement is a reload, and §1.1 says what caused it. |
| `sync_full` on a master | `INFO stats` | any increase outside a planned roll | Each one is a fork and a full transfer, plus an hour of load on the other end. |
| A second full sync to the same replica | the master's `Full resync requested by replica` lines and `sync_full` | ≥ 2 for one replica outside a planned roll | The §1.3 loop. `master_current_sync_attempts` ≥ 2 alone is not it: it counts reconnects, and every failover or master restart raises it (5 after a 4 s outage, measured). |
| Master-view lag (`master_repl_offset − slaveN offset`) | the master's `INFO replication`, or Admin → Graph store | > 8 MiB sustained (the read budget); page at > 1 GiB | The real lag (§1.5). |
| `slaveN lag=` (seconds since the last ACK) | the master's `INFO replication` | > 10 s | The replica is frozen (§1.4). |
| `loading:1` | `INFO persistence` | > 20 min | A load long enough for the buffers to overflow. |
| `replica_full_sync_buffer_peak` | `INFO replication` | > 2 GiB (half the 4 GiB limit) | A load came close to stopping its buffering. Never reset while the process lives. |
| A `GRAPH.EFFECT` in `SLOWLOG` | each replica | > 1 s | A replica waited on a reader (§1.4). |
| `DBSIZE` 0 on a master that owns slots | `DBSIZE` / `CLUSTER NODES` | any | The empty-master hazard (§8). |
| `cluster_state` | `CLUSTER INFO` | ≠ ok | |
| Masters per shard | `CLUSTER NODES` | ≠ 1 | |
| `falkordb-shard-N-2` is master | `ROLE` | any | That shard's reads now land on its master; hand the role back. |
| `rdb_last_save_time` age | `INFO persistence` | > 7 h | A save that FalkorDB aborted is silent: `rdb_last_bgsave_status` stays `ok` (source, reproduced with 40 graphs). |
| An `Evicted` event on a shard pod, or `DiskPressure` on a `falkordb-pool` node | events, node conditions | any | §1.1b. |
| A GKE operation on `falkordb-pool` | audit log / `gcloud container operations list` | any outside a planned window | §1.1c. |

Two SLOs worth stating:

* **No unplanned shard-pod replacement in 30 days.**
* **Every restart resumes by PSYNC** (`sync_partial_ok` rises and `sync_full` does not), except
  a crashed master, which full-syncs by design.

---

## 11. Turning each piece off

| Piece | How to turn it off | What comes back |
|---|---|---|
| The pinned image | Set `newTag` back to `prod-latest` | Every app deploy replaces every shard pod. **Do not.** |
| `OnDelete` | `updateStrategy: RollingUpdate` | An apply rolls pods by ordinal, master included, without regard to role. |
| `Parallel` | An orphan delete with `OrderedReady` | A loading `-0` blocks recreating `-2`. |
| AOF off | First run `CONFIG SET appendonly yes` on every pod, and wait for `aof_rewrite_in_progress:0`, so that each writes an AOF of the data it holds. Only then put `--appendonly yes` and the three flags back in the manifest. In the other order a pod boots **empty** on its next start: with AOF on and no `appendonlydir`, Redis ignores `dump.rdb` (measured), and a whole-shard restart then serves the empty set to its replicas. | Every restart full-syncs (case A). |
| `shutdown-on-sigterm save` | Remove it | Restarts come from the 6-hourly RDB, so they full-sync more often. |
| The startup hold | Remove the `if` block in `command` | A killed master rejoins with a stale RDB and its replica copies it: lost writes (case D2). |
| The `preStop` hand-over | Remove `lifecycle` | A planned stop costs 15 s plus an election, and the held restart is a full resync. |
| The readiness link check | Revert to the plain PING | A syncing replica reads as Ready, and the PDB lets a second pod drain. |
| `VKEY_MAX_ENTITY_COUNT` / `DELAY_INDEXING` | Remove them from `FALKORDB_ARGS` (or `GRAPH.CONFIG SET` the defaults) | The next save is multi-key again, and indexes build inside the load. |
| The read allowlist | `FALKORDB_REPLICA_READ_HOSTS` unset or blank | Every in-step replica takes reads, and there is no standby. |
| Masters out of the rotation | `FALKORDB_MASTER_READ_SHARE: "1"` | Each master takes a read slot, and with it the §1.4 failover risk. |
| The lag gate | No knob. `FALKORDB_REPLICA_READ_MAX_LAG_BYTES` widens the budget. | |
| DR replica-only | Unset `FALKORDB_BACKUP_REPLICA_ONLY` | A master becomes an eligible snapshot source. |
| PriorityClass | Remove `priorityClassName` from the three shard templates, apply, and roll the pods. Only then delete the PriorityClass and drop it from `kustomization.yaml`, or the next apply recreates it. Deleted while a template still names it, every new shard pod is refused at admission (`no PriorityClass with name falkordb-cluster was found`), so an evicted or rolled pod is never recreated. | Priority 0 eviction ranking. |
| NetworkPolicy | Drop it from `kustomization.yaml` and delete it | No shard ingress rule under enforcement. |

---

## 12. Longer term

**More shards, and placement.**

* A graph is one key, one hash slot and one shard. Sharding spreads *graphs*; it never splits
  one.
* Splitting the 15 GB shard means more shards, which makes graph placement matter.
* With a hash tag in the graph key (`{tag}name`), a hot or wide graph could be steered to a
  chosen shard. The app does not do this today; it would be a naming change in the
  registry.

**Bound the reads that still reach a master.**

* With `FALKORDB_MASTER_READ_SHARE 0`, a master still serves these reads:
  * the settle window after a write;
  * the pipeline's master-consistency reads;
  * every read when no read replica is vouched, or `-2` is benched (30 s after one failed or
    timed-out read on it).
* A master-side read budget kept under a share of `cluster-node-timeout`, as writes already
  are, would close §1.4 for masters.
* Report the lock behaviour upstream too. FalkorDB holds the GIL while it waits for a graph
  write lock (`QueryCtx_AcquireWriteLock`), and `GRAPH.EFFECT` takes an untimed write lock on
  the main thread. The harness numbers above are a ready-made reproduction.

**Wide graphs.** Recreate the graph at the ceiling (phase 5). The longer-term answer is the
property-storage design in [`PROPERTY_STORAGE.md`](PROPERTY_STORAGE.md), which keeps a constant
set of names per graph.

**NetworkPolicy enforcement.**

* The shard policy now exists.
* Before enforcement is turned on, add rules for a metrics scraper and for the load test (see
  the scaling guide's known gaps).
* Add an `ipBlock` for any cross-cluster client that reaches the shards through Multi-Cluster
  Services (MCS) or an internal load balancer (README, "Clients in ANOTHER cluster").

**DR cadence.**

* Every DR run is a SYNC: a fork on a replica, plus the shard's whole dataset over the network.
* The shipped schedule is `0 */6 * * *`. Check the live one with
  `kubectl -n synodic get cronjob falkordb-dr-backup -o jsonpath='{.spec.schedule}'`.
* At every 30 minutes, the standby forks and ships its dataset 48 times a day.
* Keep 6 h. Cloud SQL is the source of truth, so a snapshot only shortens a rebuild.

---

## 13. Known limitations

**There is no cap on replica reads, and no master re-run, by design.** An earlier plan was to
cap replica reads at 5 s and re-run them on the master. It was dropped because §1.4 showed that
a long read re-run on a master can freeze it past the failover window. So a read on `-2` can
still run up to `TIMEOUT_MAX` (120 s) and past it, and freeze the read replica for as long if a
write arrives. The standby keeps failovers healthy meanwhile.

**Roles drift.**

* **An automatic failover can promote `-2`.** Redis ranks its candidates by offset alone. The
  preStop hand-over lands on `-2` only when no standby is online.
* **Then the shard has no no-read standby.** While `-2` is master, no replica on that shard
  matches the allowlist, so the preference falls back to every in-step replica of the shard and
  both of them take reads.
* **What to do.** Alert on it (§10) and hand the role back with `CLUSTER FAILOVER` on the other
  replica.
* **The same happens while `-2` is down or syncing,** and after a zone loss for every shard
  whose `-2` was in that zone.

**One timed-out read on `-2` sends the shard's reads to its standby for 30 s.**

* The router benches a replica for `_REPLICA_PENALTY_S` (30 s), process-wide, after one read
  on it fails or misses its deadline. `-2` is the shard's only allowlisted replica, so its reads,
  long ones included, go to the in-step standby meanwhile, which can then be frozen and lag
  the same way.
* Only when the standby is also benched, behind or syncing do the shard's reads go to its
  master (no replica vouched).
* Failing fast, or not benching on a deadline when a shard has one read target, are the
  alternatives. Each is a tradeoff this release does not make.

**The allowlist matches hostnames.**

* It works on a cluster, where the client addresses replicas by announced hostname.
* Sentinel and standalone deployments address replicas by IP, so a hostname regex matches
  nothing there and the preference has no effect: every in-step replica reads, as before. Only the cluster overlay sets it.

**A held ex-master always full-syncs.**

* It comes back with a new replication ID, and the replica it would follow does not
  recognise it (measured: `Replication ID mismatch`).
* It pays for two loads. First it loads its own stale RDB as a master, and accepts no
  cluster-bus connection until that load ends. Only then does it learn that it was replaced,
  and it full-syncs: a transfer and a second load.
* The preStop hand-over avoids this for planned stops; a crash cannot.

**The relaxed vouch path waves an unknown lag through,** but only while the master is silent and
the vouch is under 15 s old. A loading master renews the vouch on every sample, so during a
master's load that is the whole load. An unknown lag includes a replica on a different replication
history, and an in-budget lag measured against a master offset more than 15 s old. A lag over
budget is never forgotten: it keeps that replica out however old the offset. A cached master
offset under 15 s old can still under-state the lag by up to 15 s of writes.

**The readiness change holds the PDB through a full sync.**

* A replica in an hour-long full sync is NotReady.
* With `maxUnavailable: 1` across all nine pods, that blocks every voluntary eviction in the
  cluster for that time. This is intended: no second pod drains while one is out of step.
* GKE upgrades then wait, and reportedly force the drain after about an hour. Schedule
  maintenance windows, and use exclusions around rolls.

**A load can absorb about 8 GB of writes, and no more** (§1.3). A rebuild that writes more than
8 GB during one load still loops. The §10 alert on a second full sync is how you know.

**The single-node base has the same data-directory bug.**

* `deploy/k8s/base/infrastructure/falkordb/statefulset.yaml` (`overlays/production` and dev)
  still mounts the PVC at `/data` while the image writes to `/var/lib/falkordb/data`. Its AOF
  is on the container layer.
* With `appendonly yes` and no `appendonlydir`, a restart boots **empty**.
* The same `FALKORDB_DATA_PATH=/data` fix applies there, alongside its AOF handling. It is not
  in this change.

**The FalkorDB Browser still runs in every shard.**

* The image defaults to `BROWSER=1`, so `run.sh` starts the browser's Node.js server inside each
  shard container.
* Its memory is not a term in §6.2, and the overhead term is now 0.25 GiB (not measured).
* `BROWSER=0` in the shard env is a template change, so it needs a role-aware roll. It is not
  in this change.

**The shutdown save must finish within the grace period.** A pod's 300 s covers the hand-over
and a foreground save of its whole dataset. A save cut short by SIGKILL leaves the previous
RDB, which resumes by PSYNC only if the backlog still covers it. Saving a 15 GB shard was not
timed.

**Adopted pods keep their old spec until rolled.** Pod priority and resources are fixed at
creation. Until phase 3 replaces each pod, it has priority 0, no ephemeral-storage request, the
old probes, and its data directory on the container layer.

**Existing RDBs keep their key count.** `VKEY_MAX_ENTITY_COUNT` changes only RDBs written after
it is set. A DR snapshot taken before phase 1 still has many keys per graph.

**One key still parses the name table once:** about 7.5 s per load of the wide graph, with PING
silent, until the graph is recreated.

**The DR CronJob renders with `:prod-latest`.** It lives in `overlays/production`, so every
deploy re-tags it. That is harmless, because a CronJob template change restarts nothing.

**DR edge cases:**

* A candidate with a BGSAVE running is skipped only while another candidate remains. The
  last (or only) candidate is synced anyway, and Redis queues the SYNC behind the running fork,
  as the single instance always did.
* A failover in the milliseconds between the probe and the SYNC could still fork a newly
  promoted master. This is not guarded.

**`SCALING_CONCURRENT_USERS.md` §5 still describes the old shape** (32gb, 1 master + 1 replica,
"`replicas: 3` doubles the read threads"). This release updates only its Known gaps.

**The DR snapshot script's empty-snapshot check is weaker than it reads.** Its
`[ ! -s "$OUT" ]` check can never fire, because an empty gzip is 20 bytes.
`set -o pipefail` is the real guard. It works in the image's shell: Debian trixie's dash
0.5.12-12 carries the upstream pipefail patch. Ubuntu 24.04's dash rejects it, so the DR test
stubs that one line out when run there.

---

## 14. What was corrected while this was being built

* **The 5-second replica read cap with a master fallback was dropped after it was approved.**
  The graph-lock measurement (§1.4) showed that re-running long reads on a master can freeze it
  past the failover window. The replacement is no master reads in the rotation, plus a
  no-read standby.
* **"A read cannot cause a failover" (2026-09-15) was wrong** for FalkorDB 4.20.6; see the
  correction in §1.4.
* **`--dir` in `REDIS_ARGS` would not have fixed the data directory.** It was the obvious fix,
  and it was tested before being proposed: `run.sh`'s own `--dir` wins.
* **`master_sync_in_progress` is not a readiness signal.** It reads 0 all through the 8.x
  RDB-channel handshake, while the replica answers PONG and has not synced (measured).
  Readiness gates on `master_link_status:up` instead.
* **The lag tests passed because the test doubles were impossible.** Each replica's
  self-report copied the master's offset. Once the doubles were made honest, three existing
  behaviour tests failed against the old code.
* **The writer-preference theory could not be isolated.** The theory was that reads queue
  behind a waiting writer. A short read of an *unrelated* graph waited just as long (11.3 s
  vs 11.5 s), because the main thread itself was blocked. The fix does not depend on the
  theory.
* **A held ex-master was expected to resume by PSYNC. It full-syncs** (`Replication ID mismatch`).
  The new master's backlog would have covered the gap, but the restarted node asks with the
  new random ID it generated at startup. The comments and §13 say so.
* **`test_graph_store_fork_settings.py` asserted AOF on every shard.** Those assertions now
  apply to the single-node base only, which keeps its AOF. The cluster assertions expect
  `appendonly no`, `shutdown-on-sigterm save`, the data path and the 4gb limits.
* **The CONCURRENCY_TUNING §5 table showed a seventh query thread fitting in 56Gi.** With the
  new buffers it no longer does (56.35 GiB).
* **The DR patch's "the `-1` pods are the replicas" was true only until the first failover.**
  The role is now read live.
* **Two drill commands that look right do nothing.**
  * `kubectl exec … kill -9 1`: redis-server is PID 1 and has no SIGKILL handler.
  * `DEBUG SEGFAULT`: Redis 8 disables `DEBUG` by default.
  §8 phase 4 gives commands that work.
