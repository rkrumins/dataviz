# The Lineage Lens & Context View

*For Viewers.* On a busy canvas, a single entity can have more connections
than you can comfortably read at a glance — and the ones you care about may be
scrolled off-screen or hidden behind the graph's ambient density budget. The
**Lineage Lens** solves this. It's a focused, on-demand view of *one* entity
and everything that touches it — clear, grouped, and searchable — no matter how
large or zoomed-out the canvas is. Think of it as the Context View for a node:
click, and the picture is laid out for you.

Here you'll learn to:

- **Open the Lens** on any entity — a keystroke or a right-click, a dense
  node's own chip, the Anchor Rail, or a curated View.
- **Read its layout** — sources on the left, consumers on the right, the
  focused entity in the middle.
- **Watch it load** — the Lens says what it is doing, stage by stage, and
  draws the immediate picture before the details arrive.
- **Choose the grain** — Overview, Grouped or Every card — so a hundred
  tables read as the databases they sit in, one click from their rows.
- **Walk a chain** of connections one hop at a time, straight from the data
  source, or let the Lens walk the whole flow for you, with Back/Forward to
  retrace every step.
- **Rearrange it** by dragging cards around, with every connection following,
  and come back to the focus with one click.
- **Open a container** into just the entities inside it that touch your focus,
  at any depth — or into everything it holds, with the connected ones marked.
- **Look at just the cause or just the impact**, and see how any card connects
  back to what you're looking at.
- **Share exactly what you found**, or export it as data.
- **See lineage beyond a View's boundary** and preview what sits outside it.

## What the Lens shows

The Lens opens as a near-fullscreen focus room over the canvas. By default it
presents an **interactive lineage graph**: the entity you focused sits in the
middle as a highlighted card, its **data sources** (upstream) fan out to the
left and its **data consumers** (downstream) to the right, connected by
direction-tinted edges.

Data flows **left to right** throughout, so the layout reads the same way the
canvas does. Each connected entity appears **once**, however many
relationships reach it — when more than one hop connects it to your focus, the
**wire** between them says so ("×3") rather than drawing it twice. That number
lives on the wire and nowhere else: a card used to carry its own running
tally, but that counted how much of the entity the walk had LOADED, so it grew
every time you clicked and named nothing that had changed. What a card says is
what it holds, and what it can still show you.
Neighbors that belong to the same parent — say, six fields of one dataset —
are drawn **inside a frame named for that dataset**, one row each, with their
own wires; a wire lands on the finest thing on screen at both of its ends, so
two tables opened to their columns show you which column feeds which. A column is never a peer of its own table:
where it comes from is the box it sits in, not a caption you have to squint
at. Wide tables **scroll** inside a fixed window
rather than growing it, so a 500-column source sits on the board like any
other card. Coarser partners connected **directly to your focal** — a domain,
a platform — resolve on their own: the Lens walks down through the levels
between you and them and shows the entities at **your grain** inside a frame,
with the walked path as its breadcrumb (`⋯ › PROD › CURATED › RISK_DB`). Focus
a table and the picture is tables, however many containment levels the estate
stacks above them. Coarser cards further out stay summarized until you open
them. A closed card says **how much is inside** — how many of its contents sit
on this lineage and how many it holds altogether — so you can often tell
whether it's worth opening without opening it.

