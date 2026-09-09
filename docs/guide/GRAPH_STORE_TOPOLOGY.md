# The Graph Store: Shards, Replicas & Placement

*For Administrators.* **Admin → Graph store** shows every node of every graph
store {brand} talks to — masters and replicas — with what each one holds, how
far behind its replicas are, and which data source owns each graph. This page
explains every figure on it, what "good" looks like, and what to do when one of
them looks wrong.

---

## The shape of a graph store

A FalkorDB graph lives entirely on **one node**. A cluster spreads graphs
across nodes; it never splits one. Three ideas follow from that, and the page
is built on them:

- **Slots.** A cluster divides the keyspace into 16,384 slots. A graph key
  hashes to exactly one slot, so a graph's home is decided by its *name*, not
  by where it was created or which node you happened to connect to.
- **Shards.** Each shard owns a range of slots. Every key in that range lives
  on the shard's **master**, which serves it and takes every write.
- **Replicas.** A master's replicas copy its writes and stand ready to be
  promoted when it goes away. They hold the same data and the same memory
  footprint — which is why a page that showed only masters was showing a third
  of the picture.

**Slot coverage** below 16,384 means some slots have no master right now:
usually a master is down and no replica has been promoted yet. Keys in those
slots cannot be read or written until one is.

---

## Reading the page

### The strip at the top

| Figure | What it means |
| --- | --- |
| Graph stores | Distinct stores. Providers pointing at the same cluster count once. |
| Master shards | Slot-range owners across all stores. |
| Replicas | Copies standing by. Zero means a node failure loses that shard's availability until it comes back. |
| Nodes answering | How many nodes replied to this reading. Anything below the total is listed in red near the top. |
| Memory held | Used memory across the fleet, against the ceilings the nodes report. |
| Graphs | Graph keys found, and how many no data source claims. |

### A shard card

- **Slots a–b.** The range this shard owns.
- **The master row**: address, health, uptime (or "restarted N min ago"),
  round-trip latency, a memory meter with the fleet **reserve** marked on it,
  and the node's own limits.
- **"Fits ~N more rollup edges"** is the free memory after the reserve divided
  by the fleet bytes-per-edge. It is the same arithmetic a rebuild does before
  it writes, so the page and the run never disagree. See *Rollup Capacity* for
  what to do when it is small.
- **Replica rows**, indented: their link state, how far behind they are, and
  their own memory.
- **The replication line**: how many replicas, how many online, the worst lag,
  and how many **full resyncs** have happened since the master started. A full
  resync is expensive — the master forks, dumps the whole dataset and ships it
  — and a rising count under a rebuild means the write stream is outrunning
  the replicas' buffers.
- **The graphs table**: every graph on the shard, the data source that owns it,
  whether it is the source graph or a rollup projection, its edge count and its
  size. A row marked *not found on the node* is registered to a data source but
  is not on the shard — never rebuilt, or dropped.

### Health words

| Word | Meaning | What to do |
| --- | --- | --- |
| **Up** | The node answered and its replicas are following it. | Nothing. |
| **Restarting** | It came back recently, or is loading its data. | Wait. Reads for its shard are served by its replicas; rebuilds hold their checkpoint and carry on. |
| **Behind** | A replica is not in step with its master. | Look at the lag and the findings. A rebuild paces itself against this. |
| **Unreachable** | It did not answer. | Check the pod or host. If a master, the cluster promotes a replica; until then its slots are unserved. |

**Cannot govern** is different from **unreachable**: the node answered, but it
has no `maxmemory`, so nothing can be measured against it and rebuilds landing
there fall back to a static edge cap.

---

## Findings, and the fixes they name

Each shard lists what is wrong with its replication, in plain sentences.

