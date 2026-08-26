/**
 * The rehearsal's group story, rendered.
 *
 * A rehearsal that says only WHO would sign in answers half the
 * question an operator is there to ask — the other half is what the
 * sign-in would grant, which is exactly the part being debugged when
 * "groups don't work". These lines are that half.
 */
import { describe, expect, it } from 'vitest'
import { summarizeRehearsalOutcome } from '../ssoAdminService'

describe('summarizeRehearsalOutcome', () => {
    it('names the groups and the mappings they would fire', () => {
        const lines = summarizeRehearsalOutcome({
            action: 'provision_new',
            groups: ['eng', 'analysts'],
            reconcile: {
                matched: [
                    {
                        idp_group: 'eng', target_type: 'role_binding',
                        role_name: 'workspace_member',
                        scope_type: 'workspace', scope_id: 'ws_1',
                    },
                    {
                        idp_group: 'analysts',
                        target_type: 'group_membership', group_id: 'grp_9',
                    },
                ],
                unmatched_groups: [],
            },
        })
        expect(lines[0]).toBe('Groups asserted: eng, analysts.')
        expect(lines[1]).toContain(
            'eng → workspace_member in workspace ws_1',
        )
        expect(lines[1]).toContain('analysts → group membership')
    })

    it('says plainly when groups match nothing', () => {
        const lines = summarizeRehearsalOutcome({
            groups: ['mystery'],
            reconcile: { matched: [], unmatched_groups: ['mystery'] },
        })
        expect(lines).toContain(
            'No group mapping matched — nothing would be granted.',
        )
    })

    it('lists the leftover groups beside the matches', () => {
        const lines = summarizeRehearsalOutcome({
            groups: ['eng', 'mystery'],
            reconcile: {
                matched: [{
                    idp_group: 'eng', target_type: 'group_membership',
                    group_id: 'g1',
                }],
                unmatched_groups: ['mystery'],
            },
        })
        expect(lines.join(' ')).toContain('Groups matching no mapping: mystery.')
    })

    it('says when the claims carried no groups at all', () => {
        expect(summarizeRehearsalOutcome({ groups: [] })[0])
            .toBe('The claims carried no groups.')
    })

    it('surfaces the refusal reasons on a rejected rehearsal', () => {
        const lines = summarizeRehearsalOutcome({
            action: 'rejected',
            deny_reasons: ['strict_existing_sso'],
            groups: [],
        })
        expect(lines.join(' ')).toContain('Refused because: strict_existing_sso.')
    })
})

describe('the verification line', () => {
    it('names the material a signed token verified against', () => {
        expect(summarizeRehearsalOutcome({
            groups: [],
            verification: { shape: 'jwt', verified: true, material: 'public_key' },
        })[0]).toBe(
            'The reply was a signed token, verified against your pasted public key.',
        )
        expect(summarizeRehearsalOutcome({
            groups: [],
            verification: { shape: 'jwt', verified: true, material: 'shared_secret' },
        })[0]).toContain('the shared secret')
        expect(summarizeRehearsalOutcome({
            groups: [],
            verification: { shape: 'jwt', verified: true, material: 'jwks' },
        })[0]).toContain('published keys (JWKS)')
    })

    it('says which unverified case arrived, and the rating it costs', () => {
        const json = summarizeRehearsalOutcome({
            groups: [],
            verification: { shape: 'json', verified: false, material: 'none' },
        })[0]
        expect(json).toContain('unsigned JSON')
        expect(json).toContain('rated Unverified')

        const jwt = summarizeRehearsalOutcome({
            groups: [],
            verification: { shape: 'jwt', verified: false, material: 'none' },
        })[0]
        expect(jwt).toContain('WITHOUT verification')
        expect(jwt).toContain('rated Unverified')
    })

    it('stays silent when the outcome carries no verdict', () => {
        // Handle and server rehearsals judged nothing browser-borne.
        expect(summarizeRehearsalOutcome({ groups: [] })[0])
            .toBe('The claims carried no groups.')
    })
})

describe('the authentication-time line', () => {
    it('names the consequence when the claims carried none', () => {
        const line = summarizeRehearsalOutcome({
            groups: [],
            auth_time: { present: false, ceiling_hours: 24 },
        })[0]
        expect(line).toContain('no authentication time')
        expect(line).toContain('24-hour')
        expect(line).toContain('measure from each sign-in')
    })

    it('says nothing when it was present, or when the server is older', () => {
        expect(summarizeRehearsalOutcome({
            groups: [], auth_time: { present: true, ceiling_hours: 24 },
        })[0]).toBe('The claims carried no groups.')
        expect(summarizeRehearsalOutcome({ groups: [] })[0])
            .toBe('The claims carried no groups.')
    })
})
