import type { CanvasDensity, CanvasHeaderSize } from '@/store/preferences'

/**
 * Per-density sizing tokens for FlatTreeItem rows + LayerColumn virtualizer
 * estimates. Kept colocated so the visual sizing and virtualizer height
 * estimates can never drift apart (mismatched estimates cause scroll jumps).
 *
 * Heights are the `min-h-[…]` floor in pixels; the virtualizer uses the same
 * values as `estimateSize`. Other tokens are Tailwind class strings consumed
 * by FlatTreeItem.
 *
 * `minimal` is one line per entity: FlatTreeItem drops the icon's tile, sets
 * Technical's identifier beside the name and shows rule chips as dots, so
 * nothing in the row is taller than its line and these heights are the
 * row's own.
 */
export interface DensityRowTokens {
  rootHeight: number
  childHeight: number
  paddingClass: string
  textClass: string
  iconSize: string
  iconContainerSize: string
}

const DENSITY_TOKENS: Record<CanvasDensity, DensityRowTokens> = {
  minimal: {
    rootHeight: 30,
    childHeight: 26,
    paddingClass: 'py-0.5',
    textClass: 'text-[12px]',
    iconSize: 'w-3.5 h-3.5',
    iconContainerSize: 'w-4 h-4',
  },
  compact: {
    rootHeight: 40,
    childHeight: 34,
    paddingClass: 'py-1.5',
    textClass: 'text-[12px]',
    iconSize: 'w-3.5 h-3.5',
    iconContainerSize: 'w-6 h-6',
  },
  comfortable: {
    rootHeight: 52,
    childHeight: 44,
    paddingClass: 'py-2.5',
    textClass: 'text-[13px]',
    iconSize: 'w-4 h-4',
    iconContainerSize: 'w-7 h-7',
  },
  spacious: {
    rootHeight: 60,
    childHeight: 52,
    paddingClass: 'py-3.5',
    textClass: 'text-sm',
    iconSize: 'w-5 h-5',
    iconContainerSize: 'w-9 h-9',
  },
}

const ROOT_BOOST_HEIGHT: Record<CanvasDensity, number> = {
  minimal: 0,
  compact: 4,
  comfortable: 0,
  spacious: 4,
}

const ROOT_TOKENS_OVERRIDE: Record<CanvasDensity, Pick<DensityRowTokens, 'paddingClass' | 'textClass' | 'iconSize' | 'iconContainerSize'>> = {
  minimal: {
    paddingClass: 'py-1',
    textClass: 'text-[12.5px]',
    iconSize: 'w-4 h-4',
    iconContainerSize: 'w-4 h-4',
  },
  compact: {
    paddingClass: 'py-2',
    textClass: 'text-[13px]',
    iconSize: 'w-4 h-4',
    iconContainerSize: 'w-7 h-7',
  },
  comfortable: {
    paddingClass: 'py-3',
    textClass: 'text-sm',
    iconSize: 'w-5 h-5',
    iconContainerSize: 'w-9 h-9',
  },
  spacious: {
    paddingClass: 'py-4',
    textClass: 'text-[15px]',
    iconSize: 'w-6 h-6',
    iconContainerSize: 'w-10 h-10',
  },
}

export function densityRowTokens(density: CanvasDensity, isRoot: boolean): DensityRowTokens {
  const base = DENSITY_TOKENS[density]
  if (!isRoot) return base
  const rootOverride = ROOT_TOKENS_OVERRIDE[density]
  return {
    rootHeight: base.rootHeight + ROOT_BOOST_HEIGHT[density],
    childHeight: base.childHeight,
    ...rootOverride,
  }
}

