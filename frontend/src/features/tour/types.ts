import type { LucideIcon } from 'lucide-react'

export type TourPlacement = 'top' | 'bottom' | 'left' | 'right' | 'center'

export interface TourStep {
  /** CSS selector for the element to spotlight (e.g. `[data-tour="search"]`).
   *  Omit for a centered, element-less step (intro / outro). */
  target?: string
  title: string
  /** Supports a small amount of inline emphasis via **bold**. */
  body: string
  placement?: TourPlacement
  /** Extra px of breathing room around the spotlit element. */
  padding?: number
  /** Navigate here before showing the step (so the target exists). */
  route?: string
}

export interface TourDefinition {
  id: string
  title: string
  description: string
  icon: LucideIcon
  /** Rough time to complete, e.g. "2 min". */
  estimate: string
  steps: TourStep[]
  /** Only meaningful on a specific surface (e.g. an open canvas). Such tours are
   *  offered from that surface, and from Help only while the user is there —
   *  their targets don't exist elsewhere, so they can't be launched cold. */
  contextual?: boolean
  /** Path prefix a contextual tour belongs to (e.g. "/views/"). */
  contextPathPrefix?: string
}
