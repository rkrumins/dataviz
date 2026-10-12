/**
 * Screenshot every Analytics privacy posture through the real browser.
 *
 * Same shape as `harness-shot.mjs` and for the same reason: the states this
 * covers are not reachable by hand. Seeing the strict view needs a second
 * account with no workspace bindings and two feature flags set a particular
 * way; the redaction work shipped twice with nobody having looked at it.
 *
 *   node scripts/analytics-shot.mjs [fixture:tab ...]
 */
import { spawn, execFile } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)
const PORT = 5199
const OUT = '.harness'

// One shot per posture on the tab where that posture is most visible, plus a
// dark pass — the chart palette is resolved in JavaScript, so dark is the only
// way to check the validated dark steps actually land.
const SHOTS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'privileged:overview', 'privileged:engagement', 'privileged:health',
  'privileged:workspaces', 'privileged:growth', 'privileged:content',
  'strict:overview',    // withheld people panel + locked leaderboards
  'strict:health',      // both operator sections withheld
  'strict:workspaces',  // locked rows with request-access
  'internal:overview',  // colleagues named again at the internal default
  'reported:workspaces',// named but not openable — reporting is not a door
  // A brand-new tenant: zeros that must not read as dead. Shot as an admin,
  // because the first-run panel offers the steps THIS reader can take and with
  // no claims the permission-gated half never renders.
  'firstRun:overview:admin',
  'privileged:overview:dark',
  'strict:overview:dark',
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
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
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
    // `fixture:tab[:dark|:admin]` — the third segment picks the palette or the
    // permission claims, whichever the posture needs.
    const [fixture, tab, mode] = shot.split(':')
    const query = `fixture=${fixture}&tab=${tab}`
      + (mode === 'dark' ? '&theme=dark' : '')
      + (mode === 'admin' ? '&perms=admin' : '')
    const out = join(OUT, `analytics-${shot.replace(/:/g, '-')}.png`)
    await run(chromium, [
      '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--window-size=1600,1400',
      '--virtual-time-budget=4000',
      `--screenshot=${out}`,
      `http://localhost:${PORT}/analytics-harness.html?${query}`,
    ])
    console.log('  ✓', out)
  }
} finally {
  vite.kill('SIGTERM')
}