/**
 * What the persona's technical identity line adds to an entity row when
 * Technical mode is on. Measured on the dev stack (`view_d0ea22f6c1c0`,
 * spacious): a 15px line box plus its `mt-0.5`, taking child rows 65px → 82px
 * and root rows 73px → 90px.
 *
 * LayerColumn's `estimateSize` has to include it. The estimate is what a row
 * the virtualizer has never mounted contributes to `getTotalSize()` and to
 * every `scrollToIndex` offset, so leaving it out under-reports the scroll
 * height by 17px per unmeasured row and lands a reveal off-screen. Only rows
 * rendered by `FlatTreeItem` carry the line — search-hit, load-more, skeleton
 * and error rows do not — and none does under `minimal`, which sets the
 * identifier on the name's line.
 */
export const TECHNICAL_LINE_HEIGHT = 17

export function densityRowHeights(density: CanvasDensity): { root: number; child: number; searchBox: number; skeleton: number; loadMore: number; failed: number } {
  const base = DENSITY_TOKENS[density]
  return {
    root: base.rootHeight + ROOT_BOOST_HEIGHT[density],
    child: base.childHeight,
    searchBox: 40,
    skeleton: base.childHeight,
    loadMore: 40,
    failed: 40,
  }
}

/**
 * Per-size tokens for an open layer column's header (Display › Header size).
 *
 * The title row is one height whatever it holds, so neighbouring headers end
 * on one line and the rows below them line up: the tallest thing in it is the
 * name at its lines (`leading-snug`, 1.375 × its size) or the icon tile. The
 * fold toggle (24px) and the tray's buttons (26px) fit every row. The header's
 * height is that row, its vertical padding and its 1px bottom border —
 * derived, so the lines a folded layer's spine takes and the Reset-width chip
 * land on the edge the header really has. (A column drilled into a node adds
 * its breadcrumb under the row.)
 */
export interface LayerHeaderTokens {
  /** The title row's height, px. */
  rowPx: number
  /** The header's padding; its vertical part is `padYPx` each side. */
  paddingClass: string
  padYPx: number
  /** The open header's whole height, px. */
  heightPx: number
  /** The layer's icon tile, and the icon in it. */
  tileClass: string
  glyphClass: string
  /** The name: its size, and the lines it may take before an ellipsis. */
  nameClass: string
  /** A rename or new-group field in the row, at the name's size. */
  inputClass: string
}

const withHeight = (t: Omit<LayerHeaderTokens, 'heightPx'>): LayerHeaderTokens =>
  ({ ...t, heightPx: t.rowPx + 2 * t.padYPx + 1 })

const HEADER_TOKENS: Record<CanvasHeaderSize, LayerHeaderTokens> = {
  // One line of a 13px name (17.9px) beside a 28px tile.
  compact: withHeight({
    rowPx: 28,
    paddingClass: 'px-4 py-2',
    padYPx: 8,
    tileClass: 'w-7 h-7 rounded-lg',
    glyphClass: 'w-3.5 h-3.5',
    nameClass: 'text-[13px] line-clamp-1 leading-snug',
    inputClass: 'py-0.5 text-[13px]',
  }),
  // The header as it has always been: two lines of a 14px name (38.5px).
  comfortable: withHeight({
    rowPx: 39,
    paddingClass: 'px-4 py-3',
    padYPx: 12,
    tileClass: 'w-9 h-9 rounded-xl',
    glyphClass: 'w-4 h-4',
    nameClass: 'text-sm line-clamp-2 leading-snug',
    inputClass: 'py-1 text-sm',
  }),
  // Two lines of a 15px name (41.25px) beside a 40px tile.
  spacious: withHeight({
    rowPx: 42,
    paddingClass: 'px-4 py-3.5',
    padYPx: 14,
    tileClass: 'w-10 h-10 rounded-xl',
    glyphClass: 'w-5 h-5',
    nameClass: 'text-[15px] line-clamp-2 leading-snug',
    inputClass: 'py-1 text-[15px]',
  }),
}

export function layerHeaderTokens(size: CanvasHeaderSize): LayerHeaderTokens {
  // A size this build does not know (a newer build wrote it) draws the default.
  return HEADER_TOKENS[size] ?? HEADER_TOKENS.comfortable
}
