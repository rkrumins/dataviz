# NexusLineage Technical Specification

## Overview

NexusLineage is a billion-node-ready Data Lineage platform that overlays user-defined business ontologies (Context Lenses) onto physical technical metadata. The system uses a multi-graph architecture with sparse matrix projections for depth-99 lineage trace computation.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React 19)                       │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ React Flow  │  │   Zustand   │  │   Spatial Viewport      │  │
│  │   Canvas    │  │   Stores    │  │   Lazy Loading          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ REST/WebSocket
┌─────────────────────────────────────────────────────────────────┐
│                      BACKEND (FastAPI + Python 3.12)             │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Rule Engine │  │  GraphBLAS  │  │    Hybrid Cache         │  │
│  │             │  │  Projector  │  │    (Redis + Memory)     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        STORAGE LAYER                             │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐  ┌─────────────────────────────────┐   │
│  │     FalkorDB         │  │     Redis Cache                 │   │
│  │  (PhysicalFabric +   │  │  (Projection Matrix Cache)      │   │
│  │   ContextLenses)     │  │                                 │   │
│  └─────────────────────┘  └─────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Models

### PhysicalFabric Graph (Technical Metadata)

```typescript
interface PhysicalNode {
  urn: string;                    // Unique Resource Name (e.g., "urn:li:dataset:...")
  type: 'table' | 'column' | 'pipeline' | 'dashboard' | 'job';
  sourceSystem: string;           // DataHub, Solidatus, custom
  schemaHash: string;             // For change detection
  properties: Record<string, unknown>;
  lastSyncedAt: Date;
}

interface PhysicalEdge {
  id: string;
  upstreamUrn: string;
  downstreamUrn: string;
  edgeType: 'PRODUCES' | 'CONSUMES' | 'TRANSFORMS';
  confidence: number;             // 0.0 - 1.0
  metadata: {
    transformationSql?: string;
    columnMappings?: Array<{ source: string; target: string }>;
  };
}
```

### ContextLens Graph (Business Ontology)

```typescript
interface BusinessEntity {
  id: string;
  lensId: string;
  displayName: string;
  description?: string;
  classificationTags: string[];
  ruleBindings: string[];         // References to MappingRule IDs
}

interface LensManifest {
  lensId: string;
  version: string;                // SemVer
  name: string;
  description: string;
  imports: LensImport[];          // Namespace-scoped dependencies
  rules: MappingRule[];
  createdAt: Date;
  updatedAt: Date;
}

interface LensImport {
  sourceLensId: string;
  targetLensId: string;
  versionPin: string;             // Exact version or semver range
  alias?: string;
}
```

### Rule Definitions

```typescript
interface MappingRule {
  ruleId: string;
  lensId: string;
  priority: number;               // For ordering (not conflict resolution)
  matcher: URNMatcher;
  entityBindings: string[];       // Multi-classification: URN maps to N entities
  ttlSeconds: number;             // Hybrid cache TTL (default: 3600)
}

interface URNMatcher {
  type: 'regex' | 'glob' | 'jsonpath' | 'exact';
  pattern: string;
  sourceFilter?: string[];        // Optional: limit to specific source systems
}
```

---

## Rule Engine Logic

### Projection Algorithm

1. **Load Physical Fabric**: Query FalkorDB for adjacency matrix `P` (sparse CSR format)
2. **Build Projection Matrix**: For each Context Lens, evaluate rules to create `R` (URN → EntityID mappings)
3. **Matrix Power**: Compute `B = R × P^n` for depth-n lineage using GraphBLAS
4. **Cache Strategy**: 
   - **Hot paths**: Cache in Redis with configurable TTL
   - **Cold paths**: Compute on-demand

### Multi-Classification Handling

When a rule matches a URN to multiple business entities:
- Create fan-out edges in the projection
- Trace-99 explores all branches
- Response includes provenance tags showing which rule created each mapping

### Namespace-Scoped Imports

