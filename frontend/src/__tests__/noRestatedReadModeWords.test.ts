/**
 * THE READ MODES ARE WORDED ONCE: in the registry
 * (`backend/app/config/versioned_graph_settings.py`), which generates
 * `src/generated/versionedGraphSettings.json`.
 *
 * What a read mode promises its readers had been written about seven times,
 * Admin → Infrastructure's `readModes.ts` among them, and several copies no
 * longer said what the code did. Now a screen takes a mode's words from the
 * catalogue (or the served schema), a test reads its labels from there, and a
 * comment names a mode by its id (`latest`, `in_place`, `beside`).
 *
 * SOURCE-LEVEL ON PURPOSE: a restated promise renders fine and reads fine, until
 * the registry's wording changes and the copy doesn't. So every file under
 * `src/` outside `src/generated/` is read, and none may hold a mode's promise
 * or its short name verbatim.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import catalogue from '@/generated/versionedGraphSettings.json'

const SRC = resolve(__dirname, '..')
const GENERATED = join(SRC, 'generated')

const READ_MODE = catalogue.settings.find((s) => s.key === 'reads.mode')
const WORDS = [...new Set((READ_MODE?.choices ?? []).flatMap((c) => [c.promise, c.short]))]

const HOW_TO_FIX =
  'Take the words from the catalogue instead: `CATALOGUE.settings` (or the schema the page reads), '
  + '`formatValue(setting, id)` for a mode\'s name, `choices.find(c => c.id === id)` in a test. '
  + 'In a comment, name the mode by its id.'

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return path === GENERATED ? [] : files(path)
    return [path]
  })
}

describe('the read modes’ words', () => {
  it('are in the catalogue: each mode has its promise and its short name there', () => {
    expect(READ_MODE?.choices.length).toBeGreaterThan(0)
    for (const c of READ_MODE!.choices) {
      expect(c.promise).not.toBe('')
      expect(c.short).not.toBe('')
    }
  })

  it('are restated nowhere else under src/', () => {
    const restated = files(SRC).flatMap((path) => {
      const text = readFileSync(path, 'utf8')
      return WORDS.filter((w) => text.includes(w)).map((w) => `${relative(SRC, path)}: “${w}”`)
    })
    expect(restated, HOW_TO_FIX).toEqual([])
  })
})
