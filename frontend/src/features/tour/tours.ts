import { Sparkles, DatabaseZap, Compass, Boxes, Workflow, Import, Layers, GitPullRequestArrow, Focus } from 'lucide-react'
import type { TourDefinition } from './types'

/**
 * Product tours. Each step spotlights a real element by CSS selector — we anchor
 * on `data-tour="…"` attributes so refactors don't silently break a tour. Steps
 * with no target render as a centered card (intro / outro).
 */
export const TOURS: TourDefinition[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    description: 'A two-minute lap around the workspace — search, navigation, personas, and help.',
    icon: Sparkles,
    estimate: '2 min',
    steps: [
      {
        title: 'Welcome aboard 👋',
        body: "Here's a quick lap around the workspace. It takes about two minutes — you can leave any time with **Esc**.",
      },
      {
        target: '[data-tour="search"]',
        placement: 'bottom',
        title: 'Find anything, fast',
        body: 'Jump to any workspace, view, or data source from here — or press **⌘K** from anywhere.',
      },
      {
        target: '[data-tour="nav"]',
        placement: 'right',
        title: 'Get around',
        body: 'Your workspaces, data sources, and views live in the sidebar. This is home base.',
      },
      {
        target: '[data-tour="persona"]',
        placement: 'bottom',
        title: 'Business or technical?',
        body: 'Flip between a **business** and a **technical** lens — the same graph, described in the language that suits you.',
      },
      {
        target: '[data-tour="help"]',
        placement: 'bottom',
        title: 'Help is always here',
        body: 'Open the Help panel to search the docs and read guides without leaving your work. Press **?** any time.',
      },
      {
        title: "You're all set",
        body: 'That’s the tour. Open the **Help** panel whenever you want to take it again or dive into the guides.',
      },
    ],
  },
]

