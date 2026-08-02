/**
 * Who may publish a view to everyone, from this workspace, over this
 * source.
 *
 * The wizard used to answer that with the publish PERMISSION alone,
 * which was right only while publishing was admin-only. Now workspaces
 * are open by default: an ordinary member publishes directly, and the
 * permission is what a *restricted* source or a *request* workspace
 * falls back to. Getting this wrong is not cosmetic — it decides
 * whether clicking "Everyone" publishes the view or quietly files a
 * request for someone else to answer.
 */
import { describe, expect, it } from 'vitest'

import { resolvePublishGate } from '../publishGate'

describe('an open workspace', () => {
    it('lets a member publish directly', () => {
        const gate = resolvePublishGate({
            hasPublishPermission: false,
            publishPolicy: 'open',
            sourceRestricted: false,
        })
        expect(gate.canPublish).toBe(true)
        expect(gate.canRequestPublish).toBe(false)
    })

    it('still routes through a request when the source is restricted', () => {
        const gate = resolvePublishGate({
            hasPublishPermission: false,
            publishPolicy: 'open',
            sourceRestricted: true,
        })
        expect(gate.canPublish).toBe(false)
        expect(gate.canRequestPublish).toBe(true)
        expect(gate.restrictedSource).toBe(true)
    })
})

describe('a request workspace', () => {
    it('routes a member through a request', () => {
        const gate = resolvePublishGate({
            hasPublishPermission: false,
            publishPolicy: 'request',
            sourceRestricted: false,
        })
        expect(gate.canPublish).toBe(false)
        expect(gate.canRequestPublish).toBe(true)
    })
})

describe('the publish permission', () => {
    it('publishes directly whatever the policy says', () => {
        for (const publishPolicy of ['open', 'request'] as const) {
            for (const sourceRestricted of [false, true]) {
                const gate = resolvePublishGate({
                    hasPublishPermission: true, publishPolicy, sourceRestricted,
                })
                expect(gate.canPublish).toBe(true)
                expect(gate.canRequestPublish).toBe(false)
            }
        }
    })
})

describe('an unknown policy', () => {
    it('falls back to the platform default rather than locking people out', () => {
        // The workspace list is loaded lazily and a wizard can mount
        // before it lands; treating "not loaded yet" as "locked down"
        // would show a request badge that a refresh then contradicts.
        const gate = resolvePublishGate({
            hasPublishPermission: false,
            publishPolicy: undefined,
            sourceRestricted: false,
        })
        expect(gate.canPublish).toBe(true)
    })
})
