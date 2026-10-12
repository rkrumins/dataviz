# Navigating Layers

*For Viewers.* A Context View arranges your graph into **layers** — vertical
columns that read left to right, like *Source → Staging → Transform →
Warehouse*. It's a clear way to see data flow, but a rich graph can run wider
and taller than one screen. This page shows you how to move around a large
layered view without losing your place: the Layer Strip, resizable columns,
load-more paging, and the lists of off-screen partners at each column's edge.
None of them change your data — they're all about finding your way.

This page covers how to:

- **Orient yourself** with the Layer Strip's live "you-are-here" indicator.
- **Resize and collapse** columns so the layers you care about get the room.
- **Load more** roots, children, and connection detail as you go — always
  additively.
- **Reach off-screen partners** of a selected entity from the list at the
  edge of their column.
- **Find orphaned entities** (advanced) and put them in a layer.

## The layered canvas

Each **column** is one layer, and each column lists its entities as an
expandable tree. A column header shows the layer's name, its colour, and a small
count in the form **loaded / total** — how many entities are loaded into that
layer (collapsed children included) versus how many it holds: the loaded ones,
plus the children the server reports for loaded rows and what the server still
counts for the layer's entity types. A trailing **+** means some types have no
count yet, so the total is a minimum. Hover the count for how many rows are in
the tree right now. Columns handle very long lists smoothly, rendering only what's on
screen as you scroll, so a layer with thousands of entities stays responsive.

## The Layer Strip: your "you-are-here" navigator

When a canvas is wider than the window, it's scrollable — but scrolling alone
doesn't tell you *where you are* among the layers. The **Layer Strip** is a
slim, floating dock at the bottom-centre of the canvas that does. It shows one
chip per layer, each with the layer's colour dot and name:

> ● Source   ● Staging   **● Transform**   ● Warehouse

- Chips for the columns **currently in view light up** in the layer's colour, so
  the strip is a live "you-are-here" indicator that tracks as you scroll.
- **Click a chip** to smoothly scroll that column into view — the fastest way to
  jump from one end of a wide canvas to the other.
- A **Fit** control (also `⌘0` / `Ctrl-0`) frames all layers to the window, so
  orientation and the way back to "see everything" live on the same surface.

The strip stays docked to the canvas frame, never drifting into the scroll area,
so it's always exactly where you left it.

## Resizing and collapsing columns

Layers aren't one-size-fits-all — a layer full of long table names needs more
room than one holding a handful of domains.

- **Resize a column** by dragging the handle on its right edge. A thin coloured
  guide appears on hover; drag to set the width you want. **Double-click** the
  handle to snap back to the default. Your chosen widths are remembered **per
  layer across sessions**, so a view you've tuned stays tuned. When a column has
  a custom width, a small **"Reset width"** chip appears on hover as a one-click
  way back to the default.
- **Collapse a column** with the panel toggle in its header to shrink it to a
  narrow spine showing just the layer's name and count. Collapse the layers
  you're not working in to give the ones you are more room; click a collapsed
  column to expand it again.

## Loading more: roots and children

Large layers don't load everything at once — that would be slow and
overwhelming. Instead {brandShort} loads a page at a time and lets you pull in
more as you go. Loading is always **additive**: nothing already on the canvas is
replaced or lost.

- **More children.** When an expanded entity has more children than are shown, a
  **"Load N more · X remaining"** row sits at the bottom of its child list.
  Click it any time to fetch the next page. It also works **one page ahead**:
  when you scroll it into view and pause on it briefly, the next page loads on
  its own, so a long list keeps filling as you read down it. Scrubbing quickly
  past the row won't trigger it — only pausing does.

- **More top-level entities.** When a layer's roots run past the first page, a
  chip in the bottom-right reads **"N top-level loaded"** with a **Load more**
  button, shown whenever the last page came back full (a hint that the source
  likely has more). Scrolling a column to its very end also pulls the next page
  of roots automatically, one page ahead.

- **More connection detail.** When only part of the flows behind the lines on
  screen has loaded, a **"Showing X of Y underlying flows"** chip offers
  **Load more** to page in the rest.

> **Note:** These chips live in the bottom-right cluster and each explains itself
> on hover. They only appear when there's genuinely more to load — a quiet,
> honest signal that the picture isn't yet complete.

## Orphaned entities (advanced)

An **orphan** is an entity whose type normally sits inside another (a Table
inside a Schema, say) but which has no parent in the data. Most readers never
need them, so they don't change the board, the default lists or the status
chips. When you do want them:

1. Open **Display** in the toolbar.
2. In its **Advanced** section, choose **Orphaned entities…**

A side panel lists every orphan in the data source, a page at a time, with how
many there are ("Many" when the server can't count them quickly). **Load more**
pages through the rest. Each row shows:

- the entity's **name** and **type**;
- **where it is in this view**: the layer it's drawn in; *Layer* **· not
  loaded** when the view puts it in that layer but the canvas hasn't loaded it
  yet; or **Not in this view**;
- **Reveal**, which loads the entity if needed and scrolls to it. It's off for
  entities this view doesn't place;
- **Place in layer…**, on a draft and not during a trace. It pins the entity to
  the layer you pick, just like dragging it into that column, and shows up in
  **Review & Save** as a layout change you can undo. Undoing it takes the
  entity out of the layer but leaves it loaded, so the canvas then counts it
  among the loaded entities that are not in this view.

Opening the panel changes nothing on the canvas. Only Reveal and Place in layer
do.

## Reaching off-screen partners

When you select an entity, some of its connected partners will be in *other*
columns and often scrolled out of sight. Rather than leave those connections
pointing into empty space, each column lists them at the edge they're beyond:
**Off-screen above** at the top of the column, **Off-screen below** at the
bottom. The selected entity's lines run to these entries.

- **Select** an entity, or simply **rest the pointer** on one — after a brief
  pause its lists appear. Move away and they clear a moment later, so they
  never clutter the canvas.
- Each entry names the partner — or, for several in one card, how many (for
  example *3 sources*) — says how it connects (**feeds**, **fed by**, or
  **feeds & fed by**) and where it sits, with its number of flows.
- **Click an entry** (it shows **Reveal** as you hover) to scroll that real
  entity into view in its column. The selection stays where it was.
- When a column has more partners than it can list, the last entry reads
  **N more in the lens**. Click it to open the
  [Lineage Lens](/guide/lineage-lens), which lists every connection, grouped and
  searchable.
- To tuck a list away, click its **×** or press `Esc` while it has focus. It
  folds into a small pill (for example *↑ 4 connected*); click the pill to open
  the list again.

> **Tip:** Prefer the small pill all the time? Open **Display** in the view's
> header and, under **Lineage appearance → Appearance**, turn off **Off-screen
> partners**.

The lists turn "this connects to something off-screen" into "here's exactly
what, and here's a click to reach it" — so a wide, layered canvas stays
navigable even when the entities you care about are far apart.

## Where to next

- [The Lineage Lens & Context View](/guide/lineage-lens) — when you want every
  connection of one entity, grouped and searchable.
- [Tracing Lineage on the Canvas](/guide/exploring-graph) — when you want to
  follow lineage from an entity across all the layers.
- [Creating Views](/guide/creating-views) — when you want to learn what a
  curated View is and how its layers are defined.
