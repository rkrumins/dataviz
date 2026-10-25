# Advanced Search

*For Viewers and Builders.* Advanced Search finds every entity in a View that
matches what you describe — a name, a tag, a property value, a place in the
lineage — however large the View is. Ask in plain words, start from a recipe,
or build the query as a sentence, counted as you go. It lights the matches up
on the canvas, counts them in every container, and keeps the searches you use
again, for you or for everyone who opens the View. This page shows you how to
ask, narrow the results, act on the matches, and save the searches you reuse.

> **Note:** *The one-sentence model* — A search is a set of **filters** (joined
> with AND, OR and NOT) run over **one View**. The same filters power the quick
> search box, the Advanced Search panel, saved searches and
> [display rules](/guide/display-rules).

---

## Get started in 5 minutes

1. **Open a View** and press `⌘⇧F` / `Ctrl+Shift+F`. The **Advanced Search**
   panel opens beside the canvas, ready for filters.
2. **Add a filter** — type `dataset` into **Search by name, tag, type,
   property…** and pick **Everything of type dataset**, or choose **Add filter
   → Tags & properties → Tag is…** and pick `PII`. Each filter is a card, and
   the matches light up on the canvas as you edit.
3. **Add another** the same way. Filters join with **AND**; click it between
   two cards to match any of them instead.
4. **Narrow from the answer** — a type chip keeps one type, a breadcrumb looks
   inside a container. **Isolate** in the match bar shows only the matches and
   their containers; **Highlight** goes back.
5. **Choose Save**, name it "Customer PII", and pick **Everyone on this view**
   (or **Just me**). It's now one click away in the **Library**.

