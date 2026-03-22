import {
  Rocket,
  LayoutGrid,
  Server,
  AlertTriangle,
  HelpCircle,
  type LucideIcon,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────

export interface DocSection {
  id: string
  label: string
  icon: LucideIcon
}

export interface DocEntry {
  slug: string
  section: string
  title: string
  description?: string
  importFn: () => Promise<{ default: string }>
}

export interface FAQEntry {
  category: string
  question: string
  answer: string
}

// ── Sections ───────────────────────────────────────────────────────

export const docSections: DocSection[] = [
  { id: 'getting-started', label: 'Getting Started', icon: Rocket },
  { id: 'architecture', label: 'Architecture', icon: LayoutGrid },
  { id: 'reference', label: 'Technical Reference', icon: Server },
  { id: 'operations', label: 'Operations', icon: AlertTriangle },
  { id: 'faq', label: 'FAQ', icon: HelpCircle },
]

// ── Document Entries ───────────────────────────────────────────────
// Adding a new doc? Add one entry here — that's it.

export const docEntries: DocEntry[] = [
  // Getting Started
  {
    slug: 'overview',
    section: 'getting-started',
    title: 'Project Overview',
    description: 'What Synodic is and how the platform works',
    importFn: () => import('@docs/OVERVIEW.md?raw'),
  },
  {
    slug: 'setup',
    section: 'getting-started',
    title: 'Setup Guide',
    description: 'Docker and local development setup',
    importFn: () => import('@docs/SETUP.md?raw'),
  },

  // Architecture
  {
    slug: 'architecture',
    section: 'architecture',
    title: 'Architecture',
    description: 'System design, services, and data flow',
    importFn: () => import('@docs/ARCHITECTURE.md?raw'),
  },
  {
    slug: 'decisions',
    section: 'architecture',
    title: 'Design Decisions',
    description: 'ADRs and architectural trade-offs',
    importFn: () => import('@docs/DECISIONS.md?raw'),
  },

  // Technical Reference
  {
    slug: 'backend',
    section: 'reference',
    title: 'Backend Reference',
    description: 'API routes, services, and repositories',
    importFn: () => import('@docs/BACKEND.md?raw'),
  },
  {
    slug: 'frontend',
    section: 'reference',
    title: 'Frontend Reference',
    description: 'Components, stores, and hooks',
    importFn: () => import('@docs/FRONTEND.md?raw'),
  },
  {
    slug: 'data-architecture',
    section: 'reference',
    title: 'Data Architecture',
    description: 'Database schema and entity relationships',
    importFn: () => import('@docs/DATA_ARCHITECTURE.md?raw'),
  },
  {
    slug: 'api-features',
    section: 'reference',
    title: 'Feature Flags API',
    description: 'Feature flag endpoints and contracts',
    importFn: () => import('@docs/API_FEATURES.md?raw'),
  },

  // Operations
  {
    slug: 'technical-debt',
    section: 'operations',
    title: 'Technical Debt',
    description: 'Known debt items and remediation plan',
    importFn: () => import('@docs/TECHNICAL_DEBT.md?raw'),
  },
  {
    slug: 'signup-service',
    section: 'operations',
    title: 'User Service Plan',
    description: 'Signup and user management roadmap',
    importFn: () => import('@docs/SIGNUP_USER_SERVICE_PLAN.md?raw'),
  },
]

// ── FAQ ────────────────────────────────────────────────────────────

export const faqEntries: FAQEntry[] = [
  // General
  {
    category: 'General',
    question: 'What is Synodic?',
    answer:
      'Synodic is a **data lineage visualization platform** that connects to graph databases (FalkorDB, Neo4j, DataHub) and renders interactive lineage maps. It helps teams understand how data flows across systems — from source to dashboard.',
  },
  {
    category: 'General',
    question: 'What databases does Synodic support?',
    answer:
      'Synodic supports **FalkorDB** (default, Redis-protocol graph DB), **Neo4j**, and **DataHub** as graph providers. The management database uses **PostgreSQL** in production or **SQLite** for local development.',
  },
  {
    category: 'General',
    question: 'Is Synodic open source?',
    answer:
      'Yes. Synodic is open source and available on GitHub. Contributions, issues, and feature requests are welcome.',
  },

  // Setup
  {
    category: 'Setup',
    question: 'How do I get started quickly?',
    answer:
      'Run `docker compose up --build` from the repo root. This starts all 5 services (frontend, viz-service, graph-service, FalkorDB, PostgreSQL). Open http://localhost:3080 and log in with `admin@synodic.local` / `admin123`. See the [Setup Guide](/docs/setup) for details.',
  },
  {
    category: 'Setup',
    question: 'How do I connect my first graph database?',
    answer:
      'After logging in, navigate to **Admin → Unified Registry → Connections**. Click **Add Connection**, choose your provider type (FalkorDB, Neo4j, or DataHub), enter connection details, and test connectivity. The platform bootstraps a default FalkorDB connection on first boot.',
  },
  {
    category: 'Setup',
    question: 'What happens on first boot?',
    answer:
      'On first boot, the viz-service creates all database tables, seeds the feature registry and ontology templates, creates an admin user, and bootstraps a default provider, workspace, and data source from environment variables.',
  },
  {
    category: 'Setup',
    question: 'How do I seed demo data?',
    answer:
      'Run `docker compose --profile seed up --build` to populate FalkorDB with enterprise demo scenarios (finance, ecommerce, HR, marketing). Configure scenarios, scale, and depth via environment variables. See the [Setup Guide](/docs/setup) for all options.',
  },

  // Concepts
  {
    category: 'Concepts',
    question: 'What is a Provider?',
    answer:
      'A **Provider** represents a graph database connection (e.g., a FalkorDB instance). It stores host, port, credentials, and health status. Each provider can contain multiple graphs.',
  },
  {
    category: 'Concepts',
    question: 'What is a CatalogItem?',
    answer:
      'A **CatalogItem** is a named graph or dataset discovered from a provider. When you connect a provider, Synodic discovers available graphs and registers them as catalog items. Catalog items can then be bound to workspaces.',
  },
  {
    category: 'Concepts',
    question: 'What is an Ontology?',
    answer:
      'An **Ontology** defines the semantic layer — node types, edge types, colors, icons, and business context. It controls how lineage graphs are rendered and interpreted. Ontologies are versioned and can be shared across workspaces.',
  },
  {
    category: 'Concepts',
    question: 'What is a Workspace?',
    answer:
      'A **Workspace** is the top-level organizational unit that binds a catalog item (data source) with an ontology. Users interact with workspaces to explore lineage, create views, and apply context lenses.',
  },
  {
    category: 'Concepts',
    question: 'What are Projection Modes?',
    answer:
      'Projection modes control how lineage data is visualized: **Graph** (free-form force-directed), **Hierarchy** (tree layout), **Reference** (dependency matrix), and **Layered Lineage** (horizontal flow by data tier). Each mode offers a different perspective on the same underlying data.',
  },
  {
    category: 'Concepts',
    question: 'What are Context Lenses?',
    answer:
      'Context Lenses are saved view configurations that highlight specific aspects of your lineage — such as a particular data domain, pipeline stage, or ownership boundary. They allow teams to focus on what matters without modifying the underlying graph.',
  },

  // Architecture
  {
    category: 'Architecture',
    question: 'Why are there two backend services?',
    answer:
      'The **Visualization Service** (port 8000) handles auth, workspace management, ontology, and orchestration. The **Graph Service** (port 8001) handles provider discovery, connectivity testing, and direct graph queries. This separation allows independent scaling and eventual microservice extraction.',
  },
  {
    category: 'Architecture',
    question: 'What is the tech stack?',
    answer:
      'Frontend: **React 19 + TypeScript + Vite + Tailwind CSS**. Backend: **Python 3.12 + FastAPI + SQLAlchemy 2.0 async**. Graph DB: **FalkorDB** (default). Management DB: **PostgreSQL** (production) / SQLite (dev). State: **Zustand**. Visualization: **React Flow**.',
  },

  // Troubleshooting
  {
    category: 'Troubleshooting',
    question: 'The frontend shows a blank page or API errors',
    answer:
      'Ensure both backend services are running and healthy. In Docker mode, check that `nginx.conf` proxy targets match the service names. In local dev, check that `vite.config.ts` proxy targets point to `localhost:8000` and `localhost:8001`.',
  },
  {
    category: 'Troubleshooting',
    question: 'I see "No data source for workspace" error',
    answer:
      'This means the workspace was created without a data source binding. Run `docker compose down -v` to clear stale data, then `docker compose up --build` for a clean bootstrap.',
  },
  {
    category: 'Troubleshooting',
    question: 'Docker Compose fails with port conflicts',
    answer:
      'Another process is using one of the required ports (6379, 5432, 8000, 8001, 3080). Stop the conflicting process or change the port mapping in `docker-compose.yml`.',
  },
]

// ── Helpers ────────────────────────────────────────────────────────

export function getEntryBySlug(slug: string): DocEntry | undefined {
  return docEntries.find((e) => e.slug === slug)
}

export function getEntriesForSection(sectionId: string): DocEntry[] {
  return docEntries.filter((e) => e.section === sectionId)
}

export function getSectionById(sectionId: string): DocSection | undefined {
  return docSections.find((s) => s.id === sectionId)
}
