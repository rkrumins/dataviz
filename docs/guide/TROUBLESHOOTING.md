# Troubleshooting

*For everyone.* Common situations and how to resolve them, grouped by who usually
hits them. Most issues come down to **wrong workspace, missing access, or an
unhealthy provider** — start there.

> **Tip:** *First three checks, every time* — (1) Am I in the right
> **workspace**? (2) Do I have **access** to this thing? (3) Is the **provider
> healthy**? These resolve the majority of problems.

---

## For everyone

### I can't find a View someone shared with me
- You may not have **access** — its visibility could be too narrow, or it wasn't
  shared with you explicitly. Ask the owner to set Team/Enterprise visibility or
  grant you access. See [Browsing Views](/guide/browsing-views).
- You might be in the **wrong workspace**. Views belong to a workspace — open
  **Workspaces** from the sidebar to see the ones you have access to, then enter
  the one you want. Each screen shows you which workspace you're in; there's no
  separate global switcher to keep in sync.

### A View or the Explorer looks empty
- Check that you're in the right **workspace** for what you're trying to see — an
  empty picture usually means you're not where you think you are.
- The workspace's **data source** may be missing or its provider unhealthy. Ask an
  admin to confirm (see admin section below).

### I can't edit a View
- You likely have **viewer** access only. Ask the owner for an **editor** grant.
  See [Managing Views](/guide/managing-views).

### "What am I actually allowed to do?"
- Open your **My Access** page — it lists your roles, scopes, and permissions in
  plain language. See [Users & Access](/guide/users-access).

### The graph is hard to read / too busy
- Reduce **entity types** shown, raise the **granularity** (table or domain), and
  use **layers**. Hit **Fit** to recenter and open the **minimap**. See
  [Exploring the Graph](/guide/exploring-graph).

---

## For Builders

### My saved View doesn't look the way I left it
- Confirm you're opening the right **version/workspace**. If colours or types
  changed, the underlying **ontology** may have been updated — check with an
  admin. Published ontologies are immutable precisely to prevent this, so a change
  implies a new version was assigned. See [The Semantic Layer](/guide/semantic-layer).

### My View is too slow to load
- It's probably showing **too much**. Trim entity types, raise granularity, and
  split one giant View into several focused ones. See
  [Creating Views](/guide/creating-views).

### Teammates can't discover my View
- Set the right **visibility** (Team/Enterprise) and add **tags** from your
  team's agreed vocabulary. See [Ways of Working](/guide/ways-of-working).

---

## For Administrators

### Users report "No data source for workspace"
- The workspace has no **data source binding**. Bind a catalog item + ontology in
  the workspace. This is the single most common setup gap. See
  [Admin Setup](/guide/admin-setup), Step 5.

### The graph is empty or stale for everyone
- Check **provider health** in Admin/Ingestion. An unhealthy provider means no
  fresh data. Re-test connectivity; fix credentials/network. See
  [Governance & Operations](/guide/governance-ops).

### Domain-level granularity is missing or slow
- The data source's **aggregation** job may not be **ready**. Check and re-run it
  from the data source settings.

### A new user can't log in
- Their signup may still be **pending** — approve it in **Admin → Users**. Confirm
  the account isn't **suspended**. See [Users & Access](/guide/users-access).

### Someone has too much / too little access
- Review their **role bindings** and **scope** (global vs workspace), and any
  **group** memberships. Prefer adjusting the **group** over the individual.

### A rebuild is slow, or says a query was too large or timed out

A rebuild that meets the graph store's **per-query** limits — the memory
ceiling or the time limit on one query — does not fail; it goes slower until
every query fits: serial reads, a lighter reconcile strategy, narrower scans
down to a single row, smaller write batches, backoff retries. Job History
shows *Going slower to fit the graph store* while it happens, and every
run's **Run settings** disclosure lists what it ran with and what it adapted
to. It remembers per source, so the next rebuild starts there. If a run does
fail: a *single row* larger than the per-query memory ceiling means the
ceiling (`QUERY_MEM_CAPACITY`) must be raised — **Admin → Graph store →
Adjust limits** does it at runtime and checks the
container memory limit first, and the failed source's guidance links straight
to it; a narrowest scan that kept timing out means the store stopped
answering — check it, then **Resume from cursor** (raise the store's query
time cap the same way if scans need longer than it allows). Retry with the **Gentle**
profile (pre-selected after either failure), or — on a running job — give it
more time or go gentler (pace the writes, read serially, halve the scans)
with **Adjust this run**, without cancelling it. The canvas's own reads narrow
the same way under those limits; when one still loses part of the answer, the
canvas says which limit refused it and offers the same *Adjust graph store
limits* control to a system administrator. See [Rollup capacity](/guide/rollup-capacity).

### A rebuild failed with "connection refused" or "error 111"

A graph store node stopped answering during the run. This is almost always a
node being **restarted or replaced** rather than a store that is gone, and the
rebuild is built for it: it waits for the node, reconnects to it (or to the
replica the cluster promotes in its place), and carries on from its checkpoint
at the same width. You only see a failure when the node stayed away longer
than the run's wait (`AGGREGATION_STORE_OUTAGE_HOLD_S`, 15 minutes by
default) — and then the message names the node and how long it waited.

1. Open **Admin → Graph store**. The node will be *Unreachable*, or *Up* with
   "restarted N min ago". The page also shows whether its replicas kept up.
2. Ask the cluster why it went:

   ```
   kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'
   ```

   `OOMKilled` means the container limit is too small for the node's
   `maxmemory` plus its per-query ceilings — see the sizing rule in the
   FalkorDB deployment guide. Anything else usually means a health probe gave
   up while the node was busy.
3. If it happened **during a rebuild**, look at that shard's replication on
   the same page. A replica that is behind, a climbing full-resync count, or
   an effects threshold above 0 all point at the same cause: replicas
   re-running every write batch on their main thread until they miss their
   probes. Set the effects threshold to 0 from **Adjust limits** (apply to all
   nodes) and add `EFFECTS_THRESHOLD 0` to the deployment's `FALKORDB_ARGS`.
4. Resume the run from the failed source's guidance. Nothing already written
   is repeated.

**"Provider X unavailable: Circuit open; will probe downstream again in ~28s"**
is the old shape of this: the breaker treating a node being replaced as a
broken store and answering every user that way for a reset window. That no
longer happens — a failover is reported as its own signal, users see
"Reconnecting to the graph store" over their existing data, and reads retry
themselves. If you do see it, the store is genuinely not answering: check the
nodes on Admin → Graph store.

### I changed an ontology and many Views shifted
- That's expected if a new version was assigned — check the **audit trail** to see
  what changed and when. Re-assign the previous published version if needed.

---

## Still stuck?

- Re-read the relevant persona page in this guide — most "how do I…?" answers live
  there.
- Check the [Glossary](/guide/glossary) if a term is unclear.
- For deep technical detail (deployment, APIs, architecture), see the
  engineer-focused [documentation](/docs).
