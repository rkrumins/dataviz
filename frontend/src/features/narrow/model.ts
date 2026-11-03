/**
 * Narrow — the canvas shows only chosen entities and what they reach.
 *
 * The scope is resolved on the server (`POST /graph/members`, the membership
 * contract in `backend/common/models/view_membership.py`), so the answer is the
 * same for everyone, for a share link, and for any script — and is computed once
 * for all of them. The wire types are `@/types/membership`; this module is what
 * the canvas makes of them: the presets people pick from, the sentence that says
 * what a spec will show, and the read-outs drawn from a result (which rows stay,
 * and how the members spread over the view's layers).
 *
 * Pure: no React, no store.
 */
import type {
  MemberEntry,
  MembershipExpand,
  MembershipResult,
  MembershipSeeds,
  MembershipSpec,
} from '@/types/membership'

/** The server's limits, restated for the controls (a spec past them is refused). */
export const SEEDS_MAX = 5000
export const HOPS_MAX = 25

export const NO_EXPANSION: MembershipExpand = { children: 0, upstream: 0, downstream: 0, partnerChildren: 0 }

export function specFor(seeds: MembershipSeeds, expand: Partial<MembershipExpand> = {}, within: MembershipSpec['within'] = 'view'): MembershipSpec {
  return { v: 1, seeds, within, expand: { ...NO_EXPANSION, ...expand } }
}

// ── Presets ────────────────────────────────────────────────────────────────

export type PresetId = 'just' | 'one-level' | 'two-levels' | 'neighbours' | 'upstream' | 'downstream'

export interface NarrowPreset {
  id: PresetId
  label: string
  /** What it shows, in words. */
  hint: string
  expand: MembershipExpand
  /** Needs the Lineage trace switch on. */
  lineage: boolean
}

/** The common shapes, in the order people reach for them. */
export const PRESETS: readonly NarrowPreset[] = [
  { id: 'just', label: 'Nothing more', hint: 'Only the starting points themselves',
    expand: { ...NO_EXPANSION }, lineage: false },
  { id: 'one-level', label: 'One level in', hint: 'The entities and what sits directly inside them',
    expand: { ...NO_EXPANSION, children: 1 }, lineage: false },
  { id: 'two-levels', label: 'Two levels in', hint: 'Their children, and their children’s children',
    expand: { ...NO_EXPANSION, children: 2 }, lineage: false },
  { id: 'neighbours', label: 'Sources & consumers', hint: 'One step upstream and downstream, with what is inside those',
    expand: { ...NO_EXPANSION, upstream: 1, downstream: 1, partnerChildren: 1 }, lineage: true },
  { id: 'upstream', label: 'Entire upstream', hint: 'Everything that feeds them — for root cause',
    expand: { ...NO_EXPANSION, upstream: 'all' }, lineage: true },
  { id: 'downstream', label: 'Entire downstream', hint: 'Everything they feed — for impact',
    expand: { ...NO_EXPANSION, downstream: 'all' }, lineage: true },
]

export function presetOf(expand: MembershipExpand): PresetId | null {
  return PRESETS.find((p) => sameExpand(p.expand, expand))?.id ?? null
}

export function sameExpand(a: MembershipExpand, b: MembershipExpand): boolean {
  return a.children === b.children && a.upstream === b.upstream
    && a.downstream === b.downstream && a.partnerChildren === b.partnerChildren
}

export function usesLineage(expand: MembershipExpand): boolean {
  return expand.upstream !== 0 || expand.downstream !== 0
}

// ── Identity ───────────────────────────────────────────────────────────────

/** The spec written one way (seed URNs de-duplicated and sorted) — equal
 *  specs, equal keys. The server hashes the same canonical form. */
export function canonicalSpec(spec: MembershipSpec): MembershipSpec {
  if (!spec.seeds.urns) return spec
  const urns = [...new Set(spec.seeds.urns.map((u) => u.trim()).filter(Boolean))].sort()
  return { ...spec, seeds: { ...spec.seeds, urns } }
}

export function specKey(spec: MembershipSpec): string {
  const c = canonicalSpec(spec)
  return JSON.stringify([c.v, c.within, c.seeds.urns ?? null, c.seeds.query ?? null,
    c.expand.children, c.expand.upstream, c.expand.downstream, c.expand.partnerChildren])
}

// ── Words ──────────────────────────────────────────────────────────────────

const LEVELS = ['', 'one level', 'two levels']

function steps(n: number): string {
  return n === 1 ? 'one step' : `${n} steps`
}

/** The parts of an expansion, in words, without the seeds: ["everything inside
 *  them", "their sources 2 steps up"]. Empty: just the seeds. */
