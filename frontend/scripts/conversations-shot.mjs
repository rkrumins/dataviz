/**
 * Screenshot the conversations harness through the real browser: every page, at desktop and
 * phone width, light and dark. Same shape as workspace-shot.mjs: starts Vite, drives the
 * pre-installed Chromium, writes PNGs to .harness/ (HARNESS_OUT to change it).
 *
 *   node scripts/conversations-shot.mjs [shot ...]
 *
 * A shot is `page[:state][:dark][:390]`, e.g. `thread:answered:dark` or `ask:entity:390`.
 * HARNESS_PORT picks Vite's port (default 5377).
 */
import { spawn, execFile } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)
const PORT = Number(process.env.HARNESS_PORT || 5377)
const OUT = process.env.HARNESS_OUT || '.harness'

const PAGES = [
  'view-drawer', 'thread:open', 'thread:answered', 'thread:private', 'thread:anchored', 'thread:deleted', 'thread:closed',
  'ask', 'ask:entity', 'rows', 'inbox',
  'profile:overview', 'profile:conversations', 'profile:thread', 'profile:watching', 'profile-other', 'contacts:named', 'contacts:derived',
  'contacts:edit', 'source-tab', 'hovercard', 'cards',
]
const SHOTS = process.argv.slice(2).length ? process.argv.slice(2)
  : PAGES.flatMap(p => [p, `${p}:dark`, `${p}:390`, `${p}:dark:390`])

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  if (!existsSync(root)) return null
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium-')) continue
    for (const sub of ['chrome-linux', 'chrome-linux64']) {
      const p = join(root, dir, sub, 'chrome')
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

// Its own process group, so stopping it stops Vite too and not only the npx in front of it
// (an orphaned Vite would hold its pipes open and keep this script from exiting).
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Vite did not start in 60s')), 60_000)
  vite.stdout.on('data', d => { if (String(d).includes('Local:')) { clearTimeout(timer); resolve() } })
  vite.stderr.on('data', d => {
    if (String(d).includes('is in use')) {
      clearTimeout(timer)
      reject(new Error(`Port ${PORT} is already in use — stop it first, or set HARNESS_PORT`))
    }
  })
})

try {
  await ready
  for (const shot of SHOTS) {
    const parts = shot.split(':')
    const [page] = parts
    const extra = parts.slice(1)
    const query = new URLSearchParams({ page })
    const state = extra.find(x => !['dark', '390', 'entity'].includes(x))
    if (state) query.set('state', state)
    if (extra.includes('entity')) query.set('entity', '1')
    if (extra.includes('dark')) query.set('theme', 'dark')
    const size = extra.includes('390') ? '390,844' : '1280,900'
    const out = join(OUT, `conversations-${shot.replace(/:/g, '-')}.png`)
    await run(chromium, [
      '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=2', `--window-size=${size}`, '--virtual-time-budget=6000',
      `--screenshot=${out}`, `http://localhost:${PORT}/conversations-harness.html?${query}`,
    ])
    console.log('  ✓', out)
  }
} finally {
  try { process.kill(-vite.pid, 'SIGTERM') } catch { vite.kill('SIGTERM') }
}
