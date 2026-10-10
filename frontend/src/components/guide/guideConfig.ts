import {
  Compass,
  Hammer,
  ShieldCheck,
  Rocket,
  BookMarked,
  Eye,
  GitBranch,
  Save,
  Share2,
  Network,
  PlugZap,
  Users,
  History,
  GitPullRequest,
  KeyRound,
  PenLine,
  Gauge,
  ToggleLeft,
  LifeBuoy,
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
  importFn: () => Promise<{ default: string }>
}

/** A curated "key journey" surfaced on the hub. */
export interface KeyJourney {
  title: string
  outcome: string
  slug: string
  persona: string
  icon: LucideIcon
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
      'Find views in the Explorer, read their lineage, and trace it to answer your own questions — no setup required.',
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
      'Build views with New View, share them at the right visibility, and shape what your data means through the semantic layer.',
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
      'Connect data sources, manage users and access, keep data fresh, and decide which features everyone gets.',
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
      'Changes to a graph’s data are made in a private draft and published — usually through a review in the Review Center. Every published change stays in history, so you can undo one change or restore an earlier point. For anyone who edits data or reviews changes.',
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
    description: 'What {brand} is, the path for your role, and where to get help',
    importFn: () => import('@docs/guide/WELCOME.md?raw'),
  },
  {
    slug: 'key-concepts',
    section: 'start-here',
    title: 'Key Concepts',
    description: 'Workspaces, data sources, views, lineage and roles — how the pieces fit together',
    importFn: () => import('@docs/guide/KEY_CONCEPTS.md?raw'),
  },
  {
    slug: 'quick-start',
    section: 'start-here',
    title: 'Quick Start',
    description: 'Your first 10 minutes: sign in, open a view, trace it and keep it one click away',
    importFn: () => import('@docs/guide/QUICK_START.md?raw'),
  },

  // For Viewers
  {
    slug: 'browsing-views',
    section: 'viewer',
    persona: 'viewer',
    title: 'Finding Views',
    description: 'Find a view in the Explorer, check it before you open it, and keep favourites close',
    importFn: () => import('@docs/guide/BROWSING_VIEWS.md?raw'),
  },
  {
    slug: 'reading-lineage',
    section: 'viewer',
    persona: 'viewer',
    title: 'Reading Lineage',
    description: 'Read entities, lines and roll-ups, and show more or less detail',
    importFn: () => import('@docs/guide/READING_LINEAGE.md?raw'),
  },
  {
    slug: 'exploring-graph',
    section: 'viewer',
    persona: 'viewer',
    title: 'Tracing Lineage on the Canvas',
    description: 'Search inside a view, trace one entity or several, narrow the result and share it as a link',
    importFn: () => import('@docs/guide/EXPLORING_GRAPH.md?raw'),
  },
  {
    slug: 'advanced-search',
    section: 'viewer',
    persona: 'viewer',
    title: 'Advanced Search',
    description: 'Find every match in a View, act on it on the canvas, and save the searches you reuse',
    importFn: () => import('@docs/guide/ADVANCED_SEARCH.md?raw'),
  },
  {
    slug: 'lineage-lens',
    section: 'viewer',
    persona: 'viewer',
    title: 'The Lineage Lens & Context View',
    description: 'Focus on one thing’s upstream and downstream — and what sits just outside the view',
    importFn: () => import('@docs/guide/LINEAGE_LENS.md?raw'),
  },
  {
    slug: 'navigating-layers',
    section: 'viewer',
    persona: 'viewer',
    title: 'Navigating Layers',
    description: 'The Layer Strip, resizable columns, load-more paging, and off-screen partners',
    importFn: () => import('@docs/guide/NAVIGATING_LAYERS.md?raw'),
  },
  {
    slug: 'requesting-access',
    section: 'viewer',
    persona: 'viewer',
    title: 'Requesting Access',
    description: 'What an access message means, how to ask for access, and where to see the answer',
    importFn: () => import('@docs/guide/REQUESTING_ACCESS.md?raw'),
  },

  // For Builders
  {
    slug: 'creating-views',
    section: 'builder',
    persona: 'builder',
    title: 'Creating Views',
    description: 'The Create New View wizard step by step: data, layout, layers and who can see it',
    importFn: () => import('@docs/guide/CREATING_VIEWS.md?raw'),
  },
  {
    slug: 'managing-views',
    section: 'builder',
    persona: 'builder',
    title: 'Managing & Sharing Views',
    description: 'Who can see a view, sharing and publishing, versions, and keeping a workspace tidy',
    importFn: () => import('@docs/guide/MANAGING_VIEWS.md?raw'),
  },
  {
    slug: 'display-rules',
    section: 'builder',
    persona: 'builder',
    title: 'Display Rules',
    description: 'Tag every entity that matches a search with a coloured chip, and share rules between Views',
    importFn: () => import('@docs/guide/DISPLAY_RULES.md?raw'),
  },
  {
    slug: 'semantic-layer',
    section: 'builder',
    persona: 'builder',
    title: 'The Semantic Layer',
    description: 'Entity and relationship types, how they look, and changing them safely',
    importFn: () => import('@docs/guide/SEMANTIC_LAYER.md?raw'),
  },

  // Versioning & Change Control
  {
    slug: 'versioning-change-control',
    section: 'versioning',
    persona: 'versioning',
    title: 'Versioning & Change Control',
    description: 'How change control works, whether it’s on for your data, and undo vs. restore',
    importFn: () => import('@docs/guide/VERSIONING_CHANGE_CONTROL.md?raw'),
  },
  {
    slug: 'editing-in-a-draft',
    section: 'versioning',
    persona: 'versioning',
    title: 'Editing in a Draft',
    description: 'Change entities and relationships privately, stage and save your edits, then publish them',
    importFn: () => import('@docs/guide/EDITING_IN_A_DRAFT.md?raw'),
  },
  {
    slug: 'review-center',
    section: 'versioning',
    persona: 'versioning',
    title: 'The Review Center',
    description: 'Find merge requests, check what they change, pull in the latest, and merge or dismiss them',
    importFn: () => import('@docs/guide/REVIEW_CENTER.md?raw'),
  },
  {
    slug: 'import-export',
    section: 'versioning',
    persona: 'versioning',
    title: 'Import & Export',
    description: 'Bulk-load or back up data through the same review flow, and move views between environments',
    importFn: () => import('@docs/guide/IMPORT_EXPORT.md?raw'),
  },

  // For Administrators
  {
    slug: 'admin-setup',
    section: 'admin',
    persona: 'admin',
    title: 'Admin Setup',
    description: 'From a fresh deployment to your team’s first view, in six checked steps',
    importFn: () => import('@docs/guide/ADMIN_SETUP.md?raw'),
  },
  {
    slug: 'workspace-admin',
    section: 'admin',
    persona: 'admin',
    title: 'Workspace Admin',
    description: 'Members, data sources, aggregation, views, profiling, reviews and ontology health',
    importFn: () => import('@docs/guide/WORKSPACE_ADMIN.md?raw'),
  },
  {
    slug: 'users-access',
    section: 'admin',
    persona: 'admin',
    title: 'Users & Access',
    description: 'Invites, accounts, roles, groups and permissions',
    importFn: () => import('@docs/guide/USERS_ACCESS.md?raw'),
  },
  {
    slug: 'sso-setup',
    section: 'admin',
    persona: 'admin',
    title: 'Single Sign-On',
    description: 'Connect an identity provider, map claims, rehearse, publish',
    importFn: () => import('@docs/guide/SSO_SETUP.md?raw'),
  },
  {
    slug: 'sso-operations',
    section: 'admin',
    persona: 'admin',
    title: 'Running Single Sign-On',
    description: 'Access rules, sign-in posture, linking, and why a sign-in failed',
    importFn: () => import('@docs/guide/SSO_OPERATIONS.md?raw'),
  },
  {
    slug: 'governance-ops',
    section: 'admin',
    persona: 'admin',
    title: 'The Admin Console',
    description: 'Every Administration page: overview, infrastructure, Redis & graph store, branding, telemetry, announcements and the audit log',
    importFn: () => import('@docs/guide/GOVERNANCE_OPS.md?raw'),
  },
  {
    slug: 'feature-switches',
    section: 'admin',
    persona: 'admin',
    title: 'Feature Switches',
    description: 'Turn capabilities on or off for everyone, what each switch does, and who notices',
    importFn: () => import('@docs/guide/FEATURE_SWITCHES.md?raw'),
  },
  {
    slug: 'data-freshness',
    section: 'admin',
    persona: 'admin',
    title: 'Data Freshness & Ingestion',
    description: 'Check that lineage is current, refresh or rebuild a source, and read the five Ingestion tabs',
    importFn: () => import('@docs/guide/DATA_FRESHNESS.md?raw'),
  },
  {
    slug: 'analytics',
    section: 'admin',
    persona: 'admin',
    title: 'Analytics',
    description: 'Who can open Analytics, what each of the six tabs answers, and what is hidden from whom',
    importFn: () => import('@docs/guide/ANALYTICS.md?raw'),
  },
  {
    slug: 'graph-store-topology',
    section: 'admin',
    persona: 'admin',
    title: 'The Graph Store: Shards, Replicas & Placement',
    description: 'What every figure on the Graph store page means, and what to do when one looks wrong',
    importFn: () => import('@docs/guide/GRAPH_STORE_TOPOLOGY.md?raw'),
  },
  {
    slug: 'rollup-capacity',
    section: 'admin',
    persona: 'admin',
    title: 'Rollup Capacity & Large Graphs',
    description: 'What a rebuild measures before it writes, the limits you set, and what "would not fit" means',
    importFn: () => import('@docs/guide/ROLLUP_CAPACITY.md?raw'),
  },

  // Reference
  {
    slug: 'ways-of-working',
    section: 'reference',
    title: 'Ways of Working',
    description: 'Team habits for naming, tagging, sharing and tidying views',
    importFn: () => import('@docs/guide/WAYS_OF_WORKING.md?raw'),
  },
  {
    slug: 'glossary',
    section: 'reference',
    title: 'Glossary & Acronyms',
    description: 'Every term and acronym, in plain language',
    importFn: () => import('@docs/guide/GLOSSARY.md?raw'),
  },
  {
    slug: 'troubleshooting',
    section: 'reference',
    title: 'Troubleshooting',
    description: 'Look up a message or symptom and see what to do',
    importFn: () => import('@docs/guide/TROUBLESHOOTING.md?raw'),
  },
]

