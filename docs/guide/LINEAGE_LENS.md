# The Lineage Lens & Context View

*For Viewers.* On a busy canvas, a single entity can have more connections
than you can comfortably read at a glance. The **Lineage Lens** solves this:
focus one entity and its lineage is laid out for you — upstream sources on
the left, downstream consumers on the right — walkable one hop at a time,
and openable one containment level at a time, however deep your estate goes.

Here you'll learn to:

- **Open the Lens** from a dense node, the Anchor Rail, or a curated View.
- **Read the picture** — real connections first, rolled-up summaries where
  that's all that exists, hierarchy drawn as frames and breadcrumbs.
- **Walk the lineage** hop by hop in either direction, with Back/Forward
  retracing every step.
- **Open what's inside** anything — and keep going: children of children,
  lineage of a child, children of a partner.
- **Drill a rolled-up connection** into the concrete connections it stands
  for.
- **Share the exploration** as a link that reopens the same picture.

## What the Lens shows

The Lens opens as a near-fullscreen focus room over the canvas. The entity
you focused sits in the middle with its full location breadcrumb
(`⌂ Domain › Platform › Schema`) — each level clickable to re-focus there.
Its **real direct lineage** fans out around it: data flows **left to right**,
sources upstream, consumers downstream, with each wire labelled by its
relationship name from your ontology.

Hierarchy is never flattened away:

- Partners that live inside the same parent are drawn **inside a frame named
  for that parent** — a column is never a loose peer of its own table.
- Coarse partners whose lineage exists only as a **rolled-up summary** appear
  as one card with a dashed wire and an **×N** count — one click shows the
  concrete connections underneath.
- Every card, at every depth, carries the same gestures. Nothing dead-ends.

The focal card shows its measured in/out degree and, once measured, its
**reach** — how many distinct entities it touches transitively upstream and
downstream ("Reaches 12 upstream · 47 downstream"). A truncated measurement
shows as a floor ("47+"); the Lens never invents a number. An entity with no
lineage in a direction says so plainly ("No upstream lineage in the data
source") — only once that is actually known.

## The gestures

Everything in the Lens is one of four gestures, available on every card:

- **⊕ (per direction)** — fetch that entity's next hop of lineage. When a
  degree has been measured, the pill says how much more there is (**+12**);
  unknown shows no number, never a made-up zero. There is **no hop limit** —
  the picture grows sideways as far as you walk, and the camera follows
  what arrived. The upstream ⊕ sits on the card's left edge, the downstream
  ⊕ on its right — the gestures live where their answers land.
- **› (chevron)** — open what the entity contains. On a **rolled-up
  partner** it opens *connected only*: exactly the contents the visible
  lineage reaches, drilled straight from the wires — focus a Domain with a
  rolled-up connection to another Domain, open it, and you see precisely
  the applications your side touches; open one of those and you see its
  datasets, as deep as the estate nests (self-nesting hierarchies
  included). Levels with a single connected child are **walked
  automatically** and named in the frame's header ("C › PROD › CURATED").
  The frame's strip states the honest counts ("2 connected") and toggles to
  **Show all** — everything inside, with the unconnected members drawn
  quiet. On anything else the chevron opens plain contents, one paged level
  at a time ("page 2 of 4 · 8 of 25"), and larger frames carry a **Find**
  box that narrows the page without pretending the rest doesn't exist
  ("3 of 14 match"). Children are full cards with their own gestures; a
  second click folds the frame away — the loaded data stays, and the
  coarse wire returns.
- **×N (on a wire)** — a rolled-up connection standing for N concrete ones;
  click to drill one structural step toward the real edges. Repeat as
  needed: a drill always terminates at concrete connections. Only the far
  side refines — the near side stays whole until you deliberately open it,
  and the wires snap onto the true endpoints the moment they're on the
  board.
- **Click / double-click** — click inspects (a detail strip with identity,
  degrees, description, and actions: **Focus here**, **Reveal on canvas**,
  **Open details**); double-click re-centers the Lens on that entity.

**Back and Forward** — buttons or **←/→** — retrace your walk exactly like
browser history: stepping back never loses where you'd been, hops ahead stay
visible (dimmed) in the trail, and focusing somewhere new truncates only the
forward side. The **?** button in the corner replays the gesture guide, and
the **image** button downloads the current picture as a PNG.

## Honesty rules

- Every count on screen is a **measurement or a floor, never a guess** — a
  capped fetch or truncated trace is announced in a banner with its reason.
- If an entity has no lineage of its own at its grain but an **ancestor**
  does, the Lens says exactly that and offers to focus the ancestor — it
  never silently swaps in the ancestor's picture.
- If an entity has no lineage at its own grain because the real connections
  live on its **children** — a dataset whose columns carry the lineage —
  the Lens shows the children-grain truth instead of an empty board: its
  contents open under it, their sources and consumers land one hop out,
  grouped in their own parents' frames.
- Wide sets **page at a fixed size** ("‹ 3 of 12 ›"); nothing is silently
  dropped for legibility.
- Direction always follows the ontology's declared edge orientation — the
  same arrows the canvas draws — with the relationship name on the wire
  (e.g. `Consumes`) carrying the meaning.

## Opening the Lens

- Right-click an entity → **Focus Connections** (or press **F**).
- The **Focus** button in the entity drawer.
- The **Anchor Rail**'s "+N more · Open lens" overflow.
- The density cue chip ("Strongest N of M · Open lens") on a busy node.
- A shared exploration link (see below).

However you open it, the Lens is strictly a way of *looking* — it reads
connections, it never rewrites them.

## Sharing an exploration

A walked path is a finding. The **Share** button copies a link that reopens
this exact picture — the walk, and every expansion, open and drill you made
on the current focal — for a colleague. Malformed or outdated links simply
open the canvas normally; a share link can never break anything.

## Curated views and lineage beyond your scope

Inside a curated View, an entity may legitimately connect to things outside
the view's boundary. When the external-lineage preview is enabled, the Lens
shows those out-of-scope partners in a quiet strip along the bottom, each
tagged with its direction — advisory only; nothing lands on the canvas until
you act.

## Where to next

- Follow a chain across many hops on the canvas → [Reading Lineage](/guide/reading-lineage)
- Drive your own investigation on the open canvas → [Exploring the Graph](/guide/exploring-graph)
- Understand what a curated View is and how to build one → [Creating Views](/guide/creating-views)
