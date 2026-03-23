# Synodic — Seed Scripts

Scripts for generating and loading synthetic enterprise data-lineage graphs into FalkorDB or Neo4j.

## Prerequisites

| Dependency | Required For | Default |
|---|---|---|
| FalkorDB | `seed_falkordb.py`, `seed_large_lineage.py` | `localhost:6379` |
| Neo4j | `seed_neo4j.py` | `bolt://localhost:7687` |
| Python 3.11+ | All scripts | — |
| Docker | `docker_seed.py`, `seed.sh --docker` | — |

Start the infrastructure first:

```bash
# Via docker-compose (recommended)
docker compose up falkordb postgres

# Or run FalkorDB standalone
docker run -p 6379:6379 -p 3000:3000 falkordb/falkordb:latest
```

---

## Quick Start

```bash
# Helper script (auto-detects venv, sets defaults)
./backend/scripts/seed.sh

# Or run directly
python backend/scripts/seed_falkordb.py --scenarios finance,ecommerce --scale 1
```

---

## Seed Scripts Overview

### `seed_falkordb.py` — Primary FalkorDB Seeder

The main seeder for development and demos. Generates a complete enterprise graph with configurable scenarios, breadth, and depth.

```bash
python backend/scripts/seed_falkordb.py [OPTIONS]
```

| Flag | Default | Description |
|---|---|---|
| `--scenarios` | `finance` | Comma-separated list: `finance`, `hr`, `marketing`, `ecommerce`, or `all` |
| `--scale` | `1` | Volume multiplier (1 = ~1k nodes). Fills with archive data to reach target |
| `--breadth` | `1` | Parallel system chains per domain. 2 = doubled source systems |
| `--depth` | `1` | Transformation layers (staging tiers). 2+ = richer lineage paths |

**Examples:**

```bash
# Minimal demo (finance only, ~200 nodes)
python backend/scripts/seed_falkordb.py --scenarios finance

# Full demo with all 4 domains
python backend/scripts/seed_falkordb.py --scenarios all --depth 2

# Stress test (~5k nodes, deep lineage)
python backend/scripts/seed_falkordb.py --scenarios all --scale 5 --breadth 2 --depth 3
```

**What it generates:**

| Layer | Entity Types | Description |
|---|---|---|
| Governance | `Tag`, `GlossaryTerm` | PII, Certified, GDPR-Sensitive tags; business terms (Revenue, EBITDA, etc.) |
| Source | `Domain` → `DataPlatform` → `Container` → `Dataset` → `SchemaField` | SAP, NetSuite, Shopify, Workday, etc. |
| ETL | `DataFlow` → `DataJob` | Airflow pipelines with extract/validate/load steps |
| Transform | `Container` → `Dataset` → `SchemaField` (in Snowflake) | Bronze/silver/gold staging tiers with dbt transforms |
| Mart | `Dataset` (aggregated) | Rolled-up summary tables with `AGGREGATED` edges |
| Consumption | `Dashboard` → `Chart`, `Report` | Tableau dashboards, scheduled reports |
| Application | `App` | Internal portals consuming from gold datasets |

**Edge types used:**

| Edge | From → To | Purpose |
|---|---|---|
| `CONTAINS` | Parent → Child | Structural hierarchy |
| `TRANSFORMS` | SchemaField → SchemaField | Column-level lineage |
| `CONSUMES` | Dataset → DataJob | ETL input |
| `PRODUCES` | DataJob → Dataset | ETL output |
| `BELONGS_TO` | GlossaryTerm → Domain | Ownership |
| `TAGGED_WITH` | Dataset/SchemaField → Tag | Governance tagging |
| `RELATED_TO` | Dataset → Dataset | Cross-domain relationships |
| `AGGREGATED` | SchemaField → SchemaField | Roll-up lineage |

---

### `seed_large_lineage.py` — Large-Scale Lineage Seeder

Designed for performance testing with realistic multi-hop lineage across three enterprise domains (Finance/SAP, Sales/Salesforce, Marketing/eCommerce).

```bash
python backend/scripts/seed_large_lineage.py [OPTIONS]
```

| Flag | Default | Description |
|---|---|---|
| `--scale` | `1.0` | Volume factor. `1.0` = 100k nodes, `10.0` = 1M nodes |
| `--dry-run` | off | Generate in memory only, skip database push |
| `--push-falkordb` | off | Push generated data to FalkorDB (required for actual seeding) |

**Examples:**

```bash
# Dry run — generate and count, don't push
python backend/scripts/seed_large_lineage.py --scale 0.1 --dry-run

# Push 100k nodes to FalkorDB
python backend/scripts/seed_large_lineage.py --scale 1.0 --push-falkordb

# 1M node stress test
python backend/scripts/seed_large_lineage.py --scale 10.0 --push-falkordb
```

**Key differences from `seed_falkordb.py`:**

