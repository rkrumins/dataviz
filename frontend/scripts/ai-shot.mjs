/**
 * Screenshot every AI assistant harness state through the real browser.
 *
 * Same shape as `search-shot.mjs`: the states are named fixtures in
 * `src/harness/aiFixtures.ts`, each a URL of `ai-harness.html`, so a card, the
 * streaming states or the dark palette is judged by looking rather than by
 * asserting. Chromium's own headless --screenshot, on its virtual clock, which
 * also runs the scripted stream to its end before the shot.
 *
 *   node scripts/ai-shot.mjs [fixture[:dark][:business][:w360][:top] ...]
 */
import { spawn, execFile } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)
const PORT = 5199
const OUT = '.harness'

// Each state light; the ones carrying the most colour dark as well; the
// densest at the rail's narrowest.
const SHOTS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'empty', 'empty:dark', 'emptyApp', 'helpEmpty', 'notConfigured', 'notConfigured:dark',
  'impact:top', 'impact', 'impact:dark:top', 'impact:w360:top', 'upstream:top',
  'pii', 'pii:dark', 'results:top', 'results:dark:top', 'results:w360:top',
  'help', 'help:dark', 'views', 'query:top', 'query:dark:top', 'error',
  'thinking', 'streaming', 'streaming:dark',
  // What it knows about the page: the card over the chip, as an answer's card, on a generic
  // schema, the type confirmation, a workspace and a guide page.
  'contextCard', 'contextCard:dark', 'contextCard:business', 'contextCard:w360',
  'contextBlock:top', 'contextBlock:dark:top', 'contextBlock:w360:top',
  'genericWelcome', 'genericWelcome:dark', 'genericCard', 'genericCard:dark',
  'typeConfirm', 'typeConfirm:dark', 'workspaceWelcome', 'workspaceWelcome:dark', 'docHelp', 'docHelp:dark',
  // The launcher, and the bottom-right corner it shares.
  'launcher', 'launcher:dark', 'launcherPill', 'launcherPill:dark', 'launcherUnread', 'launcherUnread:dark',
  'launcherStreaming', 'launcherDock', 'launcherDock:dark', 'launcherChecklist',
]

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  if (!existsSync(root)) return null
  for (const dir of readdirSync(root)) {
    if (!dir.startsWith('chromium-')) continue
    // Older Playwright builds unpack to chrome-linux, newer ones to chrome-linux64.
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

// `--strictPort` so a leftover server FAILS here rather than being silently
// reused (it would serve the module graph it started with). Its own process
// group, so stopping it stops the Vite that `npx` starts.
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
    // `fixture[:dark][:business][:w360][:top]` — any order after the fixture.
    const [fixture, ...flags] = shot.split(':')
    const query = [`fixture=${fixture}`]
    for (const flag of flags) {
      if (flag === 'dark') query.push('theme=dark')
      else if (flag === 'business') query.push('persona=business')
      else if (/^w\d+$/.test(flag)) query.push(`width=${flag.slice(1)}`)
      else if (flag === 'top') query.push('scroll=top')
    }
    const out = join(OUT, `ai-${shot.replace(/:/g, '-')}.png`)
    await run(chromium, [
      '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--window-size=1280,1600',
      '--virtual-time-budget=8000',
      `--screenshot=${out}`,
      `http://localhost:${PORT}/ai-harness.html?${query.join('&')}`,
    ])
    console.log('  ✓', out)
  }
} finally {
  try { process.kill(-vite.pid, 'SIGTERM') } catch { /* already gone */ }
}
process.exit(0)
