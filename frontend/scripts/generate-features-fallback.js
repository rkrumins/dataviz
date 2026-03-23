/**
 * Generate features fallback JSON from backend seed (single source of truth).
 * Run from repo root: node frontend/scripts/generate-features-fallback.js
 * Or from frontend: npm run generate:features-fallback
 * Writes frontend/src/generated/featuresFallback.json
 */
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.join(__dirname, '..')
const repoRoot = path.join(frontendDir, '..')  // npm run from frontend → repo root
const outPath = path.join(frontendDir, 'src', 'generated', 'featuresFallback.json')

const result = spawnSync('python', ['backend/scripts/export_features_fallback.py'], {
  cwd: repoRoot,
  encoding: 'utf-8',
  maxBuffer: 1024 * 1024,
})

if (result.error) {
  console.error('Failed to run Python export script:', result.error.message)
  process.exit(1)
}
if (result.status !== 0) {
  console.error('Python script stderr:', result.stderr)
  process.exit(1)
}

const outDir = path.dirname(outPath)
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true })
}
fs.writeFileSync(outPath, result.stdout, 'utf-8')
console.log('Wrote', outPath)