export function expansionPhrases(expand: MembershipExpand, plural = true): string[] {
  const them = plural ? 'them' : 'it'
  const their = plural ? 'their' : 'its'
  const out: string[] = []
  if (expand.children === 'all') out.push(`everything inside ${them}`)
  else if (expand.children) out.push(`${LEVELS[expand.children] ?? `${expand.children} levels`} inside ${them}`)
  const up = expand.upstream
  const down = expand.downstream
  if (up && down && up === down) {
    out.push(up === 'all' ? 'everything upstream and downstream' : `${their} sources and consumers ${steps(up)} out`)
  } else {
    if (up) out.push(up === 'all' ? 'everything upstream' : `${their} sources ${steps(up)} up`)
    if (down) out.push(down === 'all' ? 'everything downstream' : `what ${plural ? 'they feed' : 'it feeds'} ${steps(down)} down`)
  }
  if ((up || down) && expand.partnerChildren) {
    out.push(expand.partnerChildren === 'all' ? 'everything inside those' : 'what sits directly inside those')
  }
  return out
}

function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** "orders, everything inside it and everything upstream" — what a spec shows,
 *  given what its seeds are called (a name, "3 entities", "the search's 47 matches"). */
export function describeNarrow(spec: MembershipSpec, seedsLabel: string): string {
  const plural = !(spec.seeds.urns && spec.seeds.urns.length === 1)
  const parts = expansionPhrases(spec.expand, plural)
  return joinPhrases([seedsLabel, ...parts])
}

/** How the seeds are named: one by name, a few by count. */
export function seedsLabel(urns: readonly string[], nameOf: (urn: string) => string): string {
  if (urns.length === 1) return nameOf(urns[0])
  return `${urns.length.toLocaleString()} entities`
}

/** Each limit a result reached, in words — said, never silent. */
export function truncationNotes(result: MembershipResult): string[] {
  return result.truncated.map((t) => {
    switch (t.reason) {
      case 'seed_cap': return `The search found more than ${t.limit.toLocaleString()} matches — the first ${t.limit.toLocaleString()} are the starting points.`
      case 'member_cap': return `It reaches more than ${t.limit.toLocaleString()} entities — the first ${t.limit.toLocaleString()} are shown.`
      case 'trace_cap': return 'The lineage was too large to follow to its end — what was reached is shown.'
      case 'chains_cap': return `Only the first ${t.limit.toLocaleString()} can be opened up to on the canvas.`
      case 'deadline': return 'It ran out of time — what was reached is shown. Trying again may reach more.'
      case 'incomplete': return 'Part of the graph didn’t answer — what was reached is shown. Trying again may reach more.'
    }
  })
}

/** A short answer that asking again may improve on. */
export function canRetry(result: MembershipResult): boolean {
  return result.truncated.some((t) => t.reason === 'deadline' || t.reason === 'incomplete')
}

// ── What the canvas draws ──────────────────────────────────────────────────

export interface NarrowVisibility {
  /** Each member, by URN, with why. */
  byUrn: ReadonlyMap<string, MemberEntry>
  /** Containers of members: how many members are inside each. */
  ancestors: ReadonlyMap<string, number>
  /** Members whose everything-inside is in scope. */
  whole: ReadonlySet<string>
}

export function visibilityOf(result: MembershipResult): NarrowVisibility {
  const byUrn = new Map<string, MemberEntry>()
  for (const m of result.members) byUrn.set(m.urn, m)
  const ancestors = new Map<string, number>()
  for (const m of result.members) {
    for (const a of result.chains[m.urn] ?? []) ancestors.set(a, (ancestors.get(a) ?? 0) + 1)
  }
  return { byUrn, ancestors, whole: new Set(result.wholeSubtree) }
}

export interface LayerShare {
  layerId: string
  count: number
}

/**
 * How the members spread over the view's layers: each member is counted in the
 * layer it, or its nearest container, is drawn in. `elsewhere` counts members
 * with no drawn container (not loaded yet, or outside the view's layers).
 */
export function layerDistribution(
  result: MembershipResult,
  layerOf: (urn: string) => string | undefined,
): { layers: LayerShare[]; elsewhere: number } {
  const counts = new Map<string, number>()
  let elsewhere = 0
  for (const m of result.members) {
    let layer = layerOf(m.urn)
    for (const a of result.chains[m.urn] ?? []) {
      if (layer) break
      layer = layerOf(a)
    }
    if (layer) counts.set(layer, (counts.get(layer) ?? 0) + 1)
    else elsewhere++
  }
  return { layers: [...counts].map(([layerId, count]) => ({ layerId, count })), elsewhere }
}
