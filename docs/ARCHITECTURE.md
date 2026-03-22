# Synodic Platform Architecture

> **Synodic** is a workspace-centric graph visualization and data lineage platform. It enables teams to explore, trace, and manage data relationships across heterogeneous graph backends through a unified semantic layer.

---

## System Overview

Synodic is composed of three primary layers: a **React 19 frontend**, a **dual-service FastAPI backend**, and **pluggable graph data providers** (FalkorDB, Neo4j, DataHub, Mock).

```mermaid
graph TB
    subgraph Frontend["Frontend (React 19 + Vite)"]
        UI[UI Components<br/>Radix UI + Tailwind]
        Stores[Zustand Stores<br/>auth, workspaces, schema, canvas]
        GPC[GraphProviderContext<br/>RemoteGraphProvider]
        RQ[TanStack React Query]
    end

    subgraph VizService["Visualization Service (Port 8000)"]
        Auth[Auth Middleware<br/>JWT + Argon2id]
        API[FastAPI Routers<br/>/api/v1/*]
        CE[ContextEngine<br/>Query Orchestration]
        PR[ProviderRegistry<br/>Singleton Cache]
        OS[OntologyService<br/>Three-Layer Resolver]
        Repos[Repository Layer<br/>SQLAlchemy 2.0 Async]
    end

    subgraph GraphService["Graph Service (Port 8001)"]
        GS_API[FastAPI Routers<br/>/graph/v1/*]
        GS_Providers[Provider Discovery<br/>Connectivity Testing]
    end

    subgraph Storage["Data Layer"]
        MgmtDB[(Management DB<br/>SQLite / PostgreSQL)]
        FDB[(FalkorDB<br/>Redis Protocol)]
        Neo4j[(Neo4j)]
        DH[(DataHub<br/>GraphQL)]
    end

    UI --> Stores
    Stores --> GPC
    GPC --> RQ
    RQ -->|HTTP + JWT| API
    RQ -->|HTTP| GS_API

    API --> Auth
    Auth --> CE
    CE --> PR
    CE --> OS
    OS --> Repos
    PR -->|Cached Instances| FDB
    PR -->|Cached Instances| Neo4j
    PR -->|Cached Instances| DH
    Repos --> MgmtDB

    GS_API --> GS_Providers
    GS_Providers -.->|Stateless Test| FDB
    GS_Providers -.->|Stateless Test| Neo4j

    style Frontend fill:#1e293b,stroke:#3b82f6,color:#e2e8f0
    style VizService fill:#1e293b,stroke:#8b5cf6,color:#e2e8f0
    style GraphService fill:#1e293b,stroke:#10b981,color:#e2e8f0
    style Storage fill:#1e293b,stroke:#f59e0b,color:#e2e8f0
```

---

## Core Entity Model (Four Entities)

The core architectural concept is the **Provider + CatalogItem + Ontology + Workspace** quartet, bound together by `WorkspaceDataSource`:

