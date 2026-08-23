import { expect } from 'vitest'

let ran = 0
/** Register in `beforeEach` of a harness file: `beforeEach(() => countTest())`. */
export function countTest(): void { ran += 1 }
/** Fails the file if fewer than `min` tests executed — catches a module
 *  that silently failed to load (e.g. a missing dependency). */
export function expectTestsRan(min: number): void {
  expect(ran, `harness canary: only ${ran} tests ran (min ${min}) — did the module load?`).toBeGreaterThanOrEqual(min)
}
