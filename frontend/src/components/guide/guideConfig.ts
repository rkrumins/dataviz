import {
  Compass,
  Hammer,
  ShieldCheck,
  Rocket,
  BookMarked,
  Eye,
  Layers,
  Settings2,
  GitBranch,
  Save,
  Share2,
  Network,
  PlugZap,
  Users,
  History,
  GitPullRequest,
  ArrowLeftRight,
  Boxes,
  type LucideIcon,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────

/** A persona is an audience-oriented grouping the hub is organised around. */
export interface GuidePersona {
  id: string
  label: string
  icon: LucideIcon
  tagline: string
  intro: string
  startSlug: string
  /** Tailwind accent classes used across cards, badges and active states. */
  accent: {
    gradient: string // e.g. 'from-indigo-500 to-violet-600'
    text: string // e.g. 'text-indigo-600 dark:text-indigo-400'
    soft: string // tinted background
    border: string
    glow: string // shadow colour
  }
}

/** A sidebar section. May belong to a persona or stand alone (start/reference). */
export interface GuideSection {
  id: string
  label: string
  icon: LucideIcon
  persona?: string
}

/** One guide article, backed by a Markdown file in /docs/guide. */
export interface GuideEntry {
  slug: string
  section: string
  persona?: string
  title: string
  description: string
  readingTime: string
  importFn: () => Promise<{ default: string }>
}

/** A curated "key journey" surfaced on the hub. */
export interface KeyJourney {
  title: string
  outcome: string
  slug: string
  persona: string
  icon: LucideIcon
  time: string
}

/** A glossary chip shown on the hub's acronym strip. */
export interface GlossaryChip {
  term: string
  full: string
}

export interface GuideFAQ {
  category: string
  question: string
  answer: string
}

// ── Personas ───────────────────────────────────────────────────────

export const guidePersonas: GuidePersona[] = [
  {
    id: 'viewer',
    label: 'Viewers',
    icon: Compass,
    tagline: 'Find, read, and trace your data',
    intro:
      'Browse curated views, read lineage fluently, and explore the graph to answer your own questions — no setup required.',
    startSlug: 'browsing-views',
    accent: {
      gradient: 'from-sky-500 to-indigo-600',
      text: 'text-sky-600 dark:text-sky-400',
      soft: 'bg-sky-500/10',
      border: 'border-sky-500/20',
      glow: 'shadow-sky-500/20',
    },
  },
  {
    id: 'builder',
    label: 'Builders',
    icon: Hammer,
    tagline: 'Create, organise, and share',
    intro:
      'Turn explorations into durable, shareable Views, organise them for your team, and shape what your data means through the semantic layer.',
    startSlug: 'creating-views',
    accent: {
      gradient: 'from-violet-500 to-fuchsia-600',
      text: 'text-violet-600 dark:text-violet-400',
      soft: 'bg-violet-500/10',
      border: 'border-violet-500/20',
      glow: 'shadow-violet-500/20',
    },
  },
  {
    id: 'admin',
    label: 'Administrators',
    icon: ShieldCheck,
    tagline: 'Connect, govern, and operate',
    intro:
      'Connect data sources, manage users and access, and keep the platform healthy, trustworthy, and well-communicated.',
    startSlug: 'admin-setup',
    accent: {
      gradient: 'from-emerald-500 to-teal-600',
      text: 'text-emerald-600 dark:text-emerald-400',
      soft: 'bg-emerald-500/10',
      border: 'border-emerald-500/20',
      glow: 'shadow-emerald-500/20',
    },
  },
  {
    id: 'versioning',
    label: 'Versioning & Change Control',
    icon: History,
    tagline: 'Draft, review, and roll back safely',
    intro:
      'Every change to a graph goes through a draft and a review before it publishes — with a full history you can always undo or roll back. Spans Builders (making changes) and Administrators (reviewing them).',
    startSlug: 'versioning-change-control',
    accent: {
      gradient: 'from-amber-500 to-orange-600',
      text: 'text-amber-600 dark:text-amber-400',
      soft: 'bg-amber-500/10',
      border: 'border-amber-500/20',
      glow: 'shadow-amber-500/20',
    },
  },
]

// ── Sections ───────────────────────────────────────────────────────

export const guideSections: GuideSection[] = [
  { id: 'start-here', label: 'Start Here', icon: Rocket },
  { id: 'viewer', label: 'For Viewers', icon: Compass, persona: 'viewer' },
  { id: 'builder', label: 'For Builders', icon: Hammer, persona: 'builder' },
  { id: 'versioning', label: 'Versioning & Change Control', icon: History, persona: 'versioning' },
  { id: 'admin', label: 'For Administrators', icon: ShieldCheck, persona: 'admin' },
  { id: 'reference', label: 'Reference', icon: BookMarked },
]

// ── Entries ────────────────────────────────────────────────────────
// Adding a new article? Drop a Markdown file in /docs/guide and add one
// entry here — the sidebar, hub index, and pager update automatically.

export const guideEntries: GuideEntry[] = [
  // Start Here
  {
    slug: 'welcome',
    section: 'start-here',
    title: 'Welcome to {brand}',
    description: 'What {brand} is, who it’s for, and how to use this guide',
    readingTime: '4 min',
    importFn: () => import('@docs/guide/WELCOME.md?raw'),
  },
  {
    slug: 'key-concepts',
    section: 'start-here',
    title: 'Key Concepts',
    description: 'The ten-word vocabulary that makes everything click',
    readingTime: '8 min',
    importFn: () => import('@docs/guide/KEY_CONCEPTS.md?raw'),
  },
  {
    slug: 'quick-start',
    section: 'start-here',
    title: 'Quick Start',
    description: 'Your first 10 minutes, from sign-in to your first View',
    readingTime: '6 min',
    importFn: () => import('@docs/guide/QUICK_START.md?raw'),
  },

  // For Viewers
  {
    slug: 'browsing-views',
    section: 'viewer',
    persona: 'viewer',
    title: 'Browsing Views',
    description: 'Find, open, and favourite curated explorations',
    readingTime: '5 min',
    importFn: () => import('@docs/guide/BROWSING_VIEWS.md?raw'),
  },
  {
    slug: 'reading-lineage',
    section: 'viewer',
    persona: 'viewer',
    title: 'Reading Lineage',
    description: 'Interpret nodes, edges, colours, and granularity',
    readingTime: '7 min',
    importFn: () => import('@docs/guide/READING_LINEAGE.md?raw'),
  },
  {
    slug: 'exploring-graph',
    section: 'viewer',
    persona: 'viewer',
    title: 'Exploring the Graph',
    description: 'Search, trace, expand, and filter on the open canvas',
    readingTime: '7 min',
    importFn: () => import('@docs/guide/EXPLORING_GRAPH.md?raw'),
  },
  {
    slug: 'lineage-lens',
    section: 'viewer',
    persona: 'viewer',
    title: 'The Lineage Lens & Context View',
    description: 'Focus on one thing’s upstream and downstream — and what sits just outside the view',
    readingTime: '8 min',
    importFn: () => import('@docs/guide/LINEAGE_LENS.md?raw'),
  },
  {
    slug: 'navigating-layers',
    section: 'viewer',
    persona: 'viewer',
    title: 'Navigating Layers',
    description: 'The Layer Strip, resizable columns, load-more paging, and the Anchor Rail',
    readingTime: '7 min',
    importFn: () => import('@docs/guide/NAVIGATING_LAYERS.md?raw'),
  },

  // For Builders
  {
    slug: 'creating-views',
    section: 'builder',
    persona: 'builder',
    title: 'Creating Views',
    description: 'The View Wizard, layers, visibility, and tagging',
    readingTime: '7 min',
    importFn: () => import('@docs/guide/CREATING_VIEWS.md?raw'),
  },
  {
    slug: 'managing-views',
    section: 'builder',
    persona: 'builder',
    title: 'Managing Views',
    description: 'Edit, share, co-own, and keep your collection tidy',
    readingTime: '6 min',
    importFn: () => import('@docs/guide/MANAGING_VIEWS.md?raw'),
  },
  {
    slug: 'semantic-layer',
    section: 'builder',
    persona: 'builder',
    title: 'The Semantic Layer',
    description: 'Ontologies, types, hierarchy, and safe versioning',
    readingTime: '8 min',
    importFn: () => import('@docs/guide/SEMANTIC_LAYER.md?raw'),
  },

  // Versioning & Change Control
  {
    slug: 'versioning-change-control',
    section: 'versioning',
    persona: 'versioning',
    title: 'Versioning & Change Control',
    description: 'Drafts, review and merge, and undo vs. restore',
    readingTime: '9 min',
    importFn: () => import('@docs/guide/VERSIONING_CHANGE_CONTROL.md?raw'),
  },
  {
    slug: 'import-export',
    section: 'versioning',
    persona: 'versioning',
    title: 'Import & Export',
    description: 'Bulk-load or back up data through the same review flow',
    readingTime: '6 min',
    importFn: () => import('@docs/guide/IMPORT_EXPORT.md?raw'),
  },

  // For Administrators
  {
    slug: 'admin-setup',
    section: 'admin',
    persona: 'admin',
    title: 'Admin Setup',
    description: 'From a fresh platform to a workspace your team can use',
    readingTime: '8 min',
    importFn: () => import('@docs/guide/ADMIN_SETUP.md?raw'),
  },
  {
    slug: 'workspace-admin',
    section: 'admin',
    persona: 'admin',
    title: 'Workspace Admin',
    description: 'Day-2 workspace ops: wizards, moves, Views, and ontology health',
    readingTime: '8 min',
    importFn: () => import('@docs/guide/WORKSPACE_ADMIN.md?raw'),
  },
  {
    slug: 'users-access',
    section: 'admin',
    persona: 'admin',
    title: 'Users & Access',
    description: 'Approvals, roles, groups, scopes, and grants',
    readingTime: '8 min',
    importFn: () => import('@docs/guide/USERS_ACCESS.md?raw'),
  },
  {
    slug: 'sso-setup',
    section: 'admin',
    persona: 'admin',
    title: 'Single Sign-On',
    description: 'Connect an identity provider, map claims, rehearse, publish',
    readingTime: '7 min',
    importFn: () => import('@docs/guide/SSO_SETUP.md?raw'),
  },
  {
    slug: 'governance-ops',
    section: 'admin',
    persona: 'admin',
    title: 'Governance & Operations',
    description: 'Provider health, audits, announcements, and flags',
    readingTime: '6 min',
    importFn: () => import('@docs/guide/GOVERNANCE_OPS.md?raw'),
  },

  // Reference
  {
    slug: 'ways-of-working',
    section: 'reference',
    title: 'Ways of Working',
    description: 'Conventions and habits that make {brand} shine for teams',
    readingTime: '7 min',
    importFn: () => import('@docs/guide/WAYS_OF_WORKING.md?raw'),
  },
  {
    slug: 'glossary',
    section: 'reference',
    title: 'Glossary & Acronyms',
    description: 'Every term and acronym, in plain language',
    readingTime: '6 min',
    importFn: () => import('@docs/guide/GLOSSARY.md?raw'),
  },
  {
    slug: 'troubleshooting',
    section: 'reference',
    title: 'Troubleshooting',
    description: 'Common situations and how to resolve them',
    readingTime: '6 min',
    importFn: () => import('@docs/guide/TROUBLESHOOTING.md?raw'),
  },
]

// ── Key journeys (curated hub cards) ───────────────────────────────

export const keyJourneys: KeyJourney[] = [
  {
    title: 'Trace a dataset’s lineage',
    outcome: 'Follow data upstream and downstream to see its blast radius',
    slug: 'exploring-graph',
    persona: 'viewer',
    icon: GitBranch,
    time: '7 min',
  },
  {
    title: 'Open and favourite a View',
    outcome: 'Find curated explorations and pin the ones you use most',
    slug: 'browsing-views',
    persona: 'viewer',
    icon: Eye,
    time: '5 min',
  },
  {
    title: 'Read a lineage graph',
    outcome: 'Decode nodes, edges, colours, and granularity at a glance',
    slug: 'reading-lineage',
    persona: 'viewer',
    icon: Network,
    time: '7 min',
  },
  {
    title: 'Focus with the Lineage Lens',
    outcome: 'Isolate one thing’s upstream and downstream — and what sits just outside the view',
    slug: 'lineage-lens',
    persona: 'viewer',
    icon: Eye,
    time: '8 min',
  },
  {
    title: 'Save & share a View',
    outcome: 'Turn an exploration into a durable asset for your team',
    slug: 'creating-views',
    persona: 'builder',
    icon: Save,
    time: '7 min',
  },
  {
    title: 'Organise and co-own Views',
    outcome: 'Keep your team’s collection tidy, shareable, and trusted',
    slug: 'managing-views',
    persona: 'builder',
    icon: Share2,
    time: '6 min',
  },
  {
    title: 'Shape the semantic layer',
    outcome: 'Define what your data means with a versioned ontology',
    slug: 'semantic-layer',
    persona: 'builder',
    icon: Layers,
    time: '8 min',
  },
  {
    title: 'Connect your first data source',
    outcome: 'Provider → catalog → workspace → data source, end to end',
    slug: 'admin-setup',
    persona: 'admin',
    icon: PlugZap,
    time: '8 min',
  },
  {
    title: 'Manage users & access',
    outcome: 'Approve people and grant exactly the right access',
    slug: 'users-access',
    persona: 'admin',
    icon: Users,
    time: '8 min',
  },
  {
    title: 'Operate the platform',
    outcome: 'Keep providers healthy and changes well-governed',
    slug: 'governance-ops',
    persona: 'admin',
    icon: Settings2,
    time: '6 min',
  },
  {
    title: 'Undo or roll back a change',
    outcome: 'Know exactly when to reverse one edit vs. reset to a point in time',
    slug: 'versioning-change-control',
    persona: 'versioning',
    icon: History,
    time: '9 min',
  },
  {
    title: 'Review and merge a draft',
    outcome: 'Approve, request changes, or resolve a conflicting edit',
    slug: 'versioning-change-control',
    persona: 'versioning',
    icon: GitPullRequest,
    time: '9 min',
  },
  {
    title: 'Bulk-import or export data',
    outcome: 'Load a spreadsheet of changes or take a full, re-importable backup',
    slug: 'import-export',
    persona: 'versioning',
    icon: ArrowLeftRight,
    time: '6 min',
  },
  {
    title: 'Move a data source between workspaces',
    outcome: 'Reassign it safely — only possible when nothing is built on it yet',
    slug: 'workspace-admin',
    persona: 'admin',
    icon: Boxes,
    time: '8 min',
  },
]

// ── Quick-start preview steps (hub strip) ──────────────────────────

export const quickStartSteps: string[] = [
  'Sign in and get your bearings',
  'Pick a workspace',
  'Open a View',
  'Trace lineage upstream & downstream',
  'Save and favourite it',
]

// ── Glossary chips (hub acronym strip) ─────────────────────────────

export const glossaryChips: GlossaryChip[] = [
  { term: 'Lineage', full: 'How data flows between things' },
  { term: 'View', full: 'A saved, shareable exploration' },
  { term: 'Ontology', full: 'The semantic layer — what data means' },
  { term: 'Workspace', full: 'An isolated team/project context' },
  { term: 'Granularity', full: 'Zoom level: column → table → domain' },
  { term: 'Upstream', full: 'Where data came from' },
  { term: 'Downstream', full: 'What data feeds' },
  { term: 'RBAC', full: 'Role-Based Access Control' },
  { term: 'Blast Radius', full: 'Everything a change would affect' },
  { term: 'Provider', full: 'A connection to a graph database' },
]

// ── Hub FAQs ───────────────────────────────────────────────────────

export const guideFaqs: GuideFAQ[] = [
  {
    category: 'Getting started',
    question: 'I’m new — where should I begin?',
    answer:
      'Read [Key Concepts](/guide/key-concepts) for the vocabulary, then do the [Quick Start](/guide/quick-start) in a real workspace. Ten minutes each and everything clicks.',
  },
  {
    category: 'Getting started',
    question: 'Do I need to be an engineer to use {brand}?',
    answer:
      'No. This guide is written for everyone. Viewers and Builders never touch code — only Administrators deal with connections, and even that is wizard-driven.',
  },
  {
    category: 'Using {brand}',
    question: 'What’s the difference between a View and the Explorer?',
    answer:
      'A **View** is a curated, saved snapshot someone built. The **Explorer** is an open canvas for your own investigations. Start in Views to learn the landscape; use the Explorer to answer new questions. See [Exploring the Graph](/guide/exploring-graph).',
  },
  {
    category: 'Using {brand}',
    question: 'Can I break anything by clicking around?',
    answer:
      'No. Looking, panning, zooming, and tracing never change data. Editing, saving, and sharing always require a deliberate action.',
  },
  {
    category: 'Access',
    question: 'Why can’t I see a View someone shared?',
    answer:
      'Either its **visibility** is too narrow or you’re in the wrong **workspace**. Ask the owner to widen visibility or share it explicitly, and confirm you’ve opened the right workspace from the sidebar. See [Browsing Views](/guide/browsing-views).',
  },
  {
    category: 'Access',
    question: 'How do I find out what I’m allowed to do?',
    answer:
      'Open your **My Access** page — it lists your roles, scopes, and permissions in plain language. See [Users & Access](/guide/users-access).',
  },
  {
    category: 'Using {brand}',
    question: 'I published a mistake — how do I fix it?',
    answer:
      '**Undo this change** if you know exactly which edit was wrong and want to keep everything since — **Restore to this point** if you need to reset the whole graph to a known-good moment. Both add a new entry to history rather than erasing anything. See [Versioning & Change Control](/guide/versioning-change-control).',
  },
  {
    category: 'Using {brand}',
    question: 'Can I bulk-load data from a spreadsheet?',
    answer:
      'Yes — **Import** (in the header menu, while editing) stages a spreadsheet\'s worth of changes on a draft for you to review before anything publishes. See [Import & Export](/guide/import-export).',
  },
]

// ── Helpers ────────────────────────────────────────────────────────

export function getGuideEntry(slug: string): GuideEntry | undefined {
  return guideEntries.find((e) => e.slug === slug)
}

export function getEntriesForSection(sectionId: string): GuideEntry[] {
  return guideEntries.filter((e) => e.section === sectionId)
}

export function getGuideSection(sectionId: string): GuideSection | undefined {
  return guideSections.find((s) => s.id === sectionId)
}

export function getPersona(personaId: string | undefined): GuidePersona | undefined {
  return personaId ? guidePersonas.find((p) => p.id === personaId) : undefined
}

/** Flat ordered list used by the prev/next pager. */
export const orderedSlugs: string[] = guideSections.flatMap((s) =>
  getEntriesForSection(s.id).map((e) => e.slug),
)

export function getPagerNeighbors(slug: string): {
  prev: GuideEntry | undefined
  next: GuideEntry | undefined
} {
  const idx = orderedSlugs.indexOf(slug)
  return {
    prev: idx > 0 ? getGuideEntry(orderedSlugs[idx - 1]) : undefined,
    next:
      idx >= 0 && idx < orderedSlugs.length - 1
        ? getGuideEntry(orderedSlugs[idx + 1])
        : undefined,
  }
}
