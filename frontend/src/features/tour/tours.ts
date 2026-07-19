import { Sparkles, DatabaseZap, Compass, Boxes, Workflow } from 'lucide-react'
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
)

export function getTour(id: string): TourDefinition | undefined {
  return TOURS.find((t) => t.id === id)
}

/** The tour offered to first-time users (once the feature is enabled). */
export const FIRST_RUN_TOUR = 'getting-started'
