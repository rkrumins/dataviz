/**
 * Shared animation constants — consistent, snappy motion across the app.
 *
 * PERFORMANCE CONTRACT: every token here drives `transform` / `opacity`
 * only (GPU-composited — no layout or paint properties). Durations are
 * tuned tight so motion reads as a flourish over already-present content,
 * never a wait. Reduced motion is handled globally by
 * `<MotionConfig reducedMotion>` in `main.tsx` (OS setting) plus the app
 * `reducedMotion` preference — do NOT gate individual components by hand.
 *
 * Durations follow the OntologySchemaPage / ExplorerPreviewDrawer precedent:
 *   tab swaps   → 0.12 s
 *   cards/fades  → 0.16 s
 *   drawers      → 0.18 s decelerating curve (a spring has no fixed end;
 *                  it keeps emitting frames after it looks finished, and a
 *                  drawer that pushes the canvas relayouts on every one)
 */

export const MOTION = {
  /** Standard fade-in for sections and panels */
  fadeIn: { duration: 0.16, ease: 'easeOut' as const },

  /** Stagger between sibling cards in a grid (seconds) */
  cardStagger: 0.025,

  /** Per-card entry transition */
  cardEntry: { duration: 0.16, ease: 'easeOut' as const },

  /** Card initial y-offset (px) — transform, free to animate */
  cardY: 8,

  /** Modal/drawer spring — responsive without overshoot */
  modalSpring: { type: 'spring' as const, damping: 30, stiffness: 380 },

  /** Side drawers (slide / width-reveal) — tight and snappy, minimal overshoot */
  drawerSlide: { duration: 0.18, ease: [0.32, 0.72, 0, 1] as const },

  /** Expand/collapse (data sources, accordions) */
  collapse: { duration: 0.16, ease: 'easeInOut' as const },

  /** Step-to-step swap (wizard, tabs) */
  stepSwap: { duration: 0.12, ease: 'easeOut' as const },

  /** Stagger between form fields (seconds) */
  fieldStagger: 0.02,

  /** Per-field entry transition */
  fieldEntry: { duration: 0.12, ease: 'easeOut' as const },

  /** Section-level stagger on the dashboard (seconds between sections) */
  sectionStagger: 0.025,

  /** Section entry transition */
  sectionEntry: { duration: 0.18, ease: 'easeOut' as const },

  /** Section initial y-offset (px) */
  sectionY: 8,

  /**
   * Cap for index-scaled stagger so long lists reveal in one graceful wave
   * instead of crawling: `delay = min(i, staggerMax) * stagger`.
   */
  staggerMax: 6,
} as const
