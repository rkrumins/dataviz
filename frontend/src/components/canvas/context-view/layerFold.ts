/**
 * Fold distant layers — which layer columns stay open, and how wide the
 * folded ones are.
 *
 * A view with more layers than the canvas is wide used to scroll sideways,
 * and every flow into a layer scrolled out of sight simply stopped being
 * drawn: the edge overlay only draws a line whose two ends are on screen.
 * So instead of scrolling away, the layers outside a WINDOW fold into slim
 * spines, the whole run fits on screen, and a flow into a folded layer
 * lands on its spine (LayerColumn's fold anchors).
 *
 * The window is one contiguous run of open columns — the flows between two
 * neighbouring open layers are the ones being read — and it behaves like a
 * scroll position measured in layers: it opens from an ANCHOR layer as far
 * as the width allows, and it slides rather than jumps.
 *
 *   * A layer the reader must keep (the selected row's) is never folded to
 *     make room: the window slides the least that keeps it open — which is
 *     what happens when the entity drawer takes 500px off the canvas.
 *   * A layer the reader folded by hand stays a spine wherever the window
 *     goes, and the window runs straight past it.
 *   * With nothing to fold — everything fits — nothing folds, and the canvas
 *     is exactly the one it always was.
 *
 * Pure: no React, no DOM. Widths are LAYOUT px, the canvas zoom already
 * divided out.
 */
import { COLUMN_GAP_PX, EXPANDED_COLUMN_MIN_WIDTH_PX } from './fitZoom'

/** The widest a spine gets: room for the icon, the flow count and the name. */
export const SPINE_MAX_WIDTH_PX = 56
/** The narrowest: a vertical name is still legible here. Past it the run
 *  scrolls, rather than squeezing spines into slivers nobody can click. */
export const SPINE_MIN_WIDTH_PX = 24
/** Between two neighbouring spines. The columns wrapper's `gap-12`
 *  ({@link COLUMN_GAP_PX}) is room for lines to curve between two columns;
 *  no line is drawn between two spines, so the wrapper pulls a spine that
 *  follows a spine back by `-ml-[42px]`, which leaves this. */
export const SPINE_GAP_PX = 6

export interface FoldLayer {
  id: string
  /** The column's open width: its minimum, which is what it claims first. */
  width: number
}

export interface FoldAnchor {
  layerId: string
  /** `start`: the window opens rightward from this layer — the way the run
   *  reads, and the default. `center`: it opens around it, both sides alike
   *  — what "take me to that layer" asks for. */
  align: 'start' | 'center'
}

export interface LayerFoldInput {
  /** In column order. */
  layers: readonly FoldLayer[]
  /** Width the layer columns may use, in layout px. `<= 0` means not
   *  measured yet, and folds nothing. */
  available: number
  /** Where the window opens from. `null` opens it from the first layer. */
  anchor: FoldAnchor | null
  /** A layer that must stay open — see the header. */
  keepOpenId: string | null
  /** Layers the reader folded by hand. */
  userFolded: ReadonlySet<string>
}

export interface LayerFold {
  folded: ReadonlySet<string>
  spineWidth: number
  /** First and last open layer index; -1 when no layer is open. */
  first: number
  last: number
  /** The layers, all open, would not fit — folding is doing something. */
  overflows: boolean
}

/** Width of the run with the given layers open, gaps included. */
function runWidth(layers: readonly FoldLayer[], open: readonly boolean[], spineWidth: number): number {
  let width = 0
  for (let i = 0; i < layers.length; i++) {
    width += open[i] ? layers[i].width : spineWidth
    if (i > 0) width += open[i] || open[i - 1] ? COLUMN_GAP_PX : SPINE_GAP_PX
  }
  return width
}

/**
 * One width for every spine, decided by how many layers there are rather
 * than by where the window is, so spines do not change width as it slides.
 *
 * Open columns come first: find the most layers that can be open with the
 * spines at their narrowest, then give the spines whatever width that count
 * leaves. Sized for the tightest window — one of the widest columns per open
 * layer, spines on both sides of it — so every window position fits.
 */
