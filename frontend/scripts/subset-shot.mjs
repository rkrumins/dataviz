/**
 * Screenshot the subset-view UI through the real browser: the Subset
 * Studio's steps, the virtual-hop path popover, the status chip and the
 * create dialog, in light and dark.
 *
 * Same shape as `harness-shot.mjs`: jsdom does no layout, so a panel that
 * overflows its rail or a chip that clips its label passes every unit test.
 *
 *   node scripts/subset-shot.mjs [fixture[:dark] ...]
 */
import { spawn, execFile } from 'node:child_process'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import { join } from 'node:path'

const run = promisify(execFile)
const PORT = 5198
const OUT = join('.harness', 'subset')
const FIXTURES = ['studioPick', 'studioConnect', 'studioShape', 'pathPopover', 'hopsChip', 'wizardDetails', 'wizardReview']
const SHOTS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : FIXTURES.flatMap(f => [f, `${f}:dark`])

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
      reject(new Error(`Port ${PORT} is already serving an older build. Stop it first: pkill -f "vite --port ${PORT}"`))
    }
  })
})

try {
  await ready
  for (const shot of SHOTS) {
    const [fixture, theme] = shot.split(':')
    const out = join(OUT, `${fixture}${theme === 'dark' ? '-dark' : ''}.png`)
    await run(chromium, [
      '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=2', '--window-size=1400,900', '--virtual-time-budget=5000',
      `--screenshot=${out}`,
      `http://localhost:${PORT}/subset-harness.html?fixture=${fixture}${theme === 'dark' ? '&theme=dark' : ''}`,
    ], { maxBuffer: 32 * 1024 * 1024 })
    console.log(`  → ${out}`)
  }
} finally {
  vite.kill('SIGTERM')
}
