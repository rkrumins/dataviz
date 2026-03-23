/**
 * Shared animation constants — consistent, snappy motion across the app.
 *
 * Durations follow the OntologySchemaPage / ExplorerPreviewDrawer precedent:
 *   tab swaps  → 0.15 s
 *   cards/fades → 0.2 s
 *   drawers     → spring (damping 28, stiffness 320)
 */

export const MOTION = {
  /** Standard fade-in for sections and panels */
  fadeIn: { duration: 0.2, ease: 'easeOut' as const },

  /** Stagger between sibling cards in a grid (seconds) */
  cardStagger: 0.035,

  /** Per-card entry transition */
  cardEntry: { duration: 0.2, ease: 'easeOut' as const },

  /** Card initial y-offset (px) */
  cardY: 8,

  /** Modal/drawer spring — responsive without overshoot */
  modalSpring: { type: 'spring' as const, damping: 28, stiffness: 320 },

  /** Expand/collapse (data sources, accordions) */
  collapse: { duration: 0.2, ease: 'easeInOut' as const },

  /** Step-to-step swap (wizard, tabs) — matches OntologySchemaPage 0.15 s */
  stepSwap: { duration: 0.15, ease: 'easeOut' as const },

  /** Stagger between form fields (seconds) */
  fieldStagger: 0.03,

  /** Per-field entry transition */
  fieldEntry: { duration: 0.15, ease: 'easeOut' as const },

  /** Section-level stagger on the dashboard (seconds between sections) */
  sectionStagger: 0.04,

  /** Section entry transition */
  sectionEntry: { duration: 0.25, ease: 'easeOut' as const },

  /** Section initial y-offset (px) */
  sectionY: 8,
} as const