// ── Key journeys (curated hub cards) ───────────────────────────────

export const keyJourneys: KeyJourney[] = [
  {
    title: 'Find and favourite a view',
    outcome: 'Search the Explorer and keep the views you use most one click away',
    slug: 'browsing-views',
    persona: 'viewer',
    icon: Eye,
  },
  {
    title: 'Trace a dataset’s lineage',
    outcome: 'Follow data upstream to its source and downstream to everything it affects',
    slug: 'exploring-graph',
    persona: 'viewer',
    icon: GitBranch,
  },
  {
    title: 'Focus with the Lineage Lens',
    outcome: 'Isolate one thing’s upstream and downstream — and what sits just outside the view',
    slug: 'lineage-lens',
    persona: 'viewer',
    icon: Eye,
  },
  {
    title: 'Ask for the access you need',
    outcome: 'Request a role in a workspace and follow your request until it’s answered',
    slug: 'requesting-access',
    persona: 'viewer',
    icon: KeyRound,
  },
  {
    title: 'Create a view',
    outcome: 'Build a saved view with New View: pick the data, the layout and what it shows',
    slug: 'creating-views',
    persona: 'builder',
    icon: Save,
  },
  {
    title: 'Share and co-own views',
    outcome: 'Choose who can see a view, add co-editors, and keep the collection tidy',
    slug: 'managing-views',
    persona: 'builder',
    icon: Share2,
  },
  {
    title: 'Edit data in a draft',
    outcome: 'Change entities and relationships privately, then stage and save your edits',
    slug: 'editing-in-a-draft',
    persona: 'versioning',
    icon: PenLine,
  },
  {
    title: 'Review and merge a draft',
    outcome: 'Approve, merge or dismiss a merge request — pulling in the latest changes first',
    slug: 'review-center',
    persona: 'versioning',
    icon: GitPullRequest,
  },
  {
    title: 'Undo or roll back a change',
    outcome: 'Know when to reverse one change and when to restore an earlier point',
    slug: 'versioning-change-control',
    persona: 'versioning',
    icon: History,
  },
  {
    title: 'Connect your first data source',
    outcome: 'Register a provider, onboard data sources into a workspace, and watch the first build',
    slug: 'admin-setup',
    persona: 'admin',
    icon: PlugZap,
  },
  {
    title: 'Keep data fresh',
    outcome: 'See which sources are behind, and rebuild their lineage summaries',
    slug: 'data-freshness',
    persona: 'admin',
    icon: Gauge,
  },
  {
    title: 'Turn features on or off',
    outcome: 'Decide which capabilities everyone gets, and see what each switch hides',
    slug: 'feature-switches',
    persona: 'admin',
    icon: ToggleLeft,
  },
]

