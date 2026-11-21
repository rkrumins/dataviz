/**
 * Sign-in fields: which appear is the server's list for the chosen method,
 * so they change with it; secrets are write-only — the marker and empty
 * boxes are never sent, and Remove is what sends `secretsClear`.
 */
import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { REDACTED } from '@/components/admin/sso/settings/ui'
import type { AuthTypeFields } from '@/services/aiAdminService'
import { AuthFields } from '../auth/AuthFields'
import { authDraftFrom, authInput, emptyAuth, type AuthDraft } from '../auth/authFields'

const FIELDS: AuthTypeFields = {
    none: { config: [], secrets: [] },
    api_key: { config: ['header', 'prefix', 'in', 'param'], secrets: ['apiKey'] },
    bearer: { config: [], secrets: ['token'] },
    basic: { config: ['username'], secrets: ['password'] },
    oauth2_client_credentials: { config: ['tokenUrl', 'clientId', 'scope', 'audience', 'clientAuth'], secrets: ['clientSecret'] },
    token_mint: {
        config: ['tokenUrl', 'method', 'bodyFormat', 'body', 'headers', 'basicAuth', 'username', 'clientId',
            'tokenPath', 'expiresPath', 'tokenHeader', 'tokenPrefix', 'defaultTtlSeconds'],
        secrets: ['password', 'clientSecret'],
    },
}

/** The draft as last changed by the fields. */
let latest: AuthDraft
function Harness({ initial, fields = FIELDS }: { initial: AuthDraft; fields?: AuthTypeFields }) {
    const [draft, setDraft] = useState(initial)
    return <AuthFields draft={draft} onChange={d => { latest = d; setDraft(d) }} fields={fields} errors={{}} />
}
const mount = (initial: AuthDraft, fields?: AuthTypeFields) => {
    latest = initial
    return render(<Harness initial={initial} fields={fields} />)
}

const method = () => screen.getByRole('combobox', { name: /sign-in method/i })

describe('fields follow the sign-in method', () => {
    it('shows an API key’s header, prefix and key, and the query parameter only when the key goes in the query', async () => {
        mount(emptyAuth('api_key'))
        expect(screen.getByLabelText(/^Header name/)).toHaveValue('Authorization')
        expect(screen.getByLabelText(/^Prefix/)).toHaveValue('Bearer')
        expect(screen.getByLabelText(/^API key/)).toBeInTheDocument()
        expect(screen.queryByLabelText(/^Query parameter/)).not.toBeInTheDocument()

        await userEvent.selectOptions(screen.getByLabelText(/^Send the key in/), 'query')
        expect(screen.getByLabelText(/^Query parameter/)).toBeInTheDocument()
        expect(screen.queryByLabelText(/^Header name/)).not.toBeInTheDocument()
        expect(screen.queryByLabelText(/^Prefix/)).not.toBeInTheDocument()
    })

    it('swaps every field when the method changes, and starts the new one afresh', async () => {
        mount(emptyAuth('api_key'))
        await userEvent.selectOptions(method(), 'basic')
        expect(screen.getByLabelText(/^Username/)).toBeInTheDocument()
        expect(screen.getByLabelText(/^Password/)).toBeInTheDocument()
        expect(screen.queryByLabelText(/^Header name/)).not.toBeInTheDocument()
        expect(latest.config).toEqual({})

        await userEvent.selectOptions(method(), 'oauth2_client_credentials')
        for (const label of [/^Token URL/, /^Client ID/, /^Scope/, /^Audience/, /^Send the client credentials/, /^Client secret/]) {
            expect(screen.getByLabelText(label)).toBeInTheDocument()
        }

        await userEvent.selectOptions(method(), 'none')
        expect(screen.getByText('Nothing to fill in for this method.')).toBeInTheDocument()
    })

    it('gives a token mint its request template, with placeholders that insert into it', async () => {
        mount(emptyAuth('token_mint'))
        const body = screen.getByRole('textbox', { name: 'Request body' })
        expect((body as HTMLTextAreaElement).value).toContain('{{username}}')
        for (const label of [/^Token in the answer/, /^Lifetime in the answer/, /^Send the token in/, /^Token prefix/,
            /^Default lifetime \(seconds\)/, /^Also send a Basic header/, /^Password/, /^Client secret/]) {
            expect(screen.getByLabelText(label)).toBeInTheDocument()
        }

        fireEvent.change(body, { target: { value: '{}' } })
        fireEvent.focus(body)
        ;(body as HTMLTextAreaElement).setSelectionRange(1, 1)
        await userEvent.click(within(body.parentElement!).getByRole('button', { name: '{{clientSecret}}' }))
        expect(latest.config.body).toBe('{{{clientSecret}}}')

        await userEvent.selectOptions(screen.getByLabelText(/^Body format/), 'none')
        expect(screen.queryByRole('textbox', { name: 'Request body' })).not.toBeInTheDocument()
    })

    it('renders a field the server adds, named by its key, and offers only the methods the server knows', () => {
        const withoutBearer = Object.fromEntries(Object.entries(FIELDS).filter(([k]) => k !== 'bearer'))
        mount(emptyAuth('basic'), { ...withoutBearer, basic: { config: ['username', 'realm'], secrets: ['password'] } })
        expect(screen.getByLabelText('realm')).toBeInTheDocument()
        expect(within(method()).queryByRole('option', { name: 'Bearer token' })).not.toBeInTheDocument()
        expect(within(method()).getByRole('option', { name: 'API key' })).toBeInTheDocument()
    })
})

