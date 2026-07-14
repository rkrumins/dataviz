# Exploring the Graph

*For Viewers (and anyone curious).* The **Explorer** is the open canvas where you
ask your own questions of the data — searching, tracing, expanding, and
filtering freely. Unlike opening a saved View, here *you* drive.

> 💡 **Explorer vs Views:** A **View** is a curated, saved snapshot. The
> **Explorer** is a blank-canvas investigation. Start in a View to learn the
> landscape; come to the Explorer to answer a new question.

![Clicking a node on the open canvas to inspect its connections](/docs-assets/guide/exploring-graph-hero.png)

---

## Finding a starting point

Open **Explore** from the sidebar. An empty (or lightly seeded) canvas appears.
Begin with **search**:

- Use the on-canvas **search box** to find any node by name.
- Or press `⌘K` / `Ctrl-K` to open the **Command Palette** and search from
  anywhere.

Click a result to drop it onto the canvas as your anchor. From there, everything
is about following connections.

---

## Tracing lineage

Tracing is the core move. With a node selected, use the **Trace toolbar** or the
node's **right-click menu**:

| Action | What it does |
| --- | --- |
| **Trace Upstream** | Reveals where the data came from (its sources) |
| **Trace Downstream** | Reveals what the data feeds (its consumers) |
| **Depth** | How many hops to follow — 1 for neighbours, more for full chains |

The traced path highlights the **blast radius** — everything connected to your
node in that direction. This is exactly what you want before changing or
trusting a piece of data.

```mermaid
flowchart LR
  subgraph Upstream
    a[(Raw source)] --> b[Staging]
  end
  b --> sel{{Selected node}}
  subgraph Downstream
    sel --> c[Report] --> d([Dashboard])
  end
```

---

## Expanding hierarchy

Many nodes *contain* others (a table contains columns; a domain contains
datasets). **Click to expand** a node and reveal its children, then collapse it
again to tidy up. This lets you drill into detail only where you need it, keeping
the rest of the canvas calm.

> 💡 Expanding follows **containment**; tracing follows **lineage**. See
> [Reading Lineage](/guide/reading-lineage) for the difference.

---

## Filtering and focusing

As a graph grows, use these to keep it legible:

- **Entity-type filters** — show or hide whole categories of node (e.g. hide
  columns to see only tables).
- **Edge-type filters** — focus on lineage edges, containment edges, or both.
- **Granularity** — column → table → domain re-aggregates the whole picture to
  the altitude you need.
- **Search-to-select** — search highlights matching nodes so you can find them in
  a crowd.

---

## Canvas controls

The canvas itself has a control cluster (usually bottom-corner):

| Control | Purpose |
| --- | --- |
| **Pan** | Drag empty space to move around |
| **Zoom** | Scroll, or use the +/– buttons |
| **Fit / Recenter** | Frame everything on screen |
| **Minimap** | A small overview for large graphs; click to jump |
| **Layout** | Re-arrange nodes using an automatic layout algorithm |
| **Grid / Snap** | Align nodes neatly |

> 💡 **Lost in a big graph?** Hit *Fit* to recenter, then open the **minimap** to
> navigate the overall shape.

---

## The Command Palette (`⌘K` / `Ctrl-K`)

The Command Palette is the fastest way to do almost anything without hunting
through menus: search for nodes, start a trace, apply a filter, or jump to
another part of the app. If you remember one shortcut, make it this one.

---

## A typical investigation

A real example, start to finish:

1. *"Why does the Revenue dashboard look wrong?"*
2. Search for **Revenue dashboard**, click to anchor it.
3. **Trace Upstream**, depth 2 — see which tables feed it.
4. **Expand** the suspicious table to inspect its columns.
5. Switch **granularity** to *column* to pinpoint the exact field.
6. Found the culprit? **Save as View** and share it with the data team so the
   investigation isn't lost. → [Creating Views](/guide/creating-views)

---

## Where to next

- Turn your investigation into a shareable artefact → [Creating Views](/guide/creating-views)
- Understand the colours and edge types → [Reading Lineage](/guide/reading-lineage)
- Adopt good habits for naming and sharing → [Ways of Working](/guide/ways-of-working)
