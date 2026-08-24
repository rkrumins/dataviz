/**
 * The right settings form for the kind, plus a way out of it.
 *
 * Typed fields cover what the providers actually read. They cannot cover
 * everything — a key we do not model would be silently dropped by a form
 * that only knows six fields, so the Advanced editor stays, over the *same*
 * object rather than as a rival copy of it. Edit either; they are one
 * value.
 *
 * `custom` keeps JSON as its only editor: it is the dev kind with no fixed
 * schema, so there is nothing to type.
 */
import { useMemo, useState } from 'react'
import { AlertCircle, Code2 } from 'lucide-react'
import type { IdpKind } from '@/services/ssoAdminService'
import { OidcSettingsForm } from './OidcSettingsForm'
import { SamlSettingsForm } from './SamlSettingsForm'
import { BackchannelSettingsForm } from './BackchannelSettingsForm'
import { CustomProfileSettingsForm } from './CustomProfileSettingsForm'
import { TextAreaField } from './ui'

export function SettingsEditor({
    kind, value, onChange, redirectUriHint,
}: {
    kind: IdpKind
    value: Record<string, unknown>
    onChange: (next: Record<string, unknown>) => void
    redirectUriHint?: string
}) {
    const jsonOnly = kind === 'custom'

    return (
        <div className="space-y-4">
            {kind === 'oidc' && (
                <OidcSettingsForm
                    value={value}
                    onChange={onChange}
                    redirectUriHint={redirectUriHint}
                />
            )}
            {kind === 'saml2' && (
                <SamlSettingsForm value={value} onChange={onChange} />
            )}
            {kind === 'custom_profile' && (
                <CustomProfileSettingsForm value={value} onChange={onChange} />
            )}
            {kind === 'backchannel' && (
                <BackchannelSettingsForm value={value} onChange={onChange} />
            )}

            <AdvancedJson
                value={value}
                onChange={onChange}
                alwaysOpen={jsonOnly}
                label={jsonOnly ? 'Settings (encrypted JSON)' : undefined}
            />
        </div>
    )
}

function AdvancedJson({
    value, onChange, alwaysOpen, label,
}: {
    value: Record<string, unknown>
    onChange: (next: Record<string, unknown>) => void
    alwaysOpen?: boolean
    label?: string
}) {
    const [open, setOpen] = useState(Boolean(alwaysOpen))
    // Only while the operator is typing here. Outside of that the textarea
    // reflects `value`, so a change made in the typed fields shows up
    // rather than being overwritten by a stale draft.
    const [draft, setDraft] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    const text = useMemo(
        () => draft ?? JSON.stringify(value, null, 2),
        [draft, value],
    )

    function edit(next: string) {
        setDraft(next)
        try {
            const parsed = JSON.parse(next)
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                setError('Settings must be a JSON object.')
                return
            }
            setError(null)
            onChange(parsed as Record<string, unknown>)
        } catch (err) {
            // Report, but do not discard: an object mid-edit is unparseable
            // for most of the keystrokes it takes to fix it.
            setError((err as Error).message)
        }
    }

    return (
        <div className={alwaysOpen ? '' : 'pt-3 border-t border-black/[0.08] dark:border-white/[0.10]'}>
            {alwaysOpen ? (
                <span className="block text-xs font-semibold text-ink mb-1.5">
                    {label}
                </span>
            ) : (
                <button
                    type="button"
                    onClick={() => { setOpen(o => !o); setDraft(null); setError(null) }}
                    aria-expanded={open}
                    className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted hover:text-ink"
                >
                    <Code2 className="w-3 h-3" />
                    {open ? 'Hide advanced (JSON)' : 'Advanced (JSON)'}
                </button>
            )}

            {open && (
                <>
                    {!alwaysOpen && (
                        <p className="mt-2 text-[10px] text-ink-muted">
                            The same settings, for keys the fields above do not
                            cover. Edits here and above are the same value.
                        </p>
                    )}
                    <TextAreaField
                        rows={alwaysOpen ? 10 : 8}
                        value={text}
                        onChange={e => edit(e.target.value)}
                        onBlur={() => { if (!error) setDraft(null) }}
                        invalid={Boolean(error)}
                        className="mt-2"
                    />
                    {error && (
                        <p className="mt-1 flex items-start gap-1 text-[11px] text-red-500">
                            <AlertCircle className="w-3 h-3 mt-px shrink-0" />
                            {error}
                        </p>
                    )}
                </>
            )}
        </div>
    )
}
