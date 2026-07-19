# Troubleshooting

*For everyone.* Common situations and how to resolve them, grouped by who usually
hits them. Most issues come down to **wrong workspace, missing access, or an
unhealthy provider** — start there.

> **Tip:** *First three checks, every time* — (1) Am I in the right
> **workspace**? (2) Do I have **access** to this thing? (3) Is the **provider
> healthy**? These resolve the majority of problems.

---

## For everyone

### I can't find a View someone shared with me
- You may not have **access** — its visibility could be too narrow, or it wasn't
  shared with you explicitly. Ask the owner to set Team/Enterprise visibility or
  grant you access. See [Browsing Views](/guide/browsing-views).
- You might be in the **wrong workspace**. Views belong to a workspace — open
  **Workspaces** from the sidebar to see the ones you have access to, then enter
  the one you want. Each screen shows you which workspace you're in; there's no
  separate global switcher to keep in sync.

### A View or the Explorer looks empty
- Check that you're in the right **workspace** for what you're trying to see — an
  empty picture usually means you're not where you think you are.
- The workspace's **data source** may be missing or its provider unhealthy. Ask an
  admin to confirm (see admin section below).

### I can't edit a View
- You likely have **viewer** access only. Ask the owner for an **editor** grant.
  See [Managing Views](/guide/managing-views).

### "What am I actually allowed to do?"
- Open your **My Access** page — it lists your roles, scopes, and permissions in
  plain language. See [Users & Access](/guide/users-access).

### The graph is hard to read / too busy
- Reduce **entity types** shown, raise the **granularity** (table or domain), and
  use **layers**. Hit **Fit** to recenter and open the **minimap**. See
  [Exploring the Graph](/guide/exploring-graph).

---

## For Builders

### My saved View doesn't look the way I left it
- Confirm you're opening the right **version/workspace**. If colours or types
  changed, the underlying **ontology** may have been updated — check with an
  admin. Published ontologies are immutable precisely to prevent this, so a change
  implies a new version was assigned. See [The Semantic Layer](/guide/semantic-layer).

### My View is too slow to load
- It's probably showing **too much**. Trim entity types, raise granularity, and
  split one giant View into several focused ones. See
  [Creating Views](/guide/creating-views).

### Teammates can't discover my View
- Set the right **visibility** (Team/Enterprise) and add **tags** from your
  team's agreed vocabulary. See [Ways of Working](/guide/ways-of-working).

---

## For Administrators

### Users report "No data source for workspace"
- The workspace has no **data source binding**. Bind a catalog item + ontology in
  the workspace. This is the single most common setup gap. See
  [Admin Setup](/guide/admin-setup), Step 5.

### The graph is empty or stale for everyone
- Check **provider health** in Admin/Ingestion. An unhealthy provider means no
  fresh data. Re-test connectivity; fix credentials/network. See
  [Governance & Operations](/guide/governance-ops).

### Domain-level granularity is missing or slow
- The data source's **aggregation** job may not be **ready**. Check and re-run it
  from the data source settings.

### A new user can't log in
- Their signup may still be **pending** — approve it in **Admin → Users**. Confirm
  the account isn't **suspended**. See [Users & Access](/guide/users-access).

### Someone has too much / too little access
- Review their **role bindings** and **scope** (global vs workspace), and any
  **group** memberships. Prefer adjusting the **group** over the individual.

### I changed an ontology and many Views shifted
- That's expected if a new version was assigned — check the **audit trail** to see
  what changed and when. Re-assign the previous published version if needed.

---

## Still stuck?

- Re-read the relevant persona page in this guide — most "how do I…?" answers live
  there.
- Check the [Glossary](/guide/glossary) if a term is unclear.
- For deep technical detail (deployment, APIs, architecture), see the
  engineer-focused [documentation](/docs).