function spineWidthFor(layers: readonly FoldLayer[], available: number, shut: readonly boolean[]): number {
  const n = layers.length
  let widest = 0
  let openable = 0
  layers.forEach((layer, i) => {
    if (shut[i]) return
    widest = Math.max(widest, layer.width)
    openable += 1
  })
  widest = widest || EXPANDED_COLUMN_MIN_WIDTH_PX
  const gapsFor = (open: number) =>
    (open - 1) * COLUMN_GAP_PX + 2 * COLUMN_GAP_PX + Math.max(0, n - open - 2) * SPINE_GAP_PX
  const room = (open: number) => (available - open * widest - gapsFor(open)) / (n - open)
  let open = 1
  for (let k = Math.min(openable, n - 1); k > 1; k--) {
    if (room(k) >= SPINE_MIN_WIDTH_PX) { open = k; break }
  }
  if (n - open <= 0) return SPINE_MAX_WIDTH_PX
  return Math.min(SPINE_MAX_WIDTH_PX, Math.max(SPINE_MIN_WIDTH_PX, Math.floor(room(open))))
}

function summarise(layers: readonly FoldLayer[], open: readonly boolean[], spineWidth: number, overflows: boolean): LayerFold {
  const folded = new Set<string>()
  let first = -1
  let last = -1
  open.forEach((isOpen, i) => {
    if (!isOpen) { folded.add(layers[i].id); return }
    if (first === -1) first = i
    last = i
  })
  return { folded, spineWidth, first, last, overflows }
}

export function computeLayerFold({ layers, available, anchor, keepOpenId, userFolded }: LayerFoldInput): LayerFold {
  const n = layers.length
  const shut = layers.map(layer => userFolded.has(layer.id))
  const allOpen = shut.map(isShut => !isShut)
  if (n === 0 || available <= 0 || runWidth(layers, allOpen, SPINE_MAX_WIDTH_PX) <= available) {
    return summarise(layers, allOpen, SPINE_MAX_WIDTH_PX, false)
  }

  const spineWidth = spineWidthFor(layers, available, shut)
  let open: boolean[] = new Array(n).fill(false)
  const tryOpen = (i: number): boolean => {
    open[i] = true
    if (runWidth(layers, open, spineWidth) <= available) return true
    open[i] = false
    return false
  }
  // Walk from `from` in `dir`, opening layers until one does not fit. A
  // hand-folded layer is stepped over — it is a spine inside the window.
  // Reports whether the walk ran out of layers rather than out of room.
  const extend = (from: number, dir: 1 | -1): boolean => {
    for (let i = from; i >= 0 && i < n; i += dir) {
      if (shut[i]) continue
      if (!tryOpen(i)) return false
    }
    return true
  }
  // Open `seed` — always, even when it alone is wider than the canvas — then
  // grow toward `dir`; a window that reaches the end of the run with room to
  // spare grows back the other way, so it is never left half-empty.
  const grow = (seed: number, dir: 1 | -1) => {
    open = new Array(n).fill(false)
    open[seed] = true
    if (extend(seed + dir, dir)) extend(seed - dir, dir === 1 ? -1 : 1)
  }
  const growAround = (seed: number) => {
    open = new Array(n).fill(false)
    open[seed] = true
    let right = seed + 1
    let left = seed - 1
    let rightDone = false
    let leftDone = false
    while (!rightDone || !leftDone) {
      if (!rightDone) {
        while (right < n && shut[right]) right++
        if (right < n && tryOpen(right)) right++
        else rightDone = true
      }
      if (!leftDone) {
        while (left >= 0 && shut[left]) left--
        if (left >= 0 && tryOpen(left)) left--
        else leftDone = true
      }
    }
  }
  // The first layer at or after `i` that can open, else the last one before it.
  const openable = (i: number): number => {
    for (let j = Math.max(0, i); j < n; j++) if (!shut[j]) return j
    for (let j = Math.min(n - 1, i - 1); j >= 0; j--) if (!shut[j]) return j
    return -1
  }

  const anchorIndex = anchor ? layers.findIndex(layer => layer.id === anchor.layerId) : -1
  const seed = openable(anchorIndex === -1 ? 0 : anchorIndex)
  if (seed === -1) return summarise(layers, open, spineWidth, true)
  if (anchor?.align === 'center' && anchorIndex !== -1) growAround(seed)
  else grow(seed, 1)

  const keep = keepOpenId ? layers.findIndex(layer => layer.id === keepOpenId) : -1
  if (keep !== -1 && !shut[keep] && !open[keep]) {
    // Slide the least: the kept layer becomes the window's near edge.
    const lastOpen = open.lastIndexOf(true)
    grow(keep, keep > lastOpen ? -1 : 1)
  }
  return summarise(layers, open, spineWidth, true)
}
