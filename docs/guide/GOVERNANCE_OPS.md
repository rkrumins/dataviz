# The Admin Console

*For Administrators.* **Administration**, in the sidebar, is where you run
{brand} itself: its health, its look, its switches, its people and its audit
trail. This page is a map of every Administration page — what it's for, who
can open it, and the tasks you'll do there — with step-by-step help for the
pages that don't have a guide of their own.

> **Before you start:** **Administration** appears in the sidebar only if you
> hold `system:admin` (the **Super Admin** role) or `system:groups:manage`
> (which the **Org Admin** role also carries). **Workspaces**, **Ingestion**
> and **Semantic Layers** are separate sidebar items — not part of
> Administration.

---

## Who can open each page

Administration's own sidebar has two groups: **System** and **Identity &
Access**. Opening Administration lands you on the first page you're allowed to
see; pages you can't open don't appear. A Super Admin holds every permission,
so sees them all.

| Page | Use it to | Who can open it | Help |
| --- | --- | --- | --- |
| **Global Overview** | See graph scale across every workspace | Super Admin | [Below](#global-overview) |
| **Infrastructure** | Check the live health of every backing service | Super Admin | [Below](#infrastructure) |
| **Redis & Graph Store** | See how Redis and the default graph store are configured, and test them | Super Admin | [Below](#redis--graph-store) |
| **Graph store** | See shards, replicas and where every graph lives | Super Admin | [The Graph Store](/guide/graph-store-topology) |
| **Branding** | Set the product name, logo, colour and support email | Super Admin | [Below](#branding) |
| **Features** | Turn capabilities on and off for everybody | Super Admin | [Feature Switches](/guide/feature-switches) |
| **Telemetry** | Find out which help content people miss | `system:audit:read` | [Below](#telemetry) |
| **Announcements** | Show a banner to everyone | Super Admin | [Below](#announcements) |
| **User Management** | Invite, add, approve and look after accounts | Super Admin | [Users & Access](/guide/users-access) |
| **Groups** | Bundle people to grant roles in bulk | `system:groups:manage` — Org Admins and Super Admins | [Users & Access](/guide/users-access#groups) |
| **Permissions** | See and change what each role grants, and who has access where | Super Admin | [Users & Access](/guide/users-access#permissions) |
| **SSO** | Connect and run single sign-on | Super Admin | [Single Sign-On](/guide/sso-setup) |
| **Audit Log** | See who changed roles, access and accounts, and when | `system:audit:read` | [Below](#audit-log) |

> **Note:** The **Org Auditor** role holds `system:audit:read` but not the
> permission that opens Administration, so today an Org Auditor can't reach
> **Telemetry** or **Audit Log** in the app. An **Org Admin** sees only
> **Groups**.

---

## Global Overview

**What it's for:** a one-screen answer to "how big is everything?" across every
workspace. **Who:** Super Admins.

![The Global Overview page: total nodes, edges, data sources and entity types, the counts of physical connections and isolated workspaces, and a per-workspace breakdown table](/docs-assets/guide/admin-infrastructure-hero.png)

- Four totals across the platform: **Total Nodes**, **Total Edges**, **Data
  Sources** and **Entity Types**.
- How many **Physical Connections** (providers) and **Isolated Workspaces**
  there are.
- A table of every workspace — **Sources**, **Nodes**, **Edges** and **Entity
  Types**, the biggest first, the default workspace marked **DEFAULT**. Select
  a row to open that workspace.
- **Enterprise Data Model** — every entity type found across all workspaces.

Two shortcuts sit at the top: **Register Connection** opens **Ingestion →
Providers**, and **Create Workspace** opens **Workspaces**. [Admin
Setup](/guide/admin-setup) walks through both.

---

## Infrastructure

**What it's for:** live health, performance and data-plane lag across every
backing service — the place to start when people report slowness or missing
data, and worth a glance after a deployment or a large data load. **Who:**
Super Admins.

The page refreshes every 10 seconds (or select **Refresh**). Read it top to
bottom:

1. **The status banner** — **All systems operational**, **Some components need
   attention** or **Core database unreachable**, with a one-line count of
   healthy services.
2. **The inventory strip** — **Workspaces**, **Data sources**, **Providers**
   (active / total), **Versioned graphs**, **Open reviews** and **Commits**.
3. **Service tiles** — one per backing service (the Postgres databases, Redis,
   the graph store, and the aggregation and stats services), each **Healthy**,
   **Degraded**, **Down** or **Not configured**.
4. **Graph data providers** — reachability of every registered graph backend,
   **Memory headroom** for each graph store node, and any **Graphs not
   publishing**.
5. **Workload tiles** — **Aggregation success rate**, **Avg job duration** (last
   50 completed), **Stuck jobs** (running with no executor heartbeat),
   **Overdue data sources** (not polled within twice their interval) and
   **Overlay integrity**.
6. **Diagnostics & remediation** — what each signal means, why it might be
   happening, and how to resolve it. Expand a finding for the details.
7. Further panels for **Enabling version control**, **Versioned graph
   projection** and **Delivery pipelines** (queue depth and consumer lag).

### Adjust the graph store's limits

Each node under **Memory headroom** shows its current limits. To change them:

1. Select **Adjust graph store limits** next to the node. The **Graph store
   limits** dialog opens, with a **How they are sized** link.
2. Set **Query time cap (TIMEOUT_MAX)**, **Per-query memory ceiling
   (QUERY_MEM_CAPACITY)** or **Effects threshold (EFFECTS_THRESHOLD)**. Raising
   the memory ceiling also needs the **Container memory limit**, because the
   application can't read it. In a multi-node store, tick **Apply the same
   limits on every primary node, not only this one** if the change must survive
   a failover.
3. Select **Review change**, check **What changes**, then select **Apply now**.

**You should now see** the new limits on the node. A runtime change lasts until
the graph store restarts; the dialog gives you the `FALKORDB_ARGS` fragment to
make it permanent. [Rollup Capacity & Large
Graphs](/guide/rollup-capacity#adjusting-the-graph-stores-own-limits) explains
every check the dialog makes. The same dialog opens from **Adjust limits** on
the **Graph store** page.

### When a provider goes offline

{brand} re-checks every provider about every 30 seconds. When one stops
answering, a **Provider Unavailable** banner appears across the top of the app
(you can **Snooze** it), and the provider shows as unreachable here and on its
card in **Ingestion → Providers**. Not every offline provider is a hard outage:
where {brand} still holds recent data, the figures show a **Cached · updated *X*
ago** chip rather than an error, so people keep working with slightly stale but
real data. The chip clears itself once the provider is back. To test a
provider yourself, open **Ingestion → Providers** and select **Test** on its
card (or **Re-test All**).

---

## Redis & Graph Store

**What it's for:** the Redis-protocol endpoints {brand} runs on — the streams
that carry background work, the cache that speeds up reads, and the default
graph store — with where each value came from, whether it's reachable, and
which providers it touches. **Who:** Super Admins.

The page is **Deploy-managed · read-only**: settings come from environment
variables and mounted secret files, so it shows what resolved and never stores
a secret.

1. Open **Administration → Redis & Graph Store**. The top right shows how many
   endpoints resolved, such as **3/3 healthy**.
2. Read the three cards — **Streams · coordination bus**, **Cache · provider
   read accelerator** and **FalkorDB · graph database**. Each shows a status
   (**Healthy**, **Degraded**, **Misconfigured** or **Not configured**), its
   **Resolved connection**, and what happens if it's down.
3. Select **Test connection** on a card. It opens a live PING + INFO to confirm
   authentication and TLS.

**You should now see** the result of the test on the card.

| Endpoint | The card's verdict if it is down | What that means |
| --- | --- | --- |
| **Streams · coordination bus** | "Background work stops; auth stays up." | New background jobs stop being picked up, so aggregation and versioning stall until it recovers. |
| **Cache · provider read accelerator** | "Reads get slower; nothing breaks." | Values are recomputed on the fly; the cache is never on the critical path. |
| **FalkorDB · graph database** | "Graph reads and writes on the env-default instance fail." | Covers only the deployment's default graph store. Providers registered in **Ingestion** with their own endpoints aren't on this card. |

To change an endpoint, update the variable or secret in your deployment,
restart the affected services, then use **Test connection** to confirm. Each
card lists its variables and the **Affected services on change**;
[Configuration](/docs/configuration) covers the deployment settings. **Impact
on providers**, at the foot of the page, shows which providers use the shared
default cache and which have a **Dedicated override**. A **Deprecated
configuration in use** notice appears if the deployment still relies on older
setting names.

---

## Graph store

**What it's for:** every graph store {brand} talks to, totalled — then, per
store, every node (masters and replicas), what each holds, how far replicas lag
and where every graph lives. **Who:** Super Admins. [The Graph Store: Shards,
Replicas & Placement](/guide/graph-store-topology) explains every figure on it.

---

## Branding

**What it's for:** how this deployment presents itself — the name, logo,
colours and legal text used across the app, the sign-in screen and the browser
tab. **Who:** Super Admins.

1. Open **Administration → Branding**. The **Live preview** shows the sign-in
   card as you type.
2. Change any of the fields below. A counter shows how many unsaved changes you
   have; **Discard** undoes them.
3. Select **Save changes**.

**You should now see** "Branding saved — the new name and logo are live
everywhere."

| Section | Field | Where it shows |
| --- | --- | --- |
| **Identity** | **Application name** | The full product name — the sign-in screen and the browser tab |
| | **Short name** | Tight spaces such as the top bar and command palette |
| | **Description** | A one-line summary under the name on the sign-in screen, and the page's meta description |
| | **Sign-in tagline** | The line beneath the name on the sign-in screen |
| **Logo & favicon** | **Logo** | The top bar; falls back to the default mark when empty |
| | **Favicon** | The browser tab |
| **Theme** | **Accent colour** | Highlights, buttons and active states — a hex value such as `#6366f1`, applied live across the app |
| **Legal & contact** | **Copyright** | Footer text on the sign-in screen and elsewhere |
| | **Support email** | Turns on **Contact support** in the in-app **Help** panel; leave it blank to hide it |

Empty fields fall back to the deployment's defaults.

**Uploads save on their own.** Upload an image (SVG, PNG, JPEG, WebP or ICO,
up to 1 MB), or paste a hosted image URL instead — an upload takes precedence
over a URL. Under **Built-in marks**, **Use this mark** applies one of the
ready-made marks as both logo and favicon in one click. Uploads and built-in
marks apply immediately; a pasted URL is saved with **Save changes**.

**To start again,** select **Reset to defaults**. It clears every override —
name, logo, favicon, colours and legal text — immediately, and can't be undone.

### When someone else saved first

Branding is versioned, so two admins can't silently overwrite each other.

- If someone saves while you're editing, a notice can appear: "Someone else saved
  branding (version *N*) while you were editing. Nothing you typed was touched;
  saving will ask which changes to keep." Select **Review** to look now.
- When you save over a newer version, the **Branding changed while you were
  editing** panel opens instead: "Version *N* was saved elsewhere … Nothing you
  typed has been lost." It lists any field you both changed under **Both
  changed**, **Theirs** and **Yours**. Select **Keep my changes** (yours go on
  top of their version — then select **Save changes** again) or **Discard
  mine**. If you hadn't changed anything, select **Load version *N***.

![Administration → Branding with the Identity section filled in and the Live preview of the sign-in card on the right](/docs-assets/guide/governance-ops-branding.png)

---

## Features

**Features** is the master panel for what your users can and cannot do. Every
switch takes effect immediately, for everybody. The ones administrators meet
first are **Self-registration** (off by default), **Invite links** (on),
**Version control** (on), **Announcements** (on) and **Guided product tours**
(off). [Feature Switches](/guide/feature-switches) explains every switch, its
default, and what happens when you turn it off. **Who:** Super Admins.

---

## Telemetry

**What it's for:** how your help content is working — which pages people find
helpful, what they searched the documentation for and didn't find, and where
they abandon guided tours. In short: what to write or fix next. **Who:**
`system:audit:read` (Super Admins).

It draws on three signals:

- **"Was this helpful?" votes** — the question at the foot of every User Guide
  and Documentation page, counted from signed-in readers.
- **Searches that found nothing** — documentation searches that returned no
  results, called **content gaps**.
- **Guided-tour engagement** — tours finished, and where people skipped out.
  Tours are off by default, so this stays empty until you turn them on.

1. Open **Administration → Telemetry**.
2. Choose a window: **7d**, **30d** (the default) or **90d**.
3. Read the cards: **Helpful score** (the share of thumbs-up votes),
   **Feedback votes**, **Tours completed** and **Content gaps**.
4. Work down **Content gaps — searches that found nothing**: up to 15 searches,
   most-asked first, each with how many times it was asked.
5. Check **Helpful by page** — thumbs-up and thumbs-down counts per page,
   most-voted first. Select a page name to open it.
6. If tours are on, check **Tour funnel — completion & drop-off**: starts,
   completion rate, and **Most drop-off at step *N*** for each tour.

| If you see… | Do this | Because |
| --- | --- | --- |
| A search in **Content gaps** | Add or retitle a guide section using the words people typed | People are looking for it and finding nothing |
| A page with many thumbs-down votes | Rewrite its opening and first steps | That's where most readers give up |
| Most tour drop-off at one step | Shorten or fix that step | Everyone after it is lost |

For product adoption — who uses which views and features — use
[Analytics](/guide/analytics) instead.

---

## Announcements

**What it's for:** a banner across the top of the app, for everyone — planned
maintenance, a new feature, a known issue. **Who:** Super Admins.

1. Open **Administration → Announcements** and select **New Announcement**.
2. Enter a **Title** and **Message**, and choose a **Banner Type**: **Info**,
   **Warning** or **Success**.
3. Leave the switch on **Active** ("Banner is visible to all users") to publish
   it as soon as you create it.
4. Set **Snooze Duration** in minutes. `0` means people can't hide the banner;
   any other value lets them hide it for that long, after which it comes back.
5. Optionally add **Button Text** and a **Button URL** — for example a **Learn
   More** link to the details.
6. Select **Create**.

**You should now see** the announcement in the list, and the banner appears for
everyone within one check — browsers look for changes every 15 seconds unless
you change **Polling Interval** under **Banner Settings** (the gear button).

On each announcement in the list, the switch pauses or republishes it ("is
paused — nobody sees the banner now"), the pencil opens **Edit Announcement**,
and the bin deletes it permanently after you confirm. To silence every banner
at once without touching them one by one, switch off **Announcements** in
**Administration → Features**; turn it back on and they return exactly as they
were.

> **Tip:** Keep announcements short and specific, post them *before*
> disruptive work, and remove them once they're stale — nothing erodes trust
> like a banner about last month's maintenance.

---

## Audit Log

**What it's for:** "who changed this, and when?" for access and accounts —
sign-ins and sign-outs, failed sign-ins and ended sessions, every change to
roles, permissions, workspace members, groups and view shares, access
requests, single sign-on settings, and account changes such as approvals, role
changes, suspensions, password resets and invites. **Who:** `system:audit:read`
(Super Admins).

1. Open **Administration → Audit Log**.
2. Choose a **Range**: **Last 24h**, **Last 7d** (the default), **Last 30d** or
   **All time**.
3. Choose a **Scope** (see the table below). **Security** is the default.
4. Narrow it down: select a category card — **Workspace bindings**, **Role
   lifecycle**, **Permissions** or **User lifecycle** — or type a name, email or
   user ID into **Who did it** or **Who it affected**. **Clear** resets them.
5. Read the table — **When**, **What happened**, **Actor**, **Target** and
   **Workspace** — and select a row for its details, such as the event ID and
   role. Select **Load more** for older events.

**You should now see** only the events that match, newest first.

| Scope | Shows | Hides |
| --- | --- | --- |
| **Security** | Sign-ins, sign-outs, failed sign-ins, session revocations, and every role and permission change | Access-denied noise, password-reset and signup chatter, new invites and new access requests |
| **Activity** | Everything in **Security**, plus password resets, signups, invites and new access requests | Only the access-denied noise |
| **Everything** | The unfiltered log, including hourly access-denied events — slow on busy systems | Nothing |

Some history lives elsewhere:

| To see… | Go to |
| --- | --- |
| Changes to a semantic layer | **Semantic Layers** → the layer → **History** (when **Layer history & audit** is on) |
| What happened to one view | The view's **Activity** |
| Why one person's single sign-on failed | **Administration → SSO → Diagnostics** — see [Running Single Sign-On](/guide/sso-operations#when-a-sign-in-fails) |

---

## Looking for something else?

These live outside Administration:

| To… | Go to |
| --- | --- |
| Register or test a provider | **Ingestion → Providers** — see [Admin Setup](/guide/admin-setup) |
| Monitor or re-run aggregation, or check freshness | **Ingestion → Job History** and **Ingestion → Freshness**, or a workspace's **Aggregation** tab — see [Data Freshness & Ingestion](/guide/data-freshness) |
| Give someone a role in one workspace | The workspace's **Members** tab — see [Workspace Admin](/guide/workspace-admin) |
| Edit a semantic layer | **Semantic Layers** — see [The Semantic Layer](/guide/semantic-layer) |
| See adoption and engagement | **Analytics** — see [Analytics](/guide/analytics) |

---

## A suggested operating rhythm

| Cadence | Do this |
| --- | --- |
| **Daily / on alert** | Glance at **Infrastructure**; act on anything **Down** or **Degraded**. |
| **Weekly** | Check **Ingestion → Job History** for failed aggregation; revoke invite links you no longer need under **Manage links**; clear stale announcements; read **Telemetry** content gaps. |
| **Monthly** | Review role changes in the **Audit Log**; review roles and groups for drift; sort **User Management** by **Last seen** to find unused accounts. |
| **Per change** | Announce disruptive work ahead of time; check what depends on a provider before deleting it; check a semantic layer's **Health** before publishing changes. |

---

## Where to next

- [Users & Access](/guide/users-access) — when you want to invite people,
  choose roles or use groups.
- [Feature Switches](/guide/feature-switches) — when you want to know what each
  switch does before you flip it.
- [Data Freshness & Ingestion](/guide/data-freshness) — when aggregation fails
  or data looks out of date.
- [Running Single Sign-On](/guide/sso-operations) — when people sign in through
  your identity provider.
