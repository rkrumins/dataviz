# Troubleshooting

*For everyone.* Something on screen isn't what you expected? Look up the exact
message, or the symptom that matches, to see what's causing it and how to fix
it — or exactly what to tell your administrator.

> **Tip:** Three checks solve most problems. Are you in the right **workspace**
> and view? Do you have **access** to it? Is its **provider** — the connection
> to the graph database — healthy?

[screenshot-pending]: # "troubleshooting-state-card — A view's canvas dimmed behind the 'Taking a little longer than usual' card, showing the 'Retrying automatically…' status line and the 'Retry now' button"

---

## Messages you may see

Find the words on your screen below. Most of these clear on their own:
{brand} keeps retrying, and nothing you've saved is lost while it does.

### On a view's canvas

When a view can't finish loading, a card covers the empty canvas. Over a view
that's already drawn, a small pill at the top says the same thing, and you can
keep working with what's there.

| Message (exact text) | What it means | What to do |
|---|---|---|
| **Preparing your graph** | The graph store is starting up after a restart, or the node holding this graph is being replaced. Your data is safe. | Wait — usually a few seconds. **Retry now** tries again at once. Tell your administrator if it lasts minutes. |
| **Taking a little longer than usual** (over a drawn view: **Refreshing is taking longer than usual**) | The server is busy — it runs only so many graph reads at once for each data source and asks your browser to retry shortly — or a query ran past its time limit. Nothing is lost. | Wait: it retries every 10 seconds or so, then about once a minute. **Retry now** tries again at once. See [A view keeps saying "Taking a little longer than usual"](#a-view-keeps-saying-taking-a-little-longer-than-usual). |
| **Reconnecting your session** | Your sign-in needs refreshing. The graph service is fine. | Select **Reload page**. |
| **Something went wrong while loading** (over a drawn view: **This view hit an error while refreshing**) | The page hit an error while drawing this view — a fault, not an outage. | Reload the page. If it keeps happening, tell your administrator which view. |
| **Graph service is unavailable** | The graph store for this data source isn't answering, or your browser can't reach {brand} at all. | Wait — the view fills in when the service is back. Tell your administrator if it lasts. |
| **12 entities didn’t load** (or **Some entities didn’t load**) | Part of the view arrived; the rest is being retried. | Wait, or select the pill's circular arrow (**Retry now**). Once the pill says "Retry loads the rest", it has stopped retrying on its own. |
| **This view encountered an error** | The view's page stopped working. | Select **Retry**; reload the page if it comes back. |

### Banners above a Context View

| Message (exact text) | What it means | What to do |
|---|---|---|
| **Reconnecting to the graph store — the node holding this graph is restarting.** | A graph store node is being replaced; you see the last answer meanwhile. | Nothing — it clears within seconds. |
| **Showing the last saved copy of this canvas — no fresh answer for 4 minutes.** (or **Provider is recovering — this canvas may be out of date.**) | The provider can't answer freshly, so you see the last good copy. The time is how long there has been no fresh answer — the copy may be older. | Don't rely on it for recent changes until the banner clears. |
| **Connections are still catching up.** | Recently published changes haven't reached the graph yet. | Wait — it clears on its own. |
| **Source data changed — lineage is being recomputed. Showing the previous rollup.** | The lineage summaries are being rebuilt; you see the previous ones. | Wait. |
| **Connections between collapsed items haven’t been summarised for this source yet — open an item to see the connections inside it.** | The summaries (rollups) that draw lines between closed items haven't been built. | Open an item to see inside it, and ask an administrator to run the data source's aggregation. |
| **Showing the largest relationships — narrow the selection to see more.** | There was too much to draw, so only the largest relationships are shown. | Open fewer items, or select fewer entities. |
| **The graph store refused part of this read at its per-query memory limit** (or **The graph store timed out on part of this read**) | Part of the read hit a graph store limit. | Narrow the selection. System administrators also see **Adjust graph store limits** — see [Rollup Capacity & Large Graphs](/guide/rollup-capacity). |
| **Some relationships could not be loaded — the canvas may be incomplete.** | Fetching the connections failed. | Select **Retry** on the banner. |
| **No containment types configured.** | The semantic layer doesn't say which relationships mean "contains", so nothing nests. | Ask whoever looks after the [semantic layer](/guide/semantic-layer). |

### On the Explorer, for one data source

When the [Explorer](/guide/browsing-views) is filtered to one data source, a
banner reports its lineage summaries (its aggregation).

| Message (exact text) | What it means | What to do |
|---|---|---|
| **Aggregating Graph Lineage...** or **Preparing Aggregation...** | The summaries are being built. | Wait — the banner shows progress. |
| **Graph Drift Detected** | The graph has changed since its summaries were built. | If you manage the data source, select **Re-aggregate**; otherwise tell your administrator. |
| **Aggregation Failed** | The last build failed. | Tell your administrator — see [A rebuild is slow, or says a query was too large or timed out](#a-rebuild-is-slow-or-says-a-query-was-too-large-or-timed-out). |
| **Aggregation Not Set Up**, **Aggregation Skipped** or **Aggregation Cancelled** | There are no current summaries. Views work, but lines between collapsed items won't appear. | Ask an administrator to run the aggregation if you need those lines. |

### Banners across the top of the app

| Message (exact text) | What it means | What to do |
|---|---|---|
| **You're Offline** | Your device has lost its network connection. | Reconnect; the banner clears by itself. |
| **Service Unavailable** | Your browser can't reach the {brand} server. | Wait — **Connection Restored** tells you it's over. Tell your administrator if it lasts. |
| **Provider Unavailable** (or **2 Providers Unavailable**) | A provider isn't answering, so views that read from it can't load fresh data. | Tell your administrator if it's unexpected. **Snooze** hides it for **15 minutes**, **1 hour**, **4 hours** or **Until tomorrow**. |

### Access and switched-off features

| Message (exact text) | What it means | What to do |
|---|---|---|
| **Access denied** (a card at the bottom of the screen) | Your account lacks a permission this action needs. | Use **Request access** if the card offers it — see [I got "Access denied"](#i-got-access-denied). |
| **Read-only view** | The view was shared with you to read; changing it needs access to its workspace. | Use **Request edit access** on the card. |
| **You don't have access** | This page isn't part of your role. | Ask your workspace admin or system administrator. |
| **Access revoked** | You were removed from the workspace while in it. | Select **Request access again** or **Go to workspaces**. |
| "… is turned off for this deployment." (or a page such as **Reviews are turned off**) | An administrator has switched the feature off for everyone. Requesting access won't change it. | Ask an administrator — it's under **Administration → Features** (the message calls it "Admin → Features"). |

**Which switch is behind the message?** Match the start of the message to the
switch on **Administration → Features** — see
[Feature Switches](/guide/feature-switches).

| The message starts… | Switch |
|---|---|
| "Editing is turned off…" | **Edit mode** |
| "Version control is turned off…" | **Version control** |
| "Lineage tracing is turned off…" | **Lineage trace** |
| "Publishing views to everyone is turned off…" | **Publishing views to everyone** |
| "That view type is not available…" | **View modes** |
| "Exporting graph data is turned off…" | **Export graph data** |
| "View versions, import and export are a preview…" | **View versions, import and export** |
| "Exporting views to a file is turned off…" | **Export views** |
| "Importing views from a file is turned off…" | **Import views** |
| "Building a lineage model from scratch is turned off…" | **Build lineage from scratch** |
| "Semantic layers are read-only…" | **Edit semantic layers** |
| "Only administrators can change semantic layers…" | **Let non-admins edit layers** |
| "Importing semantic layers is turned off…" | **Import layers** |
| "Exporting semantic layers is turned off…" | **Export layers** |
| "Suggesting a semantic layer from the graph is turned off…" | **Suggest from graph** |
| "Semantic layer history is hidden…" | **Layer history & audit** |
| "Self-registration is turned off…" | **Self-registration** |
| "Invite links are turned off…" | **Invite links** |

### Status chips on Ingestion and data source pages

Provider and data source rows carry a small chip, shown in capitals. Hover over
it for details.

| Chip | What it means | What to do |
|---|---|---|
| **Refreshed 5m ago** (or **Fresh**) | The figures are current. A ⚠ after it means the provider fails now and then. | Nothing. |
| **Stale 2d ago** | Not refreshed for that long. The chip only turns amber after a day without a refresh (the default). | Wait for the next scheduled scan, or refresh. |
| **Cached** | The provider is offline; you see the last cached figures. | Administrators: check the provider. |
| **Offline** | The provider is offline and nothing is cached yet. | Administrators: **Ingestion → Providers**, then **Re-test All**. |
| **Paused** | Background refreshes can't reach their queue. | Administrators: check **Administration → Infrastructure**. |
| **Computing…** or **Partial** | Figures are being worked out, or fallback figures show while a full refresh runs. | Wait. |

### The sync chip in a view's header

Beside the data source's name in a view's header, a chip says whether the view
reads the latest version of its data. Select it for each step, with times. See
[Data Freshness & Ingestion](/guide/data-freshness).

| Chip | What it means | What to do |
|---|---|---|
| **In sync · v12** (or **In sync · read 3m ago**) | Current. | Nothing. |
| **1 version behind**, **Catching up · 2 versions behind** or **Rebuilding · 40%** | Recent changes are still being written to the graph. | Wait. |
| **Refresh failed · 2 versions behind** | Writing the latest changes failed; views read from the system of record meanwhile. | Tell someone who manages the data source — they can rebuild it from **Data health**. |
| **Summaries updating** or **Refreshing** | Lineage summaries are being rebuilt. | Wait. |
| **Summaries need attention**, **Summaries missing**, or a chip starting **Summaries:** | Lineage summaries failed, are missing, or aren't being served. | Tell your administrator. |
| **Changed since the last refresh** or **Not read for 2h** | An external graph has changed, or hasn't been read recently. | Wait; tell your administrator if it stays. |
| **Checking sync…** or **Sync not reported yet** | No status yet. | Wait a moment. |

---

## For everyone

### I can't find a View someone shared with me

**Likely cause:** its visibility doesn't include you, or a filter is hiding it.

1. Open the **Inbox** (the bell in the top bar) and select the message about
   the share.
2. In the **Explorer** (**Explore** in the sidebar), select **Shared** — views
   shared with you directly or through a group — and **Clear all** to remove
   other filters.
3. A view opened to your whole workspace or to everyone isn't under
   **Shared**: select **All** and search for it by name.
4. Still missing? Ask the owner to select **Share** on the view and check its
   **Visibility** and whether you're listed as a **Viewer** or **Editor** — see
   [Who can see a View](/guide/managing-views#who-can-see-a-view). If it's in a
   workspace you aren't a member of, see
   [Requesting Access](/guide/requesting-access).

### A View or the Explorer looks empty

**Likely cause:** it's still loading, a filter is hiding things, or there's no
data yet.

1. If a card or pill shows on the canvas, look it up in
   [On a view's canvas](#on-a-views-canvas).
2. In the Explorer, select **All**, then **Clear all**. **No views yet** means
   nothing has been built — if you build views, select **Create Your First
   View**.
3. If a whole workspace has no data, ask an administrator — see
   [For Administrators](#for-administrators).

### A view keeps saying "Taking a little longer than usual"

**Likely cause:** too many graph reads are running at once for this data source
— common when many people open large views together — so the server turns some
away and your browser retries. A query that keeps running past the graph
store's time limit looks the same.

1. Give it a minute; it fills in as soon as an answer arrives. **Retry now**
   tries again at once.
2. If an **Access denied** card appeared too, the cause is access — see
   [I got "Access denied"](#i-got-access-denied).
3. If only one very large view does this, try again later, or ask its owner to
   split it into smaller, focused views.
4. If several people see it at the same time, tell your administrator — see
   [Many people see "Taking a little longer than usual" at once](#many-people-see-taking-a-little-longer-than-usual-at-once).

### Is this data up to date?

1. Look at the sync chip beside the data source's name in the view's header —
   **In sync · v12** means current.
2. Select the chip to see when the change was published, written to the graph,
   and summarised.
3. In a Context View, a banner tells you when you're looking at a saved copy
   or at previous summaries.
4. Tell your administrator if the chip shows **Refresh failed** or **Summaries
   missing**, or stays behind. See
   [Data Freshness & Ingestion](/guide/data-freshness).

### I can't edit a View

**Likely cause:** you can only read it, or editing is switched off.

1. To change a view's design you need to be its **Editor**, or have a workspace
   role that edits views. Ask the owner to select **Share** and add you — see
   [Managing & Sharing Views](/guide/managing-views).
2. To change the data, select **Edit** in a Context View's header; your edits go
   to a private draft. **Edit** appears only when version control is on and
   your workspace role isn't **Viewer**. See
   [Editing in a Draft](/guide/editing-in-a-draft).
3. If **Edit** is greyed out with "Version control isn't set up for this data
   source yet", version control has to be set up first — ask your
   administrator.
4. A **Read-only view** card means the view was shared with you to read — use
   **Request edit access**.

### "What am I actually allowed to do?"

Open the avatar menu at the top right and select **My access**. It lists your
roles and what they let you do; **My access requests** shows any requests you've
made and their status. See [Requesting Access](/guide/requesting-access).

### I got "Access denied"

**Likely cause:** the action needs a permission you don't have — unless the
message says something "is turned off for this deployment", which is a feature
switch (see the next entry).

1. If the card shows **Request access**, select it, choose a role, add a reason
   if you like, and select **Submit request**.
2. Follow it under **My access requests** on your **My access** page: it shows
   **Pending**, **Approved** or **Denied**.
3. With no **Request access** button, ask the workspace's admin, and include the
   line shown under **Details**.

See [Requesting Access](/guide/requesting-access) for the whole journey.

### A button or page I expected is missing

**Likely cause:** an administrator has switched the feature off, or your role
doesn't include it.

1. Ask a colleague in the same workspace. If it's missing for them too, it's
   almost certainly a feature switch.
2. Check **My access** (avatar menu) for what your roles allow.
3. Ask your administrator. Common cases, with the switch on
   **Administration → Features**:
   - No **Edit** button — **Edit mode** or **Version control**.
   - No **Trace Lineage** or **Focus Lens** — **Lineage trace**.
   - No way to export graph data — **Export graph data**.
   - No **Import a view** in the Create View wizard — **View versions, import
     and export** (off by default) and **Import views**.
   - A view type missing from the wizard — **View modes**.
   - **Enterprise** visibility unavailable — **Publishing views to everyone**.
   - No guided tours in **Help** — **Guided product tours** (off by default).

See [Feature Switches](/guide/feature-switches).

### The graph is hard to read / too busy

**Likely cause:** too much is open at once. These steps change only what you
see.

1. Close containers you don't need — lines between closed items summarise the
   lineage inside them.
2. Select one entity and choose **Focus Lens** to see just its connections in
   the [Lineage Lens](/guide/lineage-lens); set **Density** to **Overview**.
3. Choose **Trace Lineage** and lower **Upstream depth** or **Downstream
   depth** in the trace dock — see
   [Tracing Lineage on the Canvas](/guide/exploring-graph).
4. In a Context View, use **Display** for zoom, density and badges, and ⌘0 /
   Ctrl-0 to fit every column on screen.
5. Switch the top bar's toggle to **Business** to show names only.

---

## Sessions and signing in

### I was signed out unexpectedly

**Likely causes**, most common first:

- A time limit. By default you sign in again after 12 hours without activity
  (an open {brand} tab keeps you active), and every session ends after 7 days.
  Single sign-on adds a daily check (next entry). Your administrator can change
  these limits.
- Your sessions were ended — with **Sign out everywhere** in **Account
  settings**, or by an administrator.
- Two {brand} environments open in the same browser — see
  [Signing in to one environment signs me out of another](#signing-in-to-one-environment-signs-me-out-of-another).

What to do:

1. Sign in again. Nothing you saved is affected.
2. If you were editing a draft, changes you'd staged but not saved are kept in
   this browser: reopen the draft and you'll see "Restored 3 unsaved changes
   from your last session." Keep them, or select **Discard all**.
3. If it keeps happening, check **Account settings → Recent activity** and tell
   your administrator.

### I have to sign in again every day

With single sign-on, {brand} asks your identity provider to confirm who you
are at least once every 24 hours (the default). Password accounts don't have
this daily check.

1. When the limit passes, you're sent through your company's sign-in. If you're
   still signed in there, it completes on its own and you land back where you
   were.
2. If the sign-in page says "Your corporate sign-in could not be renewed
   automatically.", sign in again from that page.
3. If it says "Sign-in through your identity provider didn't complete.", copy
   the reference under "Quote this reference to your administrator:" and send
   it to your administrator.

> **Admins:** the daily limit is `SSO_SESSION_MAX_AGE_HOURS`. Look up a failed
> sign-in by its reference — see [Running Single Sign-On](/guide/sso-operations).

### Signing in to one environment signs me out of another

**Likely cause:** two {brand} environments (say, test and production) open in
one browser use the same session cookie names, so each sign-in replaces the
other.

1. Meanwhile, use a separate browser profile for each environment.
2. Ask your administrator to give each environment its own
   `AUTH_ENVIRONMENT_ID` — see
   [Multi-Environment Sessions](/docs/multi-environment-sessions).

### "Reconnecting your session" keeps coming back

1. Select **Reload page** on the card. You're reconnected, or taken to the
   sign-in page — sign in again.
2. If the card returns on every view straight after signing in, tell your
   administrator: the browser may not be keeping the session cookies.

> **Admins:** the usual causes are secure-only cookies on a plain-HTTP host, or
> two environments sharing cookie names — see
> [Multi-Environment Sessions](/docs/multi-environment-sessions).

---

## For Builders

### My saved View doesn't look the way I left it

**Likely cause:** you're in a draft, someone else edited the view, or its
semantic layer changed.

1. If version control is on, check the version switcher in the view's toolbar:
   **Published** is the version everyone sees; otherwise it names your draft.
2. Select **Activity** in the view's header to see who changed it, and when.
3. If colours, names or types changed, the data source was switched to another
   version of its semantic layer, or uses a draft version, which changes
   whenever someone edits it. Ask whoever looks after the
   [semantic layer](/guide/semantic-layer).

### My View is too slow to load

**Likely cause:** the server is busy, or the view asks for a lot — a view with
thousands of entities loads in many requests, and meets the server's limits
sooner at busy times.

1. Read the message on the canvas — see [On a view's canvas](#on-a-views-canvas).
2. If this view is slow every time, split it into focused views that each answer
   one question. See [Creating Views](/guide/creating-views).
3. If every view is slow at busy times, tell your administrator.

### Teammates can't discover my View

1. Select **Share** and check **Visibility**: **Private** is you, people you
   share with and workspace admins; **Workspace** is everyone in the workspace;
   **Enterprise** is everyone signed in. Enterprise may need approval — **Ask to
   publish this view**, then **Send request**. See
   [Who can see a View](/guide/managing-views#who-can-see-a-view).
2. Add tags from your team's vocabulary so the view turns up in the Explorer's
   filters — see [Ways of Working](/guide/ways-of-working).

### My review won't merge — it says "Pull latest"

**Likely cause:** changes were published after the draft began, so it's behind
("This draft is behind main… Pull the latest changes (resolving any conflicts)
before it can be merged.").

1. Select **Pull latest** in the review — or **Get latest updates** on the
   draft's "Updates available" banner.
2. Resolve any conflicts it reports.
3. Select **Merge**.

See [The Review Center](/guide/review-center).

---

## For Administrators

### Users report "No data source for workspace"

The workspace has no data source yet, so its graph requests fail — the most
common setup gap.

1. Open the workspace from **Workspaces** and go to **Data Sources**.
2. Select **Add Source** (**Add First Source** on an empty workspace). The
   **Add Data Source** wizard opens at **Source**.
3. Pick the catalog item, choose its semantic layer on **Semantics**, and select
   **Add data source** on **Review**.

See [Admin Setup](/guide/admin-setup).

### The graph is empty or stale for everyone

1. Open **Ingestion → Providers** and check each provider's
   [status chip](#status-chips-on-ingestion-and-data-source-pages).
2. Select **Re-test All**, and fix credentials or network access for any
   provider that fails.
3. Check **Ingestion → Freshness** for sources whose summaries are behind.

See [Data Freshness & Ingestion](/guide/data-freshness).

### Lines between collapsed items are missing or out of date

**Likely cause:** the data source's lineage summaries (built by its aggregation)
were never built, failed, or are being rebuilt.

1. Open **Ingestion → Freshness** to see each source's state.
2. Run the aggregation: the workspace's **Aggregation** tab (**Re-trigger**), or
   **Ingestion → Job History** (**Re-trigger aggregation**).
3. If it fails or crawls, see the next two entries and
   [Rollup Capacity & Large Graphs](/guide/rollup-capacity).

### A rebuild is slow, or says a query was too large or timed out

A rebuild that meets the graph store's **per-query** limits — its memory ceiling
or the time limit on one query — slows down until every query fits rather than
failing. **Job History** shows *Going slower to fit the graph store* meanwhile,
and each run's **Run settings** lists what it adapted to. If a run does fail:

1. A *single row* larger than the per-query memory ceiling means raising
   `QUERY_MEM_CAPACITY`: **Administration → Graph store → Adjust limits** does
   it at runtime, checking the container memory limit first. The failed
   source's guidance links straight there.
2. A narrowest scan that kept timing out means the store stopped answering:
   check it, then **Resume from cursor**. Raise the store's query time cap the
   same way if scans need longer.
3. Retry with the **Gentle** profile (pre-selected after either failure). On a
   running job, **Adjust this run** gives it more time or makes it gentler
   without cancelling it.

See [Rollup Capacity & Large Graphs](/guide/rollup-capacity).

### A rebuild failed with "connection refused" or "error 111"

A graph store node stopped answering — almost always one being **restarted or
replaced**. The rebuild waits for it and carries on from its checkpoint; it
fails only when the node stays away longer than the run's wait
(`AGGREGATION_STORE_OUTAGE_HOLD_S`, 15 minutes by default), and the message
then names the node.

1. Open **Administration → Graph store**. The node shows *Unreachable*, or
   "restarted N min ago", with whether its replicas kept up.
2. Ask the cluster why it went:

   ```
   kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'
   ```

   `OOMKilled` means the container limit is too small for the node's
   `maxmemory` plus its per-query ceilings — see the sizing rule in
   [FalkorDB Deployment](/docs/falkordb-deployment). Anything else usually
   means a health probe gave up while the node was busy.
3. If it happened **during a rebuild**, check that shard's replication on the
   same page. A replica that is behind, a climbing full-resync count or an
   effects threshold above 0 mean replicas are re-running every write batch
   until they miss their health checks: set **Effects threshold
   (EFFECTS_THRESHOLD)** to 0 in **Adjust limits** (tick "Apply the same limits
   on every primary node, not only this one."), and add `EFFECTS_THRESHOLD 0`
   to the deployment's `FALKORDB_ARGS`.
4. Resume the run from the failed source's guidance — nothing already written
   is repeated.

A failure that reads "Circuit open; will probe downstream again in ~28s" means
the store is genuinely not answering: check its nodes. See
[The Graph Store](/guide/graph-store-topology).

### Many people see "Taking a little longer than usual" at once

**Likely cause:** demand above capacity. Each server admits only so many graph
reads at a time for each data source (and the graph store runs only as many
queries as it has query threads); the rest are turned away with "retry shortly"
(HTTP 429), and the canvas retries them. The server log records each as
"Provider busy on …".

1. Check **Administration → Graph store** for a busy, restarting or unreachable
   node.
2. Note when it happens: a burst as many people open views settles by itself; a
   sustained level needs more capacity or different limits.
3. See [Concurrency and Timeout Tuning](/docs/concurrency-tuning) and
   [Scaling for Concurrent Users](/docs/scaling-concurrent-users).

### A new user can't log in

1. In **Administration → User Management**, find them under **Pending
   Approval** (or the **Pending** filter) and select **Approve**.
2. If the account is **Suspended**, select **Reactivate**.
3. For a failed single sign-on, ask for the reference on their sign-in page and
   look it up — see [Running Single Sign-On](/guide/sso-operations).

See [Users & Access](/guide/users-access).

### Someone has too much / too little access

1. Check their roles and scope (organisation-wide or one workspace) under
   **Administration → Permissions**, and their memberships under **Groups**.
2. Prefer changing a **group** over changing the individual.
3. With single sign-on, access rules may grant roles too. Removing someone from
   an identity-provider group removes only what the rule granted — the same role
   granted by hand stays. See what they still hold under **Administration → SSO
   → Diagnostics**; suspending the account ends access at once. See
   [Running Single Sign-On](/guide/sso-operations).

### I changed an ontology and many Views shifted

Views show whichever version of the semantic layer (ontology) their data source
uses. Editing a *published* version never changes it — the edit becomes a new
draft version that no data source uses until someone selects it. But a data
source that uses a *draft* version changes as soon as the draft is edited, and
switching a data source to another version changes its views at once.

1. Open the layer under **Semantic Layers** and check its **History** tab. If
   the tab is missing, the **Layer history & audit** switch has hidden it.
2. To go back, open the data source on its workspace's **Data Sources** tab,
   select **Edit**, and pick the earlier version (drafts are marked
   "(draft)").
3. To avoid surprises, point data sources at published versions and publish
   changes deliberately.

---

## Still stuck?

1. Open **Help** — the question-mark button in the top bar, or press **?**
   outside a text field — and search the guide and documentation.
2. If your organisation has set a support address, **Help** shows **Contact
   support**; select it to email them.
3. Otherwise contact your administrator, and send:
   - the exact message, copied or as a screenshot;
   - the page's address from your browser;
   - when it happened, whether it happens every time, and what you did just
     before;
   - for **Access denied**, the line under **Details**; for a failed single
     sign-on, the reference from the sign-in page.

## Where to next

- [Glossary & Acronyms](/guide/glossary) — when a word on screen is unfamiliar.
- [Requesting Access](/guide/requesting-access) — when you need into a workspace
  or view you can't open.
- [Feature Switches](/guide/feature-switches) — when you administer {brand} and
  want to know what each switch turns off.
- [Data Freshness & Ingestion](/guide/data-freshness) — when you need to know
  how current a view's data is.
