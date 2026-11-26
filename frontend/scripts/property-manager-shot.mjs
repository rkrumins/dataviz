/**
 * Screenshot Property Manager's Properties tab — its relationships above all — through the real
 * browser, worked as a person would: the Properties tab opened, Relationships picked, a row opened,
 * the bulk dialog taken to its Where step. Each scene is a URL of `property-manager-harness.html`
 * (see `src/harness/propertyManagerHarness.tsx`); PNGs land in .harness/.
 *
 * Driven with Playwright, not Chromium's `--screenshot`, because every state here is behind a
 * click.
 *
 *   node scripts/property-manager-shot.mjs [shot[:dark] ...]
 *
 *   shots  entities · relationships · row (a row opened) · reading · stale · empty · unavailable ·
 *          error · where (the bulk dialog on a relationship property, at Where) · promote (a
 *          relationship property made a field) · rule (a display rule applied to relationships)
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const { chromium } = createRequire(import.meta.url)('playwright')
const PORT = 5199
const OUT = '.harness'

const SHOTS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'entities', 'relationships', 'relationships:dark', 'row', 'row:dark', 'reading', 'reading:dark',
  'stale', 'empty', 'empty:dark', 'unavailable', 'error', 'where', 'where:dark',
  'promote', 'promote:dark', 'rule', 'rule:dark',
]

/** Which harness scene each shot reads. */
const SCENE = { entities: 'relationships', row: 'relationships', where: 'relationships', promote: 'relationships',
  rule: 'relationships' }

mkdirSync(OUT, { recursive: true })

// `--strictPort`: a leftover server fails here rather than serving the code it started with.
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Vite did not start in 60s')), 60_000)
  vite.stdout.on('data', (d) => { if (String(d).includes('Local:')) { clearTimeout(timer); resolve() } })
  vite.stderr.on('data', (d) => {
    if (String(d).includes('is in use')) { clearTimeout(timer); reject(new Error(`Port ${PORT} is in use — stop it first: pkill -f "vite --port ${PORT}"`)) }
  })
})

const browser = await chromium.launch()
try {
  for (const shot of SHOTS) {
    const [name, flag] = shot.split(':')
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
    await page.goto(`http://localhost:${PORT}/property-manager-harness.html?scene=${SCENE[name] ?? name}${flag === 'dark' ? '&theme=dark' : ''}`)
    if (name === 'rule') {
      // A new display rule, applied to relationships: its three steps.
      await page.getByRole('button', { name: 'Display rules' }).click()
      await page.getByRole('button', { name: /New rule|Create your first rule/ }).click()
      await page.getByRole('radio', { name: /Relationships/ }).click()
    } else {
      await page.getByRole('button', { name: 'Properties' }).click()
      if (name !== 'entities') await page.getByRole('radio', { name: 'Relationships' }).click()
    }
    if (name === 'row' || name === 'where' || name === 'promote') await page.getByTitle('sla', { exact: true }).waitFor()
    if (name === 'promote') {
      const row = page.getByTitle('sla', { exact: true }).locator('xpath=ancestor::div[contains(@class, "group")][1]')
      await row.hover()
      // Shown while the row is hovered: clicked as the pointer reaches it.
      await page.locator('button[aria-label="More actions for sla"]').click({ force: true })
      await page.getByRole('menuitem', { name: /Make it a field/ }).click()
      await page.mouse.move(4, 4)                          // no tooltip left over from the menu
    }
    if (name === 'row') {
      await page.getByTitle('sla', { exact: true }).click()
      // The row opened, at the top of the tab: its gauge, its type bars and its values in view.
      await page.getByTitle('sla', { exact: true }).evaluate((el) => el.closest('.group').scrollIntoView({ block: 'start' }))
    }
    if (name === 'where') {
      const row = page.getByTitle('sla', { exact: true }).locator('xpath=ancestor::div[contains(@class, "group")][1]')
      await row.hover()
      await row.getByRole('button', { name: 'Change', exact: true }).click()
      await page.getByRole('textbox', { name: 'Value' }).fill('8h')
      await page.getByRole('button', { name: /^Next/ }).click()
    }
    await page.waitForTimeout(600)
    const out = join(OUT, `property-manager-${shot.replace(/:/g, '-')}.png`)
    await page.screenshot({ path: out })
    console.log('  ✓', out)
    await page.close()
  }
} finally {
  await browser.close()
  try { process.kill(-vite.pid, 'SIGTERM') } catch { /* already gone */ }
}
process.exit(0)