describe('secrets are write-only', () => {
    const stored = () => authDraftFrom('api_key', { header: 'api-key', prefix: '' }, { apiKey: { configured: true } })

    it('states a configured secret instead of showing it, and sends nothing for it when left alone', () => {
        mount(stored())
        expect(screen.getByText('Configured — leave as-is to keep it')).toBeInTheDocument()
        expect(latest.secrets.apiKey).toBe(REDACTED)
        const body = authInput(latest, FIELDS)
        expect(body.secrets).toBeUndefined()
        expect(body.secretsClear).toBeUndefined()
        // An empty prefix means "none" and is kept; the header is as stored.
        expect(body.authConfig).toEqual({ header: 'api-key', prefix: '' })
    })

    it('sends a rotated value, never the marker', async () => {
        mount(stored())
        await userEvent.click(screen.getByRole('button', { name: /rotate/i }))
        await userEvent.type(screen.getByLabelText(/^API key/), 'sk-new')
        expect(authInput(latest, FIELDS)).toMatchObject({ secrets: { apiKey: 'sk-new' } })
        expect(JSON.stringify(authInput(latest, FIELDS))).not.toContain(REDACTED)
    })

    it('sends secretsClear on Remove, and can take it back', async () => {
        mount(stored())
        await userEvent.click(screen.getByRole('button', { name: 'Remove api key' }))
        expect(screen.getByText('Removed when you save')).toBeInTheDocument()
        expect(authInput(latest, FIELDS)).toMatchObject({ secretsClear: ['apiKey'] })
        expect(authInput(latest, FIELDS).secrets).toBeUndefined()

        await userEvent.click(screen.getByRole('button', { name: /keep it/i }))
        expect(screen.getByText('Configured — leave as-is to keep it')).toBeInTheDocument()
        expect(authInput(latest, FIELDS).secretsClear).toBeUndefined()
    })

    it('never names a secret in both secrets and secretsClear — a new value wins', () => {
        const draft: AuthDraft = { ...stored(), secrets: { apiKey: 'sk-new' }, secretsClear: ['apiKey'] }
        const body = authInput(draft, FIELDS)
        expect(body.secrets).toEqual({ apiKey: 'sk-new' })
        expect(body.secretsClear).toBeUndefined()
    })

    it('drops empty boxes and the fields of a hidden option, and parses JSON and numbers', () => {
        const draft: AuthDraft = {
            authType: 'token_mint',
            config: { ...emptyAuth('token_mint').config, tokenUrl: 'https://login.example.com/token', username: '',
                headers: '{ "X-App": "{{clientId}}" }', defaultTtlSeconds: '600', bodyFormat: 'form' },
            secrets: { password: 'pw', clientSecret: '' },
            secretsClear: [],
        }
        const body = authInput(draft, FIELDS)
        expect(body.authConfig).toMatchObject({
            tokenUrl: 'https://login.example.com/token', bodyFormat: 'form',
            body: { username: '{{username}}', password: '{{password}}' },
            headers: { 'X-App': '{{clientId}}' }, defaultTtlSeconds: 600, basicAuth: false,
        })
        expect(body.authConfig).not.toHaveProperty('username')
        expect(body.secrets).toEqual({ password: 'pw' })
    })
})
