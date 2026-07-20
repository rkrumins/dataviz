import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import mermaid from 'mermaid'

/**
 * Every mermaid diagram in the docs/guide must parse under the installed
 * mermaid — otherwise the reader gets a "Syntax Error" where a diagram should
 * be. A mermaid major bump (parser gets stricter) or a hand-authored typo used
 * to surface only in the browser; this makes it a red build instead.
 *
 * Brand tokens are interpolated first, exactly as MarkdownComponents does at
 * render time, so `{brand}` in a diagram isn't a false failure.
 */
const DOCS = resolve(process.cwd(), '..', 'docs')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.md')) out.push(p)
  }
  return out
}

function mermaidBlocks(src: string): string[] {
  const out: string[] = []
  const re = /```mermaid\s*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.push(m[1])
  return out
}

describe('docs mermaid diagrams', () => {
  it('every mermaid block parses under the installed mermaid', async () => {
    mermaid.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'loose' })
    const failures: string[] = []
    for (const path of walk(DOCS)) {
      const blocks = mermaidBlocks(readFileSync(path, 'utf8'))
      for (let i = 0; i < blocks.length; i++) {
        const code = blocks[i]
          .replaceAll('{brand}', 'Context Visualization Platform')
          .replaceAll('{brandShort}', 'CVP')
        try {
          await mermaid.parse(code)
        } catch (e) {
          const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0]
          failures.push(`${path.replace(DOCS, 'docs')} [block ${i + 1}]: ${msg}`)
        }
      }
    }
    expect(failures).toEqual([])
  })
})
