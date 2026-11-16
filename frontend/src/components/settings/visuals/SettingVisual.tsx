/**
 * SettingVisual — the explainer a setting names (`setting.visual`), fed from the values in force,
 * the values with staged changes applied, and the platform's live facts. Explainers that move a
 * value (the memory marks) stage through `onStage`. Without the facts an explainer needs, it draws
 * nothing rather than a picture of made-up numbers.
 */
import type { Setting, SettingsFacts, SettingValue, Values } from '../types'
import { CopyRoomBar } from './CopyRoomBar'
import { GuardMeter } from './GuardMeter'
import { MemoryMarks } from './MemoryMarks'
import { ReadTimeline } from './ReadTimeline'
import { IdleTimeline, RetentionTimeline } from './RetentionTimeline'
import { WriteRhythm } from './WriteRhythm'

export function SettingVisual({ setting, settings, current, next = current, facts = {}, onStage, className }: {
    setting: Setting
    /** Every setting, by key: explainers read their neighbours (the stop mark beside the start mark). */
    settings: Record<string, Setting>
    current: Values
    next?: Values
    facts?: SettingsFacts
    onStage?: (key: string, value: SettingValue | null) => void
    className?: string
}) {
    const n = (vals: Values, key: string, fallback = 0) => {
        const v = vals[key] ?? settings[key]?.default.code
        return typeof v === 'number' ? v : fallback
    }
    switch (setting.visual) {
        case 'read_timeline':
            return <ReadTimeline className={className} setting={setting} value={current[setting.key] ?? setting.default.code} next={next[setting.key]} />
        case 'write_rhythm': {
            const rhythm = (v: Values) => ({
                statementTargetMs: n(v, 'updates.statementTargetMs', 500),
                pacingRatio: n(v, 'updates.pacingRatio', 0.25),
                readPressureRatio: n(v, 'updates.readPressureRatio', 2),
            })
            return <WriteRhythm className={className} {...rhythm(current)} next={rhythm(next)} />
        }
        case 'memory_marks': {
            if (!facts.nodes?.length) return null
            const startKey = 'residency.unloadStartPct'
            const stopKey = 'residency.unloadStopPct'
            const margin = settings[stopKey]?.rules.find((r) => r.other === startKey)?.margin ?? 0
            return (
                <MemoryMarks
                    className={className}
                    nodes={facts.nodes}
                    start={n(next, startKey, 80)}
                    stop={n(next, stopKey, 70)}
                    saved={{ start: n(current, startKey, 80), stop: n(current, stopKey, 70) }}
                    startRange={settings[startKey]?.range ?? undefined}
                    stopRange={settings[stopKey]?.range ?? undefined}
                    margin={margin}
                    onChange={onStage ? (start, stop) => {
                        if (start !== n(next, startKey)) onStage(startKey, start)
                        if (stop !== n(next, stopKey)) onStage(stopKey, stop)
                    } : undefined}
                />
            )
        }
        case 'copy_room': {
            if (!facts.nodes?.length || !facts.largestGraph) return null
            const max = next['builds.copyMaxBytes']
            return (
                <CopyRoomBar
                    className={className}
                    graph={facts.largestGraph}
                    copyRoomPct={n(current, 'builds.copyRoomPct', 220)}
                    nextCopyRoomPct={n(next, 'builds.copyRoomPct', 220)}
                    startPct={n(next, 'residency.unloadStartPct', 80)}
                    copyMaxBytes={typeof max === 'number' ? max : 'unlimited'}
                    nodes={facts.nodes}
                />
            )
        }
        case 'retention_timeline': {
            const days = (v: Values) => (v[setting.key] === 'forever' ? 'forever' : n(v, setting.key, 30))
            return <RetentionTimeline className={className} days={days(current)} nextDays={days(next)} />
        }
        case 'idle_timeline':
            return (
                <IdleTimeline
                    className={className}
                    standardIdleSecs={n(current, 'residency.standardIdleSecs', 604800)}
                    coldlineIdleSecs={n(current, 'residency.coldlineIdleSecs', 3600)}
                    autoUnload={(next['residency.autoUnload'] ?? true) !== false}
                    next={{ standardIdleSecs: n(next, 'residency.standardIdleSecs', 604800), coldlineIdleSecs: n(next, 'residency.coldlineIdleSecs', 3600) }}
                />
            )
        case 'guard_meter': {
            if (!facts.sampleImport) return null
            const limits = (v: Values) => ({
                enabled: (v['imports.replaceGuard'] ?? true) !== false,
                minLive: n(v, 'imports.guardMinLive', 1000),
                deleteShare: n(v, 'imports.guardDeleteShare', 0.5),
                createShare: n(v, 'imports.guardCreateShare', 0.5),
                minMatchShare: n(v, 'imports.minMatchShare', 0.05),
            })
            return <GuardMeter className={className} limits={limits(current)} next={limits(next)} sample={facts.sampleImport} />
        }
        default:
            return null
    }
}
