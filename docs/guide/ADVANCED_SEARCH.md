# Advanced Search

*For Viewers and Builders.* Advanced Search finds every entity in a View that
matches what you describe — a name, a tag, a property value, a place in the
lineage — however large the View is. It lights the matches up on the canvas,
counts them in every container, and keeps the searches you use again, for you
or for everyone who opens the View.

> **Note:** *The one-sentence model* — A search is a set of **filters** (joined
> with AND, OR and NOT) run over **one View**. The same filters power the quick
> search box, the Advanced Search panel, saved searches and
> [display rules](/guide/display-rules).

---

## Get started in 5 minutes

1. **Open a View** and press `/`. The **Search this view…** box in the header
   takes the keystroke.
2. **Type a word** — say `customer`. After two characters {brand} searches the
   *whole* View on the server, not just what's on screen, and lists the **Top
   matches** with the path to each one.
3. **Press Enter** (or click a match) to fly the canvas to it, expanding
   whatever it sits inside.
4. **Press `⌘↵` / `Ctrl+Enter`** to open the **Advanced Search panel** with the
   same query. Every match is listed, grouped by layer, and highlighted on the
   canvas; collapsed containers show how many matches they hold.
5. **Choose Refine** and add a filter: **Add filter → Tags & properties →
   Tag is…** and pick `PII`. The results update as you edit.
6. **Try Isolate** in the match bar to show only the matches and their
   containers, then **Highlight** to go back.
7. **Choose Save**, name it "Customer PII", and pick **Everyone on this view**
   (or **Just me**). It's now one click away in the **Library**.

That's the whole loop: type, refine, act on the canvas, keep.

---

## Where to find it

| Surface | Where | How to open |
| --- | --- | --- |
| **Search box** | The header of a View (**Search this view…**) | Click it, or press `/` anywhere on the canvas |
| **Advanced Search panel** | The left side of the canvas | `⌘⇧F` / `Ctrl+Shift+F`, the ✨ **Refine** button in the search box, `⌘↵` in the search box, or **See all … results** in its list |
| **Search button** | The Graph and Hierarchy canvases (no header box) | Click **Search ⌘⇧F**, or press the shortcut |
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
**Options** — a query card, and the results. It can be resized from its edge.

### Where the search runs

Pick the scope from the header's scope menu:

| Scope | What it searches | Use it when |
| --- | --- | --- |
| **All nodes in this view** *(Recommended, the default)* | Everything the View contains, including containers you haven't expanded | Almost always |
| **Visible nodes** | Only what's on the canvas right now | You want a quick answer about what's in front of you |
| **Entire data source** *(Power user)* | The whole data source, past the View's boundary — results may include entities that aren't in this View | You're looking for something the View leaves out. You confirm before it switches |

A search never shows you anything the View's own permissions don't allow: the
server works out the View's boundary itself, whatever the browser sends.

### Building a query

An empty query card shows a search field ("add a filter") and example queries
drawn from this View's own data. Pick a suggestion — an entity type, a tag, a
property or one of its values — and it becomes a filter row. Or use **Add
filter**:

| Category | Filters |
| --- | --- |
| **Text** | Name contains… · Qualified name contains… · Description contains… |
| **Structure** | Entity type is… · Root in view is… · Inside Subtree |
| **Tags & properties** | Tag is… · Has property… · Property compares to… |
| **Graph shape** | No upstream lineage · No downstream lineage · No lineage edges · Has upstream lineage · Has downstream lineage |
| **Advanced** | Path from A to B · Within N hops of… · Number of edges… · Every entity · AND group · OR group · NOT group |

Rows are joined with **AND**; click an **AND** between them to match any row
(**OR**) instead. Select several rows to **Group as AND / OR** on their own, or
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

### Code mode

Switch the query card from **Visual** to **Code** to type the query instead.
Both modes edit the same query, so you can move between them freely. Press
`⌘↵` / `Ctrl+Enter` (or click away) to apply.

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

Anything the words can't spell — within N hops, a path, a depth-limited
subtree — appears as its own JSON, such as `{"kind": "withinHops", …}`, and
you can paste JSON there yourself. A quoted value always stays text:
`code = "007"` looks for the text `007`, not the number 7.

