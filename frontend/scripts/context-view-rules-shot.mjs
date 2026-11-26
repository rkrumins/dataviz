/**
 * Screenshot the Context View's lines as the view's relationship display rules paint them, through
 * the real browser: the `rules` scene of `context-view-harness.html` (src/harness/contextViewHarness.tsx)
 * at rest, with a dashboard selected (its lines carry the rules' chips), and with a painted line
 * hovered (its card names the rules). PNGs land in .harness/.
 *
 *   node scripts/context-view-rules-shot.mjs [shot[:dark] ...]
 *
 *   shots  rest · selected · hover
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const { chromium } = createRequire(import.meta.url)('playwright')
const PORT = 5199
const OUT = '.harness'
const SHOTS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['rest', 'rest:dark', 'selected', 'selected:dark', 'hover', 'hover:dark']

mkdirSync(OUT, { recursive: true })
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Vite did not start in 60s')), 60_000)
  vite.stdout.on('data', (d) => { if (String(d).includes('Local:')) { clearTimeout(timer); resolve() } })
  vite.stderr.on('data', (d) => {
    if (String(d).includes('is in use')) { clearTimeout(timer); reject(new Error(`Port ${PORT} is in use — stop it first: pkill -f "vite --port ${PORT}"`)) }
  })
})

const browser = await chromium.launch()
try {
  for (const shot of SHOTS) {
    const [name, flag] = shot.split(':')
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 })
    const query = new URLSearchParams({ fixture: 'rules', ...(flag === 'dark' ? { theme: 'dark' } : {}),
      ...(name === 'selected' ? { select: 'd0' } : {}) })
    await page.goto(`http://localhost:${PORT}/context-view-harness.html?${query}`)
    await page.waitForSelector('g[data-edge-rule]', { timeout: 30_000 })
    await page.waitForTimeout(name === 'selected' ? 1800 : 1200)
    if (name === 'hover') {
      // A point on a painted line's hit path (the hit layer draws each line again, with the same path).
      const at = await page.evaluate(() => {
        const core = [...document.querySelectorAll('g[data-edge-rule] path')].pop()
        const hit = [...document.querySelectorAll('path[data-canvas-interactive]')]
          .find((p) => p.getAttribute('d') === core?.getAttribute('d'))
        if (!hit) return null
        const p = hit.getPointAtLength(hit.getTotalLength() * 0.3)
        const m = hit.getScreenCTM()
        return { x: p.x * m.a + m.e, y: p.y * m.d + m.f }
      })
      if (at) {
        await page.mouse.move(at.x - 20, at.y - 20)
        await page.mouse.move(at.x, at.y, { steps: 6 })
        await page.waitForTimeout(700)
      }
    }
    const file = join(OUT, `context-view-rules-${name}${flag === 'dark' ? '-dark' : ''}.png`)
    await page.screenshot({ path: file })
    console.log(file)
    await page.close()
  }
} finally {
  await browser.close()
  process.kill(-vite.pid)
}
