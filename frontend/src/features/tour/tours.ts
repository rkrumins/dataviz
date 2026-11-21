import { Sparkles, DatabaseZap, Compass, Boxes, Workflow, Import, Layers, GitPullRequestArrow, Focus, FlaskConical, Rocket, Building2 } from 'lucide-react'
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
        body: '**Business** keeps to the essentials: fewer tools, plain names, the rest a click away under **More**. **Technical** shows every tool and each entity’s identifier. Same graph, either way.',
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
        body: 'Open any workspace and it starts on its **Overview**: what needs you, the views you use, and the workspace at a glance. Its **views**, **data**, **reviews** and **people** each have a tab.',
      },
      {
        title: "That's workspaces",
        body: 'With a workspace in place, your team has an isolated home to explore lineage together. Open **Help** to replay any tour.',
      },
    ],
  },
  {
    id: 'workspace-detail',
    title: 'Find your way around a workspace',
    description: 'What a workspace shows you first, and where everything else lives.',
    icon: Boxes,
    estimate: '1 min',
    // Lives on /workspaces/:wsId, which has no static path to navigate to. Offered
    // from the workspace's own header, and from Help while you're under /workspaces/.
    contextual: true,
    contextPathPrefix: '/workspaces/',
    steps: [
      {
        title: 'A workspace, at a glance',
        body: 'Each workspace opens on its **Overview** — built for using it, not configuring it. Leave any time with **Esc**.',
      },
      {
        target: '[data-tour="workspace-health"]',
        placement: 'bottom',
        title: 'Can I use it right now?',
        body: 'Its health, said as a sentence. If something needs fixing and you can fix it, the link takes you straight there.',
      },
      {
        target: '[data-tour="workspace-actions"]',
        placement: 'bottom',
        title: 'The way in',
        body: '**Explore views** opens everything built here. If you can create views, **New view** starts one in this workspace.',
      },
      {
        target: '[data-tour="workspace-attention"]',
        placement: 'bottom',
        title: 'What needs you',
        body: 'Reviews asking for you, people asking to join, a source that needs a look — only what is yours to act on.',
      },
      {
        target: '[data-tour="workspace-tabs"]',
        placement: 'bottom',
        title: 'Everything else',
        body: '**Views** to browse, **Data** for where it comes from and how fresh it is, **Reviews** for proposed changes — and, for the people who run it, **People** and **Settings**.',
      },
      {
        title: 'Business or Technical',
        body: 'Want identifiers, projection modes and raw errors? Switch to the **Technical** view at the top of the app — the same page, with every detail showing.',
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
        body: 'Open **Display** to adjust zoom, density and how lineage is drawn — the canvas your way.',
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
        title: 'Three stages, left to right',
        body: 'Connect **Providers**, register **Data Sources**, then watch **Job History** as the platform ingests them. **Freshness** and **Profiling** show how current and how big the data is once it’s in.',
      },
      {
        target: '[data-tour="ingestion-connect"]',
        route: '/ingestion?tab=providers',
        placement: 'bottom',
        title: '1 · Connect & test a provider',
        body: 'Register a graph database (FalkorDB, Neo4j, Spanner, DataHub) and **Test** the connection before going further.',
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
    // Offered from the Review Center (/reviews) itself and from Help while you're there;
    // its steps point at the queues, filters and list it shares with a workspace's Reviews tab.
    contextual: true,
    contextPathPrefix: '/reviews',
    steps: [
      {
        title: 'Changes, reviewed',
        body: 'Edits are **drafted**, opened as a merge request, **reviewed**, then **merged** — like a pull request for your graph. Leave any time with **Esc**.',
      },
      {
        target: '[data-tour="reviews-queues"]',
        placement: 'right',
        title: 'Who it waits on',
        body: 'What **needs your review**, **your own requests** — waiting, sent back, ready to merge — and **everything open**, each with its count, and a dot while something in it is new.',
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
        body: 'Narrow by **data source** or **author**, search titles and descriptions, and order by **last activity** or when it was **opened**.',
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
      body: 'The whole immediate lineage loads by itself — the capsule at the top says where the walk stands. **Click** a card to inspect it. **Double-click** to focus there. **Hover** a card\'s edge for its follow control — "Load upstream" — and click to grow the board from exactly that entity. The **chevron** opens what\'s inside a card, at any depth, instantly. **Drag** any card to arrange the picture — the connections follow it; **Center on focus** beside the name brings you back, and the board offers it by itself if the focus leaves the screen.',
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
      target: '[data-tour="lens-direction"]',
      placement: 'bottom',
      title: 'Narrow the view',
      body: '**Both / Root cause / Impact** narrows the picture to just what feeds this entity or just what it feeds — instantly, with nothing new to fetch.',
    },
    {
      target: '[data-tour="lens-density"]',
      placement: 'bottom',
      title: 'Choose the grain',
      body: 'Partners that share a container fold into it — five tables under one database are one frame. **Overview** lands those containers closed with their counts, **Grouped** opens them to their strongest rows, **Every card** folds nothing. The numbers are the same at every rung; it is your preference, and it follows you.',
    },
    {
      title: 'See the path, take it with you',
      body: 'Hover or click any card to spotlight its lineage on the board. Click it to stick, and a chip at the bottom states exactly what it knows — drawn versus known — with a button to follow further and one to focus there. When you\'re ready to hand it off, the corner controls save the picture as a **PNG**, or the data itself as **JSON** or **CSV**.',
    },
    {
      target: '[data-tour="lens-share"]',
      placement: 'bottom',
      title: 'Share what you found',
      body: 'Copy a link that reopens this exact exploration — the walked path, everything you expanded, and your direction setting — for a colleague.',
    },
    {
      title: 'Retrace any time',
      body: 'Every focus is recorded: **← / →** step back and forward, and the **Path** trail jumps anywhere you\'ve been. The **(?)** icon in the header has the full gesture list any time.',
    },
  ],
})

// The self-service paths: the Playground, asking for a workspace, and answering those asks.
TOURS.push(
  {
    id: 'playground',
    title: 'Find your way around the Playground',
    description: 'Your experiments, how many more you can start, what everyone else made — and the way to a workspace of your own.',
    icon: FlaskConical,
    estimate: '1 min',
    // The Playground is a workspace page (/workspaces/<its id>): its ribbon tells it
    // apart from every other workspace. Offered from its own header, and from Help there.
    contextual: true,
    contextPathPrefix: '/workspaces/',
    contextAnchor: '[data-tour="playground-ribbon"]',
    steps: [
      {
        title: 'Welcome to the Playground',
        body: 'A common area for trying ideas: build graphs of your own, explore them in views, and see what others made. Leave any time with **Esc**.',
      },
      {
        target: '[data-tour="playground-ribbon"]',
        placement: 'bottom',
        padding: 2,
        title: 'Not production',
        body: 'Nothing here is production data, and nothing you do here changes it — so **experiment freely**.',
      },
      {
        target: '[data-tour="playground-experiments"]',
        placement: 'right',
        title: 'Your experiments',
        body: 'The graphs you started and the views you built. The meter counts your graphs against your **quota** — delete one you’re done with to start another. Experiments don’t expire.',
      },
      {
        target: '[data-tour="playground-new-graph"]',
        placement: 'left',
        title: 'Start a new graph',
        body: 'Pick a **starter data model** and you have a blank graph of your own — draw on the canvas, or bring things in from a file.',
      },
      {
        target: '[data-tour="playground-everyone"]',
        placement: 'top',
        title: 'Everyone’s experiments',
        body: 'The latest from everyone else here. **Open one** for ideas — only the person who made it can change it.',
      },
      {
        target: '[data-tour="overview-layout"]',
        placement: 'bottom',
        title: 'Your layout',
        body: 'Show views as **Compact**, **Cards** or a **List** — whichever reads best. It remembers your choice.',
      },
      {
        target: '[data-tour="workspace-request"]',
        placement: 'top',
        title: 'Ready for a workspace of your own?',
        body: 'When an experiment outgrows the Playground, **ask for a workspace** of its own — the graphs you built here come with it, and you’ll run it.',
      },
      {
        title: 'Happy experimenting',
        body: 'Build, explore, share. Open **Help** to replay this tour any time.',
      },
    ],
  },
  {
    id: 'request-workspace',
    title: 'Get a workspace of your own',
    description: 'Ask the platform team for a workspace, try ideas in the Playground meanwhile, and follow your request.',
    icon: Rocket,
    estimate: '1 min',
    // For people who can't create workspaces: offered while the Request a workspace
    // button is on the page. Its first step opens Workspaces, so Getting started can launch it.
    contextual: true,
    contextPathPrefix: '/workspaces',
    contextAnchor: '[data-tour="workspaces-request"]',
    steps: [
      {
        route: '/workspaces?tab=mine',
        title: 'A workspace of your own',
        body: 'Workspaces are made by the platform team — but you can **ask for one**, and try your ideas in the Playground while you wait. Leave any time with **Esc**.',
      },
      {
        target: '[data-tour="workspaces-request"]',
        placement: 'bottom',
        title: 'Request a workspace',
        body: 'A short guided form: what it’s for, who it’s for, and the teammates to bring. Once it’s approved, **you’ll be its admin**.',
      },
      {
        target: '[data-tour="playground-card"]',
        placement: 'bottom',
        title: 'Try it in the Playground first',
        body: 'Build graphs of your own and explore them, apart from production. **What you build there can come with you** to your new workspace.',
      },
      {
        target: '[data-tour="workspace-request"]',
        placement: 'bottom',
        title: 'Where your request stands',
        body: 'Before you ask, this card is the way in. Once you have, it follows your request — **Sent → Reviewed → Ready** — and if the platform team has a question, you answer it here.',
      },
      {
        title: 'You know the way',
        body: 'Ask when you’re ready — your **Inbox** tells you when it’s answered. Open **Help** to replay this tour.',
      },
    ],
  },
  {
    id: 'workspace-approver',
    title: 'Answer workspace requests',
    description: 'Who is asking for a workspace and why — and how to approve, send back or decline.',
    icon: Building2,
    estimate: '1 min',
    // On Workspaces → Requests, for the people who create workspaces, while requests wait there.
    contextual: true,
    contextPathPrefix: '/workspaces',
    contextAnchor: '[data-tour="workspace-requests-queue"]',
    steps: [
      {
        route: '/workspaces?tab=requests',
        title: 'Requests for new workspaces',
        body: 'People who can’t create workspaces ask for them here, and you answer. Leave any time with **Esc**.',
      },
      {
        target: '[data-tour="workspace-requests-queue"]',
        placement: 'bottom',
        title: 'Who is waiting',
        body: 'Who asked, what it’s for, what comes with it — teammates, groups, graphs from the Playground — and **how long they’ve waited**. **Waiting** is what needs you; **All** includes what’s been answered.',
      },
      {
        target: '[data-tour="workspace-request-review"]',
        placement: 'left',
        title: 'Review',
        body: 'Opens the whole request — its purpose, its people, the data it needs — beside the list.',
      },
      {
        title: 'Approve, send back, or decline',
        body: '**Approve** shows exactly what will be made before it is, and lets you tidy the name first. **Send back** asks the requester a question. **Decline** says why.',
      },
      {
        title: 'Requests, answered',
        body: 'The requester hears in their **Inbox** either way. Open **Help** to replay this tour.',
      },
    ],
  },
)

export function getTour(id: string): TourDefinition | undefined {
  return TOURS.find((t) => t.id === id)
}

/**
 * Is this tour offered from Help on the page the reader is on? A contextual tour
 * only on its own surface: under its path, and — when it names one — while its
 * anchor is on the page.
 */
export function isTourOffered(tour: TourDefinition, pathname: string, doc: ParentNode = document): boolean {
  if (!tour.contextual) return true
  if (!tour.contextPathPrefix || !pathname.startsWith(tour.contextPathPrefix)) return false
  return !tour.contextAnchor || doc.querySelector(tour.contextAnchor) !== null
}

/** The tour offered to first-time users (once the feature is enabled). */
export const FIRST_RUN_TOUR = 'getting-started'
