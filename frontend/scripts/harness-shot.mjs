/**
 * Screenshot every Lens harness fixture through the real browser.
 *
 * Starts Vite, drives the pre-installed Chromium at each fixture, writes
 * PNGs to .harness/. No Playwright dependency — Chromium's own headless
 * --screenshot is enough, and adding a browser automation dep to ship a
 * screenshot would not be.
 *
 *   node scripts/harness-shot.mjs [fixture ...]
 */
import { spawn, execFile } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)
const PORT = 5199
const OUT = '.harness'
const FIXTURES = process.argv.slice(2).length ? process.argv.slice(2) : ['columns', 'deep', 'wide', 'small']

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

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'inherit'],
})
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Vite did not start in 60s')), 60_000)
  vite.stdout.on('data', d => {
    process.stdout.write(d)
    if (String(d).includes('Local:')) { clearTimeout(timer); resolve() }
  })
})

try {
  await ready
  for (const fixture of FIXTURES) {
    const out = join(OUT, `${fixture}.png`)
    await run(chromium, [
      '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--window-size=1600,900',
      '--virtual-time-budget=4000',
      `--screenshot=${out}`,
      `http://localhost:${PORT}/lens-harness.html?fixture=${fixture}`,
    ], { maxBuffer: 32 * 1024 * 1024 })
    console.log(`  → ${out}`)
  }
} finally {
  vite.kill('SIGTERM')
}