- **Replicas re-run every write** (`effects_threshold_high`). Below the store's
  `EFFECTS_THRESHOLD`, a write is replicated by re-running the whole query on
  every replica — **on the replica's main thread, with no timeout**. A rollup
  batch is hundreds of cheap MERGEs, so it replicates this way, and a replica
  busy re-running one answers no health probe. Set the threshold to `0` from
  **Adjust limits** on the master (apply to all nodes) so replicas apply a
  compact change log instead, and add `EFFECTS_THRESHOLD 0` to `FALKORDB_ARGS`
  so it survives a restart.
- **A replica is behind** (`replica_behind`) or **its link is down**
  (`replica_link_down`). Look at whether a rebuild is running: the rebuild
  waits for acknowledgement and will already be pacing itself. Persistent lag
  with no rebuild running points at the network or a replica short of CPU.
- **Full resyncs are climbing** (`full_resync_storm`). The replica output
  buffer or the replication backlog is too small for the write rate. Raise
  `client-output-buffer-limit replica` and `repl-backlog-size`.
- **The node restarted** (`node_restarted`). Its run id changed since the last
  reading. Kubernetes decides this, and {brand} cannot read the reason — ask
  the cluster:

  ```
  kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'
  ```

  `OOMKilled` means the container limit is too low for the node's `maxmemory`
  plus its per-query ceilings; anything else usually means a health probe gave
  up while the node was busy.
- **The replica buffer is small** (`output_buffer_small`). Under a large
  rebuild, a 256 MB replica buffer overflows and forces a full resync.

---

## Placement: which shard is a graph on?

Placement is arithmetic, not a lookup: the key hashes to a slot, and the slot
belongs to a shard. Two consequences worth knowing:

- A data source in **dedicated projection** mode writes its rollups to a
  *different* graph key (`<graph>_proj`), which hashes on its own — so its
  rollups can live on a different shard than its source graph. Both are shown
  on the data source's profile.
- **Moving a graph to another shard means renaming it.** There is no command
  that moves one graph between shards; the key decides. In practice you rebuild
  the source under a new name, or add memory to the shard it is on.

---

## What users see while a node is being replaced

A master that goes away is a pause, not an outage:

- Reads for its shard fail fast with a short retry hint, and the canvas keeps
  showing what it already had behind a *Reconnecting to the graph store* line.
  It retries by itself.
- The circuit breaker does **not** open for a node that is failing over, so a
  restart no longer answers every user with "Circuit open" for half a minute.
- A rebuild waits for the node, reconnects to it (or to the replica promoted in
  its place) and carries on from its checkpoint at the same width. If it does
  give up, the failure names the node and how long it waited.

---

## Adjusting a node's limits

**Adjust limits** on a master opens the same dialog the Infrastructure page
uses. It sets, at runtime:

- `TIMEOUT_MAX` — the per-query time cap every timeout knob is clamped to.
- `QUERY_MEM_CAPACITY` — the per-query memory ceiling. Raising it is checked
  against the container's memory limit using the deployment guide's sizing
  rule, and refused with the shortfall if the container cannot back it.
- `EFFECTS_THRESHOLD` — see the finding above. **Apply to all nodes** is the
  right choice here: a promoted replica must already carry it.

A runtime change lasts until the server restarts; the dialog hands you the
`FALKORDB_ARGS` fragment that makes it permanent.

---

## Why this page exists

A rebuild of a densely connected graph used to take a whole shard down. The
chain was: the rebuild wrote as fast as the master accepted; every replica
re-ran each batch on its main thread; the replicas stopped answering their
health probes; Kubernetes restarted them; the run died with a refused
connection; and the circuit breaker then answered every user of that provider
with *"Circuit open; will probe downstream again in ~28s"* — text that names no
node.

Every one of those steps is now visible here, and most are prevented. What
remains visible is the evidence: the effects threshold, the lag, the resync
count, the restarts, and which graph is on which node.

*See also: Rollup Capacity & Large Graphs, and the FalkorDB deployment guide
for container sizing and the probe tolerances.*
