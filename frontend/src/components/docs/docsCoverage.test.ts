import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The pages that list every feature switch, permission and role list all of
 * them.
 *
 * Switches and permissions are added in the backend seeds, and the pages that
 * explain them were each a release or two behind (10 of 28 switches and 6 of
 * 23 permissions were missing). These read the seeds the way the backend
 * does, so a new switch, permission or role fails here until it is written up.
 */

const ROOT = join(__dirname, '..', '..', '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/** `{ key, name }` for every switch in `SEED_DEFINITIONS`. */
function seededSwitches(): Array<{ key: string; name: string }> {
  const src = read('backend/app/config/features_seed.py')
  const defs = src.slice(src.indexOf('SEED_DEFINITIONS'))
  return defs
    .split(/\n\s*"key":\s*/)
    .slice(1)
    .map((chunk) => ({
      key: /^"([^"]+)"/.exec(chunk)?.[1] ?? '',
      name: /"name":\s*"([^"]+)"/.exec(chunk)?.[1] ?? '',
    }))
}

/** Permission ids from `PERMISSIONS` and role names from `SYSTEM_ROLES`. */
function seededRbac(): { permissions: string[]; roles: string[] } {
  const src = read('backend/app/config/rbac_seed.py')
  const block = (name: string) => src.slice(src.indexOf(`${name}:`), src.indexOf('\n)', src.indexOf(`${name}:`)))
  return {
    permissions: [...block('PERMISSIONS').matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]),
    roles: [...block('SYSTEM_ROLES').matchAll(/"name":\s*"([^"]+)"/g)].map((m) => m[1]),
  }
}

describe('every seeded switch, permission and role is documented', () => {
  const switches = seededSwitches()
  const { permissions, roles } = seededRbac()

  it('reads the seeds (the parse itself works)', () => {
    expect(switches.length).toBeGreaterThanOrEqual(20)
    expect(switches.every((s) => s.key && s.name)).toBe(true)
    expect(permissions.length).toBeGreaterThanOrEqual(20)
    expect(roles).toContain('super_admin')
  })

  it('the Feature Switches guide names every switch as Administration → Features shows it', () => {
    const page = read('docs/guide/FEATURE_SWITCHES.md')
    expect(switches.filter((s) => !page.includes(s.name)).map((s) => s.name)).toEqual([])
  })

  it('the Feature Switches API reference lists every switch key', () => {
    const page = read('docs/API_FEATURES.md')
    expect(switches.filter((s) => !page.includes(`\`${s.key}\``)).map((s) => s.key)).toEqual([])
  })

  it('the RBAC reference lists every permission and every built-in role', () => {
    const page = read('docs/RBAC.md')
    expect(permissions.filter((p) => !page.includes(`\`${p}\``))).toEqual([])
    expect(roles.filter((r) => !page.includes(`\`${r}\``))).toEqual([])
  })
})