- Fixed 3-domain layout (Finance, Sales, Marketing) with hardcoded realistic schemas (SAP VBAK/VBAP, Salesforce Account/Contact/Opportunity, etc.)
- Full medallion architecture: Source → Airflow → S3 Bronze → Spark Silver → Snowflake Gold → Mart
- Column-level lineage with proper `DataJob` intermediaries (`CONSUMES` → Job → `PRODUCES`)
- PII auto-detection on columns (email, phone, names) with `TAGGED_WITH` → PII tag
- Bulk Cypher push with label-specific `MATCH` for performance at scale
- Scale filler generates archive data to reach target node count

---

### `seed_neo4j.py` — Neo4j Seeder

Same generation logic as `seed_falkordb.py` but pushes to Neo4j via the `Neo4jProvider`.

```bash
python backend/scripts/seed_neo4j.py [OPTIONS]
```

| Flag | Default | Description |
|---|---|---|
| `--scenarios` | `finance` | Same as `seed_falkordb.py` |
| `--scale` | `1` | Same as `seed_falkordb.py` |
| `--breadth` | `1` | Same as `seed_falkordb.py` |
| `--depth` | `1` | Same as `seed_falkordb.py` |
| `--wipe` | off | Wipe all data before seeding |

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `NEO4J_URI` | `bolt://localhost:7687` | Neo4j connection URI |
| `NEO4J_USERNAME` | `neo4j` | Auth username |
| `NEO4J_PASSWORD` | `password` | Auth password |
| `NEO4J_DATABASE` | `neo4j` | Target database |

---

### `docker_seed.py` — Docker-Aware Seeder

Wraps `seed_falkordb.py` for use as a one-shot Docker container. Waits for FalkorDB health, checks if data already exists (skips if so), then seeds.

```bash
# Standalone
python backend/scripts/docker_seed.py --scenarios all --scale 1

# Via docker-compose (recommended)
docker compose --profile seed up --build
```

**Environment variables (set in `docker-compose.yml`):**

| Variable | Default | Description |
|---|---|---|
| `FALKORDB_HOST` | `localhost` | FalkorDB hostname |
| `FALKORDB_PORT` | `6379` | FalkorDB port |
| `FALKORDB_GRAPH_NAME` | `nexus_lineage` | Target graph name |
| `SEED_SCENARIOS` | `finance,ecommerce` | Scenarios to generate |
| `SEED_SCALE` | `1` | Scale factor |
| `SEED_BREADTH` | `1` | Breadth multiplier |
| `SEED_DEPTH` | `2` | Depth multiplier |
| `SEED_FORCE` | `false` | Set `true` to re-seed even if data exists |

---

### `optimize_falkordb.py` — Index Creation

Creates FalkorDB indices on `urn`, `displayName`, and `qualifiedName` across all node labels. Run after seeding for query performance.

```bash
python backend/scripts/optimize_falkordb.py
```

---

## Shell Script: `seed.sh`

Convenience wrapper that handles venv activation, argument parsing, and backend selection.

```bash
./backend/scripts/seed.sh [OPTIONS]
```

| Flag | Description |
|---|---|
| `--all` | Seed all scenarios (finance, hr, marketing, ecommerce) |
| `--scenarios <list>` | Comma-separated scenario list |
| `--scale <n>` | Scale factor |
| `--breadth <n>` | Breadth multiplier |
| `--depth <n>` | Depth (transformation layers) |
| `--large` | Use `seed_large_lineage.py` instead of `seed_falkordb.py` |
| `--neo4j` | Use `seed_neo4j.py` (requires Neo4j running) |
| `--docker` | Run via `docker compose --profile seed` |
| `--wipe` | Wipe existing data before seeding (Neo4j) or force re-seed (Docker) |
| `--dry-run` | Generate only, don't push (large lineage mode) |

**Examples:**

```bash
# Default: finance + ecommerce, depth=2
./backend/scripts/seed.sh

# All scenarios via Docker
./backend/scripts/seed.sh --docker --all

# Large-scale performance test (100k nodes)
./backend/scripts/seed.sh --large --scale 1.0

# Neo4j with wipe
./backend/scripts/seed.sh --neo4j --all --wipe

# Dry run to check node/edge counts
./backend/scripts/seed.sh --large --dry-run --scale 0.5
```

---

## Scenarios

Each scenario generates a complete data lineage chain from source systems through transformations to consumption.

| Scenario | Domain | Source Systems | Datasets | Consumption |
|---|---|---|---|---|
| `finance` | Finance | SAP ERP, NetSuite | Sales, Accounting, Materials, Transactions | CFO Dashboard, Monthly Variance, Tax Audit |
| `hr` | Human Resources | Workday, Greenhouse | Workers, Compensation, Applications | Headcount Overview, Recruitment Funnel |
| `marketing` | Marketing | Google Ads, HubSpot | Campaigns, Keywords, Contacts, Leads | Marketing ROI, Lead Attribution |
| `ecommerce` | eCommerce | Shopify, Stripe | Orders, Products, Charges, Refunds | Sales Dashboard, Inventory Health |

