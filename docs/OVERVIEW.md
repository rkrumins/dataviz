# {brand}: Project Overview, Vision & Roadmap

The starting point for understanding {brand} — what it is, the problem it solves, what has shipped, and where it's headed.

**Who it's for:** anyone new to the platform — admins, data engineers, business stakeholders, and developers looking for orientation before the deeper design docs.

**What you'll find here:**
- Key terms and a role-based reading guide
- The problem, the vision, and core design principles
- Shipped capabilities and honest maturity assessment
- Competitive positioning and forward-looking roadmap

> **Tip:** Skim the [Key Terms](#key-terms) table first — the four-entity vocabulary (Provider, CatalogItem, Ontology, Workspace) recurs across every other doc.

---

## What is {brand}?

{brand} is a **workspace-centric data lineage and governance platform** that transforms how organizations explore, understand, and govern their data relationships. It provides an interactive graph visualization experience over heterogeneous data backends, unified by a flexible semantic layer (ontology system).

---

## Key Terms

| Term | Definition |
|------|-----------|
| **Provider** | Infrastructure connection to a graph database (FalkorDB, Neo4j, DataHub). Stores host, port, credentials, TLS settings. |
| **Ontology** | Versioned semantic schema defining entity types (e.g., Dataset, SchemaField) and relationship types (e.g., CONTAINS, TRANSFORMS). Formerly called "Blueprint". |
| **Workspace** | Operational context for a team or project. Contains data sources, views, and context models. Provides isolation between teams. |
| **CatalogItem** | Governed data product abstraction. Represents a discovered or registered graph/schema from a Provider, with permission control. Bridges Providers and DataSources. |
| **DataSource** | Binding of a Provider + CatalogItem + Ontology within a Workspace. The unit of data access. |
| **View** | Saved graph exploration with layout, filters, and visibility scoping (enterprise/team/personal). |
| **Context Model** | Layer configuration for organizing complex graphs. Defines how entities are grouped and displayed. |
| **Projection Mode** | How aggregated lineage edges are stored. `in_source` writes them in the original graph; `dedicated` creates a separate projection graph to preserve source data integrity. |
| **Granularity** | Level of detail in lineage visualization. Can be aggregated (domain → table) or fine-grained (column-level). |
| **Containment Hierarchy** | Parent-child relationships between entities (e.g., Domain contains Dataset contains SchemaField). |
| **Three-Layer Ontology Resolution** | How ontologies are assembled: system defaults + workspace-assigned definitions + provider-introspected types. Cached for 5 minutes. |

---

## Reading Guide

**New Platform Admin:**
1. This document (vision & capabilities)
2. [SETUP.md](SETUP.md) -- get the platform running
3. [ARCHITECTURE.md](ARCHITECTURE.md) -- understand core concepts
4. [BACKEND.md](BACKEND.md) -- Admin Infrastructure section

**Data Engineer:**
1. Steps 1--4 above
2. [FRONTEND.md](FRONTEND.md) -- graph exploration & canvas
3. Return to this doc -- "For Data Engineers" workflows

**Developer:**
1. [ARCHITECTURE.md](ARCHITECTURE.md) -- system design
2. [BACKEND.md](BACKEND.md) -- full API reference
3. [FRONTEND.md](FRONTEND.md) -- component architecture
4. [DECISIONS.md](DECISIONS.md) -- architectural trade-offs
5. [TECHNICAL_DEBT.md](TECHNICAL_DEBT.md) -- known risks

**Deep Dive:**
- [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) -- all schema details
- [API_FEATURES.md](API_FEATURES.md) -- feature flag contract

---

```mermaid
mindmap
  root(({brand}))
    Interactive Lineage
      Trace upstream/downstream
      Multi-granularity zoom
      Column → Table → Domain
      Aggregated edge rollups
    Semantic Governance
      Versioned ontologies
      Evolution policies
      Impact analysis
      Schema drift detection
      Audit Trail (OntologyAuditLog)
      Source Mappings
      Drift Detection
    Graph Change Control
      Drafts + review & merge (PR-style)
      Publish, revert, restore
      Version-control master switch
      Resumable enable-VC bootstrap job
    Lineage Lens / Context View
      External-degree signal
      Curated-view chip
      Layer Strip
      Anchor Rail + one-page-ahead pagination
    Data Catalog
      CatalogItems
      Workspace Bindings
      Impact Analysis
    Guided Onboarding
      First-Run Hero
      Setup Wizard
      Progress Tracker
      Asset Onboarding
    Multi-Backend
      FalkorDB (primary)
      Neo4j (enterprise)
      DataHub (catalog)
      Extensible provider ABC
    Workspace Isolation
      Multi-tenant by design
      Team/project contexts
      Role-based access
      Scoped views & lenses
    Visual Experience
      Glass morphism design
      Persona toggle (biz/tech)
      Layer Studio (WYSIWYG)
      ELK layout (Web Worker)
```

---

## The Problem

Modern data ecosystems are complex. Organizations face:

1. **Lineage opacity** -- Data flows through dozens of systems (warehouses, lakes, pipelines, BI tools) without a unified view of how datasets relate
2. **Schema fragmentation** -- Different teams use different metadata schemas, making cross-team data discovery impossible
3. **Governance gaps** -- No way to assess the blast radius of schema changes, deprecations, or pipeline failures
4. **Tool lock-in** -- Existing lineage tools (Atlas, DataHub, Marquez) are tightly coupled to specific backends, making migration painful
5. **Two-audience problem** -- Data engineers need column-level technical detail; business stakeholders need domain-level overviews. No tool serves both well

---

## The Vision

> **Make data lineage as intuitive as navigating a design tool** -- an interactive, persona-aware, layer-organized canvas for collaborative data exploration and governance.

### Core Design Principles

```mermaid
graph LR
    subgraph Principles
        P1["Backend-Agnostic<br/>Any graph database"]
        P2["Ontology-First<br/>Flexible semantic layer"]
        P3["Workspace-Centric<br/>Multi-tenant by design"]
        P4["Interactive-First<br/>Explore, don't report"]
        P5["Dual-Audience<br/>Business + Technical"]
    end

```

| Principle | What It Means | Why It Matters |
|-----------|---------------|----------------|
| **Backend-Agnostic** | Pluggable `GraphDataProvider` interface supports FalkorDB, Neo4j, DataHub, and custom backends | No vendor lock-in; works with existing infrastructure |
| **Ontology-First** | Entity types, relationships, visual styling, and hierarchy defined in versioned, immutable ontologies | Schema governance without code changes; teams customize independently |
| **Workspace-Centric** | Provider (infrastructure) + Ontology (semantics) + Workspace (context) as independent entities | Multi-tenancy, team isolation, and infrastructure reuse built in from day one |
| **Interactive-First** | Canvas-based exploration with trace, expand, filter, and zoom -- not static reports | Users discover relationships through interaction, not pre-built dashboards |
| **Dual-Audience** | Persona toggle transforms the same graph into business-level or technical-level views | One source of truth, two experiences; bridges the gap between data teams and stakeholders |

---

## How It Works

### For Data Engineers

```mermaid
graph LR
    A["Connect Provider<br/>(FalkorDB, Neo4j)"] --> B["Discover & Catalog<br/>(assets, schemas)"]
    B --> C["Assign Ontology<br/>(entity types, hierarchy)"]
    C --> D["Create Workspace<br/>(team/project context)"]
    D --> E["Explore Lineage<br/>(trace, filter, aggregate)"]
    E --> F["Save Views<br/>(share with team)"]

```

1. **Connect** a graph database (FalkorDB, Neo4j, or DataHub) via the admin panel
2. **Discover & catalog** available graphs and schemas from the connected provider
3. **Define or assign** an ontology that describes the entity types and relationships in the graph
4. **Create a workspace** that binds the provider, catalog items, and ontology into an operational context
5. **Explore** the graph interactively: trace upstream/downstream lineage, zoom between granularity levels (column -> table -> domain), filter by edge type
6. **Save and share** views with the team, with visibility scoping (private, team, enterprise)

### For Business Stakeholders

1. **Toggle to business persona** in the top bar
2. **Search** for a domain, dataset, or business term on the dashboard
3. **See high-level data flow** -- domains, applications, and their relationships
4. **Drill down** by toggling to technical persona or expanding containment hierarchy
5. **Bookmark** frequently-accessed views for quick return

### For Platform Admins

1. **Register Provider** -- connect to your graph database (FalkorDB, Neo4j, DataHub)
2. **Discover Schema** -- introspect provider to discover available graphs and schemas
3. **Register Catalog Items** -- promote discovered assets into governed data products
4. **Onboard Assets** -- guided 4-step wizard (workspace allocation, aggregation, semantics, review)
5. **Configure Ontology** -- define or customize entity and relationship types
6. **Create Workspace** -- bind providers, catalog items, and ontologies into team contexts
7. **Manage users** -- approve signups, assign roles (admin/user/viewer)
8. **Manage feature flags** -- toggle experimental features, set experimental notices

> **Note:** If this is a fresh platform with no providers, the **FirstRunHero** will guide you through this flow automatically.

---

## Key Capabilities

### 1. Multi-Granularity Lineage

```mermaid
graph TB
    subgraph Column["Column Level"]
        C1["orders.customer_id"] -->|TRANSFORMS| C2["analytics.customer_key"]
        C3["orders.total"] -->|TRANSFORMS| C4["analytics.revenue"]
    end

    subgraph Table["Table Level (Aggregated)"]
        T1["orders"] -->|"AGGREGATED (2)"| T2["analytics"]
    end

    subgraph Domain["Domain Level"]
        D1["Sales"] -->|"flows to"| D2["Analytics"]
    end

    Column -.->|"Zoom out"| Table
    Table -.->|"Zoom out"| Domain

```

Trace lineage at any level of the ontology hierarchy. The server aggregates fine-grained edges (column-to-column) into coarser edges (table-to-table, domain-to-domain) on the fly, driven by the ontology's hierarchy levels.

### 2. Ontology-Driven Schema Governance

```mermaid
graph LR
    subgraph Lifecycle["Ontology Lifecycle"]
        Draft["Draft<br/>(editable)"] --> Validate["Validate<br/>(check cycles)"]
        Validate --> Impact["Impact Analysis<br/>(compare to published)"]
        Impact --> Publish["Publish<br/>(immutable)"]
        Publish --> Clone["Clone<br/>(new draft v2)"]
        Clone --> Draft
    end

```

- **Three-layer resolution:** System defaults + workspace-assigned ontology + introspected gap-fill
- **Evolution policies:** `reject` (block breaking changes), `deprecate` (mark removed), `migrate` (auto-remap)
- **Impact analysis:** Before publishing, see which workspaces and data sources are affected
- **Schema drift detection:** Automatic flagging when graph data contains types not in the ontology

### 3. Interactive Canvas Experience

- **Canvas-first:** Pan, zoom, trace, expand -- not a static chart
- **Schema-driven rendering:** `GenericNode` renders any entity type from ontology visual config
- **ELK layout in Web Worker:** Responsive UI even with 1000+ nodes
- **Context menus, inline editing, command palette (Cmd+K):** Power-user interactions
- **Level of detail:** Automatic granularity switching based on zoom level

### 4. Layer Studio & Smart Assignment

```mermaid
graph LR
    subgraph Studio["Layer Studio (WYSIWYG)"]
        Left["Layer Hierarchy<br/>(drag-drop ordering)"]
        Center["Entity Browser<br/>(assign to layers)"]
        Right["Live Preview<br/>(instant feedback)"]
    end

    subgraph Smart["Smart Features"]
        Auto["Auto-Organize<br/>(ML suggestions)"]
        Rules["Smart Rule Builder<br/>(rule-based assignment)"]
        Conflict["Conflict Resolution<br/>(overlapping rules)"]
    end

    Studio --> Smart

```

Organize complex graphs into meaningful layers. The Layer Studio provides a three-panel WYSIWYG editor with drag-drop, undo/redo, and AI-powered organization suggestions.

### 5. Workspace Isolation & Multi-Tenancy

- **Workspace = team/project context:** Each workspace binds providers, ontologies, and graph names
- **Data source scoping:** Views are scoped to `{workspaceId}/{dataSourceId}` -- no cross-tenant data leaks
- **Role-based access:** Admin, user, viewer roles with JWT-based enforcement
- **Provider sharing:** One infrastructure provider serves multiple workspaces without credential duplication

### 6. Enterprise Data Catalog

- **CatalogItem abstraction** between Provider and DataSource -- governed data product layer
- **Permission-controlled asset access** -- admins register and approve catalog items before workspace binding
- **Impact analysis before deletion** -- understand downstream effects before removing catalog items
- **Workspace binding management** -- track which workspaces consume which catalog items

### 7. Guided Onboarding

- **FirstRunHero** for empty platforms -- detects no providers and launches guided setup
- **OnboardingProgress tracker** -- step-by-step progress through platform configuration
- **AssetOnboardingWizard** for streamlined setup -- 4-step guided flow (workspace allocation, aggregation, semantics, review)
- **Reduces time-to-first-value** for new admins -- from manual multi-step configuration to guided flow

### 8. Graph Versioning & Change Control (Shipped)

- **Drafts + review & merge:** Edit on a draft branch (`?branchId=`), then review and merge PR-style before it hits `main`
- **Publish, revert, restore:** Publish a draft, **revert** a change ("Undo this change"), or **restore** the graph to a historical commit ("Restore to this point", with a diff preview)
- **Version-control master switch:** An admin flag (`versioningEnabled`) gates every `/graph` write
- **Resumable enable-VC bootstrap:** Turning on version control for a data source runs an async, resumable job that copies the whole source graph into the versioned store as an integrity-checked `import` commit — verified on a 7.7M-entity graph

### 9. Lineage Lens / Context View (Shipped)

- **Context View:** Layer-organized, curated exploration with a **Layer Strip**, **resizable layer columns**, and one-page-ahead pagination
- **Lineage Lens:** Ego-graph overlay — click a node to see immediate upstream/downstream neighbors grouped by type, regardless of canvas scale
- **External-degree signal:** A "lineage outside this view" chip driven by total lineage degree per node (`POST /{ws_id}/graph/nodes/degree`)
- **Anchor Rail:** Keeps the focal entity stable as columns paginate and resize

---

## Competitive Positioning

```mermaid
quadrantChart
    title Lineage Platform Landscape
    x-axis Static Visualization --> Interactive Exploration
    y-axis Single Backend --> Multi-Backend
    quadrant-1 {brand} Target
    quadrant-2 Emerging
    quadrant-3 Traditional
    quadrant-4 Specialized
    Apache Atlas: [0.2, 0.2]
    DataHub: [0.5, 0.3]
    Amundsen: [0.3, 0.2]
    Marquez: [0.25, 0.35]
    OpenLineage: [0.15, 0.7]
    {brand}: [0.8, 0.8]
```

| Aspect | {brand} | DataHub | Atlas | Marquez |
|--------|---------|---------|-------|---------|
| **Graph Backend** | Pluggable (FalkorDB, Neo4j, DataHub) | Neo4j only | JanusGraph | PostgreSQL |
| **Schema Model** | Versioned ontologies with evolution policies | Fixed schema | Fixed schema | OpenLineage spec |
| **Multi-Tenancy** | Workspace-centric, built-in | UI-scoped | Not supported | Not supported |
| **Visualization** | Interactive canvas (Figma-like) | Static DAG | Static | Static |
| **Dual Audience** | Business + Technical persona toggle | Technical focus | Technical focus | Technical focus |
| **Governance** | Impact analysis, drift detection, evolution policies | Basic | Basic | None |
| **Deployment** | Docker/K8s, self-hosted or SaaS-ready | Docker/K8s | Docker | Docker |

### {brand}'s Differentiators

1. **Interactive exploration** over static reports -- trace, zoom, filter in real-time
2. **Backend-agnostic** -- works with your existing graph infrastructure, no migration required
3. **Ontology flexibility** -- define your own entity types, relationships, and visual styling
4. **Persona-aware** -- same platform, two audiences (business + technical)
5. **Workspace isolation** -- multi-tenant from day one, not bolted on

---

## Architecture at a Glance

```mermaid
graph TB
    subgraph Users["Users"]
        BU["Business User<br/>(Business Persona)"]
        DE["Data Engineer<br/>(Technical Persona)"]
        PA["Platform Admin"]
    end

    subgraph Frontend["React 19 Frontend"]
        Canvas["Interactive Canvas<br/>@xyflow + ELK Worker"]
        Admin["Admin Panels<br/>Workspaces, Providers, Users"]
        Dashboard["Dashboard<br/>Search, KPIs, Views"]
    end

    subgraph Backend["FastAPI Backend"]
        VizSvc["Visualization Service :8000<br/>Auth, Workspaces, Graph Queries,<br/>Ontology, Provider Connectivity"]
    end

    subgraph Semantic["Semantic Layer"]
        Ontology["Ontology System<br/>Versioned, Immutable, 3-Layer Merge"]
        Registry["Provider Registry<br/>Lazy Init, Cached, Async-Safe"]
    end

    subgraph Data["Data Layer"]
        MgmtDB[(Management DB<br/>SQLite / PostgreSQL)]
        FDB[(FalkorDB)]
        Neo[(Neo4j)]
        DH[(DataHub)]
    end

    BU --> Dashboard
    DE --> Canvas
    PA --> Admin

    Frontend -->|JWT| VizSvc

    VizSvc --> Ontology
    VizSvc --> Registry

    Registry --> FDB
    Registry --> Neo
    Registry --> DH
    Ontology --> MgmtDB
    VizSvc --> MgmtDB

```

For detailed architecture documentation, see:
- [ARCHITECTURE.md](ARCHITECTURE.md) -- System design, service architecture, deployment
- [BACKEND.md](BACKEND.md) -- API reference, services, providers
- [FRONTEND.md](FRONTEND.md) -- Component architecture, state management, UX patterns
- [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md) -- Data models, entity relationships, caching
- [DECISIONS.md](DECISIONS.md) -- Architectural Decision Records (ADRs)
- [TECHNICAL_DEBT.md](TECHNICAL_DEBT.md) -- Risk assessment and remediation plan

---

## Current State & Roadmap

### Current State: Shipped Platform

The platform is past MVP. The four-entity core, the ontology system, the interactive canvas, and — most recently — **graph versioning with full change control** are all shipped and in use.

```mermaid
timeline
    title {brand} Delivered Capabilities
    section Core (Shipped)
        Architecture      : Four-entity model (Provider + CatalogItem + Ontology + Workspace)
                          : Pluggable providers (FalkorDB default, Neo4j, DataHub, Spanner Graph, Mock)
                          : Workspace-centric API
        Lineage Engine    : Multi-directional trace (upstream/downstream/both)
                          : Granularity aggregation (column → table → domain)
                          : Containment hierarchy traversal
                          : Aggregated edge materialization
        Ontology System   : Versioned definitions with publish/clone lifecycle
                          : Three-layer resolution (system + assigned + introspected)
                          : Impact analysis and coverage checking
        Auth & Users      : JWT authentication with Argon2id
                          : Signup with admin approval (default OFF)
                          : Role-based + workspace-scoped access
        Data Catalog      : CatalogItem abstraction (Provider → CatalogItem → DataSource)
                          : Permission-controlled asset registration
                          : Impact analysis before deletion
    section Exploration (Shipped)
        Canvas            : Interactive canvas with ELK layout (Web Worker)
                          : Schema-driven GenericNode rendering
                          : Persona toggle (business/technical)
        Lineage Lens      : Lineage Lens / Context View
                          : External-degree signal + curated-view chip (POST /nodes/degree)
                          : Layer Strip + resizable layer columns
                          : Anchor Rail + one-page-ahead pagination
    section Change Control (Shipped)
        Versioning        : Drafts, review & merge (PR-style), publish
                          : Revert ("Undo this change") + restore ("Restore to this point")
                          : Version-control admin master switch
                          : Resumable async enable-VC bootstrap job with integrity report
                          : Verified on a 7.7M-entity graph
    section Forward-Looking
        Integrations      : Additional provider adapters (Apache Atlas, dbt, Airflow)
                          : Real-time lineage ingestion (event streaming)
        Enterprise        : SSO (SAML2 / OIDC)
                          : Workspace-level access-control policies
                          : GraphQL API layer
        Scale-out         : Horizontal scale (WEB/WORKER/CONTROLPLANE tiers) when load justifies
```

### Forward-Looking Work

The following items are **not yet shipped** and remain genuinely forward-looking:

| Area | Item | Rationale |
|------|------|-----------|
| Integrations | Additional provider adapters (Apache Atlas, dbt, Airflow) | Broader ecosystem coverage |
| Integrations | Real-time lineage ingestion (event streaming) | Live pipeline monitoring |
| Enterprise | SSO (SAML2 / OIDC) — see [SSO.md](SSO.md) | Enterprise auth requirements |
| Enterprise | Workspace-level access-control policies | Finer-grained tenant isolation |
| Enterprise | GraphQL API layer | Alternative query interface |
| Scale-out | Horizontal scale-out (WEB/WORKER/CONTROLPLANE roles) | Deferred until load justifies — see [architecture-when-scaling.md](architecture-when-scaling.md) |
| Collaboration | Comments, annotations, change proposals | Team workflow |

> Process roles (`SYNODIC_ROLE`: WEB, WORKER, CONTROLPLANE, DEV) exist today; the single-process **DEV** all-in-one role is the standard deployment shape, with the multi-tier split available when scale demands it.

---

## Project Maturity Assessment

### Strengths

- **Architecture is right:** The four-entity model (Provider + CatalogItem + Ontology + Workspace), provider abstraction, and ontology system are well-designed for the target use cases
- **Ontology system is powerful:** Versioning, impact analysis, and three-layer resolution provide genuine schema governance
- **Change control is shipped:** Graph versioning (drafts, review & merge, publish, revert, restore) plus the version-control master switch and a resumable enable-VC bootstrap job — verified on a 7.7M-entity graph
- **Exploration is differentiated:** Canvas-first exploration with persona toggle, Lineage Lens / Context View, external-degree signals, the Layer Strip, and the Anchor Rail put this ahead of static lineage tools
- **Multi-tenant from day one:** Workspace isolation is architectural, not bolted on

### Areas for Improvement

- **Security defaults still need production hardening:** Credential encryption is optional in dev, JWT is stored in localStorage, and the default admin password must be rotated before production
- **Legacy migration ongoing:** Some dual code paths remain from the pre-workspace era
- **Horizontal scale-out not yet built:** The platform runs single-process (DEV role); the WEB/WORKER/CONTROLPLANE split is designed but deferred until load justifies it

### Honest State

| Dimension | Rating | Notes |
|-----------|--------|-------|
| Architecture | Strong | Four-entity model, provider abstraction, workspace isolation, catalog governance |
| Ontology System | Strong | Versioning, impact analysis, drift detection |
| Change Control | Strong | Graph versioning shipped (drafts, merge, publish, revert, restore); enable-VC bootstrap verified at 7.7M entities |
| Frontend UX | Strong | Canvas, persona, Lineage Lens, Layer Strip, Anchor Rail, guided onboarding |
| Backend API | Solid | 50+ endpoints, clear REST patterns |
| Security | Needs Work | JWT in localStorage, optional encryption in dev, rotate default admin password |
| Scale-out | Deferred | Single-process today; multi-tier design ready when needed |

---

## Target Users

```mermaid
graph TB
    subgraph Primary["Primary Users"]
        DE["Data Engineer<br/>Debug pipelines, trace lineage,<br/>understand schema relationships"]
        DL["Data Leader / Analytics Manager<br/>Understand cross-org data flow,<br/>assess impact of changes"]
    end

    subgraph Secondary["Secondary Users"]
        PA["Platform Admin<br/>Manage providers, workspaces,<br/>users, feature flags"]
        DS["Data Scientist<br/>Discover datasets, understand<br/>provenance, assess quality"]
    end

    subgraph Future["Future Users"]
        GRC["GRC / Compliance<br/>Audit data flows, track<br/>sensitive data lineage"]
        PM["Product Manager<br/>Understand data dependencies<br/>for feature planning"]
    end

```

---

## Getting Started

### Prerequisites
- Python 3.11+
- Node.js 20+
- Docker (for FalkorDB)

### Quick Start

```bash
# 1. Clone the repository
git clone <repo-url> && cd synodic

# 2. Start FalkorDB
docker compose up -d

# 3. Install backend dependencies
pip install -r backend/requirements.txt

# 4. Start Visualization Service
GRAPH_PROVIDER=falkordb uvicorn backend.app.main:app --port 8000 --reload

# 5. Install frontend dependencies
cd frontend && npm install

# 6. Start Frontend
npm run dev
```

Open http://localhost:5173 and log in with the bootstrap admin credentials (check startup logs).

### Environment Variables

See [BACKEND.md](BACKEND.md#6-startup-lifecycle) for the full environment variable reference.

Key variables for production:
```bash
MANAGEMENT_DB_URL=postgresql+asyncpg://user:pass@host:5432/synodic  # Required
CREDENTIAL_ENCRYPTION_KEY=<fernet-key>                                # Required
JWT_SECRET_KEY=<random-32-chars>                                      # Required
CORS_ALLOWED_ORIGINS=https://your-domain.com                          # Required
ADMIN_EMAIL=admin@your-org.com                                        # Recommended
ADMIN_PASSWORD=<strong-random-password>                                # Recommended
```

---

## Related

- [Architecture](/docs/architecture) — system design, service topology, deployment
- [Data Architecture](/docs/data-architecture) — data models, entity relationships, caching, Redis topology
- [Decisions](/docs/decisions) — the ADRs behind the four-entity model and beyond
- [Services Overview](/docs/services-overview) — process-role topology (WEB, WORKER, CONTROLPLANE, DEV)
- [Technical Debt](/docs/technical-debt) — known risks and the remediation plan
- [Architecture When Scaling](/docs/scaling-architecture) — the deferred horizontal-scale plan
