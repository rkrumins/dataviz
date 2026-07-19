# Navigating Layers

*For Viewers.* A Context View arranges your graph into **layers** — vertical
columns that read left to right, like *Source → Staging → Transform →
Warehouse*. It's a clear way to see data flow, but a rich graph can run wider
and taller than one screen. This page covers the controls that keep a large
layered canvas easy to move around: the Layer Strip, resizable columns,
load-more paging, and the Anchor Rail. None of them change your data — they're
all about finding your way.

## The layered canvas

Each **column** is one layer, and each column lists its entities as an
expandable tree. A column header shows the layer's name, its colour, and a small
count in the form **visible / loaded** — how many rows are currently in the tree
versus how many entities are loaded in that layer overall (collapsed children
included). Columns handle very long lists smoothly, rendering only what's on
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
- A **Fit** control (also `⌘0`) frames all layers to the window, so orientation
  and the way back to "see everything" live on the same surface.

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

- **More connection detail.** Where an aggregated connection has been expanded
  and its underlying links are truncated, a **"Showing X of Y connections"** chip
  offers a **Load more** to page in the rest.

> 💡 These chips live in the bottom-right cluster and each explains itself on
> hover. They only appear when there's genuinely more to load — a quiet, honest
> signal that the picture isn't yet complete.

## The Anchor Rail

When you focus an entity, some of its connected partners will be in *other*
columns and often scrolled off-screen. Rather than leave those connections
pointing into empty space, the **Anchor Rail** docks a small stand-in chip for
each off-screen partner at the **top** (for partners above) or **bottom** (for
partners below) of the column it lives in.

- Focus by **selecting** an entity, or simply **hover** over one — after a brief
  dwell its rail docks into place. Move away and the rail clears itself a moment
  later, so it never clutters the canvas.
- Each chip is named, colour-coded to its layer, and shows the strength of the
  connection. **Click a chip** to scroll that real entity into view in its
  column — a direct jump to a partner you couldn't otherwise see.
- Each column's rail shows the strongest few partners. When there are more, a
  **"+N more · Open lens"** chip hands off to the [Lineage Lens](/guide/reading-lineage),
  which lists every connection, grouped and searchable.

The rail turns "this connects to something off-screen" into "here's exactly what,
and here's a click to reach it" — so a wide, layered canvas stays navigable even
when the entities you care about are far apart.

## Where to next

- See every connection of one entity, grouped and searchable → [Reading Lineage](/guide/reading-lineage)
- Drive your own investigation across the graph → [Exploring the Graph](/guide/exploring-graph)
- Learn what a curated View is and how layers are defined → [Creating Views](/guide/creating-views)