### Running

**Auto** (the default) runs the query a moment after each complete edit;
**Manual** waits for **Run** — handy while you build a large query. Rows you
haven't finished are left out of the run, never guessed at.

### Templates

**Library → Templates** starts you from a ready-made query. The **Featured**
ones — *Overview*, *All datasets*, *PII tagged*, *No lineage*, *No
downstream*, *No upstream*, *PII spread*, *No owner*, *Lineage gaps*,
*Orphans by layer* — cover the common questions; the full list adds
paths, hops, top-N by a property and more. Picking one replaces your current
filters.

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

Below the bar, matches are grouped (by layer in a Context View, by parent on
the other canvases). A group's **Search inside this group** adds an *Inside
Subtree* filter for it. **Load more** fetches the next thousand; **Load all**
keeps going until every match is listed.

On a very large View the first answer arrives quickly and keeps filling in —
**scanning N%** shows how far it has got, and the count reads **N+** until it's
exact. Nothing needs clicking.

### Exporting matches

**Export** writes every match — however many — to a **CSV** (opens in any
spreadsheet) or **NDJSON** file. Each row starts with the URN, name, type and
qualified name; add up to 200 property columns from the View's properties. The
file is prepared on the server and downloads when it's ready. (No **Export**?
Your administrator has turned off **Export graph data**.)

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
- **Templates** — the built-in starting points.

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
and permission to edit the View. A rule can't use *Within N hops* or a *Path*.

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
| `Enter` | Panel (outside a text field) | Reveal the current match on the canvas |
| `⌘↵` / `Ctrl+Enter` | Code mode | Apply what you typed |

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
compares to…** `owner` **is empty**. Or run the *No owner* template.

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

**Everything three hops downstream of a table.** **Add filter → Advanced →
Within N hops of…**, then set the URN, hops and direction in the JSON it adds:

```json
{"kind": "withinHops", "urns": ["urn:li:dataset:orders"], "hops": 3, "direction": "out", "edgeClass": "lineage"}
```

---

## Limits

| Limit | Value |
| --- | --- |
| Filters in one query | 64 |
| Nesting depth of groups | 6 levels |
| Filters directly inside one OR group | 24 |
| *Inside Subtree*, *Within N hops*, *Path* | Only at the top level (not inside OR or NOT); one *Path* per query |
| Saved searches per View | 500 (names unique in the View, up to 120 characters) |
| Recent searches kept per View | 10, plus any you pin |
| Export columns | 200 properties |

---

## Troubleshooting

| What you see | Why | What to do |
| --- | --- | --- |
| **No matches**, but you know it's there | The property name or value differs from what you typed, or the entity is outside the View | Pick the property and value from the suggestions; check the scope menu; try **Entire data source** |
| A **draft**'s new entity isn't found | Search reads the published graph; changes on a draft aren't searchable until they're published | Publish, or look in the draft's canvas directly |
| "*This view has no boundaries yet, so searching for a word on its own…*" | A plain word over **Everything**, in a View that doesn't limit itself to any entities or types, would read the whole data source | Add a type, tag or property filter, or set **Look in** to **Name** |
| "*…only allowed in the top-level AND group*" | *Inside Subtree*, *Within N hops* or *Path* sits inside an OR or NOT group | Move it to the top level of the query |
| "*between needs a lower and an upper value*", "*give a duration like P30D*" | A value can't be compared the way the filter asks | Fix the value the message names |
| The count reads **N+** or the results say they stopped | The answer was still being counted when the time ran out | Run it again, or narrow it; **Load all** fetches every match |
| **Save** offers only **Just me** | You can't edit this View | Ask someone who can, or share the search with them |
| "*A query named … is already saved*" | Names are unique in a View (ignoring case) | Choose another name |
| **Export** is missing | The **Export graph data** feature is off | Ask your administrator |

---

## Where to next

- Colour the canvas by a rule you write → [Display Rules](/guide/display-rules)
- Moving a library between Views, and Views between environments → [Import & Export](/guide/import-export)
- The query language, every endpoint and scripting → [Search & Display Rules Reference](/docs/feature-search-and-rules-reference)