```mermaid
erDiagram
    Provider ||--o{ WorkspaceDataSource : "hosts"
    Provider ||--o{ CatalogItem : "registered assets"
    CatalogItem ||--o| WorkspaceDataSource : "consumed by"
    Ontology ||--o{ WorkspaceDataSource : "defines semantics"
    Workspace ||--o{ WorkspaceDataSource : "contains"
    WorkspaceDataSource ||--o| CatalogItem : "references"
    Workspace ||--o{ View : "scopes"
    Workspace ||--o{ ContextModel : "scopes"

    Provider {
        text id PK "prov_*"
        text name
        text provider_type "falkordb | neo4j | datahub | mock"
        text host
        int port
        text credentials "Fernet-encrypted JSON"
        bool tls_enabled
        json permitted_workspaces "['*'] or [ws_id, ...]"
    }

    Ontology {
        text id PK "bp_*"
        text name
        int version
        bool is_published "immutable when true"
        text scope "universal | workspace"
        text evolution_policy "reject | deprecate | migrate"
        json entity_type_definitions
        json relationship_type_definitions
    }

    Workspace {
        text id PK "ws_*"
        text name
        text description
        bool is_default
        bool is_active
    }

    WorkspaceDataSource {
        text id PK "ds_*"
        text workspace_id FK
        text provider_id FK
        text graph_name
        text ontology_id FK
        text label
        bool is_primary
        text projection_mode "in_source | dedicated"
        text access_level "read | write | admin"
    }

    CatalogItem {
        text id PK "cat_*"
        text provider_id FK
        text source_identifier
        text name
        text description
        json permitted_workspaces
        text status
        datetime created_at
        datetime updated_at
    }

    View {
        text id PK "view_*"
        text workspace_id FK
        text data_source_id FK
        text visibility "enterprise | team | personal"
        json config
    }

    ContextModel {
        text id PK
        text workspace_id FK
        text data_source_id FK
        json layers_config
        bool is_template
    }

    ontology_audit_log {
        text id PK
        text ontology_id FK
        text action
        text changed_by
        json diff
        datetime created_at
    }

    announcements {
        text id PK
        text title
        text message
        text type "info | warning | critical"
        bool is_active
        datetime starts_at
        datetime expires_at
        datetime created_at
    }
```

### Why Four Entities?

| Entity | Responsibility | Reusability |
|--------|---------------|-------------|
| **Provider** | Infrastructure connection (host, port, credentials) | Shared across workspaces |
| **CatalogItem** | Data product abstraction | Abstracts physical provider graphs into governed data products with permission control and impact analysis |
| **Ontology** | Semantic schema (entity types, relationship types, hierarchy) | Versioned, reusable, immutable when published |
| **Workspace** | Operational context (team project, environment) | Contains data sources, views, context models |
| **DataSource** | Binding of Provider + Graph + Ontology within a Workspace | Unique per (workspace, provider, graph_name) |