TOURS.push(
  {
    id: 'admin-setup',
    title: 'Set up the platform',
    description: 'The path from an empty install to a browsable graph: connect a source, discover assets, make a workspace, and add meaning.',
    icon: DatabaseZap,
    estimate: '3 min',
    steps: [
      {
        title: 'From empty to insight',
        body: "Four steps take a fresh install to a graph your team can explore. Here's the path — you can leave any time with **Esc**.",
      },
      {
        target: '[data-tour="nav-ingestion"]',
        route: '/ingestion',
        placement: 'right',
        title: '1 · Connect a source',
        body: 'Start in **Ingestion**: point the platform at a graph database (FalkorDB, Neo4j, DataHub) and test the connection.',
      },
      {
        route: '/ingestion',
        title: '2 · Discover assets',
        body: 'Once connected, the platform catalogues the graphs it finds. Register the ones you want to work with as **data sources**.',
      },
      {
        target: '[data-tour="nav-workspaces"]',
        route: '/workspaces',
        placement: 'right',
        title: '3 · Create a workspace',
        body: 'A **workspace** binds a data source to the people and settings that govern it — your unit of isolation and access.',
      },
      {
        target: '[data-tour="nav-schema"]',
        route: '/schema',
        placement: 'right',
        title: '4 · Add meaning',
        body: 'Assign a **semantic layer** (ontology): node types, colours, and business context that make the raw graph readable.',
      },
      {
        title: "That's the setup",
        body: 'With a source, a workspace, and a semantic layer in place, your team can start exploring lineage. Open **Help** to replay any tour.',
      },
    ],
  },
  {
    id: 'explore-lineage',
    title: 'Explore lineage',
    description: 'Find a starting point and trace how data flows — upstream, downstream, and the blast radius of a change.',
    icon: Compass,
    estimate: '2 min',
    steps: [
      {
        title: 'Follow the data',
        body: 'Lineage answers "where did this come from?" and "what breaks if I change it?". Here’s how to read it — leave any time with **Esc**.',
      },
      {
        target: '[data-tour="nav-explore"]',
        route: '/explorer',
        placement: 'right',
        title: 'Open the Explorer',
        body: 'The **Explorer** is home to every saved view across your workspaces.',
      },
      {
        target: '[data-tour="explorer-results"]',
        route: '/explorer',
        placement: 'top',
        title: 'Every view, one place',
        body: 'Saved views live here. **Open one** to land on the interactive lineage canvas.',
      },
      {
        target: '[data-tour="explorer-search"]',
        route: '/explorer',
        placement: 'bottom',
        title: 'Find the right view',
        body: 'Search across every view by **name, tag, or workspace** to jump straight to it.',
      },
      {
        target: '[data-tour="explorer-filters"]',
        route: '/explorer',
        placement: 'bottom',
        title: 'Filter the list',
        body: 'Narrow to **Favorites**, **Recent**, **Shared**, or views that **need attention**.',
      },
      {
        target: '[data-tour="explorer-new-view"]',
        route: '/explorer',
        placement: 'left',
        title: 'Start something new',
        body: 'Build a brand-new view from scratch with **New View**.',
      },
      {
        title: 'Trace the flow',
        body: 'Open a view, click any node, and **Trace** to light up everything upstream and downstream — its blast radius.',
      },
      {
        title: 'Go deeper',
        body: 'The **Reading Lineage** guide has an interactive demo you can click through. Open **Help** to find it.',
      },
    ],
  },
  {
    id: 'workspaces',
    title: 'Organise with workspaces',
    description: 'Group data sources, govern access, and give each team its own space.',
    icon: Boxes,
    estimate: '2 min',
    steps: [
      {
        title: "Your team's spaces",
        body: "A **workspace** keeps one team's data sources, people, and settings isolated. Here's how to work with them — leave any time with **Esc**.",
      },
      {
        target: '[data-tour="nav-workspaces"]',
        route: '/workspaces',
        placement: 'right',
        title: 'Open Workspaces',
        body: 'Every workspace you can access lives here.',
      },
      {
        target: '[data-tour="workspaces-create"]',
        route: '/workspaces',
        placement: 'bottom',
        title: 'Create a workspace',
        body: 'Spin up a new workspace and bind it to the data sources it should contain.',
      },
      {
        target: '[data-tour="workspaces-toolbar"]',
        route: '/workspaces',
        placement: 'bottom',
        title: 'Find & organise',
        body: 'Search, filter by **health**, sort, and switch between grid and list.',
      },
      {
        title: 'Inside a workspace',
        body: 'Open any workspace to manage its **data sources**, **views**, **ontology**, **members**, and **reviews** — each on its own tab.',
      },
      {
        title: "That's workspaces",
        body: 'With a workspace in place, your team has an isolated home to explore lineage together. Open **Help** to replay any tour.',
      },
    ],
  },
  {
    id: 'canvas-lineage',
    title: 'Read the lineage canvas',
    description: 'Search, trace, and tune the view — a lap around the canvas toolbar.',
    icon: Workflow,
    estimate: '2 min',
    // Only works on an open view (`/views/:id`); its targets live in the canvas
    // header. Offered from the canvas itself and from Help while you're here.
    contextual: true,
    contextPathPrefix: '/views/',
    steps: [
      {
        title: 'Make sense of the graph',
        body: "You're looking at a **view** — a slice of the graph. These toolbar controls help you read it. Leave any time with **Esc**.",
      },
      {
        target: '[data-tour="canvas-search"]',
        placement: 'bottom',
        title: 'Find a node',
        body: 'Search the view for any table, dataset, or dashboard and jump straight to it on the canvas.',
      },
      {
        target: '[data-tour="canvas-lineage-toggle"]',
        placement: 'bottom',
        title: 'Show the lineage mesh',
        body: 'Toggle the **Lineage** overlay to draw how data flows between the nodes on screen.',
      },
      {
        target: '[data-tour="canvas-trace"]',
        placement: 'bottom',
        title: 'Trace a node',
        body: 'Select a node and **Trace Lineage** to light up everything upstream and downstream — its blast radius. Set the depth once a trace is running.',
      },
      {
        target: '[data-tour="canvas-display"]',
        placement: 'bottom',
        title: 'Tune the display',
        body: 'Open **Display** to adjust zoom, density, edge direction, and how lineage is drawn — the canvas your way.',
      },
      {
        title: "You've got the canvas",
        body: 'Search to find, Trace to follow, Display to tune. Open **Help** to replay this any time.',
      },
    ],
  },
  {
    id: 'ingestion',
    title: 'Connect your data',
    description: 'Point the platform at a graph database, verify the connection, and register the assets you want to work with.',
    icon: Import,
    estimate: '2 min',
    steps: [
      {
        title: 'Bring data in',
        body: 'Ingestion is where raw graphs become **data sources** your team can use. Here’s the path — leave any time with **Esc**.',
      },
      {
        target: '[data-tour="ingestion-tabs"]',
        route: '/ingestion',
        placement: 'bottom',
        title: 'Three stages, three tabs',
        body: 'Work left to right: connect **Providers**, register **Data Sources**, then watch **Job History** as the platform ingests them.',
      },
      {
        target: '[data-tour="ingestion-connect"]',
        route: '/ingestion?tab=providers',
        placement: 'bottom',
        title: '1 · Connect & test a provider',
        body: 'Register a graph database (FalkorDB, Neo4j, DataHub) and **Test** the connection before going further.',
      },
      {
        target: '[data-tour="ingestion-assets"]',
        route: '/ingestion?tab=assets',
        placement: 'right',
        title: '2 · Discover & register assets',
        body: 'Pick a provider to see the graphs it exposes, then **register** the ones you want as data sources.',
      },
      {
        title: "That's ingestion",
        body: 'Connected, registered, and ingesting. Next, bind these sources to a **workspace**. Open **Help** to replay any tour.',
      },
    ],
  },
  {
    id: 'semantic-layers',
    title: 'Add meaning with semantic layers',
    description: 'Model entity types and colours, then assign a semantic layer to each data source to make the raw graph readable.',
    icon: Layers,
    estimate: '2 min',
    steps: [
      {
        title: 'From raw graph to readable',
        body: 'A **semantic layer** (ontology) gives raw nodes and edges business meaning — types, colours, and hierarchy. Leave any time with **Esc**.',
      },
      {
        target: '[data-tour="schema-sidebar"]',
        route: '/schema',
        placement: 'right',
        title: 'Every layer, one place',
        body: 'Your semantic layers live here. **Select one** to inspect it, or start a new draft from scratch.',
      },
      {
        title: 'Model your types',
        body: "Inside a layer, the **Schema** tab is where you define **entity & relationship types** and give each a **colour** and description — the vocabulary of your graph.",
      },
      {
        target: '[data-tour="schema-dashboard"]',
        route: '/schema',
        placement: 'bottom',
        title: 'Assign it to data sources',
        body: 'The **Deployment Dashboard** binds each data source to a semantic layer — that’s what turns raw graphs into a governed, readable model.',
      },
      {
        title: "That's semantic layers",
        body: 'Model once, assign anywhere. Publish a layer and every view on those sources picks it up. Open **Help** to replay any tour.',
      },
    ],
  },
  {
    id: 'reviews',
    title: 'Review & merge changes',
    description: 'How drafts become reviewed, approved, and merged — a lap around the Review Center.',
    icon: GitPullRequestArrow,
    estimate: '2 min',
    // Reviews live at the workspace-scoped route /workspaces/:wsId/reviews, which has
    // no static path a route-step could navigate to. Offered from the reviews surface
    // itself and from Help while you're anywhere under /workspaces/.
    contextual: true,
    contextPathPrefix: '/workspaces/',
    steps: [
      {
        title: 'Changes, reviewed',
        body: 'Edits are **drafted**, opened as a merge request, **reviewed**, then **merged** — like a pull request for your graph. Leave any time with **Esc**.',
      },
      {
        target: '[data-tour="reviews-stats"]',
        placement: 'bottom',
        title: 'The state of play',
        body: 'See at a glance what’s **open**, **ready to merge**, **needs attention**, or **raised by you** — click a card to filter to it.',
      },
      {
        target: '[data-tour="reviews-list"]',
        placement: 'top',
        title: 'Every request',
        body: 'Each row is a proposed change. **Open one** to read its diff, leave feedback, approve, and merge.',
      },
      {
        target: '[data-tour="reviews-filters"]',
        placement: 'bottom',
        title: 'Find the right one',
        body: 'Narrow by **scope**, **author**, or **source**, or search by title and branch.',
      },
      {
        title: 'Approve & merge',
        body: 'Opening a request shows the full **diff** with approve and merge controls — nothing lands until it’s reviewed.',
      },
      {
        title: "That's reviews",
        body: 'Draft, review, merge — changes ship safely and with a trail. Open **Help** to replay this any time.',
      },
    ],
  },
)

