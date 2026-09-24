# Subset Views

*For Builders.* A subset view is a smaller Context View carved out of a bigger
one: just the entities a narrower audience needs, with the lineage between
them kept whole — even where it runs through the entities you left out. The
view you carved it from stays exactly as it is.

---

## When to make one

- A finance team needs twelve tables out of a four-hundred-table platform view.
- An executive wants the path from the source systems to one dashboard, and
  nothing else.
- A new joiner should start from the handful of datasets that matter before
  they meet the whole estate.

In each case the big view is right for the people who built it and too much
for the people it is now being shown to. A subset gives the second group their
own view without copying or re-drawing anything.

---

## Virtual hops: lineage that survives what you leave out

Take a chain where data flows **A → B → C → D → E → F → G**, and keep only
**A**, **C** and **F**.

- **A ⇢ C** is drawn, *via 1 hidden step* (B).
- **C ⇢ F** is drawn, *via 2 hidden steps* (D and E).
- **A ⇢ F** is *not* drawn: A's lineage reaches F only by passing through C,
  which the subset holds, and A ⇢ C ⇢ F already says so. If some path from A
  reached F *without* passing through C, the subset would draw A ⇢ F as well.

Each of these is a **virtual hop**: a stitched line in the explore accent with
a small **via N** chip at its middle, so it reads as different from a plain
line with or without colour. Hover it for what it stands for; **click it** to
see the hidden steps — named at the grain the view speaks (a hidden column is
filed under its table), with routes of equal length shown side by side — and
**Walk it in the Lens** to step through them one at a time.

> **Note:** Virtual hops are **live**. They are worked out from the graph's
> lineage each time the view opens, never frozen into the view. When lineage
> changes — a pipeline is added, a table is dropped — the hops change with it.

### How steps are counted

Steps are counted on **raw lineage** — usually column to column — which is the
finest thing the graph records. *via N* means N entities the subset leaves out
sit between the two ends on the shortest route. Two entities joined by lineage
with nothing in between are drawn as an ordinary line, not a virtual hop.

What an entity *includes* decides where a route starts and stops. An entity
that **comes with what sits inside it** (a table and its columns) owns
everything beneath it; one kept **on its own** owns only itself, and its
contents count as left out.

### How far a hop reaches

A subset draws hops up to **10 steps** long by default. Set anything from 1 to
20 in the Studio's **Shape** step: longer reach finds more distant
connections; shorter keeps the picture to close relatives.

### When the answer is incomplete

Some entities sit next to so much lineage — a hub column feeding ten thousand
others, a container holding a whole warehouse — that the walk cannot finish in
time. The view never passes that off as a complete answer: the status chip at
the bottom right says **may be incomplete** and names the entities whose links
may be missing, and offers **Try again** when the walk simply ran out of time.
Subsets work best at table or dataset grain.

---

## Making a subset: the Subset Studio

Open the view you want to carve from, then start the **Subset Studio** from
any of these:

| Where | What it does |
| --- | --- |
| **Subset** in the view's header | Opens the Studio with nothing picked |
| **Keep as a subset…** on a multi-selection | Opens it with the selection already picked |
| **Start a subset from here** on a card's right-click menu | Opens it with that card picked |
| **Make a subset…** on a view card in the Explorer | Opens the view with the Studio started |

The Studio works on the **published** view. If a draft is open, leave it first —
the Studio closes if a draft opens while you are picking, and your picks are
kept for when you come back.

While the Studio is open, **clicking a card picks it** (click again to leave it
out). What your picks hold stays lit and everything else dims; the virtual hops
your subset will draw appear on the canvas as your picks settle. The canvas
itself is untouched: nothing you do in the Studio changes the view behind it.

The rail on the right walks you through three steps. They are tabs, not a
gate — look at **Connect** after every pick if you like.

### 1 · Pick

- **Click cards** on the canvas, or add **all of a layer** or **all of a type**
  at once from **Add ▾**.
- **Grow along lineage** — bring in what feeds your picks (**Upstream**) or what
  they feed (**Downstream**), **1 step** or **All** the way. Growing works at the
  view's own grain: one step upstream of a table is the nearest tables *in the
  view* that feed it, however many hidden steps lie between.
- **Reach beyond this view** brings in entities the source view does not hold,
  one step at a time. Each lands in the layer the view's own rules choose — or,
  where no rule speaks, one layer before (upstream) or after (downstream) the
  entity it grew from.
- A grow that would add more than 50 entities **asks first**, listing them by
  layer so you can leave any out. Smaller ones add straight away with an
  **Undo**.
- The list shows everything picked, by layer, and how each came in
  (*Upstream*, *Downstream*, *On the path*, *Outside view*).

### 2 · Connect

How your picks will hang together once everything else is gone: how many are
**joined directly**, how many through **virtual hops**, and which are
**isolated** — joined to nothing else you picked. A small diagram shows the
subset as it will read. Each virtual hop opens its hidden steps, and from there
**Include these steps** brings them into the subset so the hop becomes direct
lineage.

### 3 · Shape

- **Layers** — which of the source's layers the subset keeps (a layer with
  nothing picked from it is left out).
- **What sits inside** — whether each container comes with its contents.
- **Groups** — keep the groups your picks sit in, or list each layer flat.
- **Virtual hop reach** — 1 to 20 steps.

### Save as view…

Name the subset, describe it, tag it and choose **who sees it** — the same
choices as any view, including asking an admin to publish it to everyone when
you cannot. **Review** shows what it holds and how its lineage connects, then
**Create subset** makes it in one step and opens it.

> **Tip:** The Studio keeps your picks if you reload the page. **Cancel** asks
> before it discards them.

---

## Where a subset came from

A subset remembers the view it was made from:

- Its header reads **Subset of ‹source›**, linking back to it.
- **Details › About** lists it under **Subsets** — and on the source view, the
  same section lists every subset made from it that you can open.
- Explorer cards carry a **Subset** badge.
- The view's **Activity** starts with *Made as a subset of another view*.

A source you cannot open is never named: the header says *Subset of a view you
can't open* instead.

---

## What a subset is not

> **Note:** A subset narrows **what people see**, not **what they can open**.
> Anyone who can read the data source can still search for, trace, and open
> what the subset leaves out. To restrict the data itself, use data source and
> workspace access — see [Users & Access](/guide/users-access).

A subset is also not a live mirror of its source: it starts from the source's
layers and your picks, and from then on it is a view of its own. Changing the
source view later does not change the subset. (Its virtual hops, which come
from the graph's lineage rather than from the source view, do stay live.)

---

## Limits

| | |
| --- | --- |
| Entities in one subset | 1,000 |
| Virtual hops | drawn for views of up to 2,000 entities |
| Virtual hop reach | 1–20 steps, default 10 |
| Reach beyond the view | from the first 25 picks per grow, one step at a time |
| A grow asks first | above 50 entities |

Subset views are on by default. An administrator can switch them off under
**Admin → Features › View Modes** (*Subset views with virtual hops*). With it
off, existing subsets still open and show the direct lines between what they
hold.

---

**Related:** [Creating Views](/guide/creating-views) ·
[Managing Views](/guide/managing-views) ·
[The Lineage Lens & Context View](/guide/lineage-lens)
