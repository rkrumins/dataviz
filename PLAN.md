# NexusLineage Development Roadmap

## Project Overview

NexusLineage is a billion-node-ready Data Lineage platform with multi-graph architecture, runtime sparse matrix projections, and spatial UI virtualization.

---

## Phase 1: Foundation (Database & Ingestion)

**Duration:** 2-3 weeks

### Objectives
- Set up core infrastructure
- Implement metadata ingestion pipelines
- Establish graph database schema

### Deliverables

#### 1.1 Infrastructure Setup
- [ ] Docker Compose configuration (FalkorDB + Redis + FastAPI)
- [ ] FalkorDB graph schema design
  - PhysicalFabric namespace
  - ContextLenses namespace
- [ ] Redis cache configuration for projection matrices
- [ ] GitHub Actions CI/CD pipeline

#### 1.2 Metadata Ingestion
- [ ] DataHub adapter (REST/GraphQL client)
  - Dataset metadata extraction
  - Lineage edge extraction
  - Incremental sync support
- [ ] Hierarchy adapter
  - Reference/logical model import
  - Mapping to physical URNs
- [ ] Generic graph source adapter interface
- [ ] Ingestion scheduler (Celery or similar)

#### 1.3 Core Data Models
- [ ] Pydantic v2 models for all entities
  - PhysicalNode, PhysicalEdge
  - BusinessEntity, LensManifest
  - MappingRule, URNMatcher
- [ ] FalkorDB Cypher query builders
- [ ] Schema migration system

### Success Criteria
- [ ] Successful ingestion of 10M+ nodes from DataHub
- [ ] < 100ms query latency for single-hop lookups
- [ ] Automated sync with configurable intervals

---

## Phase 2: Contextual Logic (Rule Engine & Sparse Projections)

**Duration:** 3-4 weeks

### Objectives
- Implement rule-based projection engine
- Build GraphBLAS sparse matrix operations
- Create hybrid caching layer

### Deliverables

#### 2.1 Rule Engine Core
- [ ] `RuleEngine` class implementation
  - Regex/glob/JSONPath matcher evaluation
  - Priority-based rule ordering
  - Multi-classification fan-out logic
- [ ] Rule validation and testing framework
- [ ] Rule conflict detection (informational, not blocking)

#### 2.2 Sparse Matrix Projections
- [ ] GraphBLAS integration via `python-graphblas`
  - CSR format adjacency matrix construction
  - Matrix power operations (A^n) for depth-n traces
  - Masked operations for filtered traces
- [ ] Projection matrix builder
  - URN → EntityID sparse mappings
  - Batch construction for large lenses
- [ ] Depth-99 trace algorithm
  - Early termination on convergence
  - Cycle detection

#### 2.3 Hybrid Caching Layer
- [ ] Redis-based projection cache
  - TTL per-rule configuration
  - LRU eviction strategy
- [ ] In-memory hot path cache
- [ ] Cache invalidation on:
  - Metadata sync events
  - Rule modification
  - Lens version change

#### 2.4 Lens Import Resolution
- [ ] Version-pinned import resolution
- [ ] Circular dependency detection
- [ ] Cross-lens trace merging

### Success Criteria
- [ ] Depth-99 trace on 1M nodes in < 2 seconds
- [ ] Cache hit rate > 80% for repeated queries
- [ ] Correct multi-classification handling

---

## Phase 3: UI Shell (React Flow & Spatial Virtualization)

**Duration:** 3-4 weeks  
**Status:** ✅ COMPLETED

### Objectives
- Build React 19 frontend with React Flow
- Implement spatial viewport virtualization
- Create persona-aware UI components

### Deliverables

#### 3.1 Project Setup ✅
- [x] React 19 + Vite + TypeScript
- [x] Tailwind CSS with custom design system
- [x] React Flow integration
- [x] Zustand state management

#### 3.2 Design System ✅
- [x] Adaptive theme (light/dark/system)
- [x] Glassmorphism component library
- [x] Custom typography (Outfit, Inter, JetBrains Mono)
- [x] Animation system

#### 3.3 Layout Components ✅
- [x] AppShell with responsive sidebar
- [x] TopBar with search and persona toggle
- [x] SidebarNav with saved views and recent traces
- [x] CommandPalette (Cmd+K)

