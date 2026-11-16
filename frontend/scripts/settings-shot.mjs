/**
 * Screenshot every settings-kit harness state through the real browser: the settings page in
 * both lenses, a graph's settings drawer, the review, the explainers and the primitives.
 *
 * Same shape as `provenance-shot.mjs`: the states are named fixtures in
 * `src/harness/settingsHarness.tsx`, each a URL of `settings-harness.html`, so a layout, the dark
 * palette or a phone width is judged by looking rather than by asserting.
 *
 *   node scripts/settings-shot.mjs [fixture[:dark][:mobile] ...]
 */
import { spawn, execFile } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)
const PORT = 5199
const OUT = '.harness'

const SHOTS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'platform', 'platform:dark', 'business', 'business:dark', 'graph', 'graph:dark', 'graph:mobile',
  'review', 'review:dark', 'visuals', 'visuals:dark', 'primitives', 'primitives:dark', 'business:mobile',
]

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  if (!existsSync(root)) return null
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium-')) continue
    for (const build of ['chrome-linux', 'chrome-linux64']) {
      const p = join(root, dir, build, 'chrome')
      if (existsSync(p)) return p
    }
  }
  return null
}

const chromium = findChromium()
if (!chromium) {
  console.error('No Chromium found. Set CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH.')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })

// `--strictPort` so a leftover server FAILS here rather than being silently reused, and its own
// process group so stopping it stops the Vite that `npx` starts.
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
      reject(new Error(`Port ${PORT} is already serving an older build. Stop it first:  pkill -f "vite --port ${PORT}"`))
    }
  })
})

try {
  await ready
  for (const shot of SHOTS) {
    const [fixture, ...flags] = shot.split(':')
    const query = [`fixture=${fixture}`]
    if (flags.includes('dark')) query.push('theme=dark')
    const mobile = flags.includes('mobile')
    const out = join(OUT, `settings-${shot.replace(/:/g, '-')}.png`)
    await run(chromium, [
      '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=2',
      mobile ? '--window-size=390,1600' : '--window-size=1440,2400',
      '--virtual-time-budget=5000',
      `--screenshot=${out}`,
      `http://localhost:${PORT}/settings-harness.html?${query.join('&')}`,
    ])
    console.log('  ✓', out)
  }
} finally {
  try { process.kill(-vite.pid, 'SIGTERM') } catch { /* already gone */ }
}
process.exit(0)
