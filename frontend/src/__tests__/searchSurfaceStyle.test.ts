/**
 * ONE TYPE SCALE on the search surfaces built on the shared components.
 *
 * The search panel grew seventeen hand-picked font sizes — `text-[10px]`,
 * `text-[11.5px]`, `text-[12px]` — each a little different from its
 * neighbour, which is most of why the panel read as several products. The
 * surfaces here use the theme's steps only (`text-2xs` … `text-lg`), so a
 * size is a decision made once in the theme, not again in every file.
 *
 * SOURCE-LEVEL, like `oneTooltipSystem`: a pixel size renders fine in
 * jsdom, so only the text can show where one crept in.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '..')

/** The surfaces held to the scale — each new one joins as it is built. */
const SCOPE = [
    'components/canvas/search/panel/sentence',
    'components/canvas/search/panel/map',
    'components/canvas/search/panel/counts',
    'components/canvas/search/panel/vocabulary',
]

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path)
        return /\.tsx?$/.test(entry.name) ? [path] : []
    })
}

const sources = SCOPE.flatMap((dir) => sourceFiles(join(SRC, dir)))
    .map((file) => ({ rel: relative(SRC, file), src: readFileSync(file, 'utf8') }))


describe('one type scale on the new search surfaces', () => {
    it('the sweep reaches them', () => {
        const scanned = sources.map((s) => s.rel)
        expect(scanned).toContain('components/canvas/search/panel/sentence/ClauseLine.tsx')
        expect(scanned).toContain('components/canvas/search/panel/map/QueryMap.tsx')
    })

    it('sizes text with the theme\'s steps, never a pixel size of its own', () => {
        const offenders = sources.flatMap(({ rel, src }) =>
            [...src.matchAll(/\btext-\[\d[^\]]*\]/g)].map((m) => `${rel} — ${m[0]}`))
        expect(offenders, 'Use text-2xs, text-xs, text-sm, text-base or text-lg').toEqual([])
    })
})
