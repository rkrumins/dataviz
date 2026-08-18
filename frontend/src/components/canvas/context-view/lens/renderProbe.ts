/**
 * Dev-gated render-count probe (Task 20, P0).
 *
 * Proves the fan-out claim empirically rather than by inspection: on an
 * isolation toggle, how many of the board's N cards/edges actually
 * re-rendered — not merely how long the update took. `IsolationContext`
 * broadcasting to every `useContext` consumer means today that number is
 * N regardless of how small the lit cone is; P1's subscription store
 * exists to make it the handful whose on-cone answer actually flipped.
 *
 * Stripped from production: `import.meta.env.PROD` short-circuits the
 * bump before the Map write, so the only cost outside a dev/test build
 * is one boolean check per render.
 */
export const renderCounts = new Map<string, number>()

export function bumpRenderCount(kind: string): void {
  if (import.meta.env.PROD) return
  renderCounts.set(kind, (renderCounts.get(kind) ?? 0) + 1)
}

export function resetRenderCounts(): void {
  renderCounts.clear()
}
