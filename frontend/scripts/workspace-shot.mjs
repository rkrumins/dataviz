/**
 * Screenshot the workspace page harness through the real browser, for each
 * reader and state that matters. Same shape as analytics-shot.mjs: starts Vite,
 * drives the pre-installed Chromium, writes PNGs to .harness/.
 *
 *   node scripts/workspace-shot.mjs [shot ...]
 *
 * A shot is `as:fixture:tab[:section][:dark|:technical]`, e.g.
 * `admin:failing:data:processing` or `viewer:populated:overview:dark`.
 */
import { spawn, execFile } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)
const PORT = 5199
const OUT = '.harness'

const SHOTS = process.argv.slice(2).length ? process.argv.slice(2) : [
  // The front page, as each reader meets it.
  'viewer:populated:overview', 'member:populated:overview', 'admin:failing:overview',
  // A workspace still being set up: the checklist and the empty states.
  'admin:empty:overview', 'viewer:empty:overview', 'admin:empty:data',
  // The data behind it, in plain words — and the machinery, for the Technical view.
  'member:populated:data', 'admin:failing:data:processing', 'admin:failing:data:processing:technical',
  'admin:populated:data:model', 'admin:populated:settings',
  'viewer:populated:overview:dark', 'admin:failing:overview:dark',
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

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] })
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Vite did not start in 60s')), 60_000)
  vite.stdout.on('data', d => { if (String(d).includes('Local:')) { clearTimeout(timer); resolve() } })
  vite.stderr.on('data', d => {
    if (String(d).includes('is in use')) {
      clearTimeout(timer)
      reject(new Error(`Port ${PORT} is already in use — stop it first:  pkill -f "vite --port ${PORT}"`))
    }
  })
})

try {
  await ready
  for (const shot of SHOTS) {
    const parts = shot.split(':')
    const [as, fixture, tab] = parts
    const extra = parts.slice(3)
    const section = extra.find(x => !['dark', 'technical'].includes(x))
    const query = new URLSearchParams({ as, fixture, tab })
    if (section) query.set('section', section)
    if (extra.includes('dark')) query.set('theme', 'dark')
    if (extra.includes('technical')) query.set('mode', 'technical')
    const out = join(OUT, `workspace-${shot.replace(/:/g, '-')}.png`)
    await run(chromium, [
      '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=2', '--window-size=1440,1500', '--virtual-time-budget=5000',
      `--screenshot=${out}`, `http://localhost:${PORT}/workspace-harness.html?${query}`,
    ])
    console.log('  ✓', out)
  }
} finally {
  vite.kill('SIGTERM')
}
