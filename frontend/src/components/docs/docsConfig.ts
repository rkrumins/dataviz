import {
  Rocket,
  LayoutGrid,
  Server,
  HelpCircle,
  Boxes,
  Cloud,
  GitBranch,
  Terminal,
  ShieldCheck,
  Code2,
  Database,
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

/** An audience-oriented grouping surfaced on the docs hub. */
export interface DocPersona {
  id: string
  label: string
  icon: LucideIcon
  tagline: string
  intro: string
  /** Section previewed on this persona's card. */
  sectionId: string
  /** Slug the persona's card links to. */
  startSlug: string
  accent: {
    gradient: string
    text: string
    soft: string
    border: string
    glow: string
  }
}

/** A curated "key journey" card shown on the docs hub. */
export interface DocKeyJourney {
  title: string
  outcome: string
  slug: string
  icon: LucideIcon
}

// ── Sections ───────────────────────────────────────────────────────

export const docSections: DocSection[] = [
  { id: 'getting-started', label: 'Start Here', icon: Rocket },
  { id: 'architecture', label: 'Architecture', icon: LayoutGrid },
  { id: 'dev-workflow', label: 'Setup & Development', icon: Terminal },
  { id: 'reference', label: 'Backend, API & Frontend', icon: Server },
  { id: 'services', label: 'Platform Services', icon: Boxes },
  { id: 'versioning', label: 'Versioning', icon: GitBranch },
  { id: 'security-identity', label: 'Security & Identity', icon: ShieldCheck },
  { id: 'operations', label: 'Deployment & Operations', icon: Cloud },
  { id: 'faq', label: 'FAQ', icon: HelpCircle },
]

// ── Personas (docs hub) ────────────────────────────────────────────

export const docPersonas: DocPersona[] = [
  {
    id: 'new-engineer',
    label: 'New Engineers',
    icon: Rocket,
    tagline: 'Get {brand} running and make your first change',
    intro:
      'Run the stack with one command, load demo data, learn what CI checks, and ship a first pull request with confidence.',
    sectionId: 'dev-workflow',
    startSlug: 'setup',
    accent: {
      gradient: 'from-sky-500 to-blue-600',
      text: 'text-sky-600 dark:text-sky-400',
      soft: 'bg-sky-500/10',
      border: 'border-sky-500/20',
      glow: 'shadow-sky-500/20',
    },
  },
  {
    id: 'architect',
    label: 'Architects & Tech Leads',
    icon: Boxes,
    tagline: 'Understand the system and why it\'s built this way',
    intro:
      'System design, service boundaries, the data model, and the trade-offs behind them — including the decisions that were later superseded.',
    sectionId: 'architecture',
    startSlug: 'architecture',
    accent: {
      gradient: 'from-slate-500 to-slate-700',
      text: 'text-slate-600 dark:text-slate-300',
      soft: 'bg-slate-500/10',
      border: 'border-slate-500/20',
      glow: 'shadow-slate-500/20',
    },
  },
  {
    id: 'operator',
    label: 'Platform Operators',
    icon: Cloud,
    tagline: 'Deploy, secure, and keep it running',
    intro:
      'Deploy with Docker Compose or Kubernetes, harden it for production, watch the right signals, and recover when something breaks.',
    sectionId: 'operations',
    startSlug: 'deployment',
    accent: {
      gradient: 'from-amber-500 to-orange-600',
      text: 'text-amber-600 dark:text-amber-400',
      soft: 'bg-amber-500/10',
      border: 'border-amber-500/20',
      glow: 'shadow-amber-500/20',
    },
  },
  {
    id: 'integrator',
    label: 'Integrators',
    icon: Code2,
    tagline: 'Script {brand} through its API',
    intro:
      'Sign in from a script, find the endpoint you need, follow the API’s conventions, and automate the jobs people script most.',
    sectionId: 'reference',
    startSlug: 'api-guide',
    accent: {
      gradient: 'from-violet-500 to-purple-600',
      text: 'text-violet-600 dark:text-violet-400',
      soft: 'bg-violet-500/10',
      border: 'border-violet-500/20',
      glow: 'shadow-violet-500/20',
    },
  },
  {
    id: 'security',
    label: 'Security Reviewers',
    icon: ShieldCheck,
    tagline: 'See how {brand} protects data and access',
    intro:
      'Sign-in, sessions, permissions, secrets and network posture — how each control works, how to configure it, and where it lives in the code.',
    sectionId: 'security-identity',
    startSlug: 'security-overview',
    accent: {
      gradient: 'from-indigo-500 to-blue-600',
      text: 'text-indigo-600 dark:text-indigo-400',
      soft: 'bg-indigo-500/10',
      border: 'border-indigo-500/20',
      glow: 'shadow-indigo-500/20',
    },
  },
  {
    id: 'data-engineer',
    label: 'Data Engineers',
    icon: Database,
    tagline: 'Bring a data source in and keep it fresh',
    intro:
      'Register a graph store, onboard its data, give it a semantic layer, and keep its lineage summaries fresh and within limits.',
    sectionId: 'services',
    startSlug: 'onboarding-a-source',
    accent: {
      gradient: 'from-teal-500 to-emerald-600',
      text: 'text-teal-600 dark:text-teal-400',
      soft: 'bg-teal-500/10',
      border: 'border-teal-500/20',
      glow: 'shadow-teal-500/20',
    },
  },
]

export const docKeyJourneys: DocKeyJourney[] = [
  {
    title: 'Run it locally',
    outcome: 'One command from clone to signed in, with demo data loaded',
    slug: 'setup',
    icon: Rocket,
  },
  {
    title: 'Understand the system',
    outcome: 'Services, data flow, and how the pieces fit together',
    slug: 'architecture',
    icon: LayoutGrid,
  },
  {
    title: 'See why we built it this way',
    outcome: 'Architecture decision records and the trade-offs behind them',
    slug: 'decisions',
    icon: GitBranch,
  },
  {
    title: 'Look up an API',
    outcome: 'Which router owns which paths, and where each area is documented',
    slug: 'backend',
    icon: Server,
  },
  {
    title: 'Change graph data safely',
    outcome: 'Drafts, review and merge, and revert vs. rollback in the versioning engine',
    slug: 'versioning-overview',
    icon: GitBranch,
  },
  {
    title: 'Script the API',
    outcome: 'Sign in from a script, find endpoints, and automate common jobs',
    slug: 'api-guide',
    icon: Code2,
  },
  {
    title: 'Review the security model',
    outcome: 'Every control: how it works, how to configure it, where it lives',
    slug: 'security-overview',
    icon: ShieldCheck,
  },
  {
    title: 'Onboard a data source',
    outcome: 'From provider to first build, then freshness, profiling and limits',
    slug: 'onboarding-a-source',
    icon: Database,
  },
]

// ── Document Entries ───────────────────────────────────────────────
// Adding a new doc? Add one entry here — that's it.

export const docEntries: DocEntry[] = [
  // Start Here
  {
    slug: 'overview',
    section: 'getting-started',
    title: 'Project Overview',
    description: 'What {brand} is and how the platform works',
    importFn: () => import('@docs/OVERVIEW.md?raw'),
  },
  {
    slug: 'contributing',
    section: 'getting-started',
    title: 'Contributing',
    description: 'Where things live, how a change ships, and recipes for common changes',
    importFn: () => import('@docs/CONTRIBUTING.md?raw'),
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
    slug: 'data-architecture',
    section: 'architecture',
    title: 'Data Architecture',
    description: 'Database schema and entity relationships',
    importFn: () => import('@docs/DATA_ARCHITECTURE.md?raw'),
  },
  {
    slug: 'decisions',
    section: 'architecture',
    title: 'Design Decisions',
    description: 'ADRs and architectural trade-offs',
    importFn: () => import('@docs/DECISIONS.md?raw'),
  },
  {
    slug: 'changelog',
    section: 'architecture',
    title: 'Changelog',
    description: 'Notable changes, newest first — including known limitations',
    importFn: () => import('@root/CHANGELOG.md?raw'),
  },
  {
    slug: 'scaling-architecture',
    section: 'architecture',
    title: 'Scaling Architecture',
    description: 'The deployed three-tier split, and the end-state items still open',
    importFn: () => import('@docs/architecture-when-scaling.md?raw'),
  },
  {
    slug: 'aggregation-pipeline',
    section: 'architecture',
    title: 'Aggregation Pipeline',
    description: 'How :AGGREGATED edges are materialized and rolled up',
    importFn: () => import('@docs/AGGREGATION_PIPELINE.md?raw'),
  },
  {
    slug: 'property-storage',
    section: 'architecture',
    title: 'Property Storage',
    description: 'How entity properties are stored, indexed and kept within each graph store’s limits',
    importFn: () => import('@docs/PROPERTY_STORAGE.md?raw'),
  },
  {
    slug: 'domain-ownership',
    section: 'architecture',
    title: 'Database Domain Ownership',
    description: 'Which part of the backend owns which tables in the management database',
    importFn: () => import('@root/backend/app/db/DOMAIN_OWNERSHIP.md?raw'),
  },

  // Setup & Development
  {
    slug: 'setup',
    section: 'dev-workflow',
    title: 'Developer Setup',
    description: 'Run the stack, sign in, load demo data — New Engineers start here',
    importFn: () => import('@docs/SETUP.md?raw'),
  },
  {
    slug: 'testing-and-ci',
    section: 'dev-workflow',
    title: 'Testing & CI',
    description: 'What runs on a pull request, and how to run every check locally',
    importFn: () => import('@docs/TESTING_AND_CI.md?raw'),
  },
  {
    slug: 'feature-flags-lifecycle',
    section: 'dev-workflow',
    title: 'Feature Switch Lifecycle',
    description: 'Add, ship and retire a feature switch without the guard failing',
    importFn: () => import('@docs/features/feature-flags.md?raw'),
  },
  {
    slug: 'integration-testing',
    section: 'dev-workflow',
    title: 'Local Integration Testing',
    description: 'Backend-only path to exercise the draft/branch graph journey',
    importFn: () => import('@docs/local-integration-testing.md?raw'),
  },

  // Backend, API & Frontend
  {
    slug: 'api-guide',
    section: 'reference',
    title: 'API Guide',
    description: 'Sign in from a script, find endpoints, and automate common jobs — Integrators start here',
    importFn: () => import('@docs/API_GUIDE.md?raw'),
  },
  {
    slug: 'backend',
    section: 'reference',
    title: 'Backend Reference',
    description: 'The router map, the request pipeline, and where each API area is documented',
    importFn: () => import('@docs/BACKEND.md?raw'),
  },
  {
    slug: 'frontend',
    section: 'reference',
    title: 'Frontend Reference',
    description: 'How the frontend is organised, and where to look for each part',
    importFn: () => import('@docs/FRONTEND.md?raw'),
  },
  {
    slug: 'api-features',
    section: 'reference',
    title: 'Feature Switches API',
    description: 'The feature switch endpoints, every switch, and the routes each one closes',
    importFn: () => import('@docs/API_FEATURES.md?raw'),
  },

  // Platform Services
  {
    slug: 'onboarding-a-source',
    section: 'services',
    title: 'Onboarding a Data Source',
    description: 'From provider to first build, then freshness, profiling and limits — Data Engineers start here',
    importFn: () => import('@docs/ONBOARDING_A_SOURCE.md?raw'),
  },
  {
    slug: 'services-overview',
    section: 'services',
    title: 'Platform Services Overview',
    description: 'The service inventory and how the processes fit together',
    importFn: () => import('@docs/services/OVERVIEW.md?raw'),
  },
  {
    slug: 'services-insights',
    section: 'services',
    title: 'Insights Service',
    description: 'Stats collection, discovery, admission control, and cache warming',
    importFn: () => import('@docs/services/INSIGHTS.md?raw'),
  },
  {
    slug: 'services-search',
    section: 'services',
    title: 'Search: Deep & Advanced',
    description: 'Provider-agnostic deep search and the advanced-search pipeline',
    importFn: () => import('@docs/services/SEARCH.md?raw'),
  },
  {
    slug: 'services-context-engine',
    section: 'services',
    title: 'Context Engine',
    description: 'Ontology resolution, context models, and context lenses',
    importFn: () => import('@docs/services/CONTEXT_ENGINE.md?raw'),
  },
  {
    slug: 'services-assignments',
    section: 'services',
    title: 'Assignment Engine',
    description: 'Type/ontology assignment precedence and schema mapping',
    importFn: () => import('@docs/services/ASSIGNMENTS.md?raw'),
  },
  {
    slug: 'feature-aggregation-reconciliation',
    section: 'services',
    title: 'Automatic Aggregation Reconciliation',
    description: 'The sweep that keeps rolled-up lineage matching each source, its holds, and the runbook',
    importFn: () => import('@docs/features/aggregation-reconciliation.md?raw'),
  },
  {
    slug: 'feature-external-change-notification',
    section: 'services',
    title: 'External Change Notification',
    description: 'Telling the platform an external data source changed',
    importFn: () => import('@docs/features/external-change-notification.md?raw'),
  },
  {
    slug: 'feature-view-portability',
    section: 'services',
    title: 'View Portability & Versions',
    description: 'Moving views between environments: the view file and package formats, import, and view versions',
    importFn: () => import('@docs/features/view-portability.md?raw'),
  },
  {
    slug: 'feature-search-and-rules-reference',
    section: 'services',
    title: 'Search & Display Rules Reference',
    description: 'The query model, search and view-library endpoints, the library pack format, and scripting recipes',
    importFn: () => import('@docs/features/search-and-rules-reference.md?raw'),
  },
  {
    slug: 'top-level-nodes-performance',
    section: 'services',
    title: 'Top-Level Nodes Performance',
    description: 'How the first level of a large graph loads quickly, and what to tune when it doesn’t',
    importFn: () => import('@docs/TOP_LEVEL_NODES_PERFORMANCE.md?raw'),
  },

  // Versioning
  {
    slug: 'versioning-overview',
    section: 'versioning',
    title: 'Versioning: Overview & Architecture',
    description: 'Git for graphs — draft branches, merge, review & publish, revert/rollback',
    importFn: () => import('@docs/versioning/01-overview-and-architecture.md?raw'),
  },
  {
    slug: 'versioning-data-model',
    section: 'versioning',
    title: 'Versioning: Data Model',
    description: 'The graphver Postgres schema — version rows, head pointers, partitioning and hashing',
    importFn: () => import('@docs/versioning/02-data-model.md?raw'),
  },
  {
    slug: 'versioning-branching-and-merge',
    section: 'versioning',
    title: 'Versioning: Branching, Commits & Merge',
    description: 'Drafts, publish, forks and pull requests, the 3-way merge, and the concurrency model',
    importFn: () => import('@docs/versioning/03-branching-commits-merge.md?raw'),
  },
  {
    slug: 'versioning-projection-and-cache',
    section: 'versioning',
    title: 'Versioning: Projection & Cache',
    description: 'How committed main becomes a rebuildable FalkorDB read cache, and how it stays fresh',
    importFn: () => import('@docs/versioning/04-projection-and-cache.md?raw'),
  },
  {
    slug: 'versioning-ontology-governance',
    section: 'versioning',
    title: 'Versioning: Ontology Governance',
    description: 'How the assigned ontology is enforced at the commit boundary on every write path',
    importFn: () => import('@docs/versioning/05-ontology-governance.md?raw'),
  },
  {
    slug: 'versioning-api-reference',
    section: 'versioning',
    title: 'Versioning: API Reference',
    description: 'The REST contract for the versioning and draft-aware graph routers',
    importFn: () => import('@docs/versioning/06-api-reference.md?raw'),
  },
  {
    slug: 'versioning-frontend-integration',
    section: 'versioning',
    title: 'Versioning: Frontend Integration',
    description: 'How the canvas drives versioning — edit mode as a draft, branch-scoped reads, the Save pipeline',
    importFn: () => import('@docs/versioning/07-frontend-integration.md?raw'),
  },
  {
    slug: 'versioning-import-export',
    section: 'versioning',
    title: 'Versioning: Import / Export',
    description: 'Bulk import and export as the draft flow at scale — pipeline, identity, formats and limits',
    importFn: () => import('@docs/versioning/08-import-export.md?raw'),
  },
  {
    slug: 'versioning-scale-and-roadmap',
    section: 'versioning',
    title: 'Versioning: Scale, Limits & Roadmap',
    description: 'What is measured, where the sharp edges are, and the prioritized roadmap',
    importFn: () => import('@docs/versioning/09-scale-limits-and-roadmap.md?raw'),
  },
  {
    slug: 'versioning-authoritative-sources',
    section: 'versioning',
    title: 'Versioning: Authoritative Sources',
    description: 'Managed vs federated sources, and how external catalogs re-sync as commits',
    importFn: () => import('@docs/versioning/10-authoritative-sources-datahub-openmetadata.md?raw'),
  },
  {
    slug: 'versioning-resync-at-any-scale',
    section: 'versioning',
    title: 'Versioning: Re-sync at Any Scale',
    description: 'The design that makes provider re-sync memory-bounded so its size guard can go',
    importFn: () => import('@docs/versioning/11-resync-at-any-scale.md?raw'),
  },
  {
    slug: 'versioning-e2e',
    section: 'versioning',
    title: 'Versioning: End-to-End Walkthrough',
    description: 'Hands-on test guide for the draft, branch, and merge flow',
    importFn: () => import('@docs/VERSIONING_E2E.md?raw'),
  },
  {
    slug: 'versioning-deep-dives',
    section: 'versioning',
    title: 'Versioning: Deep-Dive Index',
    description: 'Directory into the full versioning reference suite',
    importFn: () => import('@docs/versioning/README-index.md?raw'),
  },
  {
    slug: 'versioning-guide',
    section: 'versioning',
    title: 'Versioning: Suite Guide & Glossary',
    description: 'Reading paths through the suite, the glossary, and the status snapshot',
    importFn: () => import('@docs/versioning/README.md?raw'),
  },
  {
    slug: 'versioning-drafts-and-merge',
    section: 'versioning',
    title: 'Versioning: Draft Lineage & Merge Notes',
    description: 'Engineering notes on the draft read overlay, and the merge data-loss fix and repair',
    importFn: () => import('@docs/VERSIONING_DRAFTS_LINEAGE_AND_MERGE.md?raw'),
  },

  // Security & Identity
  {
    slug: 'security-overview',
    section: 'security-identity',
    title: 'Security Overview',
    description: 'Every control — how it works, how to configure it, where it lives — Security Reviewers start here',
    importFn: () => import('@docs/SECURITY_OVERVIEW.md?raw'),
  },
  {
    slug: 'rbac',
    section: 'security-identity',
    title: 'RBAC',
    description: 'Roles, permissions, and the resolver that enforces them',
    importFn: () => import('@docs/RBAC.md?raw'),
  },
  {
    slug: 'sso',
    section: 'security-identity',
    title: 'SSO (Operator Guide)',
    description: "What's supported, and how to configure and run it",
    importFn: () => import('@docs/SSO.md?raw'),
  },
  {
    slug: 'sso-integration',
    section: 'security-identity',
    title: 'SSO Integration (Developer Guide)',
    description: 'Day-1 walkthrough, architecture, sequence diagrams, and cookbooks',
    importFn: () => import('@docs/SSO_INTEGRATION.md?raw'),
  },
  {
    slug: 'multi-environment-sessions',
    section: 'security-identity',
    title: 'Multi-Environment Sessions',
    description:
      'Running two deployments in one browser, and rotating the signing key without signing everyone out',
    importFn: () => import('@docs/MULTI_ENVIRONMENT_SESSIONS.md?raw'),
  },
  {
    slug: 'signup-service',
    section: 'security-identity',
    title: 'User & Sign-up Service',
    description: 'How sign-up, approval and password reset work today, and which parts of the original plan shipped',
    importFn: () => import('@docs/SIGNUP_USER_SERVICE_PLAN.md?raw'),
  },
  {
    slug: 'sso-backchannel-contract',
    section: 'security-identity',
    title: 'Back-channel SSO Contract',
    description: 'What an Enterprise gateway must implement to sign people in through its back channel',
    importFn: () => import('@docs/SSO_BACKCHANNEL_CONTRACT.md?raw'),
  },

  // Deployment & Operations
  {
    slug: 'deployment',
    section: 'operations',
    title: 'Self-Host Deployment',
    description: 'Docker Compose on a VM: install, upgrade, back up, and the production hardening checklist — Operators start here',
    importFn: () => import('@docs/DEPLOYMENT.md?raw'),
  },
  {
    slug: 'kubernetes',
    section: 'operations',
    title: 'Deploying on Kubernetes',
    description: 'Deploy with Helm or kustomize, what each path includes, and fixing a rollout that fails',
    importFn: () => import('@docs/KUBERNETES.md?raw'),
  },
  {
    slug: 'kubernetes-cluster-overlay',
    section: 'operations',
    title: 'Production Cluster Overlay',
    description: 'Running the graph store as a cluster when one FalkorDB pod is no longer enough',
    importFn: () => import('@root/deploy/k8s/overlays/production-cluster/README.md?raw'),
  },
  {
    slug: 'configuration',
    section: 'operations',
    title: 'Configuration Reference',
    description: 'Every environment variable the backend reads, with its default — generated from the code',
    importFn: () => import('@docs/CONFIGURATION.md?raw'),
  },
  {
    slug: 'observability',
    section: 'operations',
    title: 'Observability',
    description: 'Health checks, metrics, logs, and what to alert on',
    importFn: () => import('@docs/OBSERVABILITY.md?raw'),
  },
  {
    slug: 'runbooks',
    section: 'operations',
    title: 'Runbooks',
    description: 'Backups, restores, upgrades, password resets and other routine operations',
    importFn: () => import('@docs/RUNBOOKS.md?raw'),
  },
  {
    slug: 'upgrade-2026-09-10',
    section: 'operations',
    title: 'Upgrade Note: Graph Availability',
    description: 'What changed in the 2026-09-10 release for graph availability, and how to upgrade to it',
    importFn: () => import('@docs/UPGRADE_2026-09-10_graph-availability.md?raw'),
  },
  {
    slug: 'migrations',
    section: 'operations',
    title: 'Database Migrations',
    description: 'How the schema is built, and the rules a new migration follows',
    importFn: () => import('@docs/MIGRATIONS.md?raw'),
  },
  {
    slug: 'falkordb-deployment',
    section: 'operations',
    title: 'FalkorDB Deployment',
    description: 'Enterprise HA cluster topology on GKE',
    importFn: () => import('@docs/FALKORDB_DEPLOYMENT.md?raw'),
  },
  {
    slug: 'concurrency-tuning',
    section: 'operations',
    title: 'Concurrency and Timeout Tuning',
    description: 'The eight ceilings a graph request passes, what users see when one is wrong, and the order to raise them in',
    importFn: () => import('@docs/CONCURRENCY_TUNING.md?raw'),
  },
  {
    slug: 'scaling-concurrent-users',
    section: 'operations',
    title: 'Scaling for Concurrent Users',
    description: 'Sizing each tier for ~100, ~500 and ~1,000+ people at once: connection budgets, FalkorDB, Redis, profiles and load tests',
    importFn: () => import('@docs/SCALING_CONCURRENT_USERS.md?raw'),
  },
  {
    slug: 'falkordb-dr',
    section: 'operations',
    title: 'FalkorDB Disaster Recovery',
    description: 'Back up and recover the graph store: snapshots, rebuilding version-controlled sources from Postgres, and region loss',
    importFn: () => import('@docs/FALKORDB_DR_RUNBOOK.md?raw'),
  },
  {
    slug: 'infra-launch-scale',
    section: 'operations',
    title: 'Infrastructure: Launch Scale',
    description: 'GCP infrastructure spec for ~1,000 users / 300 graphs',
    importFn: () => import('@docs/INFRASTRUCTURE_LAUNCH_SCALE.md?raw'),
  },
  {
    slug: 'infra-scaling-250m',
    section: 'operations',
    title: 'Infrastructure: 250M-Node Scale',
    description: 'Theoretical-max deployment spec',
    importFn: () => import('@docs/INFRASTRUCTURE_SCALING_250M.md?raw'),
  },
  {
    slug: 'read-path-performance',
    section: 'operations',
    title: 'Read-Path Performance',
    description: 'The read-path perf redesign — ontology tax removal, label-bucket seeks, and more',
    importFn: () => import('@docs/read-path-performance/README.md?raw'),
  },
]

// ── FAQ ────────────────────────────────────────────────────────────

export const faqEntries: FAQEntry[] = [
  // General
  {
    category: 'General',
    question: 'What is {brand}?',
    answer:
      '{brand} is a **data lineage visualization platform** that connects to graph databases (FalkorDB, Neo4j, Google Cloud Spanner Graph and DataHub) and renders interactive lineage maps. It helps teams understand how data flows across systems — from source to dashboard.',
  },
  {
    category: 'General',
    question: 'What databases does {brand} support?',
    answer:
      '{brand} supports **FalkorDB** (default, Redis-protocol graph DB), **Neo4j**, and **Google Cloud Spanner Graph** as graph providers, plus a connectivity-level **DataHub** adapter. The management database is **PostgreSQL** in every environment.',
  },
  {
    category: 'General',
    question: 'Is {brand} open source?',
    answer:
      'Yes. {brand} is open source. Contributions, issues, and feature requests are welcome; the [Setup Guide](/docs/setup) gets a development environment running.',
  },

  // Setup
  {
    category: 'Setup',
    question: 'How do I get started quickly?',
    answer:
      'Clone the repository and run `./dev.sh` from its root. The first run creates `.env.dev` with a fresh signing key, builds the images, applies the database migrations and starts every service. Open http://localhost:5173, sign in with the administrator from `.env.dev`, and choose a new password when asked. See [Developer Setup](/docs/setup).',
  },
  {
    category: 'Setup',
    question: 'How do I connect my first graph database?',
    answer:
      'Nothing is connected on first boot. As a Super Admin, open **Ingestion → Providers** and select **Register Provider**: choose FalkorDB, Neo4j, Google Cloud Spanner Graph or DataHub, enter the connection details, then **Test connection** and **Create provider**. Onboard its graphs from the **Data Sources** tab — see [Onboarding a Data Source](/docs/onboarding-a-source).',
  },
  {
    category: 'Setup',
    question: 'What happens on first boot?',
    answer:
      'A one-shot `upgrade` job builds the database schema and writes the built-in roles and permissions before any service starts. The API then seeds the feature switches and the Context View layer templates, and creates the first administrator from `ADMIN_EMAIL` and `ADMIN_PASSWORD` when the database has no users. No provider, workspace or data source is created: you register those yourself — see [Developer Setup](/docs/setup).',
  },
  {
    category: 'Setup',
    question: 'How do I seed demo data?',
    answer:
      'Run `./dev.sh exec viz-service python backend/scripts/seed_falkordb.py --graph nexus_lineage` to write a demo lineage graph into the development FalkorDB. It stays invisible in the app until you register the graph store as a provider and onboard the graph as a data source; [Load demo data](/docs/setup#load-demo-data) walks through both.',
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
      'A **CatalogItem** is a named graph or dataset discovered from a provider. When you connect a provider, {brand} discovers available graphs and registers them as catalog items. Catalog items can then be bound to workspaces.',
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
      'A **Workspace** is a team’s or a project’s area: it holds data sources (each one a graph from a provider, with its semantic layer), the views built on them, and its members, each with a role. See [Key Concepts](/guide/key-concepts#workspaces).',
  },
  {
    category: 'Concepts',
    question: 'What kinds of view are there?',
    answer:
      'Every view draws its data on one of three canvases, chosen when it is created: **Context View** (entities sorted into columns you define, with lineage between them — the recommended default), **Graph** (entities and relationships positioned freely) and **Hierarchy** (entities nested inside their parents). See [Creating Views](/guide/creating-views).',
  },
  {
    category: 'Concepts',
    question: 'What is the Lineage Lens?',
    answer:
      'The **Lineage Lens** is a focused view of one entity’s lineage inside a view: everything upstream and downstream of it, folded into as much or as little detail as you choose with **Density**, including what sits just outside the view. See [The Lineage Lens & Context View](/guide/lineage-lens).',
  },

  // Architecture
  {
    category: 'Architecture',
    question: 'Was there ever a separate Graph Service?',
    answer:
      'Yes, briefly — a standalone **Graph Service** on port 8001 handled provider discovery and connectivity testing. It was retired ([ADR-018](/docs/decisions)): it was deployed but never actually invoked, since the onboarding flow already calls the Visualization Service\'s own bulkheaded connectivity check. The provider adapters it used (Neo4j, DataHub, Spanner) survive and now run in-process inside the **Visualization Service** (port 8000), which handles everything — auth, workspaces, ontology, and provider connectivity.',
  },
  {
    category: 'Architecture',
    question: 'What is the tech stack?',
    answer:
      'Frontend: **React 19 + TypeScript + Vite + Tailwind CSS**. Backend: **Python 3.14 + FastAPI + SQLAlchemy 2.0 async**, with schema migrations managed by **Alembic**. Graph DB: **FalkorDB** (default). Management DB: **PostgreSQL**, in every environment. Cache/session store: a dedicated **Redis**. State: **Zustand**. Visualization: **React Flow**.',
  },

  // Troubleshooting
  {
    category: 'Troubleshooting',
    question: 'The frontend shows a blank page or API errors',
    answer:
      'Ensure the viz-service backend is running and healthy. In Docker mode, check that `nginx.conf` proxies to the `viz-service` container. In local dev, check that `vite.config.ts` proxies to `localhost:8000`.',
  },
  {
    category: 'Troubleshooting',
    question: 'I see "No data source for workspace" error',
    answer:
      'The workspace has no data source yet, or its data source was removed. Add one: onboard a graph from **Ingestion → Data Sources**, as [Onboarding a Data Source](/docs/onboarding-a-source) describes. Don’t run `docker compose down -v` to “reset” it — that deletes every volume, including the management database.',
  },
  {
    category: 'Troubleshooting',
    question: 'Docker Compose fails with port conflicts',
    answer:
      'Another process is using a port the stack publishes: 5173 (frontend in development), 3080 (frontend in a Compose install), 8000 (API), 8091 (aggregation control plane), 5432 (PostgreSQL), 6380 (Redis), 6379 (FalkorDB) or 3000 (FalkorDB browser). Stop the other process, or move the port as [Ports](/docs/setup#ports) describes.',
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

/** Flat reading order (all sections except the FAQ), used by the prev/next pager. */
export const orderedSlugs: string[] = docSections
  .filter((s) => s.id !== 'faq')
  .flatMap((s) => getEntriesForSection(s.id).map((e) => e.slug))

export function getPagerNeighbors(slug: string): {
  prev: DocEntry | undefined
  next: DocEntry | undefined
} {
  const idx = orderedSlugs.indexOf(slug)
  return {
    prev: idx > 0 ? getEntryBySlug(orderedSlugs[idx - 1]) : undefined,
    next:
      idx >= 0 && idx < orderedSlugs.length - 1
        ? getEntryBySlug(orderedSlugs[idx + 1])
        : undefined,
  }
}
