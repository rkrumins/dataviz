/**
 * Screenshot every Advanced Search harness state through the real browser.
 *
 * Same shape as `harness-shot.mjs` and `analytics-shot.mjs`: the states are
 * named fixtures in `src/harness/searchFixtures.ts`, each a URL of
 * `search-harness.html`, so a layout, a popover or the dark palette is
 * judged by looking rather than by asserting.
 *
 *   node scripts/search-shot.mjs [fixture[:dark][:technical][:w380] ...]
 */
import { spawn, execFile } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)
const PORT = 5199
const OUT = '.harness'

// Each state light, and the ones carrying the most colour dark as well.
const SHOTS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'empty', 'empty:dark', 'form', 'form:dark',
  'sentence', 'sentence:dark', 'sentence:w380', 'sentenceFlat', 'sentenceAny',
]

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  if (!existsSync(root)) return null
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium-')) continue
    const p = join(root, dir, 'chrome-linux', 'chrome')
    if (existsSync(p)) return p
  }
  return null
}

const chromium = findChromium()
if (!chromium) {
  console.error('No Chromium found. Set CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH.')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })

// `--strictPort` so a leftover server FAILS here rather than being silently
// reused — a reused server serves the module graph it started with, so the
// shots come back showing code you already changed.
// Its own process group, so stopping it stops the Vite that `npx` starts —
// killing `npx` alone leaves the server running and this script waiting.
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Vite did not start in 60s')), 60_000)
  vite.stdout.on('data', d => {
    process.stdout.write(d)
    if (String(d).includes('Local:')) { clearTimeout(timer); resolve() }
  })
  vite.stderr.on('data', d => {
    const s = String(d)
    process.stderr.write(s)
    if (s.includes('is in use')) {
      clearTimeout(timer)
      reject(new Error(
        `Port ${PORT} is already serving an older build — its screenshots would be stale.\n` +
        `Stop it first:  pkill -f "vite --port ${PORT}"`,
      ))
    }
  })
})

try {
  await ready
  for (const shot of SHOTS) {
    // `fixture[:dark][:technical][:w380]` — any order after the fixture.
    const [fixture, ...flags] = shot.split(':')
    const query = [`fixture=${fixture}`]
    for (const flag of flags) {
      if (flag === 'dark') query.push('theme=dark')
      else if (flag === 'technical') query.push('persona=technical')
      else if (/^w\d+$/.test(flag)) query.push(`width=${flag.slice(1)}`)
    }
    const out = join(OUT, `search-${shot.replace(/:/g, '-')}.png`)
    await run(chromium, [
      '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--window-size=1600,1000',
      '--virtual-time-budget=5000',
      `--screenshot=${out}`,
      `http://localhost:${PORT}/search-harness.html?${query.join('&')}`,
    ])
    console.log('  ✓', out)
  }
} finally {
  try { process.kill(-vite.pid, 'SIGTERM') } catch { /* already gone */ }
}
process.exit(0)