#### 3.4 Canvas Components ✅
- [x] LineageCanvas with React Flow
- [x] Custom node types:
  - DomainNode (purple, domain level)
  - AppNode (cyan, application level)
  - AssetNode (green, table/column level)
  - GhostNode (dashed, pagination indicator)
- [x] Custom LineageEdge with:
  - Animated particle flow
  - Confidence-based gradient coloring
- [x] CanvasControls panel

#### 3.5 Spatial Loading ✅
- [x] `useSpatialLoading` hook
- [x] Viewport-based data fetching
- [x] Region caching with quadtree
- [x] Debounced viewport change handler

#### 3.6 Persona System ✅
- [x] PersonaToggle component (Business/Technical)
- [x] Label resolution based on mode
- [x] LOD defaults per persona
- [x] Persisted preference

#### 3.7 Detail Panel ✅
- [x] Slide-in panel on node selection
- [x] Quick actions (Trace Up/Down, Pin, Open)
- [x] Properties display
- [x] Lineage preview
- [x] Recent activity

### Success Criteria
- [x] 60fps pan/zoom with 1000+ visible nodes
- [x] Smooth persona switching with label updates
- [x] Working detail panel with metadata display

---

## Phase 4: Context of Contexts (Inter-Ontology Stitching)

**Duration:** 2-3 weeks

### Objectives
- Implement cross-lens trace resolution
- Build lens management UI
- Add provenance tracking

### Deliverables

#### 4.1 Lens Registry
- [ ] `LensRegistry` service
  - Version-pinned lens storage
  - Import graph management
  - Lens discovery API
- [ ] Lens CRUD UI
  - Create/edit lens metadata
  - Rule builder interface
  - Import management

#### 4.2 Cross-Lens Tracing
- [ ] Import resolution during trace
- [ ] Projection matrix merging
- [ ] Provenance tagging (which lens/rule produced each edge)
- [ ] Cross-lens conflict visualization

#### 4.3 Lens Switcher UI
- [ ] Runtime lens selection
- [ ] Multi-lens overlay mode
- [ ] Lens comparison view
- [ ] Provenance overlay toggle

#### 4.4 Advanced Features
- [ ] Impact analysis (what downstream depends on X?)
- [ ] Lineage health scoring
- [ ] Stale lineage detection
- [ ] Lineage diff (what changed since last sync?)

### Success Criteria
- [ ] Successful cross-lens trace spanning 3+ ontologies
- [ ] Provenance UI showing rule attribution
- [ ] < 500ms for lens switching

---

## Technical Debt & Polish

### Performance Optimization
- [ ] WebSocket support for real-time updates
- [ ] Service Worker for offline capability
- [ ] Bundle size optimization (< 200KB gzipped)
- [ ] Matrix operation parallelization

### Testing
- [ ] Unit tests for rule engine
- [ ] Integration tests for trace API
- [ ] E2E tests with Playwright
- [ ] Performance benchmarks

### Documentation
- [ ] API documentation (OpenAPI/Swagger)
- [ ] User guide
- [ ] Administrator guide
- [ ] Rule authoring guide

---

## Timeline Summary

| Phase | Duration | Status |
|-------|----------|--------|
| Phase 1: Foundation | 2-3 weeks | Not Started |
| Phase 2: Contextual Logic | 3-4 weeks | Not Started |
| Phase 3: UI Shell | 3-4 weeks | ✅ Complete |
| Phase 4: Context of Contexts | 2-3 weeks | Not Started |
| Polish & Testing | Ongoing | Not Started |

**Total Estimated Duration:** 10-14 weeks

---

## Current Progress

### Completed (Phase 3)
- Full React 19 + Vite + Tailwind frontend
- React Flow integration with 4 custom node types
- Custom animated LineageEdge with confidence gradients
- Persona toggle (Business/Technical views)
- Adaptive modern theme with glassmorphism
- Spatial loading hook infrastructure
- Detail panel with metadata display
- Command palette and keyboard shortcuts
- Demo data with realistic lineage graph

### Next Steps
1. Begin Phase 1: Set up FalkorDB and ingestion pipelines
2. Implement DataHub adapter for physical metadata
3. Build FastAPI backend with trace endpoint
4. Connect frontend to live backend API

