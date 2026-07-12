# Data Source Profile — Design Spec

**Date:** 2026-07-11
**Status:** Approved (design) — pending implementation plan
**Supersedes:** the standalone `/datasources/:catalogId` page shipped in `b39f2b32` (relocated into a shared component; the route is kept as a thin deep-link wrapper).

## Context

A data source's insight is scattered across three places today — a row in Ingestion → Data Sources, a card in Job History, and a workspace-scoped drawer (`DataSourceDetailPanel`) — and a first pass added a *fourth*, a standalone `/datasources/:id` page. That page duplicated the workspace drawer's Insights content and pulled the user out of their hub. The root cause is that a data source has **two identities**:

- **Catalog item** (Ingestion) — the registered physical asset. Provider-level truth: what's in the graph, freshness, provider health, who consumes it. Identical regardless of workspace.
- **Workspace data source** (Workspaces) — that catalog item bound into a workspace, with aggregation config, projection mode, ontology, and views. Operational, per-binding.

**Goal:** one reusable, premium **Data Source Profile** that is surfaced *in-context* in both hubs (Ingestion + Workspaces) plus a lightweight deep-link page — with a clean Profile-vs-Operate split so nothing is duplicated, and the Workspaces mount is a genuine **superset** that preserves the powerful per-binding functionality it has today.

## Users & journeys

