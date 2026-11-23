import { describe, expect, it } from 'vitest'
import { describeWorkspaceHealth } from '../workspaceHealthStory'

const src = (label: string, aggregationStatus = 'ready', projectorCurrent: boolean | null = null) =>
    ({ label, aggregationStatus, projectorCurrent })

describe('describeWorkspaceHealth', () => {
    it('names the source that failed, and sends a manager to Processing', () => {
        const s = describeWorkspaceHealth('critical', [src('Sales', 'failed'), src('HR')], { canManage: true })
        expect(s.detail).toMatch(/“Sales” couldn’t finish refreshing/)
        expect(s.action).toEqual({ label: 'Review', section: 'processing' })
    })

    it('counts sources when more than one is at fault', () => {
        const s = describeWorkspaceHealth('critical', [src('A', 'failed'), src('B', 'failed')], { canManage: true })
        expect(s.detail).toMatch(/^2 sources couldn’t/)
    })

    it('says a stalled source is behind its changes', () => {
        const s = describeWorkspaceHealth('critical', [src('Ledger', 'ready', false)], { canManage: true })
        expect(s.detail).toBe('“Ledger” is behind its latest published changes.')
    })

    it('reassures while refreshing', () => {
        const s = describeWorkspaceHealth('warning', [src('A', 'running'), src('B')], { canManage: true })
        expect(s.detail).toBe('“A” is refreshing. Views keep working meanwhile.')
        expect(s.action?.section).toBe('processing')
    })

    it('offers no action to someone who cannot change the data', () => {
        const s = describeWorkspaceHealth('empty', [], { canManage: false })
        expect(s.detail).toMatch(/No data is connected yet/)
        expect(s.action).toBeUndefined()
    })

    it('asks nothing of a healthy workspace', () => {
        const s = describeWorkspaceHealth('healthy', [src('A'), src('B')], { canManage: true })
        expect(s).toEqual({ detail: 'All 2 data sources are up to date.' })
    })
})
