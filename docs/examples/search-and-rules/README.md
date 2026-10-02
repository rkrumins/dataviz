# Advanced Search and display rule examples

Ready-to-use searches and library packs for Advanced Search and display rules.
Every file here is checked against the server's own models by
`backend/tests/test_search_rules_examples.py`, so they stay valid as the models
change.

- User guides: [Advanced Search](../../guide/ADVANCED_SEARCH.md),
  [Display Rules](../../guide/DISPLAY_RULES.md)
- Formats, endpoints and scripting: [Search & Display Rules Reference](../../features/search-and-rules-reference.md)

## What's here

| File | What it is |
| --- | --- |
| `queries/big-datasets.search.json` | Datasets with a `rowCount` of at least a million, biggest first |
| `queries/missing-owner.search.json` | Datasets whose `owner` is missing or blank, grouped by parent |
| `queries/orphaned-tables.search.json` | Datasets with no lineage in or out, by name |
| `queries/pii-by-domain.search.json` | PII- or GDPR-tagged entities, counted per domain (aggregates only) |
| `queries/changed-last-30-days.search.json` | Datasets whose `updatedAt` is within the last 30 days |
| `queries/downstream-of-a-table.search.json` | Datasets and dashboards up to three lineage hops downstream of one table |
| `queries/paths-between-two-tables.search.json` | Lineage paths from one table to another, up to five hops |
| `packs/governance.library.json` | Rules **PII**, **Needs owner**, **Certified**, **Classified, not tagged** (off) and three saved searches |
| `packs/data-quality.library.json` | Rules **Orphan**, **Empty table**, **Stale**, **Dead end** and four saved searches |

Property names (`rowCount`, `owner`, `updatedAt`, `certified`, `pii_class`),
tags (`PII`, `GDPR-Sensitive`, `Certified`) and entity types (`dataset`,
`dashboard`, `domain`) are examples: change them to what your data uses. The
Property Manager's **Properties** tab lists every property a View's entities
carry.

## Running a query

Each `*.search.json` is a complete body for
`POST /api/v1/{ws_id}/graph/search/advanced`. Set its `scope.viewId` (and any
`REPLACE_WITH_…` URN), then, signed in as the reference describes:

```bash
curl -s "${auth[@]}" -X POST "$B/api/v1/$WS/graph/search/advanced?dataSourceId=$DS" \
  -d @queries/big-datasets.search.json | jq '{totalCount, hits: [.hits[].node.displayName]}'
```

To run one in the app instead, copy its `predicate` into the Advanced Search
panel's **Code** mode (JSON is accepted as it is) and press `⌘↵` / `Ctrl+Enter`.

## Importing a pack

**Into one View, in the app:** open the View, then **Property Manager →
Display rules → Import…** (or **Library → Import library…** in Advanced
Search), choose the file, review the preview, and **Import**.

**Into one View, or every View of a data source, from a script:**

```bash
export SYNODIC_BASE_URL=http://localhost:8000 SYNODIC_EMAIL=you@example.com
python -m backend.scripts.publish_view_library docs/examples/search-and-rules/packs/governance.library.json --view <view id>
python -m backend.scripts.publish_view_library docs/examples/search-and-rules/packs/governance.library.json --data-source <data source id>
```

Both are dry runs: they print what each View would add, skip or refuse. Add
`--apply` to import.

## Writing your own

Start from one of the packs: the envelope needs only `format` and `version`;
leave out rule `id`s and `createdAt` (an import assigns them); use 6-digit
`#rrggbb` colours. `backend/common/schema/view-library.v1.json` is the pack's
JSON Schema, for editor completion. A dry-run import is the final check.
