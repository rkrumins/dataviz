/**
 * Only the app shell is sized to the viewport.
 *
 * App.tsx is one viewport-tall column: the backend banners, then a route box
 * that scrolls every page outside AppLayout. AppLayout's <main> clips, so each
 * signed-in page brings its own scroller. A page sized to the viewport
 * (`min-h-screen`, `h-screen`, `w-screen`, or a dvh/svh/lvh twin) is the wrong
 * size wherever it renders: taller than the route box by the banners, wider
 * than it by a scrollbar, and clipped with no scrollbar under AppLayout. Such a
 * page assumes the document scrolls, which here it never does. That is how the
 * sign-in page's SSO buttons and footer ended up out of reach on any window
 * shorter than the card.
 *
 * jsdom has no layout, so no render test can see this. It is pinned at the
 * source level instead.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lineAt, stripComments } from '@/test/jsxSourceScan'

const SRC = resolve(__dirname, '..')

/** Where a viewport size is right, with the reason. Keep it short. */
const ALLOWED = new Map<string, string>([
  ['App.tsx', 'The shell itself: the one element sized to the viewport.'],
  [
    'components/admin/FirstRunHero.tsx',
    'Its full-page branch is never rendered; both callers pass `embedded`.',
  ],
])

const HOW_TO_FIX =
  'Size a page to its container, not the viewport: `min-h-full` for a page outside '
  + 'AppLayout (the route box in App.tsx scrolls it), and `absolute inset-0 '
  + 'overflow-y-auto` or `h-full overflow-y-auto` for one inside it. An overlay '
  + 'that covers the viewport is `fixed inset-0`, not `h-screen w-screen`.'

const VIEWPORT_SIZED = /(?<![\w-])(?:min-|max-)?[hw]-(?:screen|dvh|svh|lvh)(?![\w-])/g

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      // harness/ holds separate Vite entries that never render inside the shell.
      if (!['__tests__', 'node_modules', 'harness'].includes(entry.name)) out.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

function viewportSized(): string[] {
  const out: string[] = []
  for (const path of sourceFiles(SRC)) {
    const rel = relative(SRC, path)
    if (ALLOWED.has(rel)) continue
    const src = stripComments(readFileSync(path, 'utf8'))
    for (const m of src.matchAll(VIEWPORT_SIZED)) {
      out.push(`${rel}:${lineAt(src, m.index)} — ${m[0]}`)
    }
  }
  return out.sort()
}

describe('only the app shell is sized to the viewport', () => {
  it('the sweep actually walks the app', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(400)
  })

  it('no page or panel is sized to the viewport', () => {
    expect(viewportSized(), HOW_TO_FIX).toEqual([])
  })
})
