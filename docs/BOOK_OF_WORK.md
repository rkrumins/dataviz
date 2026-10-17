# Context View Canvas — Book of Work

Living backlog for the Context View lineage canvas. Captures what shipped on
`claude/canvas-lineage-edges-disappear-bhstlt`, the engineering invariants that
work established, and the prioritized road ahead.

**Status re-checked against the code on 2026-10-09 (`42cae50`).** Of the fifteen
items this backlog carried, seven have shipped, three are partly done and five
are open; see [Backlog status](#backlog-status). What is still open is under
[Still open](#still-open).

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

## Shipped on `claude/canvas-lineage-edges-disappear-bhstlt` (reference)

| Area | Outcome |
|---|---|
| Silent-loss audit (A1–A7) | Edge-fetch failure banner + retry; unresolved/unassigned chips; coverage-gated delegation; aggregated detail paging; cross-page sibling lineage; truncation heuristics |
| Adaptive edge density | Edge Budget (strongest-first, user-tweakable 100–2000), focus fan cap, status chips, flow ribbons (opt-in), density gutters, hairline in/out indicators |
| Zoom | CSS `zoom`-based (layout-truthful), fit-to-width, presets, redraw wiring |
| Lineage Lens | Ego-graph overlay, grouped/searchable, re-center stack, entry points: drawer, `f`, right-click "Focus Connections", overflow chips |
| Lens on-demand fetch | Every visited focal node's true 1-hop lineage + partner names fetched from the provider on open/walk/drill (lens-local, never mutates canvas scope); O(degree) indexed derivation; per-node loading/error/truncation narration; drill fetches an aggregate's underlying edges via the expandEdge pair query |
| In/out indicators anchored to the node box | The per-node in/out + external lineage hairlines were computed in the SVG overlay from getBoundingClientRect and redrawn on every layout change — the root fragility behind marks that shifted, ignored column width, and didn't clear on collapse. Moved them INTO FlatTreeItem as children of the row box: they now track the card's width/position via normal layout, unmount with the row on collapse, and can never drift/offset/ghost (no coordinate math). Data flows via LayerColumn (per-column log intensity so hubs stand out), gated on the lineage-flow switch; overlay's stub computation/render/state/props removed. Overlay is now edges-only |
| Overflow trailing stubs removed | Root cause (deep trace) of the moiré/ghost/"offset edge" dashed lines: per-edge overflow stubs ran from every visible row to a SHARED viewport-edge exit point, so a 160+ row column fanned into vertical dashed lines that read as ghosts and never felt tied to a card. Removed entirely — off-screen lineage is carried by the directional badges + column periphery counts (the single honest indicator). Also fixed: expand/collapse observer keyed on the expandedNodes Set reference (was `.size`, missed membership-preserving changes); scroll-parent lookup targets the real `overflow-auto` container (was `overflow-y-auto`, never matched) |
| Overflow marks: collapsed-away vs scrolled-off | An overflow stub promises "a connection you can scroll to." Collapsing a parent with expanded descendants left those descendants' edges (to still-visible nodes) drawn as dangling overflow stubs pointing at where they used to be. The overflow branch now skips any mark whose off-screen endpoint is absent from every column's live flat-tree index (geometryRegistry.hasNode) — i.e. collapsed away, not merely scrolled off |
| Overlay redraw on panel toggle | Side panels (EntityDrawer, EdgeDetailPanel, Advanced Search, builder rails) are overlays that reserve canvas space via padding — which does NOT resize the observed node cards, so the overlay's ResizeObserver never fired and lineage marks stranded as ghosts when a panel opened/closed or the tree was expanded/collapsed while one was open. A dedicated effect now forces an overlay redraw on every panel transition, with trailing settle passes for the panel slide animation |
| Overlay ghost marks + drawer Retry | Flow ribbons/badges no longer strand at stale positions after expand/collapse or drawer open/close: `getEl` rejects detached DOM elements (isConnected) so a remounted `layer-node-*` never anchors to an old rect, unobserve evicts the element cache, and the ResizeObserver now watches the container itself so a drawer that narrows the canvas without resizing fixed-width columns still triggers a redraw. The drawer's lineage-fetch Retry is a real pill hit target (was an easy-to-miss text link) |
| Lens long-name + unresolved fixes | Long field names no longer break the classic view: grid tracks are `minmax(0,1fr)` and NeighborColumn/NeighborRow carry `min-w-0` so labels truncate instead of overflowing the dialog; focal-card name uses `overflow-wrap:anywhere` for unbroken snake_case. The "Not Loaded / raw-id" group is fixed at the root: resolveNames no longer caches URNs the backend didn't return (they stay retryable instead of stranded), the URN fallback label strips structural punctuation, and any residual group is relabeled "Unresolved" with an explanatory tooltip |
| Classic-mode drill + hook tests | The ×N badge on classic-mode cards drills an aggregate into its underlying connections with the same on-demand fetch as walk columns (shared toggle-with-fetch); useLensLineage orchestration covered by direct unit tests (fetch-once, error/retry, session clearing, truncation, drill idempotence, typed containment queries, null-provider degrade) |
| Drawer–Lens parity | The entity drawer's Lineage section fetches the focal node's true 1-hop lineage on open via the same shared hook (useLensLineage, moved to hooks/), merge (mergeSupplementalEdges), and grain split (buildCanContainClosure / isCoarserGrain, extracted to lib/lineage-neighbors) as the Lens — the two surfaces can no longer disagree about counts. Loading/error/truncation narration; zero-count cards say "None found in the data source" only after a completed fetch; degrades to store-only data when no provider is reachable (useGraphProviderIfAvailable) |
| Lens walkable containment | Containers whose relationships live at child level no longer dead-end: containment edges fetched per visited node; walkable "Contains" group in walk columns + contained-entities band in classic mode (distinct visual grammar — a descent never masquerades as a flow hop); hover row actions replace the chevron in-flow instead of overlaying the label |
| Lens column organization | Flow partners grouped by their PARENT dataset (partner containment parents fetched per focal; clickable group headers re-center on the parent); per-column entity-type filter chips (toggled-off types keep their count — explicit choice, not silent loss); coarser-grain partners (containers/platforms, detected via the schema hierarchy's transitive canContain closure) demoted to a labeled muted "Rollups" tier with badges; headline counts split per grain ("N direct · M rolled-up · contains K"); parent breadcrumbs on walk rows. Walk columns share the same organization: parent-group headers that walk into the parent, frontier grain chips (lens-global filter), rollup tier, hidden-count notes; off chips render ghost (dashed + EyeOff), never strikethrough. Parent groups collapsible (chevron distinct from the walk-into name; 3+ groups per column start collapsed; searching force-expands; the group holding the walked-into hop stays open); rows use content-visibility:auto + narrowed transitions for smooth scroll at 200-row columns |
| Anchor Rail (phase 1) | Selection-scoped docked partner proxies; real-DOM chip anchoring; click-to-reveal; "+N more · Open lens" |
| Framed mode | Explicit exit chrome with Esc hint; unified entry from Frame pill and Lens "Reveal all" |
| Column periphery | Edge scrims ("↑ N more · M connections") with named-partner hover panels, per-layer calculated, store-isolated |
| Stability fixes | Edge-flash oscillator (predicate memoization + emission guards + visibility seeding); phantom vertical scroll; infinite horizontal scroll (sticky badge layer); scrollbar-gutter clipping; expansion reveal; disappearing-nodes-on-expand |

---

## Backlog status

Paths are under `frontend/src/components/canvas/context-view/` unless noted.

| # | Item | Status | Where it lives |
|---|---|---|---|
| 1 | Layer Strip | Shipped | `LayerStrip.tsx` — one chip per layer, click-to-jump, drag-to-scrub, the add-layer affordance, and Fit. Chips show no loaded count, and the strip hides while a trace is open |
| 2 | Resizable layer columns | Shipped | `LayerColumn.tsx` — 260–560 px; double-click the handle, or *Reset width*, to go back |
| 3 | Collapsible Display Settings sections | Shipped | `DisplaySettingsPopover.tsx`, `LineageDisplayPopover.tsx` — open state persisted, active value shown inline (Edge Density shows its mode, not the budget) |
| 4 | Anchor Rail 1.5 — hover with linger | Shipped | `LineageFlowOverlay.tsx` — follows hover after 250 ms and lingers 1.5 s; the bridge is time only. The rail now docks as off-screen trays above and below a column |
| 4b | Column widths in the view definition | Shipped | A draft drag saves `layer.width` through `persistReferenceLayout`; localStorage (`nx-layer-widths`) stays the viewer's override |
| 5 | Rail phase 2 — ambient top-K | Open | The rail collects partners of a focused entity only |
| 6 | Rail phase 3 — badges into rail overflow, per-column popover | Open | Left/right badges are still separate; overflow goes to the Lens |
| 7 | Root pagination beyond 200 | Shipped | `frontend/src/hooks/useGraphHydration.ts` (`loadMoreRoots`) — 200 is now a page, not a cap; `GET /graph/nodes/top-level` pages by cursor ([TOP_LEVEL_NODES_PERFORMANCE.md](TOP_LEVEL_NODES_PERFORMANCE.md)) |
| 8 | External-degree backend endpoint | Shipped, different design | `POST /api/v1/{ws_id}/graph/nodes/degree` — see [FOLLOW_UP_EXTERNAL_DEGREE.md](FOLLOW_UP_EXTERNAL_DEGREE.md) |
| 9 | Display Settings per-section reset + budget slider in the header | Partial | The budget slider is in the header Display menu whenever the mode isn't *All Edges*; one Reset covers the Canvas group. No per-section reset, and the lineage settings have none |
| 10 | WebGL "Show all" layer | Open | |
| 11 | Minimap | Open on the canvas | The Lens graph view has one; the Layer Strip's position rail is the canvas's one-dimensional map |
| 12 | Re-expand session cache | Open | Collapse still prunes and re-expand refetches, softened by a 30 s client cache for children and a 1 h Redis one |
| 13 | Long-haul dashed edge quieting | Partial | Roll-up dashes draw solid once a board passes 200 lines; nothing targets lines that span many layers |
| 14 | Lens depth/filters | Partial | One hop / full flow, and direction and entity-type filters; the 1/2/3 depth control was retired. No edge-type filter, no pin-to-compare |

---

## Shipped since this backlog was written

| Area | Outcome |
|---|---|
| Multi-entity trace | ⌘/Ctrl- and Shift-click build a selection; **Trace N entities** (or `T`) traces up to 25 as one picture, each partner measured from its nearest origin (`frontend/src/hooks/useCanvasTraceWalk.ts`); `F` opens the Lens on the whole selection |
| Trace on the canvas | The trace overlay draws on the canvas without writing the canvas store (`frontend/src/hooks/useTraceOverlay.ts`); an earlier design that merged trace data into the store was reverted |
| Share links | `?trace=` for a single-entity trace, and a Lens share code. A combined trace cannot be shared yet |
| Lens rework | A toolbar for direction, density, wires, walk and steps, and a graph view with a minimap |
| Orphaned entities | **Display → Advanced → Orphaned entities…** lists entities missing the parent their type implies, with Reveal and, on a draft, Place in layer (`OrphansDrawer.tsx`) |
| Relationship drawer and partner trays | Clicking a line opens its relationship; off-screen partners dock in trays above and below the column |
| Line styling | Lineage ports, marker sides, direction colours, frosted cards and line motion (`LineageDisplayPopover.tsx`) |
| Placement contract (preview) | One placement rule shared with the server, behind `placementContractEnabled`, off by default |
| Layer fold (preview) | Behind `canvasLayerFoldEnabled`, off by default (`useLayerFold.ts`) |

---

## Still open

The original item numbers are kept so the history above stays readable.

### Near-term

- **#5 Anchor Rail phase 2 — ambient top-K** per column in Adaptive mode
  (budget-ranked, scroll-settle damping, incumbent stickiness).
- **#6 Rail phase 3** — fold left/right badges into rail overflow; searchable
  per-column popover.
- **#9 Display Settings: per-section reset**, the lineage settings included —
  they have no reset at all. (The edge-budget slider in the header menu
  shipped.)

### Later / research

- **#10 WebGL "Show all" layer** for full-set rendering beyond the DOM ceiling.
- **#11 Minimap** on the canvas. The Layer Strip covers horizontal orientation;
  re-evaluate whether a 2D overview is still needed.
- **#12 Re-expand session cache** — collapse currently prunes + refetches on
  re-expand (deliberate); a session cache would make re-expansion instant.
- **#13 Long-haul dashed edge quieting** for lines that span many layers.
- **#14 Lens filters** — edge-type filters and pin-to-compare. (Direction and
  entity-type filters shipped; the 1/2/3 depth control was retired in
  favour of one hop / full flow.)

---

## Discoverability notes (answered questions)

- **Focus / Lens entry points (all live today):** right-click → "Focus
  Connections" (`F` shown); Entity Drawer → Focus button; `f` key (on a
  multi-selection, the whole selection); the rail's "N more in the lens";
  status chip "Open lens"; Frame pill.
- **Frame entry points:** Frame pill on selection; Lens footer "Reveal all
  on canvas". Both land in framed-mode chrome (named state, Exit, Esc hint).