// ── Quick-start preview steps (hub strip) ──────────────────────────

export const quickStartSteps: string[] = [
  'Sign in and get your bearings',
  'Pick a workspace',
  'Open a view from the Explorer',
  'Trace its lineage upstream and downstream',
  'Favourite it, or build your own with New View',
]

// ── Glossary chips (hub acronym strip) ─────────────────────────────

export const glossaryChips: GlossaryChip[] = [
  { term: 'Lineage', full: 'How data flows from source to use' },
  { term: 'View', full: 'One saved, curated canvas' },
  { term: 'Explorer', full: 'The catalogue of saved views' },
  { term: 'Ontology', full: 'The semantic layer — what data means' },
  { term: 'Workspace', full: 'A team’s or project’s space' },
  { term: 'Upstream', full: 'Where data comes from' },
  { term: 'Downstream', full: 'What data feeds' },
  { term: 'Impact', full: 'Everything downstream a change could affect' },
  { term: 'RBAC', full: 'Role-Based Access Control' },
  { term: 'Provider', full: 'A connection to a graph database' },
]

// ── Hub: jobs-first entry ──────────────────────────────────────────

/** A goal-phrased card in the hub's "What do you want to do?" row. */
export interface TopJob {
  title: string
  outcome: string
  slug: string
  icon: LucideIcon
}

