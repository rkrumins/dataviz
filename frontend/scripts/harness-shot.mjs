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
const FIXTURES = process.argv.slice(2).length
  ? process.argv.slice(2)
  // Every walk shape by default: whether a deep estate genuinely NESTS,
  // whether a diamond stays one card, whether every ⊕ state is legible
  // side by side, whether the direction preset + path highlight actually
  // draw, and — the two reported live — whether a platform holding both
  // the focus and its partners still lays out as hop COLUMNS rather than
  // collapsing into one tower. None of those can be checked any other
  // way.
  // ...and the two the user reported on 2026-08-14: a column whose own
  // platform is part of its lineage (the board that came back empty), and
  // a platform focus whose inside is not its lineage (the ⊕ that grew
  // and delivered nothing).
  //
  // ...and whether a sixty-child container reads as a BROWSABLE list —
  // one row language, connected first, a divider before the rest, honest
  // counts in the header and a peek beside the row you clicked.
  //
  // ...and whether ISOLATING one element's lineage reads as an answer:
  // the cone lit and graded, a sibling producer of the same consumer
  // quieted, and the chip that says what is isolated and how to leave —
  // at table grain, and again at COLUMN grain, where eight wires run
  // side by side and only one of them is the answer.
  //
  // ...and the half of a windowed list a shot at rest cannot show: the
  // fade under the header and the step back, which exist only once the
  // window has left the top.
  //
  // ...and the SCALE MANDATE (user, 2026-08-14): a 20-hop chain, and a
  // hub of 100 upstream across twelve systems plus 40 downstream — so a
  // performance fix that only looks fast on a five-card board is caught.
  //
  // ...and THE GRAIN SEAM (Task 22, user 2026-08-14): a cone that once
  // presented table-grain knowledge as column-grain fact (over-claim) and
  // its mirror, a row's cone going dark through a coarse hop its own
  // frame carries (under-claim) — plus the in-frame routing and badge
  // legibility the same estate exercises.
  : ['walkCollaterals', 'walkDeep', 'walkDiamond', 'walkHub', 'walkFrontier', 'walkSmall', 'walkDirectionAndHighlight',
    'walkSharedPlatform', 'walkSharedPlatformLeaf', 'walkSharedPlatformOneColumn', 'walkDensePills',
    'walkChildrenRich', 'walkChildrenScrolled', 'walkColumnFocus', 'walkPlatformFocus',
    'walkIsolatedCone', 'walkIsolatedLeafCone', 'walkLongChain', 'walkWideHub',
    'walkGrainSeam', 'walkGrainSeamUnderclaim']

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

// `--strictPort` so a server left over from an earlier run FAILS here
// rather than being silently reused. A reused server serves the module
// graph it started with, so the screenshots come back showing code you
// already changed — which reads as "my fix didn't work" and costs an
// hour. Say so plainly instead.
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
  for (const fixture of FIXTURES) {
    // Perf measurement runs (Task 20, P0) pass a raw query string, e.g.
    // `fixture=walkWideHub&perf=1`, to reach the harness's rAF sampler —
    // everyone else passes a bare fixture name. `perf=1` also needs more
    // wall-clock than a static shot: the sampler runs for ~1.5s before it
    // has anything to report.
    const query = fixture.includes('=') ? fixture : `fixture=${fixture}`
    const budget = fixture.includes('perf=1') ? 8000 : 4000
    const safeName = fixture.replace(/[^a-zA-Z0-9_-]+/g, '-')
    const out = join(OUT, `${safeName}.png`)
    await run(chromium, [
      '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--window-size=1600,900',
      `--virtual-time-budget=${budget}`,
      `--screenshot=${out}`,
      `http://localhost:${PORT}/lens-harness.html?${query}`,
    ], { maxBuffer: 32 * 1024 * 1024 })
    console.log(`  → ${out}`)
  }
} finally {
  vite.kill('SIGTERM')
}
