# Welcome to {brand}

> **{brand} is a map for your data.** It connects to the systems where your data
> already lives and draws a living, interactive picture of how everything is
> connected — so anyone on your team can see where data comes from, where it
> goes, and what depends on it.

This guide is the **single stop-shop** for using {brand}. It is written for
*everyone* who touches the platform — not just engineers. Whether you open
{brand} once a week to check a dashboard's data source or you run the whole
platform for your organisation, there's a path here for you.

---

## What problem does {brand} solve?

Modern data lives in dozens of places: warehouses, pipelines, dashboards,
spreadsheets, models. When something breaks — or when someone asks *"where did
this number come from?"* — the answer is usually trapped in someone's head or
buried in code.

{brand} makes that knowledge **visible and shareable**:

- **See the full picture.** Every table, column, dashboard, and pipeline appears
  as a node, with the connections between them drawn as lines (we call this
  **lineage**).
- **Trace cause and effect.** Click any item to follow data *upstream* (where it
  came from) or *downstream* (what it feeds). Instantly understand the *blast
  radius* of a change before you make it.
- **Speak a shared language.** A configurable **semantic layer** (the ontology)
  means a "Dataset" or a "Domain" means the same thing to everyone, with
  consistent colours and icons.
- **Capture and share understanding.** Save any exploration as a **View** and
  share it with your team, so hard-won knowledge doesn't evaporate.

---

## Who is this guide for?

{brand} serves three broad audiences. Most people are mainly one of these, but
you can be all three on different days. Pick where you fit and start there —
each path is self-contained.

| If you mostly… | You're a… | Start with |
| --- | --- | --- |
| Look things up, read dashboards, follow lineage | **Viewer** | [Browsing Views](/guide/browsing-views) |
| Build, organise, and share graphs and views | **Builder** | [Creating Views](/guide/creating-views) |
| Connect data sources, manage users and access | **Administrator** | [Admin Setup](/guide/admin-setup) |

> **Tip:** Not sure where to begin? Read [Key Concepts](/guide/key-concepts)
> first — ten minutes there will make everything else click.

---

## How this guide is organised

- **Start Here** — the mental model. What things are called and why.
  - [Key Concepts](/guide/key-concepts) · [Quick Start](/guide/quick-start)
- **For Viewers** — finding and understanding data.
  - [Browsing Views](/guide/browsing-views) · [Reading Lineage](/guide/reading-lineage) · [Exploring the Graph](/guide/exploring-graph)
- **For Builders** — creating and curating.
  - [Creating Views](/guide/creating-views) · [Managing Views](/guide/managing-views) · [The Semantic Layer](/guide/semantic-layer)
- **For Administrators** — running the platform.
  - [Admin Setup](/guide/admin-setup) · [Users & Access](/guide/users-access) · [Governance & Operations](/guide/governance-ops)
- **Reference** — to keep nearby.
  - [Ways of Working](/guide/ways-of-working) · [Glossary & Acronyms](/guide/glossary) · [Troubleshooting](/guide/troubleshooting)

---

## A note on the "why"

{brand} is opinionated by design. A few principles shape almost every screen:

1. **One graph, many lenses.** The underlying data is a single connected graph.
   Everything you do — filtering, tracing, changing granularity, switching
   persona — is a *lens* over that one graph, never a separate copy.
2. **Read-friendly first.** Looking is safe and never changes anything. You have
   to deliberately choose to edit, save, or share.
3. **Shared context beats personal context.** Saved Views and a common semantic
   layer mean the team builds a *collective* understanding over time.

Understanding these three ideas is the fastest way to feel at home. Ready?
Head to [Key Concepts](/guide/key-concepts) or jump into the
[Quick Start](/guide/quick-start).
