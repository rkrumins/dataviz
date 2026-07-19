import { Sparkles, DatabaseZap, Compass } from 'lucide-react'
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
        body: 'Lineage answers "where did this come from?" and "what breaks if I change it?". Here’s how to read it.',
      },
      {
        target: '[data-tour="nav-explore"]',
        route: '/explorer',
        placement: 'right',
        title: 'Open the Explorer',
        body: 'The **Explorer** is where saved views live. Open one to land on the interactive canvas.',
      },
      {
        target: '[data-tour="search"]',
        placement: 'bottom',
        title: 'Find a starting point',
        body: 'Search for any table, dataset, or dashboard to jump straight to it on the graph — or press **⌘K**.',
      },
      {
        title: 'Trace it',
        body: 'Click a node and **Trace** to light up everything that feeds it (upstream) and everything it feeds (downstream) — its blast radius.',
      },
      {
        title: 'Go deeper',
        body: 'The **Reading Lineage** guide has an interactive demo you can click through. Open **Help** to find it.',
      },
    ],
  },
)

export function getTour(id: string): TourDefinition | undefined {
  return TOURS.find((t) => t.id === id)
}

/** The tour offered to first-time users (once the feature is enabled). */
export const FIRST_RUN_TOUR = 'getting-started'
