/**
 * The single source of visibility truth. Eight surfaces used to carry
 * their own icon/label/description maps with three conflicting
 * description strings; they all import from lib/viewVisibility now.
 */
import { describe, expect, it } from 'vitest'
import { Globe, Lock, Users } from 'lucide-react'

import {
    VISIBILITY_ACCENT,
    VISIBILITY_ICON,
    VISIBILITY_ORDER,
    buildVisibilityOptions,
    visibilityDescription,
    visibilityLabel,
    type ViewVisibility,
} from '../viewVisibility'

describe('visibility metadata', () => {
    it('orders the tiers narrow → broad', () => {
        expect(VISIBILITY_ORDER).toEqual(['private', 'workspace', 'enterprise'])
    })

    it('maps each tier to its canonical icon', () => {
        expect(VISIBILITY_ICON.private).toBe(Lock)
        expect(VISIBILITY_ICON.workspace).toBe(Users)
        expect(VISIBILITY_ICON.enterprise).toBe(Globe)
    })

    it('labels are the product words', () => {
        expect(visibilityLabel('private')).toBe('Private')
        expect(visibilityLabel('workspace')).toBe('Workspace')
        expect(visibilityLabel('enterprise')).toBe('Enterprise')
    })

    it('descriptions are plain-language and brand-aware', () => {
        expect(visibilityDescription('private')).toMatchInlineSnapshot(
            `"Only you, people it's shared with, and workspace admins"`,
        )
        expect(
            visibilityDescription('workspace', { workspaceName: 'Finance' }),
        ).toMatchInlineSnapshot(`"Everyone in Finance"`)
        expect(
            visibilityDescription('enterprise', { appName: 'Nexus Lineage' }),
        ).toMatchInlineSnapshot(
            `"Anyone signed in to Nexus Lineage — read-only outside the view's workspace"`,
        )
        // Without a brand name the copy still reads as a sentence.
        expect(visibilityDescription('enterprise')).toContain('the platform')
    })
})

describe('buildVisibilityOptions publish gating', () => {
    const base = { appName: 'App', workspaceName: 'WS' }

    it('publisher sees all three tiers enabled', () => {
        const options = buildVisibilityOptions({
            saved: 'private', canPublish: true, ...base,
        })
        expect(options.map(o => o.disabled)).toEqual([false, false, false])
    })

    it('non-publisher cannot select enterprise', () => {
        const options = buildVisibilityOptions({
            saved: 'workspace', canPublish: false, ...base,
        })
        const enterprise = options.find(o => o.id === 'enterprise')!
        expect(enterprise.disabled).toBe(true)
        expect(enterprise.disabledReason).toMatch(/publish/i)
        expect(options.find(o => o.id === 'private')!.disabled).toBe(false)
    })

    it('non-publisher cannot UNpublish an enterprise view either', () => {
        const options = buildVisibilityOptions({
            saved: 'enterprise', canPublish: false, ...base,
        })
        expect(options.find(o => o.id === 'enterprise')!.disabled).toBe(false)
        for (const id of ['private', 'workspace'] as ViewVisibility[]) {
            const o = options.find(x => x.id === id)!
            expect(o.disabled).toBe(true)
            expect(o.disabledReason).toMatch(/unpublish/i)
        }
    })

    it('canRequestPublish turns the enterprise tile into a route, not a wall', () => {
        const options = buildVisibilityOptions({
            saved: 'workspace', canPublish: false, canRequestPublish: true, ...base,
        })
        const enterprise = options.find(o => o.id === 'enterprise')!
        expect(enterprise.disabled).toBe(false)
        expect(enterprise.disabledReason).toBeUndefined()
        expect(enterprise.requiresApproval).toBe(true)
        expect(enterprise.approvalHint).toMatch(/needs approval/i)
        // The lower tiers are unaffected — they were never publish-gated.
        for (const id of ['private', 'workspace'] as ViewVisibility[]) {
            expect(options.find(o => o.id === id)!.requiresApproval).toBe(false)
        }
    })

    it('a publisher never needs approval', () => {
        const options = buildVisibilityOptions({
            saved: 'workspace', canPublish: true, canRequestPublish: true, ...base,
        })
        expect(options.map(o => o.requiresApproval)).toEqual([false, false, false])
    })

    it('requesting is not a way to UNpublish — the lower tiers stay locked', () => {
        const options = buildVisibilityOptions({
            saved: 'enterprise', canPublish: false, canRequestPublish: true, ...base,
        })
        expect(options.find(o => o.id === 'enterprise')!.requiresApproval).toBe(false)
        for (const id of ['private', 'workspace'] as ViewVisibility[]) {
            const o = options.find(x => x.id === id)!
            expect(o.disabled).toBe(true)
            expect(o.requiresApproval).toBe(false)
        }
    })
})

describe('accent classes', () => {
    it('every class string is a literal Tailwind can see (regression: the share dialog interpolated `border-\${accent}-500`, which the JIT never emits)', () => {
        for (const tier of VISIBILITY_ORDER) {
            for (const cls of Object.values(VISIBILITY_ACCENT[tier])) {
                expect(cls).not.toContain('${')
                expect(cls).toMatch(/^[a-z0-9:/ \-.[\]%]+$/i)
            }
        }
    })
})

describe('an unsaved view (the create wizard)', () => {
    const base = { appName: 'App', workspaceName: 'WS' }

    it('never locks the lower tiers — there is nothing published to un-publish', () => {
        // Regression: the wizard passed its DRAFT selection as `saved`, so
        // choosing Enterprise instantly disabled Private and Workspace and
        // the user could not change their mind.
        const options = buildVisibilityOptions({
            saved: undefined, canPublish: false, canRequestPublish: true, ...base,
        })
        expect(options.find(o => o.id === 'private')!.disabled).toBe(false)
        expect(options.find(o => o.id === 'workspace')!.disabled).toBe(false)
    })

    it('keeps offering the approval route for enterprise', () => {
        const options = buildVisibilityOptions({
            saved: undefined, canPublish: false, canRequestPublish: true, ...base,
        })
        const enterprise = options.find(o => o.id === 'enterprise')!
        expect(enterprise.disabled).toBe(false)
        expect(enterprise.requiresApproval).toBe(true)
    })
})

describe('a restricted source', () => {
    it('says the source is why approval is needed, not the workspace', () => {
        // In an open workspace the member CAN publish other views, so a
        // bare "ask a workspace admin" reads as a bug. The hint has to
        // name the source, or the only way to understand the block is to
        // go ask someone.
        const enterprise = buildVisibilityOptions({
            canPublish: false,
            canRequestPublish: true,
            restrictedSource: true,
        }).find(o => o.id === 'enterprise')!
        expect(enterprise.requiresApproval).toBe(true)
        expect(enterprise.approvalHint).toMatch(/source/i)
    })
})
