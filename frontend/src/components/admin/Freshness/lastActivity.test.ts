import { describe, expect, it } from 'vitest'
import { activityFromEvent, resolveLastActivity } from './lastActivity'
import type { FreshnessRow } from '@/services/freshnessService'

const row = (over: Partial<FreshnessRow>): Pick<
    FreshnessRow,
    'lastEvent' | 'lastCheckedAt'
> => ({
    lastEvent: null,
    lastCheckedAt: null,
    ...over,
})

describe('resolveLastActivity', () => {
    it('returns null when there is no event and no check stamp', () => {
        expect(resolveLastActivity(row({}))).toBeNull()
    })

    it('names a newer check as Reconcile check, not a health verdict', () => {
        const checked = new Date(Date.now() - 5 * 60_000).toISOString()
        const older = new Date(Date.now() - 2 * 3600_000).toISOString()
        const activity = resolveLastActivity(row({
            lastCheckedAt: checked,
            lastEvent: { origin: 'api', outcome: 'completed', ts: older },
        }))
        expect(activity).toMatchObject({
            kind: 'in_step',
            label: 'Reconcile check',
            originLabel: 'Reconcile',
            at: checked,
            source: 'check',
        })
    })

    it('names a check on a failed source as Reconcile check, not Rebuild failed', () => {
        const checked = new Date().toISOString()
        const older = new Date(Date.now() - 3 * 7 * 24 * 3600_000).toISOString()
        expect(resolveLastActivity(row({
            lastCheckedAt: checked,
            lastEvent: { origin: 'reconcile-sweep', outcome: 'failed', ts: older },
        }))).toMatchObject({
            label: 'Reconcile check',
            at: checked,
            source: 'check',
        })
    })

    it('keeps a newer API refresh when it beats lastCheckedAt', () => {
        const newer = new Date(Date.now() - 2 * 60_000).toISOString()
        const olderCheck = new Date(Date.now() - 60 * 60_000).toISOString()
        const activity = resolveLastActivity(row({
            lastCheckedAt: olderCheck,
            lastEvent: { origin: 'api', outcome: 'completed', ts: newer },
        }))
        expect(activity).toMatchObject({
            kind: 'refresh',
            label: 'Refresh done',
            originLabel: 'API',
            at: newer,
            source: 'event',
        })
    })

    it('names a reconcile-sweep rebuild as Rebuild queued', () => {
        const ts = new Date().toISOString()
        expect(resolveLastActivity(row({
            lastEvent: { origin: 'reconcile-sweep', outcome: 'accepted', ts },
        }))).toMatchObject({
            kind: 'queued',
            label: 'Rebuild queued',
            originLabel: 'Reconcile',
        })
    })

    it('maps api accepted to Refresh queued and reconcile noop to Reconcile check', () => {
        const ts = new Date().toISOString()
        expect(resolveLastActivity(row({
            lastEvent: { origin: 'api', outcome: 'accepted', ts },
        }))?.label).toBe('Refresh queued')
        expect(resolveLastActivity(row({
            lastEvent: { origin: 'reconcile-sweep', outcome: 'noop', ts },
        }))?.label).toBe('Reconcile check')
    })

    it('falls back to lastCheckedAt alone as Reconcile check', () => {
        const checked = new Date().toISOString()
        expect(resolveLastActivity(row({
            lastCheckedAt: checked,
        }))).toMatchObject({
            kind: 'in_step',
            label: 'Reconcile check',
            at: checked,
            source: 'check',
        })
    })
})

describe('activityFromEvent', () => {
    it('matches the table labels for API and reconcile outcomes', () => {
        const ts = new Date().toISOString()
        expect(activityFromEvent({ origin: 'api', outcome: 'completed', ts }).label)
            .toBe('Refresh done')
        expect(activityFromEvent({ origin: 'api', outcome: 'failed', ts }).label)
            .toBe('Refresh failed')
        expect(activityFromEvent({ origin: 'reconcile-sweep', outcome: 'completed', ts }).label)
            .toBe('Rebuild done')
        expect(activityFromEvent({
            origin: 'reconcile-sweep', outcome: 'accepted', reason: 'overlay_missing', ts,
        }).label).toBe('Rebuild queued')
    })
})
