/**
 * Every direction cue wears the reader's lineage direction pair
 * (lib/lineageDirectionColors.ts → --nx-lineage-in-rgb / --nx-lineage-out-rgb,
 * Tailwind `lineage-in` / `lineage-out`), never a fixed hue of its own. Read
 * at the source level for the surfaces jsdom cannot see (CSS) or cannot
 * reach cheaply (the 2,000-line Lens, the row's cue).
 *
 * Browse lines and the viewport's portal chips keep their flow type's
 * colour: a product choice, which Display › Lineage colours says.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8')

describe('the lineage direction pair on every direction cue', () => {
  it("a trace's sounding line reads the pair", () => {
    const css = read('../../../../styles/globals.css')
    const gradient = (name: string) => css.match(new RegExp(`\\.${name} \\{\\s*background-image: ([^;]*);`))?.[1]
    expect(gradient('nx-trace-sounding-up')).toBe(
      'linear-gradient(to left, rgb(var(--nx-lineage-in-rgb) / 0.9), rgb(var(--nx-lineage-in-rgb) / 0.18), rgb(var(--nx-lineage-in-rgb) / 0.9))')
    expect(gradient('nx-trace-sounding-down')).toBe(
      'linear-gradient(to right, rgb(var(--nx-lineage-out-rgb) / 0.9), rgb(var(--nx-lineage-out-rgb) / 0.18), rgb(var(--nx-lineage-out-rgb) / 0.9))')
  })

  it("the Lens's hop arrows and the selected entity's tallies read the pair", () => {
    const lens = read('../LineageLens.tsx')
    expect(lens).toContain("<LucideIcons.MoveRight className={cn('w-3.5 h-3.5 text-lineage-out/80'")
    expect(lens).toContain("<LucideIcons.MoveLeft className={cn('w-3.5 h-3.5 text-lineage-in/80'")
    expect(lens).toMatch(/text-lineage-in">\s*<LucideIcons\.ArrowDownLeft className="w-3 h-3" \/>\s*\{selectedInfo\.inCount\} in/)
    expect(lens).toMatch(/text-lineage-out">\s*<LucideIcons\.ArrowUpRight className="w-3 h-3" \/>\s*\{selectedInfo\.outCount\} out/)
  })

  it("a row's out-of-view cue reads the pair, not a fixed sky", () => {
    const row = read('../FlatTreeItem.tsx')
    expect(row).not.toContain('rgb(56,189,248)')
    expect(row).toContain("borderColor: 'rgb(var(--nx-lineage-in-rgb))'")
    expect(row).toContain("borderColor: 'rgb(var(--nx-lineage-out-rgb))'")
  })

  it('Display › Lineage colours says that lines keep their flow type colour', () => {
    expect(read('../LineageDisplayPopover.tsx').replace(/\s+/g, ' '))
      .toContain('Lines outside a trace keep the colour of their flow type.')
  })
})
