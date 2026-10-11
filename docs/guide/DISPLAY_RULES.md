# Display Rules

*For Builders.*

A display rule puts a coloured tag on every entity that matches criteria you
write — **PII**, **Needs owner**, **Certified** — so the canvas answers a
question at a glance. This page shows you how to create rules, keep them in
order, and share them with other Views.

> **Before you start:** Rules belong to a View: everyone who opens it sees the
> same tags, and the data itself is never changed. To create or change rules
> you need to be able to edit the View — see
> [Who sees rules, and who can change them](#who-sees-rules-and-who-can-change-them).

> **Note:** *The one-sentence model* — A rule is a **label, a colour, an
> optional icon and a search**. Every entity the search matches, inside the
> View, wears the rule's chip.

---

## Get started in 5 minutes

1. **Open a View** you can edit and choose **Properties** in its header. The
   **Property Manager** opens on the **Display rules** tab.
2. Choose **Create your first rule** (or **New rule**).
3. Type a **Tag label** — `PII` — pick the red swatch and the **ShieldCheck**
   icon. The preview chip updates as you go.
4. Under **Apply this tag to entities where…**, choose **Add filter → Tags &
   properties → Tag is…** and pick `PII`. A moment later the editor says how
   many entities will be tagged.
5. Choose **Create rule** (or press `⌘↵` / `Ctrl+Enter`). Every matching entity
   on the canvas now wears a red **PII** chip.
6. On the rule's card, **Show every match in search** (the crosshair) opens
   Advanced Search with every match in the View listed and highlighted.

---

## What a rule is

| Part | What it does |
| --- | --- |
| **Tag label** | The chip's text. Unique in the View (ignoring case), up to 120 characters |
| **Colour** | The chip's colour, from eight swatches |
| **Icon** | Optional: one of twelve icons (Tag, ShieldCheck, AlertTriangle, Star, Flag, Lock, Eye, Database, Users, Sparkles, CircleDot, Bookmark) |
| **Criteria** | The same filters as [Advanced Search](/guide/advanced-search) — types, tags, properties, text, lineage shape, groups |
| **On / off** | A rule that's off is kept, but tags nothing |

**Every rule that matches adds its chip** — there's no winner and no priority.
The order of the rules is the order of the chips. An entity shows up to three
chips; the rest collapse into **+N**, which lists them all on hover.

A rule only ever tags entities **inside its View**, whatever its criteria say.
Chips appear in the rows of a Context View and on the cards of the Graph and
Hierarchy canvases (a Graph card at its smallest zoom leaves them out).

---

## Where to find it

- **Properties** in the header of a Context View, and on the Graph and
  Hierarchy canvases, opens the **Property Manager**. Its **Display rules** tab
  lists the View's rules; its **Properties** tab lists every property the
  View's entities carry.
- **Tag** on the Advanced Search query card turns the current search into a
  rule.

---

## Three ways to create a rule

**From scratch.** **Display rules → New rule**, then a label, colour, icon and
criteria. The editor counts the matches as you build (**Refresh** asks again).

**From a property or a tag.** On the **Properties** tab, open a property and
choose **Tag matches as rule**: the editor opens with "has this property" as
its criteria and the property's name as its label. Click a tag to start a
rule for that tag the same way. Rename it, choose a colour, save.

**From a search.** Build the search in [Advanced Search](/guide/advanced-search)
— visually or in Code mode — and choose **Tag** on the query card. The
**Create display rule** window opens with the search as its criteria. This is
also the way to write criteria as text: the rule editor itself is visual only.

`Esc` cancels the editor; `⌘↵` / `Ctrl+Enter` saves.

---

## Managing rules

Each rule's card has:

| Control | What it does |
| --- | --- |
| **Move up / Move down** | Change the rule's place, and so the order of the chips |
| **On/off switch** | Stop or resume tagging without losing the rule |
| **Show every match in search** | Open Advanced Search with every match in the View |
| **Edit rule** | Change anything about it |
| **Delete rule** | Remove it at once, for everyone — there's no undo, so export the library first if you may want it back |

The line under the chip says how many entities in the View match:

| It says | Meaning |
| --- | --- |
| **N matches in this view** | The exact count |
| **N so far · counting P%** | Still counting a large View — it finishes on its own |
| **At least N · count stopped** | The count stopped part-way; hover for why |
| **Can't be counted** | The criteria can't be run as a rule — hover for why, then edit it |
| **Disabled** | The rule is off |

Chips are worked out for the entities loaded on the canvas; the count covers
the whole View.

---

## Who sees rules, and who can change them

- **Everyone who can open the View** sees its rules, their chips and counts, can
  **Show every match in search** and can **Export** them.
- **People who can edit the View** — its creator, workspace members and admins
  with *edit views*, and anyone given the **Editor** role on it — can create,
  change, reorder, switch, delete and import rules. Others see "Only people who
  can edit this view can change them", and **Tag** in search is greyed out.

A change is saved the moment you make it. Someone who already has the View open
sees it the next time they open the View. Two people changing *different*
rules at the same time both keep their changes.

### Rules on a draft

While a [**draft**](/guide/editing-in-a-draft) of the View's data source is
open, rule changes belong to that draft: the published View keeps its rules
until the draft is published.
Then the two are merged rule by rule — a rule the draft added, changed or
removed takes the draft's version, and every other rule keeps the published
one, including rules added to the published View in the meantime.

Rules are part of the View's design, so a **View version** keeps them and
restoring a version brings its rules back.

---

## Sharing rules with other Views

A View's rules — and its saved searches — travel as a **library file**
(`<view name>.library.json`).

1. In the source View: **Property Manager → Display rules → Export** (at the
   bottom), or **Export library** at the bottom of Advanced Search's
   **Library**.
2. In the target View: **Import…** (or **Import library…**) and choose the
   file.
3. Choose how it lands:

   | Choice | What it does |
   | --- | --- |
   | **Add what's new** | Adds what the View doesn't have. A rule with the same name *and* criteria is skipped |
   | **Add everything** | Adds every rule and search. A name already in use gets a number: "PII (2)" |
   | **Replace** | Removes the View's rules **and saved searches**, then adds the file's |

4. **Review** the list: each item says **Add**, **Already here** or **Can't
   import** (with the reason), and warns when a rule names entity types this
   View doesn't show — it would tag nothing here. Nothing has changed yet.
5. Choose **Import**.

Imported rules get new identities, so importing the same file twice with **Add
everything** gives you two copies. A rule the file got wrong is refused on its
own; the rest still import.

> **Tip:** Want the same rules on **every View of a data source**? There's no
> data-source-wide rule set — rules always belong to a View — but a script can
> import one library file into each of them. See
> [Publishing to a data source](/docs/feature-search-and-rules-reference#publish-a-pack-to-every-view-of-a-data-source).

When a whole View moves between environments (a **View file**, see
[Import & Export](/guide/import-export#moving-views-between-environments)), its
display rules go with it; its saved searches don't — export the library for
those.

---

## Recipes

Each recipe gives the clicks, and the criteria as JSON — paste that into
Advanced Search's Code mode, then **Tag**. Adjust property names to your data.
The example library files in `docs/examples/search-and-rules/packs/` hold these
rules ready to import.

**PII.** New rule `PII`, red, **ShieldCheck**. **Tag is…** `PII` (add
`GDPR-Sensitive` to catch either).

```json
{"kind": "tag", "op": "hasAny", "values": ["PII", "GDPR-Sensitive"]}
```

**Needs owner.** Amber, **AlertTriangle**. **Entity type is…** `dataset`, and
**Property compares to…** `owner` **is empty** — missing, blank or an empty
list. (Or on the **Properties** tab: `owner` → **Find missing this** → **Tag**.)

```json
{"kind": "group", "op": "and", "children": [
  {"kind": "entityType", "op": "in", "values": ["dataset"]},
  {"kind": "property", "key": "owner", "op": "isEmpty"}
]}
```

**Orphan.** Indigo, **CircleDot**. **Add filter → Graph shape → No lineage
edges**: nothing flows in or out.

```json
{"kind": "isOrphan", "edgeClass": "lineage"}
```

**Certified.** Emerald, **Star**. An **OR group** of **Tag is…** `Certified`
and `certified` **is** true (compare as True/false).

```json
{"kind": "group", "op": "or", "children": [
  {"kind": "tag", "op": "has", "values": ["Certified"]},
  {"kind": "property", "key": "certified", "op": "eq", "value": true, "valueType": "boolean"}
]}
```

**Stale.** Amber, **Flag**. A **NOT group** around `updatedAt` **is within
the last** 90 days — so entities with no `updatedAt` are tagged too.

```json
{"kind": "group", "op": "and", "children": [
  {"kind": "entityType", "op": "in", "values": ["dataset"]},
  {"kind": "group", "op": "not", "children": [
    {"kind": "property", "key": "updatedAt", "op": "withinLast", "value": "P90D", "valueType": "date"}
  ]}
]}
```

**Empty table.** Pink, **Database**. `rowCount` **equals** `0` (compare as
Number).

```json
{"kind": "property", "key": "rowCount", "op": "eq", "value": 0, "valueType": "number"}
```

---

## Limits

| Limit | Value |
| --- | --- |
| Rules per View | 200 |
| Tag label | 120 characters, unique in the View |
| Criteria | 64 filters, 6 levels of groups, 24 filters in one OR group |
| Not allowed in a rule | *Within N hops*, *Path*, *Inside Subtree* inside an OR or NOT group |
| Chips shown per entity | 3, then **+N** |
| A library file | 200 rules and 500 saved searches |

---

## Troubleshooting

| What you see | Why | What to do |
| --- | --- | --- |
| "Couldn't save the rule — A rule named '…' already exists in this view." | Labels are unique in a View, ignoring case | Choose another label, or edit the existing rule |
| "A rule can't use 'within hops' or a path…" | Those describe a route through the graph; a rule asks about one entity at a time | Use a lineage-shape filter (No upstream lineage…) or keep it as a saved search |
| "…only allowed in the top-level AND group" | *Inside Subtree* sits inside an OR or NOT group | Move it to the top level |
| **Can't be counted** on a card | The rule arrived with a View file or a restored version and its criteria can't run as a rule | Hover for the reason, then **Edit rule** and save it again |
| No **New rule**, **Edit** or **Import…** | You can't edit this View | Ask someone who can, or for the **Editor** role on it |
| "Missing permission: workspace:view:edit" | The same, from an import or a script | As above |
| A rule matches nothing | A property name or value differs, the rule names a type the View doesn't show, or the rule is off | **Show every match in search** and adjust the criteria there; check the switch |
| A colleague doesn't see your new rule | Their View was open before you saved | They reopen the View |
| Chips missing on the Graph canvas | Cards at the smallest zoom leave chips out | Zoom in |

---

## Where to next

- [Advanced Search](/guide/advanced-search) — when you want to build the search behind a rule, or see every match.
- [Import & Export](/guide/import-export#view-libraries-rules-and-saved-searches) — when you want to move a rule library, or a whole View, somewhere else.
- [Search & Display Rules Reference](/docs/feature-search-and-rules-reference) — when you need the rule and pack formats, every endpoint, or scripting.
