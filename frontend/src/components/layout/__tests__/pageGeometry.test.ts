import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { describe, it, expect } from 'vitest'

/**
 * Page geometry must come from PageContainer — nothing may hand-roll it.
 *
 * The app's page container is two classes that only work together: a width cap
 * (`max-w-[1440px]`) and horizontal gutters (`px-6 md:px-10 lg:px-12`). For a
 * long time that string was copy-pasted into ~25 files, and nothing enforced it.
 * It drifted, exactly as you'd expect: the Dashboard shipped with the cap on one
 * container and the gutters on another, so the page users actually saw had a cap
 * and NO horizontal padding — content ran flush into the sidebar. Its skeleton
 * repeated the same mistake, so the loading state matched the broken layout and
 * nothing ever looked wrong.
 *
 * A component fixes the *instance*. This test fixes the *class of bug*: it fails
 * the build the moment either class is written by hand anywhere else. Use
 * `<PageContainer>`, or `pageGeometry()` for the rare element that cannot be a
 * plain div (a keyed motion.div under AnimatePresence).
 */

const SRC = join(__dirname, '..', '..', '..')

/** The only files allowed to name these classes: the owner, and this test. */
const ALLOWED = new Set([
  join('components', 'layout', 'PageContainer.tsx'),
  join('components', 'layout', '__tests__', 'pageGeometry.test.ts'),
])

const OWNED_CLASSES = [
  // The current cap. Keep this in step with MAX_WIDTHS.default in PageContainer.
  'max-w-[1760px]',
  // The previous cap. Still banned so it cannot creep back in by copy-paste from
  // an old branch, a stale snippet, or an LLM that learned the old string.
  'max-w-[1440px]',
  'px-6 md:px-10 lg:px-12',
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

describe('page geometry', () => {
  it('is never hand-rolled outside PageContainer', () => {
    const offenders: string[] = []

    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file)
      if (ALLOWED.has(rel)) continue

      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const cls of OWNED_CLASSES) {
          if (line.includes(cls)) {
            offenders.push(`${rel.split(sep).join('/')}:${i + 1} → "${cls}"`)
          }
        }
      })
    }

    expect(
      offenders,
      'These files hand-roll the page container geometry. Use <PageContainer> ' +
        '(or pageGeometry() if the element cannot be a plain div) so the cap and ' +
        'the gutters can never be applied without each other:\n' +
        offenders.join('\n'),
    ).toEqual([])
  })
})
