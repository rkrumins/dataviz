/// <reference types="node" />
/**
 * A tab body may not re-cap the page width.
 *
 * `PageContainer` already caps the page at 1760px, and its own docstring
 * argues at length against capping harder — a tight cap "left 860px — 37%
 * of the available area — permanently empty". These tabs each carried
 * `max-w-3xl` anyway, which is `MAX_WIDTHS.narrow`, documented as being for
 * *reading-width pages (account / settings forms)*. On a wide monitor that
 * stranded the content in the left third of the canvas.
 *
 * Source-level, like `pageGeometry.test.ts`, because a width cap is
 * invisible to any test that queries by role: every element still renders,
 * still has its accessible name, and still passes. The only way to catch it
 * is to look at the class.
 *
 * `max-w-` inside a tab is not banned outright — capping a paragraph's
 * measure or a rail's width is fine. What is banned is a cap on the element
 * that *contains the whole tab*, which is what the top-level wrapper is.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TABS_DIR = join(__dirname, '..')

function tabFiles(): string[] {
    return readdirSync(TABS_DIR)
        .filter(f => f.endsWith('Tab.tsx'))
        .map(f => join(TABS_DIR, f))
        .filter(f => statSync(f).isFile())
}

/**
 * The `className` of the element a tab component returns.
 *
 * Deliberately crude: it takes the first `className="…"` after the
 * component's `return (`, which is the outermost wrapper. A tab that grew a
 * fragment or a conditional root would slip past this — but that shape does
 * not exist here, and a cleverer parser would be harder to trust than the
 * thing it checks.
 */
function rootClassNames(source: string): string[] {
    const out: string[] = []
    const returns = [...source.matchAll(/\n    return \(\s*\n\s*<[A-Za-z.]+\s+([^>]*?)>/gs)]
    for (const m of returns) {
        const cls = m[1].match(/className="([^"]*)"/)
        if (cls) out.push(cls[1])
    }
    return out
}

describe('tab bodies do not cap the page width', () => {
    const files = tabFiles()

    it('finds the tab components to check', () => {
        // A rename that emptied this list would make every assertion below
        // vacuously true.
        expect(files.length).toBeGreaterThanOrEqual(4)
    })

    it.each(files)('%s has no max-w cap on its root', file => {
        const roots = rootClassNames(readFileSync(file, 'utf8'))
        expect(roots.length).toBeGreaterThan(0)
        for (const cls of roots) {
            expect(cls).not.toMatch(/\bmax-w-/)
        }
    })

})