```python
def resolve_imports(lens: LensManifest) -> List[LensManifest]:
    """
    Resolve lens imports with version pinning.
    Detects circular dependencies and version conflicts.
    """
    resolved = []
    visited = set()
    
    def visit(current_lens: LensManifest, path: List[str]):
        if current_lens.lens_id in path:
            raise CircularImportError(path + [current_lens.lens_id])
        
        if current_lens.lens_id in visited:
            return
        
        visited.add(current_lens.lens_id)
        
        for imp in current_lens.imports:
            imported_lens = load_lens(imp.source_lens_id, imp.version_pin)
            visit(imported_lens, path + [current_lens.lens_id])
            resolved.append(imported_lens)
        
        resolved.append(current_lens)
    
    visit(lens, [])
    return resolved
```

---

## API Contract

### Trace-99 Endpoint

```
POST /api/v1/trace
Content-Type: application/json

{
  "lens_id": "finance-ontology",
  "start_entity": "Revenue",
  "direction": "upstream" | "downstream" | "both",
  "max_depth": 99,
  "viewport": {
    "x_min": 0,
    "x_max": 1920,
    "y_min": 0,
    "y_max": 1080,
    "zoom": 1.0
  },
  "lod_level": "domain" | "app" | "asset",
  "include_cross_lens": true,
  "filters": {
    "classifications": ["PII", "SOX"],
    "source_systems": ["snowflake", "databricks"],
    "min_confidence": 0.7
  }
}
```

**Response:**

```json
{
  "nodes": [
    {
      "id": "asset-revenue-table",
      "type": "asset",
      "position": { "x": 700, "y": 50 },
      "data": {
        "label": "revenue_monthly",
        "businessLabel": "Monthly Revenue",
        "technicalLabel": "finance_db.analytics.revenue_monthly",
        "urn": "urn:li:dataset:...",
        "classifications": ["Financial", "SOX"],
        "confidence": 0.98,
        "lensId": "finance-ontology",
        "metadata": {
          "assetType": "table",
          "schema": "analytics",
          "rowCount": "2.4M"
        }
      }
    }
  ],
  "edges": [
    {
      "id": "edge-123",
      "source": "app-snowflake-finance",
      "target": "asset-revenue-table",
      "type": "lineage",
      "data": {
        "confidence": 0.98,
        "edgeType": "produces",
        "animated": true
      }
    }
  ],
  "pagination": {
    "has_more": true,
    "cursor": "eyJvZmZzZXQiOjUwfQ==",
    "total_count": 247
  },
  "trace_metadata": {
    "projection_cache_hit": true,
    "computed_depth": 47,
    "execution_time_ms": 142,
    "rules_evaluated": 23
  }
}
```

### Other Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/lenses` | GET | List all Context Lenses |
| `/api/v1/lenses/{id}` | GET | Get lens details with rules |
| `/api/v1/lenses` | POST | Create new Context Lens |
| `/api/v1/lenses/{id}/rules` | POST | Add rule to lens |
| `/api/v1/physical/sync` | POST | Trigger metadata sync from sources |
| `/api/v1/views` | GET/POST | Saved view management |
| `/api/v1/search` | GET | Full-text search across entities |

---

## Design Decisions

### 1. Hybrid Cache Strategy

- **Hot paths**: Frequently accessed projection matrices cached in Redis
- **Cold paths**: Computed on-demand using GraphBLAS
- **TTL**: Configurable per-rule (default 3600s)
- **Invalidation**: On metadata or rule change events

### 2. Namespace-Scoped Lens Imports

- Lenses declare explicit import dependencies
- Version pinning prevents breaking changes
- Enables "Context of Contexts" layer
- Circular dependency detection at import resolution

### 3. Multi-Classification (Fan-Out)

- Physical URNs can map to multiple business entities
- Trace explores all branches in parallel
- Results include provenance for each mapping
- UI renders multi-parent hierarchies

### 4. Spatial Virtualization

- Only nodes within current viewport are transmitted
- Client-side quadtree cache for visited regions
- Ghost nodes indicate pagination boundaries
- LOD transitions based on zoom level thresholds

### 5. Persona Toggle (Business/Technical)

- Single interface, dual label systems
- Business: Friendly names, domain-level LOD
- Technical: URNs, column-level detail
- Persisted per-user preference