// Jobs-first entry: the hub leads with what people are trying to DO, phrased as
// goals, each routing straight to the article that gets them there.
export const topJobs: TopJob[] = [
  { title: 'See what a change will break', outcome: 'Trace a dataset downstream to everything it feeds', slug: 'exploring-graph', icon: Network },
  { title: 'Find the right view', outcome: 'Search the Explorer and favourite the views you use most', slug: 'browsing-views', icon: Eye },
  { title: 'Build and share a view', outcome: 'Create a view with New View and choose who can see it', slug: 'creating-views', icon: Share2 },
  { title: 'Get access I don’t have', outcome: 'Request a role in a workspace and follow your request', slug: 'requesting-access', icon: KeyRound },
  { title: 'Fix something that isn’t working', outcome: 'Look up a message or symptom and see what to do', slug: 'troubleshooting', icon: LifeBuoy },
  { title: 'Give someone the right access', outcome: 'Invite people and grant exactly the access they need', slug: 'users-access', icon: Users },
]

// ── Hub FAQs ───────────────────────────────────────────────────────

export const guideFaqs: GuideFAQ[] = [
  {
    category: 'Getting started',
    question: 'I’m new — where should I begin?',
    answer:
      'Start with [Key Concepts](/guide/key-concepts) for the vocabulary, then follow the [Quick Start](/guide/quick-start) in a real workspace — it takes you from signing in to tracing your first lineage.',
  },
  {
    category: 'Getting started',
    question: 'Do I need to be an engineer to use {brand}?',
    answer:
      'No. Finding, reading and tracing lineage, and building views, all happen in the browser without code; connecting data is an administrator’s job, done through guided wizards — see [Welcome to {brand}](/guide/welcome).',
  },
  {
    category: 'Using {brand}',
    question: 'What’s the difference between a View and the Explorer?',
    answer:
      'A **View** is one saved, curated canvas built on a data source. The **Explorer** — **Explore** in the sidebar — is the catalogue of every view you can open, across your workspaces, where you search, filter and favourite them; see [Finding Views](/guide/browsing-views).',
  },
  {
    category: 'Using {brand}',
    question: 'Can I break anything by clicking around?',
    answer:
      'No. Reading, searching and tracing never change data, and changes to the data go into your own private draft — nothing reaches the published version until it’s reviewed or published; see [Versioning & Change Control](/guide/versioning-change-control).',
  },
  {
    category: 'Using {brand}',
    question: 'What does “Taking a little longer than usual” mean?',
    answer:
      'The server is busy — it runs a limited number of graph reads at once and asks your browser to try again shortly — or a query ran past its time limit. Nothing is lost: the view retries by itself, or you can select **Retry now**; see [Troubleshooting](/guide/troubleshooting#a-view-keeps-saying-taking-a-little-longer-than-usual).',
  },
  {
    category: 'Using {brand}',
    question: 'Is the data I’m looking at up to date?',
    answer:
      'Check the chip next to the data source’s name in the view’s header: **In sync · v12** means current, while a chip such as **1 version behind** or **Refresh failed · 1 version behind** means it isn’t — select it to see when each step last happened. See [Data Freshness & Ingestion](/guide/data-freshness).',
  },
  {
    category: 'Using {brand}',
    question: 'Can I share a trace with someone?',
    answer:
      'Yes. While a trace is open in a Context View, select **Share** in the trace dock, then **Copy link** — anyone who can open the view can open the link, and it re-runs against today’s lineage; see [Tracing Lineage on the Canvas](/guide/exploring-graph).',
  },
  {
    category: 'Access',
    question: 'Why can’t I see a View someone shared?',
    answer:
      'Check your **Inbox** and the Explorer’s **Shared** filter first; if it’s not there, its visibility may not include you, so ask the owner to check **Share**. See [I can’t find a View someone shared with me](/guide/troubleshooting#i-cant-find-a-view-someone-shared-with-me).',
  },
  {
    category: 'Access',
    question: 'How do I find out what I’m allowed to do?',
    answer:
      'Open the avatar menu at the top right and select **My access** — it lists your roles, what they let you do, and any access requests you’ve made; see [Users & Access](/guide/users-access).',
  },
  {
    category: 'Access',
    question: 'How do I get access to a workspace I can’t open?',
    answer:
      'When an **Access denied** card offers **Request access**, choose a role, add a reason if you like, and select **Submit request**. The workspace admin reviews it, and you can follow it under **My access requests** on your **My access** page — see [Requesting Access](/guide/requesting-access).',
  },
  {
    category: 'Using {brand}',
    question: 'I published a mistake — how do I fix it?',
    answer:
      'Select **Reviews** in the view’s header to open its history, then open the change’s **⋯** menu: **Undo just this change** reverses it and keeps everything since, while **Restore graph to here** rolls back everything after it. Both add a new revision instead of erasing anything (only people who manage the data source see these actions) — see [Versioning & Change Control](/guide/versioning-change-control).',
  },
  {
    category: 'Using {brand}',
    question: 'Can I bulk-load data from a spreadsheet?',
    answer:
      'Yes. In a draft, open **Import / Export** in a Context View’s header and choose **Import…** (Excel, CSV, TSV, NDJSON or JSON) — the changes land in your draft for review, and nothing reaches the published version until you publish; see [Import & Export](/guide/import-export).',
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
