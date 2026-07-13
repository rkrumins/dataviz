# Versioned Graph — Documentation Index

> **Git for graphs.** A collaborative version-control layer over the property graph: per-user
> **draft branches**, a per-entity **history** and audit trail, **3-way field-level merge**,
> **review & publish** (squash-merge) into a shared `main`, copy-on-write **forks**, **pull
> requests**, and **revert / point-in-time rollback**. Postgres is the source of truth; FalkorDB
> is a rebuildable hot-read cache of `main`.

This is a directory into the 11-chapter reference suite. Start with the two promoted pages, then
follow the deep-reference links below into whichever chapter you need.

## Start here

- **[Overview & Architecture](/docs/versioning-overview)** — the big picture: mental models,
  read/write routing, deployment, and the headline design decisions.
- **[API Reference](/docs/versioning-api-reference)** — the REST contract: the versioning and
  draft-aware graph routers, auth/RBAC/tenancy, and request/response shapes.

## Deep reference

The remaining chapters are the detailed reference material behind the two pages above. They're
linked here as GitHub source links rather than docs-site pages — the in-app docs viewer renders
markdown client-side with no build-time link rewriting for files outside its manifest, so a plain
relative link (`./02-data-model.md`) would 404 if clicked from inside the rendered site. A GitHub
link always resolves correctly, whether you're reading this file in the site, in the repo, or on
GitHub itself.

| Chapter | Covers |
|---|---|
| [02 · Data Model](https://github.com/rkrumins/dataviz/blob/main/docs/versioning/02-data-model.md) | The `graphver` Postgres schema — every table, the append-only version rows plus a mutable head-pointer, HASH partitioning on `graph_id`, ULIDs, and blake2b content hashing. |
| [03 · Branching, Commits & Merge](https://github.com/rkrumins/dataviz/blob/main/docs/versioning/03-branching-commits-merge.md) | The versioning engine — draft branches, stage → checkpoint → publish, the 3-way field-level merge that also powers rebase/fork-PR/revert, and the per-graph advisory-lock concurrency model. |
| [04 · Projection & Cache](https://github.com/rkrumins/dataviz/blob/main/docs/versioning/04-projection-and-cache.md) | How committed `main` is projected into a rebuildable FalkorDB read cache — idempotent `MERGE`/`DELETE` writes, watermark-bounded staleness, self-healing, `:AGGREGATED` rollups, and read routing. |
| [05 · Ontology Governance](https://github.com/rkrumins/dataviz/blob/main/docs/versioning/05-ontology-governance.md) | How the assigned ontology is enforced at the commit boundary on every durable write path — the two validation tiers, structural edge/containment integrity, and the decoupled rule-injection seam. |
| [07 · Frontend Integration](https://github.com/rkrumins/dataviz/blob/main/docs/versioning/07-frontend-integration.md) | How the canvas UI drives versioning — "edit mode" as an open draft, branch-scoped reads via `?branchId=`, the three-phase Save pipeline, and the Zustand / React-Query split. |
| [08 · Import / Export](https://github.com/rkrumins/dataviz/blob/main/docs/versioning/08-import-export.md) | Bulk import/export as the manual draft flow at scale — the parse → resolve → apply pipeline, identity/idempotency, reconcile modes, format adapters, and view-scoped export. |
| [09 · Scale, Limits & Roadmap](https://github.com/rkrumins/dataviz/blob/main/docs/versioning/09-scale-limits-and-roadmap.md) | The candid, measured state of scale — the proven `O(change)` wins, the deliberately-deferred sharp edges, and the prioritized roadmap. |
| [10 · Authoritative Sources (DataHub / OpenMetadata)](https://github.com/rkrumins/dataviz/blob/main/docs/versioning/10-authoritative-sources-datahub-openmetadata.md) | Forward-looking design for federating external catalogs as an authoritative base layer that re-syncs as commits under human-edit-preserving 3-way merge. |
| [11 · Re-sync at Any Scale](https://github.com/rkrumins/dataviz/blob/main/docs/versioning/11-resync-at-any-scale.md) | A designed-not-built plan to make provider re-sync memory-bounded — removing the six whole-graph copies that cost ~2 GB to compute 808 changes — so the size guard can be lifted. |

> A longer prose overview of the whole suite, including the shared glossary, lives in
> [`README.md`](https://github.com/rkrumins/dataviz/blob/main/docs/versioning/README.md).
