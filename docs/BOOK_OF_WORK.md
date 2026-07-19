# Context View Canvas — Book of Work

Living backlog for the Context View lineage canvas. Captures what shipped on
`claude/canvas-lineage-edges-disappear-bhstlt`, the engineering invariants that
work established, and the prioritized road ahead.

---

## Governing invariants (hard-won — do not regress)

1. **Never lose data silently.** Every cap, truncation, or fetch failure is
   surfaced (banners, chips, counts). Loading is strictly additive.
2. **Never draw ambient geometry to estimated positions.** Edges anchor only
   to real, rendered DOM (cards, rail chips). Estimated-position layers read
   as broken and were removed twice.
3. **Every rendering layer has an explicit budget.** Ambient edges = edge
   budget; focus fans capped; rail = 5 chips/column; ribbons = 12; badge
   partners = 8; hit layer = 1200.
4. **Layout must be truthful.** Scrollable area == visible content. CSS
   `zoom` (not transform) for canvas zoom; scrollbar gutters measured and
   subtracted; viewport-pinned chrome lives in sticky scrollport layers,
   never in content space (content-space chrome self-extends scrolling).
5. **Overlay→React feedback is fingerprint-gated and store-isolated.** The
   overlay emits through dedicated stores (`columnPeriphery`) or gated
   callbacks so a per-frame compute pass can never re-render the canvas in a
   loop (see: edge-flashing oscillator postmortem).
6. **Counts have units, and units never mix.** Rows vs connections vs
   entities are labeled, subtracted only from their own kind, and calculated
   per layer.
7. **Every mode has a visible, labeled exit.** Framed mode chrome, Lens ✕,
   Esc hints shown beside the actions they mirror.

---

## Shipped on this branch (reference)

