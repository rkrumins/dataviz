import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * PageContainer — the one place the app's page geometry is defined.
 *
 * WHY THIS EXISTS
 * Every page used to hand-copy the same class string:
 *
 *     max-w-[1440px] mx-auto px-6 md:px-10 lg:px-12
 *
 * Nothing enforced it, so it drifted. The Dashboard shipped with the string
 * split across two containers — one carrying the width cap, the other the
 * gutters — which left the real page with a cap and NO horizontal padding at
 * all, so its content ran flush into the sidebar. Its child sections had even
 * grown `px-4 md:px-0` to compensate: a gutter on mobile, then nothing from
 * `md` up, handing off to a parent gutter that never arrived. The skeleton
 * repeated the same mistake, so the loading state matched the broken layout and
 * nothing ever *looked* inconsistent.
 *
 * A shared constant would not have prevented that (you can still forget half of
 * it). A component does: you either use it and get both, or you obviously don't.
 * `pageGeometry.test.tsx` fails the build if the raw classes reappear anywhere
 * outside this file.
 *
 * THE CONTRACT
 * This component owns exactly two things — the **max-width cap** and the
 * **horizontal gutters**. It deliberately owns nothing else. Vertical rhythm
 * (`py-8`, `pb-28`), spacing (`space-y-6`) and entrance animation
 * (`animate-in fade-in`) are legitimate per-page choices, so they pass straight
 * through `className`.
 */

/**
 * How wide content may grow before it stops scanning comfortably.
 *
 * The default was 1440px, which was too tight for a data-dense tool. 1440 is a
 * READING-width heuristic borrowed from marketing/SaaS sites whose content is
 * prose and forms; this app is workspace grids, view catalogues and 6-column
 * admin tables, which want horizontal room. Worse, the cap applies to the
 * content area AFTER the 260px sidebar is gone, so on a 2560px monitor it left
 * 860px — 37% of the available area — permanently empty.
 *
 * It was also self-justifying: the grids' `2xl:` column steps had been REMOVED
 * because 1440 made extra columns cramped, which then made wide screens useless,
 * which then justified the cap. Raising the cap without raising the grids just
 * inflates the cards (at 1760, a 3-column workspace grid is 539px per card) —
 * and fat cards are precisely what made full-width feel "overwhelming" the first
 * time this was tuned. Width has to become MORE cards, not wider ones, so the
 * `wide:` breakpoint (tailwind.config.js) is the other half of this change.
 *
 * 1760 keeps laptops identical (they are below the cap either way) and takes a
 * QHD monitor from 58% to 72% content usage.
 */
const MAX_WIDTHS = {
  /** App-wide default — every top-level page. */
  default: 'max-w-[1760px]',
  /** Reading-width pages (account / settings forms), where full width hurts scannability. */
  narrow: 'max-w-3xl',
} as const

/** Horizontal gutters. Owned here so a page physically cannot ship without one. */
const GUTTERS = {
  /** Top-level pages, which sit directly against the primary sidebar. */
  page: 'px-6 md:px-10 lg:px-12',
  /**
   * Panes that sit beside a SECONDARY nav (Admin, Ontology). Tighter, because the
   * sub-nav already separates the content from the primary sidebar. Note `p-8` —
   * the class these panes used to carry — is exactly `px-8 py-8`, so callers keep
   * their `py-8` and the rendered result is unchanged.
   */
  shell: 'px-8',
} as const

export interface PageContainerProps {
  /** Max content width. Default `'default'` (1440px). */
  width?: keyof typeof MAX_WIDTHS
  /** Horizontal gutter. Default `'page'`. Use `'shell'` beside a secondary nav. */
  gutter?: keyof typeof GUTTERS
  /** Vertical rhythm / spacing / animation. NOT for width or horizontal padding. */
  className?: string
  children: ReactNode
}

export function PageContainer({
  width = 'default',
  gutter = 'page',
  className,
  children,
}: PageContainerProps) {
  return (
    <div className={cn(MAX_WIDTHS[width], 'mx-auto', GUTTERS[gutter], className)}>
      {children}
    </div>
  )
}

/**
 * The same geometry as a class string, for the rare element that CANNOT be a
 * plain `<div>`.
 *
 * The only current caller is a keyed `<motion.div>` that must stay the DIRECT
 * child of an `<AnimatePresence>` — wrapping it in `<PageContainer>` would put a
 * non-motion element in between and silently kill the exit animation.
 *
 * It reads the same constants, so the geometry still lives in exactly one place.
 * Prefer `<PageContainer>` everywhere else: this returns a string, so it is far
 * easier to use half of.
 */
export function pageGeometry({
  width = 'default',
  gutter = 'page',
}: Pick<PageContainerProps, 'width' | 'gutter'> = {}): string {
  return cn(MAX_WIDTHS[width], 'mx-auto', GUTTERS[gutter])
}