> See [DECISIONS.md ADR-001](DECISIONS.md#adr-001) for the rationale behind this design.

---

## Service Architecture

### Visualization Service (Port 8000)

The primary backend service handling all authenticated, stateful operations.

```mermaid
graph LR
    subgraph Routes["API Routes (/api/v1)"]
        AuthR["/auth/*<br/>login, signup, reset"]
        AdminR["/admin/*<br/>providers, workspaces,<br/>ontologies, features,<br/>catalog, announcements,<br/>context-model-templates"]
        GraphR["/{ws_id}/graph/*<br/>trace, nodes, edges"]
        ViewR["/views/*<br/>CRUD, favourites"]
        AssetR["/{ws_id}/assets/*<br/>rule-sets"]
        CMR["/{ws_id}/context-models"]
    end

    subgraph Services["Business Logic"]
        CE2[ContextEngine]
        OntSvc[OntologyService]
        AssignEng[AssignmentEngine]
        FeatSvc[FeatureService]
    end

    subgraph Data["Data Access"]
        PR2[ProviderRegistry]
        RepoLayer["Repositories<br/>(workspace, provider,<br/>ontology, view, user,<br/>catalog, data_source,<br/>announcement)"]
        DB2[(Management DB)]
    end

    subgraph Providers["Graph Providers"]
        FP[FalkorDBProvider]
        NP[Neo4jProvider]
        DP[DataHubProvider]
        MP[MockProvider]
    end

    AuthR --> Services
    AdminR --> Services
    GraphR --> CE2
    ViewR --> RepoLayer
    AssetR --> Services
    CMR --> Services

    CE2 --> PR2
    CE2 --> OntSvc
    OntSvc --> RepoLayer
    RepoLayer --> DB2

    PR2 --> FP
    PR2 --> NP
    PR2 --> DP
    PR2 --> MP

    style Routes fill:#312e81,stroke:#6366f1,color:#e2e8f0
    style Services fill:#1e3a5f,stroke:#3b82f6,color:#e2e8f0
    style Data fill:#1a2e35,stroke:#14b8a6,color:#e2e8f0
    style Providers fill:#2d1f0e,stroke:#f59e0b,color:#e2e8f0
```

### Graph Service (Port 8001)

A stateless companion service for **pre-registration** provider testing. It accepts connection parameters in the request body and requires no database access.

**Responsibilities:**
- List supported provider types and capabilities
- Test connectivity to graph databases before registration
- Enumerate available graphs/databases on a provider

> See [DECISIONS.md ADR-002](DECISIONS.md#adr-002) for why services are separated.

---

## Request Lifecycle

```mermaid
sequenceDiagram
    participant FE as Frontend
    participant MW as Auth Middleware
    participant EP as API Endpoint
    participant CE as ContextEngine
    participant PR as ProviderRegistry
    participant OS as OntologyService
    participant GP as GraphProvider
    participant DB as Management DB

    FE->>MW: GET /api/v1/{ws_id}/graph/trace<br/>(Bearer JWT)
    MW->>MW: Verify JWT (HS256)
    MW->>EP: Authenticated Request

    EP->>CE: get_context_engine(ws_id, ds_id?)
    CE->>DB: Fetch WorkspaceDataSource
    CE->>PR: get_provider_for_workspace()

    alt Cache Hit
        PR-->>CE: Cached GraphProvider
    else Cache Miss
        PR->>DB: Fetch Provider + Credentials
        PR->>PR: Decrypt (Fernet) + Instantiate
        PR-->>CE: New GraphProvider (cached)
    end

    CE->>OS: resolve_ontology()
    OS->>DB: Fetch assigned ontology
    OS->>OS: Merge: System Default + Assigned + Introspected
    OS-->>CE: ResolvedOntology (cached 5 min)

    CE->>GP: get_trace_lineage(urn, depth, ...)
    GP-->>CE: LineageResult (nodes + edges)

    CE->>CE: Apply granularity aggregation
    CE-->>EP: Enriched LineageResult
    EP-->>FE: JSON Response
```

> See [DECISIONS.md ADR-005](DECISIONS.md#adr-005) for caching strategy rationale.

---

## Authentication & Security

```mermaid
graph TB
    subgraph AuthFlow["Authentication Flow"]
        Login[POST /auth/login<br/>email + password]
        Signup[POST /auth/signup<br/>name, email, password]
        Approve[POST /admin/users/{id}/approve<br/>Admin only]
    end

    subgraph Security["Security Layers"]
        Argon[Argon2id<br/>Password Hashing]
        JWT[JWT HS256<br/>60-min expiry]
        Fernet[Fernet Encryption<br/>Credential at-rest]
        CSP[Security Headers<br/>CSP, X-Frame-Options]
        Rate[Rate Limiting<br/>slowapi]
    end

    subgraph Roles["Role-Based Access"]
        Admin[admin<br/>Full access]
        User[user<br/>Workspace access]
        Viewer[viewer<br/>Read-only]
    end

    Login --> Argon
    Argon -->|Constant-time verify| JWT
    Signup --> Argon
    Signup -->|status=pending| Approve
    Approve -->|status=active| JWT

    JWT --> Admin
    JWT --> User
    JWT --> Viewer

    style AuthFlow fill:#1e293b,stroke:#ef4444,color:#e2e8f0
    style Security fill:#1e293b,stroke:#f59e0b,color:#e2e8f0
    style Roles fill:#1e293b,stroke:#10b981,color:#e2e8f0
```

### Security Controls

| Layer | Mechanism | Details |
|-------|-----------|---------|
| **Password** | Argon2id | OWASP-recommended, constant-time comparison |
| **Tokens** | JWT (HS256) | 60-min expiry, contains user_id, email, role |
| **Credentials** | Fernet | Symmetric encryption for provider credentials at rest |
| **Headers** | CSP, HSTS, X-Frame-Options | Applied via middleware to all responses |
| **Rate Limiting** | slowapi | 5/min signup, 10/min login, 30/60s feature updates |
| **CORS** | Configurable origins | `CORS_ALLOWED_ORIGINS` env var |

### Production Security Notes

- **JWT Storage**: Currently stored in `localStorage` (XSS risk). Planned migration to HttpOnly cookies with CSRF protection.
- **Credential Encryption**: Optional in development (`CREDENTIAL_ENCRYPTION_KEY` not set falls back to plaintext). **REQUIRED in production** — generate a key via `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
- **Default Admin Password**: Bootstrap uses `"changeme"` — must be changed immediately in production.

### Scalability Considerations

- **ProviderRegistry per-worker isolation**: Each Uvicorn worker gets its own `ProviderRegistry` instance. Config changes in one worker are not visible to others. Future: Redis-backed shared cache.
- **SQLite limitation**: SQLite is for development only. **Production MUST use PostgreSQL** (`MANAGEMENT_DB_URL=postgresql://...`). SQLite has no concurrent write support.

---

## Deployment Architecture

```mermaid
graph TB
    subgraph Dev["Development (Local)"]
        Vite[Vite Dev Server<br/>:5173]
        Uvicorn1[Uvicorn<br/>backend.app :8000]
        Uvicorn2[Uvicorn<br/>backend.graph :8001]
        SQLite[(SQLite<br/>nexus_core.db)]
        Docker[Docker<br/>FalkorDB :6379]
    end

    subgraph Prod["Production"]
        Static[Static Files<br/>React Build]
        Gunicorn1[Gunicorn + Uvicorn Workers<br/>backend.app :8000]
        Gunicorn2[Gunicorn + Uvicorn Workers<br/>backend.graph :8001]
        PG[(PostgreSQL)]
        FDB2[(FalkorDB Cluster)]
    end

    Vite -->|proxy| Uvicorn1
    Uvicorn1 --> SQLite
    Uvicorn1 --> Docker

    Static -->|nginx| Gunicorn1
    Gunicorn1 --> PG
    Gunicorn1 --> FDB2

    style Dev fill:#1e293b,stroke:#3b82f6,color:#e2e8f0
    style Prod fill:#1e293b,stroke:#10b981,color:#e2e8f0
```

### Quick Start

**Option A — Docker Compose (recommended for first-time setup):**

```bash
# Full platform — builds & starts all 5 services
docker compose up --build

# With demo data (enterprise finance + ecommerce scenarios):
docker compose --profile seed up --build

# Open the app:
#   Frontend:              http://localhost:3080
#   Viz Service (direct):  http://localhost:8000/health
#   Graph Service (direct):http://localhost:8001/health
#   FalkorDB Browser:      http://localhost:3000
#
# Default admin login:
#   Email:    admin@synodic.local
#   Password: admin123
```

**Option B — Local development (hot-reload):**

```bash
# 1. Start infrastructure only
docker compose up -d falkordb postgres

# 2. Start Backend (Visualization Service)
GRAPH_PROVIDER=falkordb uvicorn backend.app.main:app --port 8000 --reload

# 3. Start Backend (Graph Service)
uvicorn backend.graph.main:app --port 8001 --reload

# 4. Start Frontend
cd frontend && npm run dev
```

---

## Directory Structure

```
synodic/
├── backend/
│   ├── app/                          # Visualization Service (port 8000)
│   │   ├── main.py                   # FastAPI app, lifespan, middleware
│   │   ├── api/v1/endpoints/         # Route handlers
│   │   ├── auth/                     # JWT, password hashing, dependencies
│   │   ├── db/                       # Engine, models, repositories
│   │   ├── middleware/               # Security headers, logging, request ID
│   │   ├── ontology/                 # Service, resolver, defaults, adapters
│   │   ├── providers/                # FalkorDB, Neo4j, Mock implementations
│   │   ├── registry/                 # ProviderRegistry singleton
│   │   └── services/                 # ContextEngine, AssignmentEngine
│   ├── common/                       # Shared kernel
│   │   ├── interfaces/provider.py    # GraphDataProvider ABC
│   │   └── models/                   # Pydantic DTOs (graph, management, auth)
│   ├── graph/                        # Graph Service (port 8001)
│   │   ├── main.py                   # Stateless FastAPI app
│   │   └── api/v1/endpoints/         # Provider discovery routes
│   └── stats_service/                # Stats polling background service
├── frontend/
│   ├── src/
│   │   ├── components/               # React components by feature
│   │   │   ├── admin/                # Admin panels
│   │   │   │   ├── AssetOnboardingWizard/  # 4-step asset onboarding wizard
│   │   │   │   └── AdminAnnouncements/     # Announcement management UI
│   │   │   ├── auth/                 # Login, signup, reset
│   │   │   ├── canvas/               # Graph visualization canvases
│   │   │   ├── layout/               # AppLayout, TopBar, SidebarNav
│   │   │   ├── panels/               # Node/edge detail panels
│   │   │   ├── schema/               # Schema editor
│   │   │   ├── views/                # View wizard, layer editor
│   │   │   └── ui/                   # Reusable primitives
│   │   ├── hooks/                    # 40+ custom React hooks
│   │   ├── pages/                    # Route page components
│   │   ├── providers/                # GraphProviderContext
│   │   ├── services/                 # API client modules
│   │   │   ├── catalogService.ts     # Catalog API client
│   │   │   └── announcementService.ts # Announcement API client
│   │   ├── store/                    # Zustand state stores
│   │   ├── styles/                   # Global CSS, Tailwind config
│   │   └── workers/                  # Web Workers (ELK layout)
│   ├── Dockerfile                    # Multi-stage Node build + Nginx
│   ├── nginx.conf                    # Reverse proxy + SPA config
│   └── package.json
│   ├── Dockerfile.viz                   # Visualization Service container
│   ├── Dockerfile.graph                 # Graph Service container
│   ├── requirements.txt                 # Python dependencies
│   └── scripts/
│       ├── seed_falkordb.py             # Enterprise data generator
│       ├── seed_neo4j.py                # Neo4j data generator
│       └── docker_seed.py              # Docker-aware seed entrypoint
├── docs/                             # Documentation
├── docker-compose.yml                # Full-stack orchestration
├── .dockerignore                     # Docker build exclusions
└── .env.example                      # Environment variable reference
```

---

## Technology Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| **Frontend Framework** | React | 19.0.0 | UI rendering |
| **Build Tool** | Vite | 6.0.5 | Bundling, HMR |
| **Type System** | TypeScript | 5.7.2 | Type safety |
| **State Management** | Zustand | - | Lightweight stores |
| **Graph Rendering** | @xyflow/react | 12.10.0 | Node/edge canvas |
| **Layout Algorithms** | ELK.js, Dagre | - | Graph layout (Web Worker) |
| **UI Primitives** | Radix UI | - | Accessible components |
| **Styling** | Tailwind CSS | 3.4.17 | Utility-first CSS |
| **Animations** | Framer Motion | 11.15.0 | Transitions |
| **Backend Framework** | FastAPI | >=0.100.0 | Async API |
| **ORM** | SQLAlchemy | >=2.0.0 | Async database access |
| **Password Hashing** | argon2-cffi | >=23.1.0 | Argon2id |
| **Tokens** | PyJWT | >=2.8.0 | JWT creation/verification |
| **Encryption** | cryptography | >=41.0.0 | Fernet for credentials |
| **Graph DB (Primary)** | FalkorDB | >=1.4.0 | Redis-based graph |
| **Graph DB (Alt)** | Neo4j | >=5.14.0 | Enterprise graph |
| **Management DB** | SQLite / PostgreSQL | - | Metadata storage |

---

## Containerization & Deployment

### Container Images

The platform ships as three container images. Source files:

| Image | Dockerfile | Description |
|-------|-----------|-------------|
| **Frontend** | `frontend/Dockerfile` | Multi-stage: Node 20 build + Nginx 1.27 serving |
| **Visualization Service** | `backend/Dockerfile.viz` | Python 3.13 + Gunicorn/Uvicorn, port 8000 |
| **Graph Service** | `backend/Dockerfile.graph` | Python 3.13 + Gunicorn/Uvicorn, port 8001 |

Supporting files:
- `frontend/nginx.conf` — Reverse-proxies `/api/*` to viz-service and `/graph/*` to graph-service; SPA fallback routing; static asset caching
- `.dockerignore` — Excludes `.git`, `node_modules`, `__pycache__`, local DB files, secrets

### Docker Compose

The `docker-compose.yml` at the repo root defines the full platform:

| Service | Image / Build | Ports | Purpose |
|---------|--------------|-------|---------|
| `falkordb` | `falkordb/falkordb:latest` | 6379, 3000 (Browser UI) | Graph database |
| `postgres` | `postgres:16-alpine` | 5432 | Management DB |
| `viz-service` | `backend/Dockerfile.viz` | 8000 | Auth, workspaces, graph queries, ontology |
| `graph-service` | `backend/Dockerfile.graph` | 8001 | Provider discovery & connectivity testing |
| `frontend` | `frontend/Dockerfile` | 3080 | React SPA + nginx reverse proxy |
| `seed` | *(profile: seed)* | — | One-shot demo data loader |

**What happens on first boot:**
1. PostgreSQL and FalkorDB start and pass health checks
2. `viz-service` starts, runs `init_db()` (creates all tables in PostgreSQL)
3. Seeds context model templates, feature registry, system default ontology
4. Bootstraps admin user (`admin@synodic.local` / `admin123`)
5. Bootstraps a default FalkorDB provider + workspace from env vars
6. Frontend becomes available at `http://localhost:3080`

### Demo Data Seeding

The `seed` service (opt-in via `--profile seed`) generates enterprise graph scenarios into FalkorDB:

```bash
# Seed with defaults (finance + ecommerce, ~2k nodes)
docker compose --profile seed up --build

# Customise via environment variables in docker-compose.yml:
#   SEED_SCENARIOS: finance,hr,marketing,ecommerce  (or "all")
#   SEED_SCALE: 1          (multiplier, 1 = ~1k nodes/scenario)
#   SEED_BREADTH: 1        (parallel system chains)
#   SEED_DEPTH: 1          (transformation layers)
#   SEED_FORCE: true       (re-seed even if data exists)
```

The seeder (`backend/scripts/docker_seed.py`) waits for FalkorDB, checks whether data already exists (skips if so), then generates a realistic containment hierarchy: Domain > Platform > Container > Dataset > SchemaField, with TRANSFORMS lineage edges and a consumption layer (Dashboards, Charts).

**Usage:**

```bash
# Build and start all services
docker compose up --build

# Run in background
docker compose up --build -d

# View logs
docker compose logs -f viz-service

# Tear down (preserves volumes)
docker compose down

# Tear down and remove data
docker compose down -v
```

### Kubernetes Deployment

A basic Kubernetes deployment targeting a namespace called `synodic`. These manifests assume container images are pushed to a registry (e.g., `ghcr.io/rkrumins/synodic`).

#### Namespace & ConfigMap

```yaml
# k8s/namespace.yaml
apiVersion: v1
kind: Namespace
metadata:
  name: synodic
---
# k8s/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: synodic-config
  namespace: synodic
data:
  GRAPH_PROVIDER: "falkordb"
  FALKORDB_HOST: "falkordb"
  FALKORDB_PORT: "6379"
  MANAGEMENT_DB_URL: "postgresql+asyncpg://synodic:synodic@postgres:5432/synodic"
  JWT_ALGORITHM: "HS256"
  JWT_EXPIRY_MINUTES: "60"
```

#### Secrets

```yaml
# k8s/secrets.yaml
apiVersion: v1
kind: Secret
metadata:
  name: synodic-secrets
  namespace: synodic
type: Opaque
stringData:
  JWT_SECRET_KEY: "CHANGE-ME-in-production"
  CREDENTIAL_ENCRYPTION_KEY: "CHANGE-ME-fernet-key"
  POSTGRES_PASSWORD: "synodic"
```

#### Visualization Service

```yaml
# k8s/viz-service.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: viz-service
  namespace: synodic
  labels:
    app: viz-service
spec:
  replicas: 2
  selector:
    matchLabels:
      app: viz-service
  template:
    metadata:
      labels:
        app: viz-service
    spec:
      containers:
        - name: viz-service
          image: ghcr.io/rkrumins/synodic/viz-service:latest
          ports:
            - containerPort: 8000
          envFrom:
            - configMapRef:
                name: synodic-config
            - secretRef:
                name: synodic-secrets
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 512Mi
          readinessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 10
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: 8000
            initialDelaySeconds: 15
            periodSeconds: 20
---
apiVersion: v1
kind: Service
metadata:
  name: viz-service
  namespace: synodic
spec:
  selector:
    app: viz-service
  ports:
    - port: 8000
      targetPort: 8000
```

#### Graph Service

```yaml
# k8s/graph-service.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: graph-service
  namespace: synodic
  labels:
    app: graph-service
spec:
  replicas: 1
  selector:
    matchLabels:
      app: graph-service
  template:
    metadata:
      labels:
        app: graph-service
    spec:
      containers:
        - name: graph-service
          image: ghcr.io/rkrumins/synodic/graph-service:latest
          ports:
            - containerPort: 8001
          envFrom:
            - configMapRef:
                name: synodic-config
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
          readinessProbe:
            httpGet:
              path: /health
              port: 8001
            initialDelaySeconds: 5
            periodSeconds: 10
---
apiVersion: v1
kind: Service
metadata:
  name: graph-service
  namespace: synodic
spec:
  selector:
    app: graph-service
  ports:
    - port: 8001
      targetPort: 8001
```

#### Frontend

```yaml
# k8s/frontend.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: synodic
  labels:
    app: frontend
spec:
  replicas: 2
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
        - name: frontend
          image: ghcr.io/rkrumins/synodic/frontend:latest
          ports:
            - containerPort: 80
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
---
apiVersion: v1
kind: Service
metadata:
  name: frontend
  namespace: synodic
spec:
  selector:
    app: frontend
  ports:
    - port: 80
      targetPort: 80
```

#### Ingress

```yaml
# k8s/ingress.yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: synodic-ingress
  namespace: synodic
  annotations:
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  ingressClassName: nginx
  rules:
    - host: synodic.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: viz-service
                port:
                  number: 8000
          - path: /graph
            pathType: Prefix
            backend:
              service:
                name: graph-service
                port:
                  number: 8001
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend
                port:
                  number: 80
  tls:
    - hosts:
        - synodic.example.com
      secretName: synodic-tls
```

#### Deploying

```bash
# Apply all manifests
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/

# Check rollout status
kubectl -n synodic rollout status deployment/viz-service
kubectl -n synodic rollout status deployment/graph-service
kubectl -n synodic rollout status deployment/frontend

# View pods
kubectl -n synodic get pods

# View logs
kubectl -n synodic logs -l app=viz-service -f
```

> **Note:** FalkorDB and PostgreSQL are shown inline in the Docker Compose setup. For Kubernetes, use managed services (e.g., AWS ElastiCache, Cloud SQL, RDS) or deploy them via Helm charts (`bitnami/postgresql`, `falkordb/falkordb`) with persistent volume claims.
