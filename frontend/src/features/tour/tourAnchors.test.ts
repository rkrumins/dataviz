import { describe, it, expect } from 'vitest'
import { TOURS } from './tours'

/**
 * Tour anchor integrity — the guard against a tour spotlighting nothing.
 *
 * Every step with a `[data-tour="x"]` target relies on a matching
 * `data-tour="x"` living on a real element. If a refactor renames or removes
 * that attribute, the step silently degrades to a floating centered card. This
 * turns that into a red build.
 */
const source = Object.values(
  import.meta.glob('/src/**/*.tsx', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>,
).join('\n')

const literalAnchors = new Set<string>()
for (const m of source.matchAll(/data-tour="([^"]+)"/g)) literalAnchors.add(m[1])
// SidebarNav emits nav rows dynamically: data-tour={`nav-${item.id}`}.
const hasDynamicNav = /data-tour=\{`nav-\$\{/.test(source)

function anchorExists(name: string): boolean {
  if (literalAnchors.has(name)) return true
  if (name.startsWith('nav-') && hasDynamicNav) return true
  return false
}

describe('tour anchors', () => {
  const targetNames = [
    ...new Set(
      TOURS.flatMap((t) => t.steps)
        .map((s) => s.target?.match(/\[data-tour="([^"]+)"\]/)?.[1])
        .filter((n): n is string => Boolean(n)),
    ),
  ]

  it('references at least the Explorer and Workspaces landmarks', () => {
    for (const n of ['explorer-results', 'explorer-search', 'explorer-filters', 'workspaces-create', 'workspaces-toolbar']) {
      expect(targetNames).toContain(n)
    }
  })

  it('every tour target resolves to a data-tour anchor in the source', () => {
    expect(targetNames.filter((n) => !anchorExists(n))).toEqual([])
  })
})
