/**
 * Screenshot the workspace page harness through the real browser, for each
 * reader and state that matters. Same shape as analytics-shot.mjs: starts Vite,
 * drives the pre-installed Chromium, writes PNGs to .harness/.
 *
 *   node scripts/workspace-shot.mjs [shot ...]
 *
 * A shot is `as:fixture:tab[:section][:dark|:technical|:390|:tall][:key=value…]`, e.g.
 * `admin:failing:data:processing`, `viewer:populated:overview:dark`, or
 * `admin:populated:data:ds=ds_ledger:click=Edit details:390` — a `key=value` is passed to
 * the harness as it is (`ds`, `dstab`, `click`, `steward`, `details`…).
 * HARNESS_PORT picks Vite's port (default 5199), HARNESS_OUT the folder (default .harness).
 */
import { spawn, execFile } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)
const PORT = Number(process.env.HARNESS_PORT || 5199)
const OUT = process.env.HARNESS_OUT || '.harness'

const SHOTS = process.argv.slice(2).length ? process.argv.slice(2) : [
  // The front page, as each reader meets it.
  'viewer:populated:overview', 'member:populated:overview', 'admin:failing:overview',
  // A workspace still being set up: the checklist and the empty states.
  'admin:empty:overview', 'viewer:empty:overview', 'admin:empty:data',
  // The data behind it, in plain words — and the machinery, for the Technical view.
  'member:populated:data', 'admin:failing:data:processing', 'admin:failing:data:processing:technical',
  'admin:populated:data:model', 'admin:populated:settings',
  'viewer:populated:overview:dark', 'admin:failing:overview:dark',
  // Data source details: the Sources grid and its filter, a source's About card, both
  // forms and its history — at desktop and phone width, light and dark.
  ...['', ':dark', ':390'].flatMap(v => [
    `member:populated:data${v}`,
    `member:populated:data:click=regulatory${v}`,
    `admin:populated:data:ds=ds_ledger${v}`,
    `viewer:populated:data:ds=ds_reg${v}`,
    `member:populated:data:ds=ds_risk${v}`,
    `admin:populated:data:ds=ds_ledger:click=Edit details${v}`,
    `admin:populated:data:ds=ds_reg:click=Change status${v}`,
    `viewer:populated:data:ds=ds_ledger:dstab=activity${v}`,
  ]),
]

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

// Its own process group, so stopping it stops Vite too and not only the npx in front of it.
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
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
    const section = extra.find(x => !['dark', 'technical', '390', 'tall'].includes(x) && !x.includes('='))
    const query = new URLSearchParams({ as, fixture, tab })
    if (section) query.set('section', section)
    if (extra.includes('dark')) query.set('theme', 'dark')
    if (extra.includes('technical')) query.set('mode', 'technical')
    for (const kv of extra.filter(x => x.includes('='))) query.set(kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1))
    // `tall`: a page that runs past one screen, whole.
    const size = extra.includes('390') ? (extra.includes('tall') ? '390,2600' : '390,1100') : (extra.includes('tall') ? '1440,2400' : '1440,1500')
    const out = join(OUT, `workspace-${shot.replace(/[:=]/g, '-').replace(/\s+/g, '_')}.png`)
    await run(chromium, [
      '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=2', `--window-size=${size}`, '--virtual-time-budget=6000',
      `--screenshot=${out}`, `http://localhost:${PORT}/workspace-harness.html?${query}`,
    ])
    console.log('  ✓', out)
  }
} finally {
  try { process.kill(-vite.pid, 'SIGTERM') } catch { vite.kill('SIGTERM') }
}