That's the whole loop: filter, refine, act on the canvas, keep. Two more ways
in sit beside the filters: **Or ask in plain words…** — `datasets that feed
dashboards` reads back what it understood, and how many it finds, before
anything runs — and the **Sentence** view, which reads the query the way you'd
say it. Not sure where to start? The empty panel offers **recipes**, each with
how many it finds in this View. For one word, the header's **Search this
view…** box (press `/`) is quicker: see [The search box](#the-search-box).

---

## Where to find it

| Surface | Where | How to open |
| --- | --- | --- |
| **Search box** | The header of a View (**Search this view…**) | Click it, or press `/` anywhere on the canvas |
| **Advanced Search panel** | The left side of the canvas | `⌘⇧F` / `Ctrl+Shift+F`, the ✨ **Refine** button in the search box, `⌘↵` in the search box, or **See all … results** in its list |
| **Search button** | The Graph and Hierarchy canvases (no header box) | Click **Search ⌘⇧F**, or press the shortcut |
| **Search Studio** | Over the canvas, opened out from the panel | **Open Search Studio** (⤢) in the panel's header, or `E` in the panel |
| **Command palette** | `⌘⇧P` / `Ctrl+Shift+P` on a Context View | **Ask about this view** or **Open Search Studio** |
| **Property Manager** | **Properties** in the View's header | **Find all using this** / **Find missing this** on a property opens the panel with that search |

---

## The search box

The search box is the fastest way in. It searches the **whole View** on the
server as you type (from two characters; **Enter** searches even one).

- **Look in** narrows where the word must appear: **Everything**, **Name**,
  **Description**, **Tags**, or any property the View's entities carry.
- **Match** chooses **Contains**, **Starts with**, **Ends with** or **Is
  exactly**.
- The list shows the **Top matches** (the first ten). **↑ / ↓**, **Home** and
  **End** move through them; **Enter** reveals one on the canvas.
- **Esc** closes the list first, then clears the search (and its highlights).
- A scope chip — **inside *Orders* ×** — means the search is limited to one
  container. Remove it with **×**.
- Your last five searches in this View come back when you focus an empty box.

What you type becomes a real filter, so **Refine** opens the panel on exactly
the same query, ready to extend.

---

## The Advanced Search panel

The panel has a header — **Search**, where it searches, **Refine**, **Library**,
**Options**, **Open Search Studio** — a query card, and the results. Resize it
from its edge: drag it, or focus it and use the arrow keys.

### Where the search runs

Pick the scope from the header's scope menu:

| Scope | What it searches | Use it when |
| --- | --- | --- |
| **All nodes in this view** *(Recommended, the default)* | Everything the View contains, including containers you haven't expanded | Almost always |
| **Visible nodes** | Only what's on the canvas right now | You want a quick answer about what's in front of you |
| **Entire data source** *(Power user)* | The whole data source, past the View's boundary — results may include entities that aren't in this View | You're looking for something the View leaves out. You confirm before it switches |

A search never shows you anything the View's own permissions don't allow: the
server works out the View's boundary itself, whatever the browser sends.

### Ask in plain words

Ask on the query card — **Or ask in plain words…** under the filters in
**Form**, at the top in **Sentence**. Type a question the way you'd say it:

| You ask | It reads as |
| --- | --- |
| `datasets tagged PII` · `#PII` · `PII columns` | Datasets with the tag · anything tagged · columns tagged |
| `unused datasets` · `dead ends` · `sources` · `orphaned columns` | The lineage shape: nothing downstream · nothing upstream · no lineage at all |
| `undocumented datasets` · `unowned datasets` | No `description` · no `owner` |
| `datasets that feed dashboards` · `dashboards fed by datasets` | A relationship, up to 3 hops — `directly` for one hop, `within 2 hops` for two |
| `datasets that feed no dashboards` · `only feed dashboards` · `feed at least 2 dashboards` | None of them · every one · a count |
| `datasets in Snowflake` · `datasets inside "Sales Ops"` · `datasets in the gold layer` | Inside a container you name · in a layer |
| `datasets owned by alice@corp` · `with more than 1M rows` · `updated in the last 7 days` | Property comparisons |
| `datasets that feed "CFO Revenue"` | A named entity, in quotes |

As you type it **reads the question back** — **Reads as**, and how many it
matches — before anything changes. A word with more than one reading, such as
a tag that is also a container's name, shows its readings as chips: pick the
one you mean. A name several entities share says so and lets you pick one.
Words it can't place are **searched for by name**, and it lists them.

**Enter** applies the question and runs it; **Esc** clears it; **↑** and **↓**
bring back earlier questions. Start with **and** — `and tagged PII` — to add to
the query rather than replace it (**The query becomes** says the result). Over
an answer, with the builder folded away, the same bar sits above the results.

> **Note:** Ask is rule-based. It reads your View's own types, tags, properties
> and layers; nothing you type is sent to an AI service.

### Building a query

An empty query card opens on filters: **Search by name, tag, type,
property…** suggests filters from this View's own data — its types, tags,
properties and their values — and **Add filter** lists every filter, grouped as
below. Pick one and it becomes a filter card. Beneath them, **Or ask in plain
words…** and the **recipes** (see [Recipes gallery](#recipes-gallery)) are two
more ways to start. Add more later with the same field under the cards, or
**+ and…** in **Sentence**:

| Category | Filters |
| --- | --- |
| **Text** | Name contains… · Qualified name contains… · Description contains… |
| **Structure** | Entity type is… · Root in view is… · Inside Subtree |
| **Tags & properties** | Tag is… · Has property… · Property compares to… |
| **Graph shape** | No upstream lineage · No downstream lineage · No lineage edges · Has upstream lineage · Has downstream lineage |
| **Relationships** | Parent is… · Top-level container is… · Any container above it… · Contains… · Fed by… · Feeds… · Is a named entity… · Inside a container named… |
| **Advanced** | Paths from A to B · Within N hops of… · Number of edges… · Every entity · AND group · OR group · NOT group |

In **Form**, rows are joined with **AND**; click an **AND** between them to
match any row (**OR**) instead. Select several rows to **Group as AND / OR** on their own, or
add a **NOT group** to exclude what it matches.
**Undo** and **Redo** step through your edits; **New** starts again.

**Text filters** match **Contains**, **Starts with**, **Ends with**, **Is
exactly**, or a **Wildcard pattern** (`*sales*`, `sales*`, `*_raw`).
Matching ignores case.

**Property filters** read the property's values and choose how to compare
them — **Compare as** Text, Number, True/false or Date — so `15` compares as a
number and `2026-01-31` as a date. Change it when the guess is wrong. The
operators follow the type:

| Compare as | Operators |
| --- | --- |
| **Text** | is · is not · contains · does not contain · starts with · ends with · is one of · is none of · is empty · is not empty · is set · is not set |
| **Number** | equals · does not equal · is greater than · is at least · is less than · is at most · is between · is one of · is none of · contains · starts with · ends with · is set · is not set |
| **True/false** | is · is not · is set · is not set |
| **Date** | is on · is not on · is after · is on or after · is before · is on or before · is between · is within the last · is set · is not set |

A property that holds a list reads **has**, **has any of**, **has all of** and
**has none of**: a list matches when any of its values does. Text compares
ignoring case unless you tick **Match case**.

> **Tip:** *Missing values.* "owner **is not** alice" leaves out entities with
> no owner at all, unless you tick **Include entities without owner**. A **NOT
> group** around "owner **is** alice" includes them. **is empty** finds a
> missing value, blank text or an empty list; **is not set** finds only a
> missing one.

### Build it as a sentence

The query card shows the same query four ways — **Form**, **Sentence**,
**Code** and **Cypher** — and you can switch at any time; the card remembers
your choice. It opens in **Form**, the filter cards; **Sentence** is the guided
alternative.

**Sentence** reads the query the way you'd say it: *Find* **datasets** *that
are tagged* **#PII** *and* **feed** **a dashboard**. Every highlighted word is
a token: click one to change it — a type, a tag, a value, a relationship's
verb, how far it reaches. A dashed **pick…** is something still to fill in.

- **+ and…** adds a line (any filter), **+ or…** an alternative, and **+
  that…** a condition on a relationship's relative.
- A line's **⋯** menu offers **Duplicate**, **Match any of…**, **Exclude
  these** and **Remove**.
- **all** or **any** after *Find* chooses whether every line must match or any
  one.
- What a sentence can't show — within N hops, a number of edges, groups nested
  very deep — says **Edit in Code**.

When the query has a relationship or a route, a **map** above the sentence
draws its shape — *Datasets* → *feed* → *Dashboard* — with each part's count.
Click a box or an arrow to change that part; **Map** folds it away.

**Form** shows the same query as cards, one per filter, with every option in
view.

### Counts as you build

Numbers arrive as you build, before anything runs:

- each **Sentence line** shows how many still match once it is added, read top
  to bottom like a funnel (hover for the line's own count);
- each box on the **map**, the **Ask** preview, every **recipe** and every
  **type chip** over the results shows its count.

A count reads **N+** while the View is still being counted. Counts need a
FalkorDB data source; elsewhere the numbers simply don't appear. On a very
large View, where a heavy line can take a while to finish counting, you can
turn them off under **Options → Live counts**: nothing is counted as you
build, and **Counts off · Turn on** above the sentence brings them back. A
line that can't be counted says why: **Counted once it is filled in**,
**Routes are found when the search runs**, or **Too many hops to count —
name the far end to go further**.

### When nothing matches

When a query would find nothing, the Sentence view marks the line where the
matches run out — **Nothing matches from here** — before anything runs, and
offers up to three fixes, each counted, one click to apply: **Without** the
line, **Match any condition, not all**, **Look up to *N* hops away**, **Any of
them, not every one**, **Contains *…*, not exactly**, or **Search the whole
view**. An empty answer over the results leads with the same line and fixes,
whichever builder you use.

### Relationships

A **relationship** filter finds entities by the entities related to them:
"datasets **whose parent is** a domain", "tables that **contain** a column
tagged PII", "anything that **feeds** a dashboard within three hops". Pick one
under **Add filter → Relationships**, then choose in the row:

- **Which relatives** — **Parent** (the container one level up), **Any
  ancestor**, **Top-level container**, **Child**, **Any descendant**, **Source
  (upstream)** (what feeds it), **Target (downstream)** (what it feeds), or
  **Linked either way**.
- **How many** — **Has a** (at least one matches), **Has no**, **Every** (every
  one matches — and there is one), or **Count** (at least, more than, exactly …
  *N* of them).
- **How far** — for lineage, how many hops (1 to 3; up to 10 when the far end
  is an entity you name); for ancestors and descendants, how many levels.
- **Through edges** — for lineage, only edges that meet a condition, such as
  `confidence` at least 0.8 or `mode` is `stream`. For a property an edge keeps
  among its own user properties, the choices are **is set**, **is not set**,
  **is**, **is not**, **is one of** and **is none of**.
- **Where the relative…** — the relative's own filters, in a builder of its
  own. Anything a query can say goes there, other relationships included — up
  to three relationships deep: "feeds a dashboard **whose parent is**
  *Finance*".

With no condition, any relative will do: **Has no** **Source** finds entities
nothing feeds.

**Name an entity instead of using its URN.** **Is a named entity…** and
**Inside a container named…** take a path of names from the top —
`Country / United Kingdom` — and say as you type how many entities it names
(**1 entity**, **3 entities**, **not found**). `**` stands for any number of
levels (`Country / ** / London`), and starting with `**` finds a name anywhere
in the View (`** / orders`). Because names mean the same everywhere, a saved
search or rule that uses them keeps working when it moves to another View or
environment. A path that names several entities uses all of them; one that
names nothing matches nothing.

**Paths from A to B** lists the routes between two ends, each end entities you
name or **Any entity where…** a condition: "every route from a topic to a
dataset, through edges in stream mode". The results become the routes. With an
end a condition, routes go up to 4 hops; with both, 3.

### Code mode

Switch the query card to **Code** to type the query instead. Every mode edits
the same query, so you can move between them freely, and the card reopens in
the mode you used last. Press `⌘↵` / `Ctrl+Enter` (or click
away) to apply, and `Esc` to undo your edit.

The editor helps as you type:

- **Colours** show how each word is read — a keyword, a property, a value, a
  relationship — and a red underline marks where a query stops making sense,
  with the reason below it.
- **Suggestions** (or `Ctrl+Space`) offer what fits where the cursor is: entity
  types after `type:`, tags after `tag:`, a property's values after
  `owner =`, edge properties inside `.via(`, and entities by name after `@"`.
  They come from this View's own data.
- **Reads as** says the query in words, and lists any words that will be
  searched as plain text in names.
- **Examples** insert a ready-made condition at the cursor.

A query that doesn't read is never applied: the one you had stays until you fix
it.

| You type | It means |
| --- | --- |
| `customer` or `"customer orders"` | Name contains the words |
| `qname:finance.sales` · `desc:revenue` | Qualified name / description contains |
| `type:dataset` · `type IN (dataset, dashboard)` | Entity type is one of |
| `tag:PII` · `tag:PII OR tag:GDPR` | Has the tag / either tag |
| `has:owner` · `has:owner*` · `has:*owner*` | Has a property named exactly / starting with / containing |
| `rowCount > 1000` · `rowCount >= 0` · `rowCount != 0` | Number comparison |
| `owner CONTAINS fin` · `STARTS WITH` · `ENDS WITH` · `NOT CONTAINS` | Text comparison on a property |
| `tier IN (gold, silver)` · `tier NOT IN (bronze)` | One of / none of |
| `rows BETWEEN 10 AND 20` | Both ends included |
| `labels CONTAINS ALL (pii, gold)` | A list holding every value |
| `owner IS SET` · `IS NOT SET` · `notes IS EMPTY` · `IS NOT EMPTY` | Presence |
| `updatedAt WITHIN LAST 30 DAYS` · `WITHIN LAST PT12H` | Relative dates |
| `noUpstream` · `noDownstream` · `noLineage` · `hasUpstream` · `hasDownstream` | Lineage shape |
| `"Asset Owner" = Bob` | A property name with spaces, quoted |
| `… AS NUMBER` · `… MATCH CASE` · `… INCLUDING MISSING` | After a property comparison: its type, case-sensitivity, and whether entities without the property match |
| `a AND (b OR c)` · `NOT tag:PII` · `!tag:PII` | Grouping; words side by side mean AND |
| `parent(type:domain)` · `root(@"Country")` · `ancestor(region = EMEA)` | Its parent is a domain · its top-level container is *Country* · any container above it has region EMEA |
| `child(type:column tag:PII)` · `descendant*..3(tag:PII)` | It contains a PII column · something PII up to three levels down |
| `upstream(type:topic)` · `downstream*..3(type:dashboard)` · `neighbor()` | Fed by a topic · feeds a dashboard within 3 hops · linked either way |
| `every child(description IS NOT EMPTY)` · `no upstream()` | Every one matches (and there is one) · none does |
| `count(child(type:column)) > 100` | How many relatives match |
| `upstream(…).via(confidence >= 0.8)` | Every edge walked meets the condition |
| `@"Country/United Kingdom"` · `inside @"Country/**/London"` | The entity named by that path · anything inside it (`\/` is a slash in a name, `\\` a backslash) |

A relationship word counts only when `(` follows it directly: `root cause` and
`parent (x)` are still a search for the words. Hops read like Cypher: `*2`
(exactly two), `*..3` (one to three), `*2..4`, and `*2..` for two levels or
more up or down the tree.

Anything the words can't spell — within N hops, a path, a depth-limited
subtree — appears as its own JSON, such as `{"kind": "withinHops", …}`, and
you can paste JSON there yourself. A quoted value always stays text:
`code = "007"` looks for the text `007`, not the number 7.

### The Cypher tab

**Cypher** shows the query in words and the Cypher it runs as — exactly what a
search sends — with its bound parameters and any notes from the compiler under
**Engine details** (folded for Business, open for Technical).
**Copy with values** gives the statement with its values written in, so it runs
as it is anywhere Cypher runs. A data source that isn't searched as Cypher says
so instead.

### Your own Cypher

If you may query the View's data source, the Cypher tab also offers **Edit and
run**: write your own read-only Cypher and run it on the data source, on
FalkorDB and Neo4j. It starts from the search's Cypher with its values written
in, so changing one thing and running it is the first thing it offers.

1. Choose **Edit and run**, change the query (or write a new one), and pick
   **Rows** (50, 200 or 1,000) and **Time** (5, 10 or 30 seconds).
2. Press **Run** (`⌘↵` / `Ctrl+Enter`). **Cancel** stops it.
3. Read the answer as a table. A node, an edge or a path is a chip that opens
   to its properties; a map or a list opens to its entries. The footer says how
   many rows came back and, when the answer was cut, why: more rows matched, or
   it was too large to show whole.
4. **Highlight on canvas** lights up the entities the answer names (any column
   holding nodes, or their `urn`). **Clear highlight** puts them out.

Things to know:

- **It reads the whole data source**, not only this View — including entities
  the View leaves out and internal bookkeeping such as rollup edges.
- **It only reads.** A query that would write, change the database, read files
  or URLs, call a plugin (`apoc.*`, `gds.*`) or use `$parameters` is refused
  before it runs, and the place in the query is underlined. `CALL` takes only
  the schema listings (`db.labels()`, `db.relationshipTypes()`,
  `db.propertyKeys()` …) and the full-text and vector index queries.
- **Every run is recorded** in the workspace's activity log, with its query,
  including the ones that are refused.
- **A run is never repeated for you.** If it fails, run it again yourself.
- On a **draft**, **Edit and run** is off: native queries read the published
  graph. Switch the View to main.

Who may: everyone whose role reads the workspace's data sources, through the
native query permission (`workspace:native-query:read`) an administrator can
remove from a role; and someone a View is shared with directly, when the share
has **Query data** on (see
[Let someone query the data source](/guide/managing-views#let-someone-query-the-data-source)). How it is kept safe is
in [Native read-only queries: security](/docs/native-queries).

### Running

**Auto** (the default) runs the query a moment after each complete edit;
**Manual** waits for **Run** — handy while you build a large query. Rows you
haven't finished are left out of the run, never guessed at.

### Recipes gallery

**Recipes** are ready-made questions, grouped by what you set out to do:
**Impact**, **Root cause**, **Governance & PII**, **Documentation gaps**,
**Ownership**, **Cleanup** and **Discovery**. Each is put in your View's own
words — *Datasets without an owner*, *Everything tagged PII or GDPR* — and
says how many it finds; one naming a type, tag or property the View doesn't
have isn't offered.

The empty query card starts with one per intent (**All *N*** shows the rest);
**Library → Recipes** and an idle **Search Studio** show them all. A recipe
ready to run runs at once. One with something to fill in — *Everything one
entity feeds*, *Find something by name* — says **fill in** and opens the query
at that blank. Picking a recipe replaces your current query.

---

## Working with results

The **match bar** above the results says how many entities match and how long
it took, and holds the canvas controls:

| Control | What it does |
| --- | --- |
| **‹ 3 of 47 ›** | Step through the matches (`J` / `K`); `Enter` flies the canvas to the current one |
| **Highlight** | Pulse the matches and dim everything else; their containers stay bright |
| **Isolate** | Show only the matches and the containers they sit in |
| **Hide** | The reverse — hide the matches, keep the rest (great for gaps: "has owner" + Hide) |
| **Frame** | Fit the canvas to every match |
| **Export** | Download every match as CSV or NDJSON (below) |
| **×** | Clear the results and the highlights |

The canvas keeps your matches highlighted after you close the panel, until you
clear the search or switch View. Collapsed containers show **N matches inside**.

A match found through a lineage relationship offers **How it matches**: the
routes from it to the relatives it was matched by, drawn as paths. **Undo**
brings the results back.

Below the bar, matches are grouped (by layer in a Context View, by parent on
the other canvases). A group's **Search inside this group** adds an *Inside
Subtree* filter for it. **Load more** fetches the next thousand; **Load all**
keeps going until every match is listed.

The answer refines the query, not just the list:

- **Narrow to** chips, when the matches are of several types, keep one type —
  each with its count — and **×** on a chip leaves that type out.
- The **breadcrumb** on a match — the containers it sits in — narrows to
  **inside** the one you click.
- A match says **why it matched**: the words it contains, or, when the query
  asks for any of several things, which of them it **meets**.

Each of these changes the query itself, so **Undo** takes it back.

On a very large View the first answer arrives quickly and keeps filling in —
**scanning N%** shows how far it has got, and the count reads **N+** until it's
exact. Nothing needs clicking.

### Exporting matches

**Export** writes every match — however many — to a **CSV** (opens in any
spreadsheet) or **NDJSON** file. Each row starts with the URN, name, type and
qualified name; add up to 200 property columns from the View's properties. The
file is prepared on the server and downloads when it's ready. (No **Export**?
Your administrator has turned off **Export graph data**.)

### Questions from the canvas

Right-click an entity in a Context View to ask about it without building
anything: **Everything inside this**, **Its children**, **What feeds this**,
**What this feeds** (each three hops; change it in the row), or **Routes from
this to…**, which opens the builder for you to say where to. On a container —
a table, a schema, a domain — the lineage questions take in everything inside
it, since a dataset's lineage often runs through its columns: **What this
feeds** is what it, or anything in it, feeds. With several
entities selected, right-click one of them for **What all *N* feed** and **What
feeds all *N***. Each opens the panel on an ordinary query you can refine,
save or turn into a rule.

---

## Search Studio

**Search Studio** opens the panel out over the canvas, with room to work:
**Open Search Studio** (⤢) in the panel's header, `E` in the panel, or
**Open Search Studio** in the command palette. It shows, side by side:

- **The query** — the same card: Ask, Sentence and map, Form, Code or Cypher.
- **The results** — the match bar, and the matches as a **Table** (name, type,
  where, matched because) or as **Cards**. Tick rows to act on them together:
  **Frame on canvas**, **Keep only these** (up to 64), **Leave these out**, or
  **Copy names**. A row's **Reveal** shows it on the canvas.
- **What the view holds** — its **Types**, **Tags** and **Properties** (with
  their commonest values), each counted exactly. Click one to add it to the
  query; in Cypher it is copied instead, ready to paste.

Narrower than 1,280 px the third pane becomes a drawer (**Show what the view
holds**); narrower than 1,024 px the three become tabs. **Esc** or **Back to
the panel** returns you, and **Reveal** and **Frame** step out of the way to
show the canvas. Before anything runs, the results pane offers every recipe.

---

## Saving and sharing searches

Every search you run is kept in **Library → Mine** automatically (the last ten
per View; pin one to keep it). To keep one on purpose, choose **Save** on the
query card:

| Save for | Where it lives | Who sees it |
| --- | --- | --- |
| **Everyone on this view** | The View's library, on the server | Everyone who can open the View. Only people who can edit the View can save here |
| **Just me** | This browser | You, in this browser only — it isn't synced or exported |

The **Library** chip opens all three places at once, with one filter box over
them:

- **Mine** — your recent, pinned and named searches. **Save with a name**
  (bookmark), **Share with everyone on this view** (if you can edit it),
  **Pin**, **Remove**.
- **This view** — the searches saved for everyone. Click one to load it.
  People who can edit the View see **Remove**, which asks once more — it
  removes the search **for everyone**.
- **Recipes** — ready-made questions in the View's own words (see
  [Recipes gallery](#recipes-gallery)).

A saved search keeps its **filters**. It doesn't keep the scope or options you
ran it with: loading it runs it the way the panel runs every search.

### Library files

The footer of the **Library** holds the View's whole library — its saved
searches **and** its [display rules](/guide/display-rules) — as a file:

- **Export library** downloads `<view name>.library.json`. Anyone who can open
  the View can export it.
- **Import library…** (people who can edit the View) brings a library file in.
  Choose how it lands — **Add what's new**, **Add everything** or **Replace** —
  and you see, item by item, what will be added, what's already here and what
  can't be imported, before anything changes.

The same actions sit at the bottom of the Property Manager's **Display rules**
tab. To put one library on every View of a data source, see
[Publishing a pack to a data source](/docs/feature-search-and-rules-reference#publish-a-pack-to-every-view-of-a-data-source).

---

## From a search to a display rule

**Tag** on the query card turns the query into a
[display rule](/guide/display-rules): every match gets a coloured chip on the
canvas, for everyone who opens the View. It needs at least one complete filter
and permission to edit the View. A rule can't use *Within N hops*, a *Path*, or
a lineage relationship of more than one hop.

---

## Keyboard shortcuts

| Keys | Where | Does |
| --- | --- | --- |
| `/` | Anywhere on the canvas | Jump into the search box |
| `⌘⇧F` / `Ctrl+Shift+F` | Anywhere on the canvas | Open or close the Advanced Search panel |
| `↑` `↓` `Home` `End` | Search box list | Move through the matches |
| `Enter` | Search box | Reveal the highlighted match (or search now) |
| `⌘↵` / `Ctrl+Enter` | Search box | Open the panel with this query |
| `Esc` | Search box | Close the list; press again to clear the search |
| `J` / `↓` · `K` / `↑` | Panel (outside a text field) | Next / previous match |
| `Enter` | Panel (outside a text field or button) | Reveal the current match on the canvas |
| `E` | Panel (outside a text field) | Open Search Studio |
| `Esc` | Search Studio | Back to the panel (closes an open picker first) |
| `Enter` · `Esc` | Ask bar | Apply the question and run it · clear it |
| `↑` `↓` | Ask bar | Bring back earlier questions |
| `←` `→` (`Shift` for more) · `Home` `End` | The panel's edge | Narrow or widen the panel · narrowest or widest |
| `⌘⇧P` / `Ctrl+Shift+P` | A Context View | **Ask about this view** · **Open Search Studio** |
| `⌘↵` / `Ctrl+Enter` | Code mode | Apply what you typed |
| `Esc` | Code mode | Undo your edit (closes the suggestions first) |
| `Ctrl+Space` | Code mode | Show suggestions |
| `⌘↵` / `Ctrl+Enter` | Your own Cypher | Run it |

---

## Recipes

Each recipe gives the clicks and the Code-mode text. Adjust the property names
to your data — the **Properties** tab of the Property Manager lists every
property the View's entities carry, with how many have it. Ready-to-run JSON
versions live in `docs/examples/search-and-rules/` in the repository.

**A table by name, in one domain.** Name contains `orders`, then choose
**Search inside this group** on the domain's group (or add **Inside
Subtree**).

```text
orders type:dataset
```

**Everything tagged PII.** Tag is… `PII` (pick `GDPR` too to match either).

```text
tag:PII OR tag:GDPR
```

**Datasets without an owner.** Entity type is `dataset`, then **Property
compares to…** `owner` **is empty**. Or start from the *Datasets without an
owner* recipe.

```text
type:dataset owner IS EMPTY
```

**Big datasets.** Entity type is `dataset` and `rowCount` **is at least**
`1000000`.

```text
type:dataset rowCount >= 1000000
```

**Orphans — no lineage in or out.** Entity type is `dataset` and **No lineage
edges**. Swap in **No upstream lineage** for sources nothing feeds.

```text
type:dataset noLineage
```

**Changed in the last month.** `updatedAt` **is within the last** 30 days.

```text
type:dataset updatedAt WITHIN LAST 30 DAYS
```

**PII outside the certified zone.** Tag is `PII`, plus a **NOT group** holding
Tag is `Certified`.

```text
tag:PII AND NOT tag:Certified
```

**Everything three hops downstream of a table.** Right-click the table and
choose **What this feeds**, or **Add filter → Relationships → Fed by…**, pick
**Is a named entity…** as its condition and type the table's path:

```text
upstream*..3(@"Sales/orders")
```

**Datasets in a domain, by its name.** **Inside a container named…**
`Sales`, then Entity type is `dataset`.

```text
inside @"Sales" type:dataset
```

**Tables with a PII column.** Entity type is `table`, then **Contains…** with
Tag is `PII` as its condition.

```text
type:table child(tag:PII)
```

**Tables where every column is described.**

```text
type:table every child(type:column description IS NOT EMPTY)
```

**Wide tables.** More than 100 columns:

```text
type:table count(child(type:column)) > 100
```

**What feeds a dashboard, through trusted edges.**

```text
downstream*..3(type:dashboard).via(confidence >= 0.8)
```

**Everything fed from inside one country.** Fed by something, within two
hops, whose container somewhere above is *Country / United Kingdom*:

```text
upstream*..2(ancestor(@"Country/United Kingdom"))
```

---

## Limits

| Limit | Value |
| --- | --- |
| Filters in one query | 64 |
| Nesting depth of groups | 6 levels |
| Filters directly inside one OR group | 24 |
| *Inside Subtree*, *Within N hops*, *Path* | Only at the top level (not inside OR or NOT, nor in a relationship's condition); one *Path* per query |
| Relationships inside relationships | 3 deep |
| Lineage hops in a relationship | 3; 10 when its far end is an entity you name, at the top level |
| Entities one name path names | 64 |
| Routes a *Path* lists | 128 |
| Saved searches per View | 500 (names unique in the View, up to 120 characters) |
| Recent searches kept per View | 10, plus any you pin |
| Export columns | 200 properties |
| Your own Cypher: rows | 200 by default, 1,000 at most |
| Your own Cypher: time | 10 s by default, 30 s at most |
| Your own Cypher: runs | 20 a minute per person; 2 at once per data source |
| Your own Cypher: query and answer | 20,000 characters; an answer of up to 8 MiB, each text value up to 2,000 characters and each list or map up to 100 entries |
| Counts as you build | FalkorDB data sources; not for a *Path*, or a filter not yet filled in |
| **Narrow to** chips | The 12 commonest types, counted when not every match is loaded |
| **Keep only these** (Search Studio) | 64 rows |

---

## Troubleshooting

| What you see | Why | What to do |
| --- | --- | --- |
| **No matches**, but you know it's there | The property name or value differs from what you typed, or the entity is outside the View | Pick the property and value from the suggestions; check the scope menu; try **Entire data source** |
| A **draft**'s new entity isn't found | Search reads the published graph; changes on a draft aren't searchable until they're published | Publish, or look in the draft's canvas directly |
| "*This view has no boundaries yet, so searching for a word on its own…*" | A plain word over **Everything**, in a View that doesn't limit itself to any entities or types, would read the whole data source | Add a type, tag or property filter, or set **Look in** to **Name** |
| "*…only allowed in the top-level AND group*" | *Inside Subtree*, *Within N hops* or *Path* sits inside an OR or NOT group | Move it to the top level of the query |
| "*between needs a lower and an upper value*", "*give a duration like P30D*" | A value can't be compared the way the filter asks | Fix the value the message names |
| "*… names no entity*" under **No matches**, or **not found** on a name | A name path is spelled differently, or starts below the top | Start at a top-level entity and name each container on the way down, or start with `**` |
| "*… follows lineage 4 hops, tested from every candidate: at most 3*" | A relationship whose far end is a condition goes 3 hops | Name the far end (**Is a named entity…**) to go up to 10, or use fewer hops |
| "*This link can't follow lineage or relationships*" | You opened the View through a share link | Open it as a member of the workspace |
| The count reads **N+** or the results say they stopped | The answer was still being counted when the time ran out | Run it again, or narrow it; **Load all** fetches every match |
| **Save** offers only **Just me** | You can't edit this View | Ask someone who can, or share the search with them |
| "*A query named … is already saved*" | Names are unique in a View (ignoring case) | Choose another name |
| **Export** is missing | The **Export graph data** feature is off | Ask your administrator |
| No **Edit and run** on the Cypher tab | You may not query this data source, it isn't FalkorDB or Neo4j, or **Native read-only queries** is off | Ask an administrator for the permission, or the View's owner to turn on **Query data** on your share |
| "*… reads files or URLs, and native queries only read*", "*… writes to the graph …*" | Your own Cypher used something native queries refuse | Remove what the underlined place names |
| "*More rows matched — these are the first …*" | The answer had more rows than **Rows** allows | Raise **Rows**, or narrow the query |
| "*The answer was too large to show whole*", "*… needs more memory than one query may use*" | Whole nodes or long lists made the answer too big | Return properties (`n.name`) instead of whole nodes, or fewer rows |
| "*You've run a lot of queries in a short time*" | 20 runs a minute is the limit | Wait a moment |
| No counts beside the Sentence lines, recipes or Ask | **Live counts** is off, the data source isn't FalkorDB, or you opened the View through a share link | Turn on **Options → Live counts**, or run the query to see its count |
| **Searched for by name: …** under the Ask bar | Those words aren't a type, tag, property, layer or container the View holds | Rephrase with the View's own words, pick a reading, or keep the name search |
| **Nothing matches from here** on a Sentence line | That line leaves nothing of what the lines above it found | Apply one of the fixes beside it, or change the line |

---

## Where to next

- [Display Rules](/guide/display-rules) — when you want to colour the canvas by
  a rule you write.
- [Tracing Lineage on the Canvas](/guide/exploring-graph) — when you've found an
  entity and want to follow its lineage.
- [Import & Export](/guide/import-export) — when you're moving a library between
  Views, or Views between environments.
- [Search & Display Rules Reference](/docs/feature-search-and-rules-reference) — when
  you need the query language, every endpoint and scripting.
- [Native read-only queries: security](/docs/native-queries) — when you
  review or operate **Edit and run**.
