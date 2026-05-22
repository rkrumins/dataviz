import type { CanvasDensity } from '@/store/preferences'

/**
 * Per-density sizing tokens for FlatTreeItem rows + LayerColumn virtualizer
 * estimates. Kept colocated so the visual sizing and virtualizer height
 * estimates can never drift apart (mismatched estimates cause scroll jumps).
 *
 * Heights are the `min-h-[…]` floor in pixels; the virtualizer uses the same
 * values as `estimateSize`. Other tokens are Tailwind class strings consumed
 * by FlatTreeItem.
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
  compact: 4,
  comfortable: 0,
  spacious: 4,
}

const ROOT_TOKENS_OVERRIDE: Record<CanvasDensity, Pick<DensityRowTokens, 'paddingClass' | 'textClass' | 'iconSize' | 'iconContainerSize'>> = {
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
