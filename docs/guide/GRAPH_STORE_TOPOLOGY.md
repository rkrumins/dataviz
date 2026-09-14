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

### One card per store, named by the providers that use it

The page groups by **store**, not by provider row, because memory, nodes,
slots and replication are properties of the servers — not of a row in a table.
Rows that turn out to point at the same store therefore share one card, titled
with all of their names, and the card says so in a line under the heading.

Deciding that is not a matter of comparing connection settings: two rows can
list disjoint seeds of one cluster, or name one node by its service name and
by its address. So the nodes are asked. Overlapping cluster node ids — or, off
a cluster, the same Redis run id — mean one store, and the rows fold together.
Without the fold every figure on that store is counted once per row, and the
fleet strip reports twice the memory and twice the nodes the deployment has.

What *is* per provider is the graph inventory: each row on a shard card names
the data source that owns it, so on a shared store you can still see which of
the providers a graph belongs to.

There is no default graph store, and this page has no card for one. A data
source's provider is required, so every graph accounted for here belongs to a
provider's store; the connection named by `FALKORDB_HOST` is what the
application was bootstrapped with, not somewhere anybody's lineage lives. With
no provider rows the page shows nothing but the one thing that helps: add a
provider.

---

## Reading the page

The page has two levels. The first is everything at once: the strip of fleet
totals, then one line per store — its nodes, its slot coverage, its memory,
its graphs, how full its fullest master is, and how many replication findings
it has. That is the level to compare stores on and to notice which one needs
attention.

Opening a store is the second level, in three views:

- **Replication** (what you land on): every master this store owns, and the
  replicas standing behind each one. Each master sits on a tile coloured by
  its health with its slot range, its memory against its ceiling and how many
  more rollup edges it fits; its replicas hang off a line beneath it, each
  naming the master it follows, its link status and how far behind it is. A
  master with *no* replica says so in amber — if it goes away, nothing can be
  promoted in its place. A master that is not answering says that its replicas
  are carrying the reads.
- **By shard**: the same nodes, plus the capacity arithmetic and every graph
  that lives on the shard, searchable.
- **All nodes**: one flat row per node — the answer to "are all nine up?" that
  a stack of cards makes you count.

A deployment with a single store opens it straight away, and "Open in Graph
store" from a data source or a provider lands directly on the store that holds
it.

### The strip at the top

| Figure | What it means |
| --- | --- |
| Graph stores | Distinct stores, and how many provider rows point at them. Rows sharing a store count the store once. |
| Master shards | Slot-range owners across all stores. |
| Replicas | Copies standing by. Zero means a node failure loses that shard's availability until it comes back. |
| Nodes answering | How many nodes replied to this reading. Anything below the total is listed in red near the top. |
| Data on masters | Used memory summed over the MASTERS — the size of the data itself — against the ceilings those nodes report. Each replica holds its own copy, so what the deployment needs is this figure multiplied by one plus the replicas per shard. |
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

## Who answers a read

A shard's master takes every write. Read-only queries are offered to its
**in-sync replicas** — that is what makes interactive load scale with the
replica count rather than with one master's query threads, and it is why
reads keep flowing while a master restarts.

A replica answers only when all of this holds; otherwise the master does:

- the provider allows it (*Read queries* in its connection settings, default
  *From in-sync replicas*);
- the replica is online and owes the replication stream no more than 8 MiB,
  sampled once per shard every few seconds rather than per read. Bytes, not
  the `lag` seconds `INFO` prints: a replica acknowledges the stream about
  once a second whatever it has actually applied, so those seconds read near
  zero for one that is a gigabyte behind;
- this process has not written to that graph in the last 30 seconds, so a
  caller always sees its own writes;
- the replica has not just failed a read (it is skipped for a short while).

A rebuild is pinned to the master for its whole run: it reads what it has
just written. A replica that fails a read for a reason of its own — a
connection fault, a `MOVED`, a dataset still loading — sends that read to the
master once and sits out the next half minute. A query the store refused for
its size, or aborted at its own time limit, is reported as it stands: it would
fail the same way on the master, and running it twice is load the routing
exists to shed. A replica that lets the caller's deadline expire sits out the
half minute too, but the read is not started again — the budget went with it.

Each provider's topology line says what share of its reads replicas actually
answered, once there have been enough reads for the figure to mean anything.
It is per web process, so it says "the routing is working here", not "across
the fleet".

## What users see while a node is being replaced

A master that goes away is a pause, not an outage:

- Reads for its shard keep being served by its replicas. The lag reading
  normally comes from the master, so a master that cannot be asked would have
  closed the gate on its own replicas; instead the ones it vouched for when it
  last spoke keep answering, and a graph this pod wrote to seconds ago is no
  longer pinned to a node that is not there. What comes back may be a little
  behind; what would otherwise come back is nothing.
- Anything that must go to the master — every write, and every read a rebuild
  makes — fails fast with a short retry hint, and the canvas keeps showing
  what it already had behind a *Reconnecting to the graph store* line. It
  retries by itself.
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