---

## Entity Types

All 14 entity types from the graph model:

| Entity Type | Node Label | Description |
|---|---|---|
| `DOMAIN` | `domain` | Business domain (Finance, HR, etc.) |
| `DATA_PLATFORM` | `dataPlatform` | Infrastructure platform (Snowflake, SAP, S3) |
| `CONTAINER` | `container` | Database, schema, or bucket |
| `DATASET` | `dataset` | Table, file, or topic |
| `SCHEMA_FIELD` | `schemaField` | Column with `dataType`, `nullable` properties |
| `DATA_FLOW` | `dataFlow` | Pipeline / DAG (Airflow, dbt project) |
| `DATA_JOB` | `dataJob` | Individual ETL step within a flow |
| `DASHBOARD` | `dashboard` | BI dashboard (Tableau) |
| `CHART` | `chart` | Visualization within a dashboard |
| `REPORT` | `report` | Scheduled report with `schedule` property |
| `GLOSSARY_TERM` | `glossaryTerm` | Business term with definition |
| `TAG` | `tag` | Governance label (PII, Certified, GDPR, etc.) |
| `APP` | `app` | Internal application consuming data |
| `SYSTEM` | `system` | Processing system (Spark cluster) |

## Edge Types

All 8 edge types from the graph model:

| Edge Type | Relationship | Description |
|---|---|---|
| `CONTAINS` | Parent → Child | Structural containment hierarchy |
| `TRANSFORMS` | SchemaField → SchemaField | Column-level data lineage |
| `CONSUMES` | Dataset/Job → Job/App | Input dependency |
| `PRODUCES` | Job → Dataset/Report | Output dependency |
| `BELONGS_TO` | GlossaryTerm → Domain | Domain ownership |
| `TAGGED_WITH` | Any → Tag | Governance classification |
| `RELATED_TO` | Dataset → Dataset | Cross-domain association |
| `AGGREGATED` | SchemaField → SchemaField | Roll-up/summary lineage |

---

## Node & Edge Fields

All model fields are populated by the seed scripts:

**Node fields:**

| Field | Example | Description |
|---|---|---|
| `urn` | `urn:li:dataset:orders_a1b2c3d4` | Unique identifier |
| `entityType` | `dataset` | Entity type label |
| `displayName` | `Orders` | Human-readable name |
| `qualifiedName` | `SHOPIFY_STORE.Orders` | Fully qualified path |
| `description` | `Source table: Orders` | Free-text description |
| `properties` | `{"dataType": "string", "nullable": true}` | Arbitrary key-value metadata |
| `tags` | `["source", "pii"]` | String tag list |
| `layerAssignment` | `bronze` | Data layer (source/bronze/silver/gold/mart/consumption) |
| `sourceSystem` | `shopify` | Origin system identifier |
| `lastSyncedAt` | `2026-03-19T12:00:00Z` | Last sync timestamp |

**Edge fields:**

| Field | Example | Description |
|---|---|---|
| `id` | `transforms-urn:...-urn:...` | Unique edge identifier |
| `sourceUrn` | `urn:li:schemaField:...` | Source node URN |
| `targetUrn` | `urn:li:schemaField:...` | Target node URN |
| `edgeType` | `TRANSFORMS` | Relationship type |
| `confidence` | `0.85` | Lineage confidence score (0.0–1.0) |
| `properties` | `{"logic": "dbt Tier 0"}` | Edge metadata |

---

## Typical Workflows

### First-time setup with Docker

```bash
# Start everything including seed
docker compose --profile seed up --build

# Verify data loaded
docker exec -it synodic-falkordb-1 redis-cli GRAPH.QUERY nexus_lineage "MATCH (n) RETURN labels(n), count(n)"
```

### Local development iteration

```bash
# Start infra only
docker compose up falkordb postgres -d

# Seed with your chosen scenarios
python backend/scripts/seed_falkordb.py --scenarios finance,ecommerce --depth 2

# Optimize indices
python backend/scripts/optimize_falkordb.py

# Start backend
cd backend && uvicorn app.main:app --reload
```

### Performance testing

```bash
# Generate 100k nodes (takes ~30s to generate, ~2min to push)
python backend/scripts/seed_large_lineage.py --scale 1.0 --push-falkordb

# Generate 1M nodes (takes ~5min to generate, ~20min to push)
python backend/scripts/seed_large_lineage.py --scale 10.0 --push-falkordb
```

### Re-seeding (clearing existing data)

```bash
# FalkorDB: drop the graph first
docker exec -it synodic-falkordb-1 redis-cli GRAPH.DELETE nexus_lineage

# Then re-seed
python backend/scripts/seed_falkordb.py --scenarios all --depth 2

# Or via Docker with force flag
SEED_FORCE=true docker compose --profile seed up --build seed
```
