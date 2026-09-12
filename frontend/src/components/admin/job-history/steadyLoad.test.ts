/**
 * The "Steady load" line: the three states a running rebuild's write side
 * can be in, in words an operator can act on.
 */
import { describe, expect, it } from 'vitest'
import { steadyLoadFromSnapshot, steadyLoadLine } from './steadyLoad'

describe('steadyLoadFromSnapshot', () => {
    it('is null until the run has written or held', () => {
        expect(steadyLoadFromSnapshot({})).toBeNull()
        expect(steadyLoadFromSnapshot({ processed_edges: 5 })).toBeNull()
        expect(steadyLoadFromSnapshot({ pace_batches: 1, pace_batch_rows: 50 })).toMatchObject({ batches: 1, batchRows: 50 })
        expect(steadyLoadFromSnapshot({ pace_holding: 'fork', pace_fork: 'bgsave' })).toMatchObject({ holding: 'fork', fork: 'bgsave' })
        // An empty string is "not holding", not a reason.
        expect(steadyLoadFromSnapshot({ pace_batches: 2, pace_holding: '', pace_eased: '' })).toMatchObject({ holding: undefined, eased: undefined })
    })
})

describe('steadyLoadLine', () => {
    it('describes a steady run from the last batch and the rolling figures', () => {
        const line = steadyLoadLine({
            batchRows: 250, batchS: 0.62, ackS: 0.01, sleepS: 0.63, dutyPct: 49, rowsPerS: 198.4,
            replicaLagBytes: 12 * 2 ** 20, headroomBytes: 24 * 2 ** 30,
        })
        expect(line.tone).toBe('steady')
        expect(line.title).toBe('Steady load')
        expect(line.detail).toBe('250-row batches · 620 ms each · 630 ms pause · 49% write duty · 198 rows/s · replicas 12 MB behind · 24.0 GB headroom')
    })

    it('names the replica wait only when it is worth naming, and never a negative headroom', () => {
        const line = steadyLoadLine({ batchRows: 100, batchS: 1.4, ackS: 2.2, sleepS: 3.6, headroomBytes: -5 })
        expect(line.detail).toBe('100-row batches · 1.4 s each · 2.2 s for the replicas · 3.6 s pause · 0 KB headroom')
    })

    it('says why the run is holding, and that it ends on its own', () => {
        expect(steadyLoadLine({ holding: 'fork', fork: 'bgsave' }).title).toBe('Holding — a background save is running on the graph store node')
        expect(steadyLoadLine({ holding: 'replica_lost' }).title).toBe('Holding — a replica the run started with is gone')
        expect(steadyLoadLine({ holding: 'eclipse' }).title).toBe('Holding — eclipse')
        const line = steadyLoadLine({ holding: 'memory' })
        expect(line.tone).toBe('holding')
        expect(line.detail).toContain('carries on by itself when the node is back')
    })

    it('says what easing off means for the next batches', () => {
        const line = steadyLoadLine({ eased: 'replica_lag', batchMax: 250, batchRows: 250, batchS: 0.5, sleepS: 1.0 })
        expect(line.tone).toBe('eased')
        expect(line.title).toBe('Easing off — replicas half way to the drop limit')
        expect(line.detail).toBe('batches of at most 250 rows and twice the pause until the reading is back · 250-row batches · 500 ms each · 1.0 s pause')
    })
})

describe('a node shared with another rebuild', () => {
    it('says so, because it is why the run is not at the pacing floor', () => {
        const line = steadyLoadLine({
            batchRows: 500, batchS: 0.4, sleepS: 0.4, batches: 20,
            dutyPct: 50, rowsPerS: 620, sharing: 1,
        })
        expect(line.tone).toBe('steady')
        expect(line.detail).toContain('sharing the node with another rebuild')
    })

    it('counts them when there is more than one', () => {
        const line = steadyLoadLine({ batches: 3, sharing: 2 })
        expect(line.detail).toContain('sharing the node with 2 other rebuilds')
    })

    it('says nothing when the run has the node to itself', () => {
        const line = steadyLoadLine({ batches: 3, sharing: 0 })
        expect(line.detail).not.toContain('sharing')
    })
})
