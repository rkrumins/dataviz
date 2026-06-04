# Ways of Working

*For everyone.* Tools don't create good practice — people do. This page collects
the conventions and habits that make Synodic genuinely useful for a *team*,
rather than a pile of personal bookmarks. Adopt what fits; agree on it together.

> 💡 **The north star:** a newcomer should be able to open your workspace and
> understand your data landscape *without asking anyone*. Everything below serves
> that goal.

---

## Naming conventions

Consistent names make search and the gallery do the organising for you.

**Views** — name by *audience + subject + intent*:

- ✅ `Finance → Revenue dashboard lineage`
- ✅ `[Golden] Customer 360 — table level`
- ❌ `view2`, `test`, `my graph`

Suggested prefixes your team can standardise on:

| Prefix | Meaning |
| --- | --- |
| `[Golden]` | Canonical, trusted reference |
| `[WIP]` | Work in progress, don't rely on yet |
| `[Deprecated]` | Superseded; will be removed |

**Workspaces** — name by team or domain (`Finance`, `Marketing Analytics`), not by
person.

---

## Tagging strategy

Tags are how Views get *found*. Agree on a **small, shared vocabulary** and stick
to it — five good tags beat fifty ad-hoc ones.

- **By domain:** `finance`, `marketing`, `hr`
- **By cadence:** `daily-load`, `realtime`, `batch`
- **By status:** `golden`, `wip`, `deprecated`

Document your team's tag list somewhere central and review it occasionally. Tag
sprawl is the main reason galleries become unsearchable.

---

## Choosing the right granularity

Match the altitude to the audience and the question:

| Audience / goal | Granularity |
| --- | --- |
| Executive overview, onboarding | **Domain / Business** |
| Everyday tracing and reviews | **Table / Dataset** |
| Precise impact analysis, debugging | **Column / Field** |

When sharing with stakeholders, also flip the **persona toggle** to **Business**
so names read in plain language. See [Reading Lineage](/guide/reading-lineage).

---

## Collaboration and sharing etiquette

- **Share at the right scope.** Personal for drafts, Team for shared references,
  Enterprise for genuinely canonical Views. Don't default everything to
  Enterprise — it creates noise.
- **Least access first.** Grant the narrowest visibility/role that works; widen on
  request. See [Users & Access](/guide/users-access).
- **Co-own important Views.** Add an *editor* grant to a colleague so a key View
  survives someone's holiday — or departure.
- **Explain in the description.** The "why" belongs in the View's description, not
  in someone's memory.

---

## Keeping things tidy (housekeeping)

A small, regular tidy-up keeps the platform trustworthy:

| When | Do |
| --- | --- |
| As you go | Name and tag every View you save |
| Monthly | Retire/deprecate stale Views; fix inconsistent tags |
| Quarterly | Review workspace membership and roles for drift |

Use the per-workspace **Views Manager** for bulk clean-ups
(see [Managing Views](/guide/managing-views)).

---

## Recommended workflows

### Investigating an issue
1. Search for the affected item in the **Explorer**.
2. **Trace upstream** to find the source of the problem.
3. Drill to **column** granularity to pinpoint it.
4. **Save the View** and share it with the responsible team — don't let the
   investigation evaporate.

### Onboarding a new team member
1. Point them at this **User Guide** and [Key Concepts](/guide/key-concepts).
2. Share a `[Golden]` View that maps your core data landscape.
3. Have them do the [Quick Start](/guide/quick-start) in your real workspace.

### Briefing a stakeholder
1. Open a **domain-level** View with the **Business** persona on.
2. Walk the flow left-to-right (sources → consumers).
3. Save a tailored View if you'll repeat the briefing.

---

## Anti-patterns to avoid

- ❌ **Hoarding personal Views** of things the team needs — share them.
- ❌ **Everything Enterprise-visible** — it drowns the genuinely canonical Views.
- ❌ **Cramming one View with everything** — make focused Views that answer one
  question each.
- ❌ **Editing data source / ontology without communicating** — announce changes
  that affect others.

---

## Where to next

- The vocabulary behind it all → [Key Concepts](/guide/key-concepts) ·
  [Glossary](/guide/glossary)
- Build well from the start → [Creating Views](/guide/creating-views)
- Admin-side governance → [Governance & Operations](/guide/governance-ops)
