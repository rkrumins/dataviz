/**
 * The words for an update's progress (the server's `progress`), shared by `UpdateProgress` and the
 * chips that set it in their own pills, so they say the same thing:
 *
 *   "Version 42: 63% written, about 4 min left"
 *   "Version 42 is being built beside: ready in about 3 min"
 *   "Updating to version 42"                      (a phase that counts no rows: no percentage)
 *
 * From the server's figures alone: no percentage without rows counted, no time without the
 * server's, never 100% before the update is done (every row written, it is "finishing up") and
 * never "0 min left" (under a minute is "less than a minute").
 */
import type { GraphUpdateProgress } from '@/services/versioningApiService'

type Phase = GraphUpdateProgress['phase']

/** How each phase is said, given its version as a sentence starts it ("Version 42") and as it
 *  reads mid-sentence ("version 42"). */
interface PhaseWords {
    /** The eyebrow: what kind of update this is. */
    label: string
    /** The sentence's subject, before its colon. */
    lead: (cap: string, low: string) => string
    /** A chip's subject. */
    short: (cap: string, low: string) => string
    /** The rows' verb: "63% written". */
    verb: string
    /** The phase alone, when it counts no rows: as a sentence, and in a chip. */
    alone: (cap: string, low: string) => string
    aloneShort: (cap: string, low: string) => string
}

const PHASES: Record<Phase, PhaseWords> = {
    updating: {
        label: 'Updating', lead: (cap) => cap, short: (cap) => cap, verb: 'written',
        alone: (_c, low) => `Updating to ${low}`, aloneShort: (_c, low) => `Updating to ${low}`,
    },
    seeding: {
        label: 'First copy', lead: (_c, low) => `First copy of ${low}`, short: (_c, low) => `First copy of ${low}`,
        verb: 'written', alone: (_c, low) => `Writing the first copy of ${low}`, aloneShort: (_c, low) => `First copy of ${low}`,
    },
    loading: {
        label: 'Loading', lead: (cap) => cap, short: (_c, low) => `Loading ${low}`, verb: 'loaded',
        alone: (_c, low) => `Loading ${low} into memory`, aloneShort: (_c, low) => `Loading ${low}`,
    },
    building: {
        label: 'Building beside', lead: (cap) => `${cap} is being built beside`, short: (_c, low) => `Building ${low}`,
        verb: 'written', alone: (cap) => `${cap} is being built beside`, aloneShort: (_c, low) => `Building ${low} beside`,
    },
    switching: {
        label: 'Switching when ready', lead: (cap) => `${cap} is being built beside`, short: (cap) => cap,
        verb: 'caught up', alone: (cap) => `${cap} is being built beside: catching up before the switch`,
        aloneShort: (cap) => `${cap}: catching up`,
    },
}

/** "about 4 min", "about 1 h 35 min", "less than a minute": never "0 min". */
export function aboutTime(secs: number): string {
    if (secs < 60) return 'less than a minute'
    const mins = Math.round(secs / 60)
    if (mins < 60) return `about ${mins} min`
    const rounded = Math.round(mins / 5) * 5
    const h = Math.floor(rounded / 60)
    const m = rounded % 60
    return m ? `about ${h} h ${m} min` : `about ${h} h`
}

export interface ProgressWords {
    /** What kind of update: "Updating", "Building beside"… */
    label: string
    /** The whole sentence, also the bar's `aria-valuetext`. */
    sentence: string
    /** A chip's few words, version included. */
    short: string
    /** A chip's words for a host that already names the version: null when it would add nothing. */
    bare: string | null
    /** 0–99 while rows are counted (99 once every row is written and it is finishing up); null
     *  when the phase counts none. */
    percent: number | null
    /** "about 4 min left", "ready in about 3 min"; null without a time from the server. */
    timeLeft: string | null
}

/** The words for `p`, from the server's figures alone. */
export function describeProgress(p: GraphUpdateProgress): ProgressWords {
    const words = PHASES[p.phase] ?? PHASES.updating
    const version = p.targetVersion ?? p.targetSeq
    const cap = version != null ? `Version ${version}` : 'The new version'
    const low = version != null ? `version ${version}` : 'the new version'
    const label = words.label
    if (p.total == null || p.total <= 0 || p.done == null) {
        return { label, sentence: words.alone(cap, low), short: words.aloneShort(cap, low), bare: null, percent: null, timeLeft: null }
    }
    const lead = words.lead(cap, low)
    const short = words.short(cap, low)
    if (p.done >= p.total) {
        return { label, sentence: `${lead}: finishing up`, short: `${short} · finishing up`, bare: 'finishing up', percent: 99, timeLeft: null }
    }
    if (p.done <= 0) {
        return { label, sentence: `${lead}: starting`, short: `${short} · starting`, bare: 'starting', percent: 0, timeLeft: null }
    }
    const percent = Math.min(99, Math.floor((p.done / p.total) * 100))
    const about = p.etaSecs != null && p.etaSecs > 0 ? aboutTime(p.etaSecs) : null
    if (p.phase === 'switching' && about) {
        const ready = `ready in ${about}`
        return { label, sentence: `${lead}: ${ready}`, short: `${short} · ${ready}`, bare: `${percent}% · ${ready}`, percent, timeLeft: ready }
    }
    const left = about ? `${about} left` : null
    return {
        label,
        sentence: `${lead}: ${percent}% ${words.verb}${left ? `, ${left}` : ''}`,
        short: `${short} · ${percent}%${left ? ` · ${left}` : ''}`,
        bare: `${percent}%${left ? ` · ${left}` : ''}`,
        percent,
        timeLeft: left,
    }
}