The focal's own structure is part of the picture from the moment you focus —
open it further, one chevron at a time, and it keeps unfolding: table →
column → field → sub-field, exactly as deep as the estate actually goes. There
is no cap on nesting; a self-nesting hierarchy nests in the Lens exactly as
many times as it does in the data source. Above the frames, the focal names
**where it lives** — `Snowflake › OrderApp › fact_orders` — as a breadcrumb
you can click to move up a level; those levels are always *text*, never
another nested box, so a deep hierarchy stays readable instead of turning into
boxes inside boxes inside boxes. The focal card shows a quick tally — how many
connections come *in* and how many go *out* — and one **orientation
sentence**: how many distinct entities the walk has reached, transitively,
upstream and downstream, and how many separate systems they span ("Fed by 12
sources across 4 systems · feeds 47 consumers across 3"). "Across N systems"
only appears when it says something a raw count doesn't — one system alone
isn't worth naming. This isn't a separate measurement; it's exactly what the
walk has found up to this point, so it grows as you follow a card further.
While the data source has more than the walk has reached yet, the number
shows as a floor ("47+") — the Lens never invents a number. **Every number here
is the data source's own truth, fetched
live the moment you focus** — whether or not the canvas happens to have that
entity loaded. The Lens never answers a lineage question by reading the
canvas; it asks the data source directly, one hop at a time, and shows exactly
what came back.

### How much of the picture is folded — Density

A focus with a hundred partner tables is not a hundred cards. Partners that
**share a container** fold into it: five fact tables under `GOLD` are one
`GOLD` frame with the tables as its rows, eighteen databases of two hundred
tables are eighteen frames. The **Density** control in the header is *your*
preference — it follows you from lens to lens, and the numbers on the board
are identical at every rung; only the grain folds:

| Rung | What a shared container shows | What a click does |
| --- | --- | --- |
| **Overview** | The container as one **closed card** with its counts ("5 on this lineage · of 8") | Opens it into a frame of its rows, one level at a time |
| **Grouped** *(default)* | The container as an **open frame** showing its strongest five rows, "N more" behind; the three strongest ungrouped partners open to their columns | A row's chevron opens what's inside it |
| **Every card** | Every card on its own, however many | — |

A partner with no siblings stays a card with its container named beside it
(`⋯› REPORTING`) — grouping one thing under its parent would be a click for
nothing. Every crumb like that is a button: click `REPORTING` and it becomes
the subject.

**Steps** is the other fold, for long chains: **Every step** (the default)
draws every hop on a pass-through path as its own card; **Condensed** folds a
run of single pass-through steps into one "via N steps" connector you can
open.

**Wires** folds the connections themselves. Wires land on the finest thing
on screen at both ends, so two open containers showing five and eight rows
are forty wires — and five hundred columns feeding a focus were a solid
block of colour. With **Auto** (the default), two containers with more than
twelve wires between them draw **one bundle**: a heavier wire with the total
on it ("×423"). The detail is a gesture away — **hover** a row or a card and
its own wires come back; **select** one and they stay; **hover the bundle**
itself and it fans out into every wire it stands for, and a **click** on the
bundle keeps them out until you click it again. **Bundled** folds every pair
of containers whatever the count; **Every wire** folds nothing. Like
Density, it is your preference and follows you.

### While it loads

From the moment Focus opens, a **capsule** at the top of the board says what
is happening — the same capsule a canvas Trace shows, so the two read alike:

- **The four stages** every walk has — **Focus · Picture · Flows · Drawn** —
  with the current one breathing. *Focus* is the data source finding the
  entity; *Picture* is the immediate lineage on the board; *Flows* is the
  detailed connections arriving page by page; *Drawn* is complete.
- **The numbers** — nodes, flows, requests — tick as each page lands, with
  "N more to go" when the data source has said how many steps are still owed,
  and the seconds elapsed once it has been a few.
- **A beat on the line** under the numbers for every page that lands, and a
  line of guidance on a longer wait.

There is never a percentage: the size of a lineage is unknowable until it has
been walked, and a bar that fills would lie. Under the first fetch the board
shows the **shape of the answer** — ghost sources, a ghost focus, ghost
consumers, shimmering — until the real cards take its place; the immediate
picture usually lands well inside a second, with the finer detail ("≈" counts
become exact, wires land on columns) filling in behind it. Once the walk
finishes, the capsule says **Complete** and leaves.

```mermaid
flowchart LR
  subgraph Sources
    s1[Table]
    s2[Column]
  end
  subgraph Consumers
    c1[Dashboard]
    c2[Report]
  end
  s1 --> F(((Focused entity)))
  s2 --> F
  F --> c1
  F --> c2
```

## Opening the Lens

There are a few natural ways in:

- **Select any entity and press F** — or right-click it and choose **Focus
  Connections**. This works everywhere, any time, on any entity.
- When an entity has a **large connection fan**, the canvas shows only its
  strongest links to stay legible, and a chip appears reading *"Strongest N of
  M"* with an **Open lens** button. That's your cue that there's more to see.
- The **Anchor Rail** — the small docked chips that mark a focused entity's
  off-screen partners — ends in a **"+N more · Open lens"** control when there
  are more partners than it can show.
- From a **curated view**, the "outside this view" chip offers a **Preview**
  action that opens the Lens on the out-of-scope partners (more on that below).

However you open it, the Lens is strictly a way of *looking*. Nothing you do
inside it changes your data — it reads connections, it doesn't rewrite them.

## Moving through connections

The Lens is built for exploring, not just reading:

- **Click a card** to inspect it — a detail strip slides up with the entity's
  identity, its own in/out counts, and actions. Clicking a *row* inside an
  open container opens the same answer as a **preview** beside its frame
  instead. Nothing jumps: focusing is always a deliberate second gesture.
- **Double-click a card** (or use **Focus here** in the strip) to re-center
  the Lens on that entity. The Lens fetches that entity's own neighbours from
  the data source — instantly, if you've already visited it earlier in this
  session — and the step is recorded in your **path**.
- **Back and Forward** — buttons in the header, or the **←/→** keys (outside
  an open container, where those keys browse its rows instead) — retrace
  your walk in either direction, exactly like browser history: stepping back
  never loses where you'd been, and the hops ahead of you stay visible
  (dimmed) in the **Path** trail. Click any chip in the trail to jump straight
  there. Focusing somewhere new after stepping back starts a fresh forward
  path from that point.
- **Follow a card further** — hover its edge (or a row's, or the focus's own)
  for its follow control, a compact **⊕** at rest that opens into a plain
  verb on hover: **"Load upstream"**. Click, and the Lens fetches *that one
  entity's* next hop from the data source and grows the board from exactly
  there — a row's follow seeds the walk from that row alone, not its whole
  table. What comes back is drawn where it lands, in its own hop column, the
  moment it arrives, and it adds exactly that — never more, never a guess.
  The raw connection count behind a fetch lives in the control's hover text,
  the peek, and on the wires — never on the control's face, which speaks a
  verb. A hub with more connections than fit in one response hands back a
  bookmark, and the Lens keeps pulling from where it left off, unnoticed,
  until the hub is drained. A **⊘** where a follow control would be is a
  genuine dead end: the data source has confirmed there is nothing further
  that way, and the Lens only ever says that once the walk has actually
  finished asking — never as a guess.
- **Spotlight anything** by hovering or clicking it — its lineage cone lights
  up on the board, everything else quiets to a floor. Click to stick it, and
  a chip at the bottom states its scope honestly: how much of its lineage is
  already drawn versus how much the data source knows about in total ("3 of
  8 known upstream flows on this board"), with a button to follow the rest
  and a button to focus there. **Esc**, or a click on the board behind
  everything, clears one layer at a time.
- **The trail** — every card you've explicitly focused, or grown the board
  from with a follow click, carries a small persistent mark, and the wire
  between two consecutive stops in your walk draws slightly firmer. It's a
  record of where you've actually been, not a suggestion of where to go.
- A small **loop icon** on a wire means that hop curls back *toward* your
  focus rather than away from it — the lineage genuinely cycles, and the Lens
  says so rather than letting two wires between the same pair read as a plain
  duplicate.
- **Open any card into what's inside it** with the **chevron** on its body —
  a column of a table, the tables of a platform, the fields of a column. This
  is a different question from the follow control next to it, and the two
  never interfere: a card can offer both, and looking inside something never ends
  the walk through it. Opening costs no fetch at all — it's a re-projection of
  lineage the Lens already holds — so it's instant, and it nests as deep as
  the estate actually goes.

  The card unfolds into a frame holding **only the entities inside it that
  are on this lineage**, and the header counts them at both grains that
  matter — "3 on this lineage · of 12" — so a frame is safe to leave
  collapsed. Those children are ordinary cards with chevrons of their own,
  so frames nest — table → column → field, without ever re-centering, and
  without limit. A platform that merely passes lineage through a single
  container is walked through for you, and the levels it skipped are named
  beside the frame's own name as a **breadcrumb chip** ("`clean_charges`
  *in SILVER · Snowflake*"), each crumb somewhere you can go — never drawn
  as a box around it. Frames state plainly when nothing inside is on this
  lineage rather than leaving you guessing.
- **Show everything inside**, not just the connected part, with the small
  toggle in a frame's header (**⛓ Connected** | **▤ All**). "All" lists every
  column, table or dataset the container holds, in the source system's own
  order, with the lineage-carrying ones highlighted exactly where they sit and
  the rest present but quiet — no counts, no edges, labelled *no lineage*.
  That's the honest picture: a column with no lineage is drawn as having none.
  Frames open **Connected** by default — the header's own **Connected | All**
  control changes which mode the *next* frame you open starts in, and it's
  remembered between sessions.
- **Browse a wide table by scrolling it.** Spin the wheel over an open
  frame and its rows move under a fixed window, so a 500-column table takes
  no more room on the board than a five-column one. A thumb on the frame's
  right edge shows where in the list you are (drag it to travel), and the
  numbers under it say which rows you're on ("21–40 of 428"). Reaching the
  end fetches the next page from the source before you get there, so the
  list keeps moving; a count still being paged in appears as a floor ("of
  428+"), never as a guess. In **All** mode the rows on this lineage come
  first, then a quiet divider — *everything else inside — 388 items* —
  before the ones that merely live there.
- **Read a row without leaving the picture.** Clicking any row opens a
  **preview** beside the frame: what it is, where it lives, its description,
  how much lineage flows through it and how much the source says it hasn't
  shipped yet, when it last synced — and only the moves that row can
  actually make (walk further, focus here, open what's inside, reveal on
  canvas, details). **Esc** closes it. Double-click still focuses there.
- **Browse from the keyboard.** **Tab** into an open frame and its rows
  become a list you can walk: **↑ ↓** move a cursor (scrolling the window
  along with it), **Enter** previews, **Shift+Enter** focuses there, **→**
  opens a row that holds things, **←** steps back out, **Home / End** jump to
  the ends — and simply **typing** jumps to the next name that matches.
- **Find a column you haven't scrolled to.** The **Find** icon in a frame's
  header opens a box that searches the *whole* container in the data source,
  not just the rows on screen, so a column 300 rows down is one keystroke
  away. A new search starts the list again at the top, and the counts say
  what they're scoped to. Typing a name no loaded row has, while browsing
  from the keyboard, hands your letters straight to it.
- **Choose how far the Lens walks on its own** with the **Walk** control in
  the header. **One hop** (the default) loads and draws the *whole* immediate
  lineage — every upstream source and downstream consumer, however many,
  with no "load more" to click — and leaves the next hop to you, one ⊕ at a
  time. **Full flow** keeps walking every frontier until the end-to-end flow
  is drawn, hands-free; on a very large flow it pauses once, around fifty
  thousand nodes, to ask whether to continue, since the rest may slow your
  browser. If a step fails at the data source the capsule says so and offers
  **Try again** — what is already on the board stays.
- **Look at just one side of the story** with the direction control —
  **Both**, **Root cause** (upstream only), or **Impact** (downstream only).
  This only changes what's drawn: the Lens still holds both directions
  underneath, so flipping back is instant and every count stays exactly what
  it was.
- **See how a card connects back to your focus** by hovering or selecting it
  — every wire on some shortest path back to the focus lights up and the rest
  of the picture dims. When two routes are equally short, both light up.
- **Drag a card anywhere** to arrange the picture the way you read it. Every
  connection follows the card it belongs to — moving things changes only where
  they sit, never what connects to what. An opened container moves as one
  piece, carrying its contents with it. Your arrangement survives expanding,
  opening and loading more, so the picture grows around it instead of
  resetting; **Tidy up** in the corner controls puts everything back where the
  Lens placed it.
- **Come back to the focus.** A small board is fitted whole; a large one opens
  **centred on the focus** at a readable size, with its sources and consumers
  a band either side and the rest a scroll away — never a tiny sliver you
  have to zoom into. Switching Density, Steps or direction re-centres the
  same way, and **Center on focus** — the button beside the entity's name in
  the header — does it on demand. Pan or zoom until the focus has left the
  screen and the board offers the same thing as a pill at the top; the
  corner controls carry it too. While a walk lands cards the camera holds
  still and a **Board grew · Fit** pill offers the whole picture; when the
  walk ends the camera settles on the focus once — unless you have already
  moved it yourself.
- **Filter connections** with the search box in the header — matching cards
  stay bright while the rest dim, so you can spot what matters in a crowded
  picture at a glance. The filter searches what's currently on the board; open
  a container first if what you're after might be tucked inside it.
- Cards offer two quiet actions on hover alongside Focus: **Reveal on canvas**
  (scrolls the real entity into view) and **Open details** (opens its details
  panel). The path itself is a deliverable too — **Copy path** and **Show on
  canvas** live at the end of the trail.
- **Share the exploration** with the link button in the header: it copies a
  URL that reopens this exact picture — the walked path, the focused entity,
  every hop you've revealed or expanded, which containers you opened and how
  you left them (Connected or All, and where each one was scrolled or
  searched to),
  plus your depth and direction settings — for a colleague. An older link
  someone sends you still opens on the right entity and the right walked
  path; it just won't carry the newer extras a link copied today does. The
  **image button** in the corner controls downloads the graph as a PNG for a
  deck or a doc, and the two **export** buttons beside it download the same
  picture as **JSON** or **CSV** — exactly the entities and connections on
  screen right now, as data for a script or a spreadsheet.

All of this follows you as you explore: double-click a card to focus it and
the same opening, expanding and filtering apply to that entity's own
neighbours.

First time here? The Lens offers a **one-minute guided tour** when the graph
opens; replay it any time from the **Help** panel while you're on a view. And
every control in the header explains itself: rest the pointer on any of them
— **Next**, **Walk**, **Steps**, **Density**, **Wires**, the direction presets
— and a small note names it and says what it does. The header is one row
that never spills off the edge: when the window is too narrow for every
group, the ones you reach for least fold into a **Display** menu (the
settings first — Next, Steps — then Walk), and the day-to-day controls —
direction, Density, Wires — stay on the row. Widen the window and they come
back.

Press **Esc** to close — a row preview first if one is open, then the Lens
itself. Clicking the backdrop closes it outright. To follow a chain across
the *canvas* instead, with the browse picture still underneath, use a
**Trace** — see [Exploring the Graph](/guide/exploring-graph).

## When to reach for it

Open the Lens whenever a node is *too connected to read on the canvas*. A hub
table feeding forty dashboards, a widely-reused dimension, a column referenced
everywhere — on the canvas these show as a dense fan the ambient budget
summarises. The Lens draws **every** connection — grouped by the containers
they share, folded to the grain you choose, and searchable — so "what
actually depends on this?" becomes a question you can answer in seconds.

## Curated views and lineage beyond your scope

A **View** is a curated subset of a Data Source — you chose which entities
belong in it. That means an entity inside your view may legitimately connect to
things *outside* it. Those aren't missing or broken connections; they're simply
beyond the boundary you drew. (See [Browsing Views](/guide/browsing-views) and
[Creating Views](/guide/creating-views) for what Views are and how they're
built.)

{brandShort} makes this visible instead of hiding it. When you select an entity
that has lineage reaching beyond the current view, a chip appears in the
bottom-right corner:

> **Selected: 12↑ 5↓ outside this view**

Those numbers come from a **node-degree signal** — {brand} asks the backend for
each entity's *total* lineage degree and subtracts what's already loaded on the
canvas. The remainder is the lineage that exists in the data source but leads to
entities your view doesn't include. Hovering the chip explains it in plain
terms: this is expected for a curated view, not a sign of missing data. Because
the count is measured, not guessed, an entity with no known external lineage
shows no chip at all — {brand} never invents a "zero."

## Previewing what's outside the view

The chip's **Preview** action is the guided path from that signal straight into
the Lens. It opens the focal entity's Lens with an extra **"Outside this view"**
section listing the out-of-scope partners — each labelled with its direction and
relationship, and each offering a **Trace** control to pull its lineage onto the
canvas if you decide you want it.

This preview is deliberately advisory. It shows you what's *there* without
adding anything to your view — nothing lands on the canvas until you act. It
answers "am I seeing the whole story?" honestly, then leaves the choice to
widen the picture in your hands. When you're ready to include those partners for
real, add them to the View or run a Trace from the row.

> **Note:** The external-lineage chip and the "Outside this view" preview are
> only shown when it makes sense — for curated Views where an out-of-scope
> boundary actually exists. On the open Explorer, where you're pulling in
> whatever you like, there's no boundary to report against.

## Where to next

- Follow a chain across many hops instead of one → [Reading Lineage](/guide/reading-lineage)
- Drive your own investigation on the open canvas → [Exploring the Graph](/guide/exploring-graph)
- Understand what a curated View is and how to build one → [Creating Views](/guide/creating-views)