- **Source owner / data engineer (Ingestion-centric):** register → discover → onboard → *profile* (what's in it, health, who uses it) → watch jobs. Rarely opens Workspaces.
- **Workspace owner / analyst (Workspace-centric):** open workspace → open a data source → *operate it* (aggregate, wire to views, configure) — and wants the profiling summary in that same place.

Both need profiling; they enter from different hubs. So: **one profile component, multiple entry points.**

## Architecture: one component, three frames

A single presentational component **`DataSourceProfile`** owns all profiling. It is **context-aware**:

```
<DataSourceProfile
    catalogId={string}                       // always
    context={{                               // optional workspace binding
        wsId, dataSourceId,
        ontologyId?, ontologyName?,          // the workspace drawer already has these
    } | null}
/>
```

- **Core sections** (catalog-level, render everywhere): At-a-glance metrics, What's inside (composition), Freshness & health, Where it's used, Explore lineage.
- **Enhanced sections** (render only when `context` is present): the powerful per-binding functionality brought over from the workspace drawer (see "Bring-over" below).

Three mount points, no duplicated logic:

1. **Ingestion → Data Sources** — a right-side **slide-over drawer** opened from a row, URL-driven via `?profile=<catalogId>` (shareable, back-button friendly). No workspace context → core sections. *Primary surface for the source owner.*
2. **Workspaces → data-source drawer** — `DataSourceDetailPanel`'s **Insights tab** becomes `<DataSourceProfile catalogId={ds.catalogItemId} context={{ wsId, dataSourceId: ds.id }} />`, alongside the operational tabs (Aggregation · Views · Versioning). Core **+ enhanced** sections. This retires the drawer's current count-less stats surface — one profile everywhere, numbers that agree.
3. **Deep-link page** `/datasources/:catalogId` — a thin wrapper rendering `DataSourceProfile` full-page for bookmarking/sharing. Core sections.

### The Profile-vs-Operate split (removes the duplication)

- **Profile** (shared component): what's inside, freshness/health, who uses it, lineage entry, and — with context — ontology mapping, aggregation readiness, vocab alignment.
- **Operate** (Workspaces-only, stays in the drawer's own tabs): aggregation *config* + trigger/purge, projection mode, views management, versioning.

The profile shows aggregation **as a read-only signal** ("is the lineage rolled up and current?"); the *controls* stay in the Aggregation tab.

## Data layer

One hook — **`useDataSourceProfile(catalogId)`** — bundles via React Query: catalog item (`catalogService.get`), provider (`providerService.get`), stats + freshness envelope (`useAssetStats`), and consumers (`catalogService.getImpact`). Returns a normalized `{ item, provider, stats, meta, health, consumers, isLoading, notFound }`. All three frames read from it, so they are always consistent.

Enhanced (context-only) data reuses existing hooks/services, gated on `context`:
- Aggregation readiness: `aggregationService.getReadiness(dataSourceId)` → status, `aggregationEdgeCount`, `lastAggregatedAt`, `driftDetected`, `activeJob`.
- Ontology mapping: `ontologyId`/`ontologyName` arrive on `context` (the workspace drawer already resolves them).
- Vocab alignment: existing `VocabAlignmentWarning` (`wsId`, `dataSourceId`).

## Content — user-centric, plain-language, premium

A one-line explainer at the top ("A snapshot of what's in this source, how fresh it is, and where it's used"). Sections read top-to-bottom as a story a non-technical owner understands:

**Core (everywhere):**
- **At a glance** — Nodes · Edges · Entity types · Relationship types, as stat tiles.
- **What's inside** — entity + relationship type breakdown (labelled bars, top N + "more").
- **Freshness & health** — "Refreshed 5m ago," provider health dot + `StatusChip`, one-click **Refresh now**.
- **Where it's used** — workspaces + views that consume it (from `getImpact`), each a link. Warm empty state.
- **Explore its lineage** — per-workspace entry into the canvas (`/explorer?workspace=<wsId>`), or a disabled hint when unscoped.

**Enhanced (workspace context) — the "bring-over" of powerful functionality:**
- **Semantic layer** — which ontology this source maps to, link to it.
- **Aggregation status** — ready/running/failed, last aggregated, `edgeCount`, and a **drift** indicator ("source changed since last aggregation") — read-only; a "Manage" link points to the Aggregation tab.
- **Vocabulary alignment** — the existing case-drift/multi-variant warning where declared vs physical type spellings differ.

Premium/intuitive details: slide-over with staggered reveal, honest skeletons, plain-language section titles, warm empty states, full light/dark + the app's glass/ink/indigo-emerald system. Follows the existing drawer pattern (portal + `Backdrop` + framer-motion, as `DataSourceDetailPanel`/`ExplorerPreviewDrawer`).

## Bring-over: what's preserved so nothing regresses

The Workspaces Insights tab today shows: MiniKPIs (nodes/edges/entity-types), ontology link, updated date, an entity-type-name chip list (no counts), and a node/edge ratio bar; the drawer header shows aggregation status + `lastAggregatedAt`. The shared profile is a **strict superset**:

| Current workspace Insights | In the new profile |
|---|---|
| Nodes / Edges / Entity types KPIs | At a glance (+ Relationship types, + real per-type counts) |
| Entity-type names (no counts) | What's inside — entity **and** relationship breakdown, with counts |
| Ontology link | Semantic layer (enhanced section) |
| Updated date | Freshness & health (+ provider health, + Refresh now) |
| Aggregation status + lastAggregatedAt (header) | Aggregation status (enhanced, + drift) |
| — | Where it's used (new), Explore lineage (new), Vocab alignment (surfaced) |

## Changes to existing files

- **`components/admin/RegistryAssets.tsx`** — the row insights affordance opens the drawer (`?profile=<catalogId>`) instead of routing away; render `DataSourceProfileDrawer` driven by the search param.
- **`components/admin/workspace/DataSourceDetailPanel.tsx`** — Insights tab body → `<DataSourceProfile catalogId={ds.catalogItemId} context={{ wsId, dataSourceId: ds.id }} />`; remove the now-duplicated inline stats/ratio markup. Operational tabs unchanged.
- **`pages/DataSourceOverviewPage.tsx`** — slim to a thin wrapper around `DataSourceProfile` (keep the route for deep-linking).

## New files

- `hooks/useDataSourceProfile.ts` — the bundled data hook.
- `components/insights/DataSourceProfile.tsx` — the shared, context-aware component (extracted/upgraded from the current page body).
- `components/insights/DataSourceProfileDrawer.tsx` — slide-over wrapper (portal + Backdrop + motion) used by Ingestion.

## Out of scope (deliberate)

- **Net-new** quality analytics not already in the app: orphan-count / disconnected-node surfacing (needs per-view graph context — Tier 2). Vocab-alignment *is* in scope because it already exists in the workspace drawer (preserve, don't build).
- The operational controls (aggregate/purge/config/versioning) stay in the Workspaces drawer's own tabs.
- No backend changes; all data comes from existing endpoints.

## Verification

- Unit/render tests: `DataSourceProfile` renders core sections from mocked `useDataSourceProfile`; enhanced sections appear only when `context` is passed; `DataSourceProfileDrawer` opens/closes from the URL param.
- Live: Ingestion row → drawer opens in-context and deep-links; Workspaces Insights tab shows core + aggregation/ontology/vocab; `/datasources/:id` still renders full-page. `tsc` at baseline, `vite build` green, targeted vitest green.

## Rollout note

The standalone page (`b39f2b32`) is not deleted — it's relocated behind the shared component, so the deep-link keeps working throughout.
