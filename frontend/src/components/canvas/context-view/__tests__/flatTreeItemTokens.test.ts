/**
 * The card's selection ring, its shadow and its selected rail read the lineage
 * accent from a CSS variable. A variable nobody defines resolves to nothing,
 * silently: the ring was invisible while `--accent-lineage-rgb` (never
 * defined) stood in for `--nx-accent-lineage-rgb`.
 *
 * The defined token holds SPACE-separated channels (`99 102 241`), so it only
 * works in the space syntax, `rgb(var(--nx-…) / 0.3)`. Put in the comma
 * syntax, `rgba(var(--nx-…),0.3)` becomes `rgba(99 102 241,0.3)` — invalid
 * CSS, and just as invisible as the undefined name.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stripComments } from '@/test/jsxSourceScan'

const here = resolve(__dirname, '..')
const src = stripComments(readFileSync(resolve(here, 'FlatTreeItem.tsx'), 'utf8'))
const css = readFileSync(resolve(here, '../../../styles/globals.css'), 'utf8')

describe('FlatTreeItem reads CSS variables that exist, in a syntax that works', () => {
  it('every variable it reads is defined in globals.css', () => {
    const read = [...new Set([...src.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]))]
    expect(read.length).toBeGreaterThan(0)
    expect(read.filter(name => !css.includes(`${name}:`))).toEqual([])
  })

  it('no channel token in the comma syntax', () => {
    expect(src.match(/rgba\(var\(--nx-[\w-]*\),/g) ?? []).toEqual([])
  })
})
