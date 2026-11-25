/**
 * What a connection held for review is copied as — the same rule the enable job applies
 * (`bootstrap_worker._resolved`), so the review can show the result before anyone continues.
 *
 *  • `keep_first` — its first version as it is; `keep` — the version chosen.
 *  • `merge` — the versions not left out, every property any of them holds: where they disagree, the
 *    version picked for that property, else the first that holds it. Its confidence likewise
 *    ({@link CONFIDENCE_PICK}).
 *
 * The properties left out — the review's and the connection's own — are removed from whatever the
 * rule gives.
 */
import {
  CONFIDENCE_PICK, type BootstrapReviewChoice, type BootstrapReviewRule, type BootstrapReviewVersion,
} from '@/services/versioningApiService'

export interface ReviewPolicy {
  rule: 'keep_first' | 'merge'
  excludeProperties: string[]
}

export interface Resolved {
  properties: Record<string, unknown>
  confidence: number | null
  /** Per property (and {@link CONFIDENCE_PICK}): the version its value comes from. */
  from: Record<string, number>
}

export function effectiveRule(choice: BootstrapReviewChoice | null, policy: ReviewPolicy | null): BootstrapReviewRule {
  return choice?.rule ?? policy?.rule ?? 'keep_first'
}

export function resolveCopies(
  versions: BootstrapReviewVersion[], choice: BootstrapReviewChoice | null, policy: ReviewPolicy | null,
): Resolved {
  const bySeq = new Map(versions.map((v) => [v.seq, v]))
  const seqs = [...bySeq.keys()].sort((a, b) => a - b)
  const rule = effectiveRule(choice, policy)
  let properties: Record<string, unknown> = {}
  let confidence: number | null = null
  const from: Record<string, number> = {}
  const take = (v: BootstrapReviewVersion) => {
    properties = { ...v.properties }
    confidence = v.confidence
    for (const k of Object.keys(v.properties)) from[k] = v.seq
    if (v.confidence != null) from[CONFIDENCE_PICK] = v.seq
  }
  if (rule === 'keep' && choice?.keep != null && bySeq.has(choice.keep)) {
    take(bySeq.get(choice.keep)!)
  } else if (rule === 'merge') {
    const leftOut = new Set(choice?.excludeCopies ?? [])
    const merged = seqs.filter((q) => !leftOut.has(q))
    const used = merged.length ? merged : seqs.slice(0, 1)
    const picks = choice?.values ?? {}
    for (const q of used) {
      for (const [k, v] of Object.entries(bySeq.get(q)!.properties)) {
        if (!(k in properties)) { properties[k] = v; from[k] = q }
      }
    }
    for (const [k, q] of Object.entries(picks)) {
      const held = bySeq.get(q)?.properties
      if (k !== CONFIDENCE_PICK && used.includes(q) && held && k in held) { properties[k] = held[k]; from[k] = q }
    }
    const pick = picks[CONFIDENCE_PICK]
    const order = pick != null && used.includes(pick) ? [pick, ...used] : used
    const confFrom = order.find((q) => bySeq.get(q)!.confidence != null)
    confidence = confFrom != null ? bySeq.get(confFrom)!.confidence : null
    if (confFrom != null) from[CONFIDENCE_PICK] = confFrom
  } else {
    take(bySeq.get(seqs[0])!)
  }
  const excluded = new Set([...(policy?.excludeProperties ?? []), ...(choice?.excludeProperties ?? [])])
  for (const k of excluded) { delete properties[k]; delete from[k] }
  return { properties, confidence, from }
}

/** Every property any version holds, in the order they first appear. */
export function propertyNames(versions: BootstrapReviewVersion[]): string[] {
  const seen = new Set<string>()
  for (const v of versions) for (const k of Object.keys(v.properties)) seen.add(k)
  return [...seen]
}