| Area | Outcome |
|---|---|
| Silent-loss audit (A1–A7) | Edge-fetch failure banner + retry; unresolved/unassigned chips; coverage-gated delegation; aggregated detail paging; cross-page sibling lineage; truncation heuristics |
| Adaptive edge density | Edge Budget (strongest-first, user-tweakable 100–2000), focus fan cap, status chips, flow ribbons (opt-in), density gutters, hairline in/out indicators |
| Zoom | CSS `zoom`-based (layout-truthful), fit-to-width, presets, redraw wiring |
| Lineage Lens | Ego-graph overlay, grouped/searchable, re-center stack, entry points: drawer, `f`, right-click "Focus Connections", overflow chips |
| Lens on-demand fetch | Every visited focal node's true 1-hop lineage + partner names fetched from the provider on open/walk/drill (lens-local, never mutates canvas scope); O(degree) indexed derivation; per-node loading/error/truncation narration; drill fetches an aggregate's underlying edges via the expandEdge pair query |
| Lens walkable containment | Containers whose relationships live at child level no longer dead-end: containment edges fetched per visited node; walkable "Contains" group in walk columns + contained-entities band in classic mode (distinct visual grammar — a descent never masquerades as a flow hop); hover row actions replace the chevron in-flow instead of overlaying the label |
| Lens column organization | Flow partners grouped by their PARENT dataset (partner containment parents fetched per focal; clickable group headers re-center on the parent); per-column entity-type filter chips (toggled-off types keep their count — explicit choice, not silent loss); coarser-grain partners (containers/platforms, detected via the schema hierarchy's transitive canContain closure) demoted to a labeled muted "Rollups" tier with badges; headline counts split per grain ("N direct · M rolled-up · contains K"); parent breadcrumbs on walk rows. Walk columns share the same organization: parent-group headers that walk into the parent, frontier grain chips (lens-global filter), rollup tier, hidden-count notes; off chips render ghost (dashed + EyeOff), never strikethrough |
| Anchor Rail (phase 1) | Selection-scoped docked partner proxies; real-DOM chip anchoring; click-to-reveal; "+N more · Open lens" |
| Framed mode | Explicit exit chrome with Esc hint; unified entry from Frame pill and Lens "Reveal all" |
| Column periphery | Edge scrims ("↑ N more · M connections") with named-partner hover panels, per-layer calculated, store-isolated |
| Stability fixes | Edge-flash oscillator (predicate memoization + emission guards + visibility seeding); phantom vertical scroll; infinite horizontal scroll (sticky badge layer); scrollbar-gutter clipping; expansion reveal; disappearing-nodes-on-expand |

---

## P1 — Committed next

### 1. Horizontal navigation component ("Layer Strip")
**Problem:** with many layers the only horizontal navigation is raw
scrolling; nothing shows where you are or lets you jump.
**Direction:** a slim docked strip (bottom-center of the canvas frame, sticky
— never in content space) with one chip per layer (color dot + name +
loaded count), current-viewport window highlighted, click-to-jump
(smooth-scroll the column into view), drag-to-pan. In edit mode the strip
ends with the existing "+ add layer" affordance so creation stays one
deliberate action. Fit-to-width lives on the strip too. This subsumes the
"scroll forever" concern: scroll extent is already truthful (fixed); the
strip makes long canvases *navigable*.
**Effort:** M. **Value:** high (orientation + navigation for every user).

### 2. Resizable layer columns
**Problem:** fixed 320px expanded width truncates long names and wastes
space on sparse layers.
**Direction:** drag handle on the column's right edge; min 260 / max 560px;
double-click resets. Width persisted per layer in the view layout (draft
persists via existing `persistReferenceLayout`; published views read-only
default). `computeFitZoom` and the geometry registry already read live
rects, so no math changes — only the width constant becomes per-layer.
**Effort:** S–M. **Value:** high for wide/technical names.

### 3. Collapsible Display Settings sections
**Problem:** the popover now scrolls vertically and is capped — hard to
scan.
**Direction:** yes — accordion sections (Zoom & Layout / Lineage / Density &
Chrome), persisted open/closed state, section headers show the active value
inline (e.g. "Lineage · Adaptive · budget 800") so a collapsed section still
communicates its state — consistent with the "toggles narrate their state"
principle.
**Effort:** S. **Value:** medium (daily-touched surface).

### 4. Anchor Rail phase 1.5 — hover with linger
Hover-scoped rail (not just selection) with a ~300ms linger + hover-bridge
so moving the pointer toward a chip doesn't dismiss it. Unlocks zero-click
"where does this go" while browsing.
**Effort:** S. **Value:** high.

### 4b. Column widths in the view definition (backend persistence)
Custom layer widths currently persist per-browser (localStorage). Promote
them into the view layout (`referenceLayout` → per-layer `width`), saved via
the existing `persistReferenceLayout` path in draft mode and read by all
viewers of a published view — a curated view then ships its column widths to
every consumer. Keep localStorage as the viewer-local override.
**Effort:** S–M (schema field + save/read wiring). **Value:** medium-high
for shared curated views.

## P2 — Near-term

5. **Anchor Rail phase 2 — ambient top-K** per column in Adaptive mode
   (budget-ranked, scroll-settle damping, incumbent stickiness).
6. **Rail phase 3** — fold left/right badges into rail overflow; searchable
   per-column popover.
7. **Root pagination beyond 200** — the initial per-layer root load caps at
   200 with no root-level load-more (children are properly paginated; roots
   are not). Needed before any source exceeds 200 roots in one layer.
8. **External-degree backend endpoint** (`docs/FOLLOW_UP_EXTERNAL_DEGREE.md`)
   — the only true fix for "no lineage vs lineage outside this view" in
   curated views.
9. **Display Settings: per-section reset** + surfacing the edge budget
   slider when Adaptive is active from the header menu.

## P3 — Later / research

10. **WebGL "Show all" layer** for full-set rendering beyond the DOM ceiling.
11. **Minimap** (2D overview). Re-evaluate after the Layer Strip ships — the
    strip may cover 80% of the need.
12. **Re-expand session cache** — collapse currently prunes + refetches on
    re-expand (deliberate); a session cache would make re-expansion instant.
13. **Long-haul dashed edge quieting pass.**
14. **Lens depth/filters** (2-hop, edge-type filters, pin-to-compare).

---

## Discoverability notes (answered questions)

- **Focus / Lens entry points (all live today):** right-click → "Focus
  Connections" (`F` shown); Entity Drawer → Focus button; `f` key;
  Anchor Rail "+N more · Open lens"; status chip "Open lens"; Frame pill.
- **Frame entry points:** Frame pill on selection; Lens footer "Reveal all
  on canvas". Both land in framed-mode chrome (named state, Exit, Esc hint).