TOURS.push({
  id: 'lineage-lens',
  title: 'Explore lineage in Focus mode',
  description: 'Walk an entity\'s lineage interactively — inspect, focus, expand hop by hop, and share what you find.',
  icon: Focus,
  estimate: '2 min',
  // Targets live inside the open Lens dialog on a view canvas. Offered
  // automatically the first time the graph body opens, and from Help
  // while you're on a view.
  contextual: true,
  contextPathPrefix: '/views/',
  steps: [
    {
      title: 'Focus mode',
      body: 'Everything that touches **one entity** — sources on the left, consumers on the right, rolled up so busy entities stay readable. Leave any time with **Esc**.',
    },
    {
      target: '[data-tour="lens-graph"]',
      placement: 'top',
      padding: -8,
      title: 'Explore the lineage',
      body: '**Click** a card to inspect it. **Double-click** to focus there. **Hover** a card\'s edge for its follow control — "Load upstream", "Show 3 more sources" — and click to grow the board from exactly that entity. The **chevron** opens what\'s inside a card, at any depth, instantly. **Drag** any card to arrange the picture — the connections follow it.',
    },
    {
      target: '[data-tour="lens-children-mode"]',
      placement: 'bottom',
      title: 'Open a container your way',
      body: 'Opening a table or platform shows just the parts that **connect** to your focus. Switch to **All** to see everything it holds — every column stays listed, with the ones carrying lineage highlighted in place.',
    },
    {
      target: '[data-tour="lens-graph"]',
      placement: 'top',
      padding: -8,
      title: 'Browse what a container holds',
      body: 'An open container is a **scrollable list**: spin the wheel over it and a 400-column table moves under a fixed frame, fetching more as you reach the end — the header keeps saying which rows you are on. **Click** any row for a preview beside it, with what it is, what flows through it, and where you can go next. Prefer the keyboard? **Tab** into the list, then **↑ ↓** to walk it, **Enter** to preview, **Shift+Enter** to focus there, **→** to open a row, **←** to step back out — and just **start typing** to jump to a name.',
    },
    {
      target: '[data-tour="lens-depth"]',
      placement: 'bottom',
      title: 'Set how far you reach',
      body: 'The **1 / 2 / 3** control sets how many hops a *newly* focused entity fetches. Further along the same row, **Both / Root cause / Impact** narrows the picture to just what feeds this entity or just what it feeds — instantly, with nothing new to fetch.',
    },
    {
      target: '[data-tour="lens-toggle"]',
      placement: 'bottom',
      title: 'Two ways to read it',
      body: 'Prefer scanning to exploring? Switch to the **List** columns any time — the Lens remembers your choice.',
    },
    {
      title: 'See the path, take it with you',
      body: 'Hover or click any card to spotlight its lineage on the board. Click it to stick, and a chip at the bottom states exactly what it knows — drawn versus known — with a button to follow further and one to focus there. When you\'re ready to hand it off, the corner controls save the picture as a **PNG**, or the data itself as **JSON** or **CSV**.',
    },
    {
      target: '[data-tour="lens-share"]',
      placement: 'bottom',
      title: 'Share what you found',
      body: 'Copy a link that reopens this exact exploration — the walked path, everything you expanded, and your depth and direction settings — for a colleague.',
    },
    {
      title: 'Retrace any time',
      body: 'Every focus is recorded: **← / →** step back and forward, and the **Path** trail jumps anywhere you\'ve been. The **(?)** icon in the header has the full gesture list any time.',
    },
  ],
})

export function getTour(id: string): TourDefinition | undefined {
  return TOURS.find((t) => t.id === id)
}

/** The tour offered to first-time users (once the feature is enabled). */
export const FIRST_RUN_TOUR = 'getting-started'
