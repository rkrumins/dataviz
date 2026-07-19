# Governance & Operations

*For Administrators.* Once {brand} is set up and people are using it, your job
shifts to keeping it **healthy, trustworthy, and well-communicated**. This page
covers the recurring operational tasks and the governance levers you have.

---

## Keeping providers healthy

Your Views are only as good as the connections feeding them. {brand}
continuously tracks **provider health**:

- Watch **connection status** in **Admin → Overview** / **Ingestion** — a
  provider that goes unhealthy means its data may be stale or unavailable.
- **Re-test connectivity** after credential or network changes.
- Investigate promptly when a provider degrades; downstream users will see
  empty or outdated graphs.

**Not every unhealthy provider is a hard outage.** When a provider drops offline
but {brand} still holds recent data for it, the status shows a **"Cached ·
updated X ago"** chip rather than an error. That means users can keep working
with slightly-stale-but-real data — nothing is broken. {brand} keeps re-checking
the provider (roughly every 30 seconds) and the chip clears itself automatically
once the connection is back. Only step in if the "updated" time keeps climbing,
which signals the provider has been down long enough to look at.

> 💡 Make provider health a quick part of your routine. A red provider is the
> root cause behind most "the graph looks wrong" reports.

---

## The infrastructure status dashboard

Provider connection status tells you about one source at a time. For a **single
fan-in view of overall platform health**, open **Admin → Infrastructure**. It
gathers onto one screen:

- **Graph providers** — the health of the systems storing your lineage graphs.
- **Projection & aggregation** — whether the background processing that builds
  and rolls up graph data is keeping up.
- **Background jobs & bootstrap** — the state of longer-running setup and
  processing tasks.
- **Event streams & diagnostics** — whether the internal pipelines that move
  data between components are flowing.

Check it **during an incident** — when users report widespread slowness or
missing data, this screen usually points at the cause faster than inspecting
providers one by one. It's also worth a **proactive glance** after a deployment,
a provider migration, or a large data load.

![The Global Overview screen: cross-workspace node/edge counts, data sources, and per-workspace scale](/docs-assets/guide/admin-infrastructure-hero.png)

---

## Running data-source aggregation

Some data sources **aggregate** their graph data to power higher-level
granularity (e.g. domain-level views) efficiently. Aggregation runs as a
background job with states like *pending → running → ready*.

- Trigger or monitor aggregation from the data source's settings.
- A data source that isn't **ready** may render slowly or lack aggregated
  levels — check its job state if users report missing domain-level detail.

---

## Auditing changes

Trust comes from traceability. {brand} records **audit trails** for sensitive
actions — most notably the **ontology lifecycle** (created, updated, published,
deleted). Use these to:

- answer *"who changed this, and when?"*,
- review schema evolution over time,
- support compliance and post-incident reviews.

When something visual changes unexpectedly across many Views, the ontology audit
log is the first place to look.

---

## Communicating with announcements

Use **Admin → Announcements** to post **banner notifications** to users — for
planned maintenance, new features, or known issues. Good announcement hygiene:

- Keep them **short and specific**.
- Add them **before** disruptive work (e.g. a provider migration).
- **Remove or update** them once stale — nothing erodes trust like an
  announcement about last month's maintenance.

---

## Managing feature flags

**Admin → Features** is the master panel for turning platform capabilities on
and off. The switches you'll find there include:

- **Version control** — the draft-review-publish workflow for editing graph data
  (the master switch behind [Versioning & Change Control](/guide/versioning-change-control)).
- **Trace** — the upstream/downstream tracing controls on the canvas.
- **Edit mode** — whether users can enter a data source's draft and make changes.
- **Allowed view modes** — which canvas layouts (graph, hierarchy, layered, and
  so on) people can pick from.
- **Sign-up** — whether new people can self-register (**off by default**;
  approvals still apply — see [Users & Access](/guide/users-access)).
- **Announcements** — the banner-notification system covered above.
- **Graph export** — whether users can export a data source or View to a file.
- **Blank models** — starting a data source from an empty graph rather than a
  discovered one.
- **Semantic-layer flags** — a related group covering ontology **editing**,
  **import** and **export**, **auto-suggest**, **version history**, and whether
  **non-admins** may edit ontologies.

Treat flags deliberately:

- Roll new capabilities to a **small group first** where possible.
- **Document** what you've enabled so behaviour changes aren't a mystery to your
  team.
- Turn off anything you're trialling rather than leaving it half-on.

---

## A suggested operating rhythm

| Cadence | Do this |
| --- | --- |
| **Daily / on-alert** | Glance at provider health; act on any red status |
| **Weekly** | Review pending signups; check aggregation jobs are *ready*; clear stale announcements |
| **Monthly** | Audit ontology changes; review roles/groups for drift; archive deprecated Views with workspace owners |
| **Per change** | Announce disruptive work ahead of time; validate ontology before publishing; check catalog-item impact before deletion |

---

## Governance principles

1. **Least access by default.** Grant the narrowest role and scope that works;
   widen only on demand. See [Users & Access](/guide/users-access).
2. **Immutability protects trust.** Publish ontologies deliberately — Views
   depend on them staying stable. See [The Semantic Layer](/guide/semantic-layer).
3. **Check impact before destruction.** Catalog items and ontologies show impact
   analysis before deletion — read it.
4. **Communicate proactively.** An announcement before disruption beats an
   apology after.

---

## Where to next

- People, roles, and approvals → [Users & Access](/guide/users-access)
- The full setup path → [Admin Setup](/guide/admin-setup)
- Team-wide conventions → [Ways of Working](/guide/ways-of-working)
