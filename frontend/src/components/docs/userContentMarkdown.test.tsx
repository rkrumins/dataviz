/**
 * User-authored markdown must not reach the fenced-block widgets.
 *
 * `markdownComponents` turns ```mermaid into `MermaidBlock`, which runs
 * mermaid at `securityLevel: 'loose'` — no sanitising, node labels
 * accept raw HTML — and injects the result with
 * `dangerouslySetInnerHTML`. That is fine for the docs, whose markdown
 * is imported from this repository at build time. It is not fine for a
 * property value, which anyone with edit rights writes.
 *
 * The property editor was using the docs map for its preview. Only the
 * author saw it, so the exposure was self-inflicted rather than stored
 * — but "only the author sees it" was a property of one call site, and
 * the map is exported and used in six places.
 *
 * Asserted structurally rather than by rendering, because the point is
 * which components are wired up, and a render test would pass the day
 * somebody re-pointed the editor back at the docs map through a
 * different import.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  markdownComponents,
  userContentMarkdownComponents,
} from './MarkdownComponents'

const SRC = resolve(__dirname, '../..')

describe('user-content markdown map', () => {
  it('does not share the docs map’s pre handler', () => {
    // `pre` is where every widget escape lives — mermaid, the lineage
    // demo, and the tour button all key off the fence language there.
    expect(userContentMarkdownComponents.pre).not.toBe(
      markdownComponents.pre,
    )
  })

  it('keeps the rest of the docs formatting', () => {
    // Headings, tables, callouts and links should be identical — this
    // is a narrowing, not a separate renderer.
    for (const key of ['h1', 'h2', 'table', 'blockquote', 'a', 'img']) {
      expect(userContentMarkdownComponents[key as 'h1']).toBe(
        markdownComponents[key as 'h1'],
      )
    }
  })

  it('is what the property editor actually imports', () => {
    // The wiring is the finding. A map nobody uses fixes nothing.
    const editor = readFileSync(
      resolve(SRC, 'components/panels/property/MarkdownValueEditor.tsx'),
      'utf8',
    )
    expect(editor).toContain('userContentMarkdownComponents')
    expect(editor).not.toMatch(/components=\{markdownComponents\}/)
  })

  it('no user-content surface imports the docs map directly', () => {
    // The docs map belongs to /docs, /guide and the help panel, whose
    // markdown ships in the repo. If another user-content surface picks
    // it up later, this is what says so.
    const userSurfaces = [
      'components/panels/property/MarkdownValueEditor.tsx',
      'components/panels/property/valueWidgets.tsx',
    ]
    for (const rel of userSurfaces) {
      const body = readFileSync(resolve(SRC, rel), 'utf8')
      expect(
        body.includes('components={markdownComponents}'),
        `${rel} renders user-authored markdown through the docs map`,
      ).toBe(false)
    }
  })
})
