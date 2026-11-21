/**
 * The sign-in fields of a connection or a knowledge source. Which fields
 * appear is the server's list for the chosen method, so they change with it.
 *
 * Secrets are write-only (`SecretField`): a configured one is stated, not
 * shown, and Rotate replaces it. Remove is the one way to send `secretsClear`,
 * and it can be undone until the draft is saved.
 */
import { useRef } from 'react'
import { Trash2, Undo2 } from 'lucide-react'
import { Skeleton } from '@/components/ui/primitives'
import {
    Field, FieldGrid, REDACTED, SecretField, SelectField, TextAreaField, TextField,
} from '@/components/admin/sso/settings/ui'
import type { AuthType, AuthTypeFields } from '@/services/aiAdminService'
import {
    AUTH_TYPES, PLACEHOLDERS, changeAuthType, configMeta, secretMeta,
    type AuthDraft, type FieldMeta,
} from './authFields'

export function AuthFields({
    draft, onChange, fields, errors, storedType,
}: {
    draft: AuthDraft
    onChange: (next: AuthDraft) => void
    /** `GET /admin/auth-types`; undefined while it loads. */
    fields: AuthTypeFields | undefined
    errors: Record<string, string>
    /** The method saved now, when editing — switching away from it drops its secrets. */
    storedType?: AuthType
}) {
    const spec = fields?.[draft.authType]
    const offered = AUTH_TYPES.filter(t => !fields || fields[t.value])
    const blurb = AUTH_TYPES.find(t => t.value === draft.authType)?.blurb
    const setConfig = (field: string, value: string | boolean) =>
        onChange({ ...draft, config: { ...draft.config, [field]: value } })
    const setSecret = (name: string, value: string) =>
        onChange({ ...draft, secrets: { ...draft.secrets, [name]: value } })

    const shown = (spec?.config ?? []).filter(f => {
        const meta = configMeta(draft.authType, f)
        return !meta.showIf || meta.showIf(draft.config)
    })
    const short = shown.filter(f => configMeta(draft.authType, f).kind !== 'json')
    const long = shown.filter(f => configMeta(draft.authType, f).kind === 'json')

    return (
        <div className="space-y-4">
            <Field label="Sign-in method" hint={blurb}>
                <SelectField
                    value={draft.authType}
                    onChange={e => onChange(changeAuthType(e.target.value as AuthType))}
                >
                    {offered.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </SelectField>
            </Field>

            {storedType && storedType !== draft.authType && (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">
                    Saving with a different sign-in method removes the secrets stored for the current one.
                </p>
            )}

            {!fields ? (
                <div className="space-y-2" aria-label="Loading the sign-in fields">
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-2/3" />
                </div>
            ) : (
                <>
                    {short.length > 0 && (
                        <FieldGrid>
                            {short.map(f => (
                                <ConfigField
                                    key={f}
                                    meta={configMeta(draft.authType, f)}
                                    value={draft.config[f]}
                                    error={errors[f]}
                                    onChange={v => setConfig(f, v)}
                                />
                            ))}
                        </FieldGrid>
                    )}
                    {long.map(f => (
                        <JsonField
                            key={f}
                            meta={configMeta(draft.authType, f)}
                            value={draft.config[f]}
                            error={errors[f]}
                            onChange={v => setConfig(f, v)}
                        />
                    ))}
                    {(spec?.secrets.length ?? 0) > 0 && (
                        <FieldGrid>
                            {spec!.secrets.map(name => {
                                const meta = secretMeta(draft.authType, name)
                                if (draft.secretsClear.includes(name)) {
                                    return (
                                        <Field key={name} label={meta.label} unlabelled>
                                            <div className="flex items-center gap-2 px-3 py-2 rounded-xl border-2 border-rose-400/40 bg-rose-500/[0.06]">
                                                <span className="flex-1 text-xs text-ink">Removed when you save</span>
                                                <button
                                                    type="button"
                                                    onClick={() => onChange({
                                                        ...draft,
                                                        secrets: { ...draft.secrets, [name]: REDACTED },
                                                        secretsClear: draft.secretsClear.filter(n => n !== name),
                                                    })}
                                                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-black/[0.10] dark:border-white/[0.12] text-[11px] text-ink-muted hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                                                >
                                                    <Undo2 className="w-3 h-3" aria-hidden /> Keep it
                                                </button>
                                            </div>
                                        </Field>
                                    )
                                }
                                return (
                                    <div key={name}>
                                        <SecretField
                                            label={meta.label}
                                            hint={meta.hint}
                                            placeholder={meta.placeholder}
                                            value={draft.secrets[name] ?? ''}
                                            onChange={v => setSecret(name, v)}
                                        />
                                        {draft.secrets[name] === REDACTED && (
                                            <button
                                                type="button"
                                                onClick={() => onChange({
                                                    ...draft,
                                                    secrets: { ...draft.secrets, [name]: '' },
                                                    secretsClear: [...draft.secretsClear, name],
                                                })}
                                                className="mt-1 inline-flex items-center gap-1 text-[11px] text-rose-600 dark:text-rose-400 hover:underline"
                                            >
                                                <Trash2 className="w-3 h-3" aria-hidden /> Remove {meta.label.toLowerCase()}
                                            </button>
                                        )}
                                    </div>
                                )
                            })}
                        </FieldGrid>
                    )}
                    {shown.length === 0 && !spec?.secrets.length && (
                        <p className="text-xs text-ink-muted">Nothing to fill in for this method.</p>
                    )}
                </>
            )}
        </div>
    )
}

function ConfigField({ meta, value, error, onChange }: {
    meta: FieldMeta
    value: string | boolean | undefined
    error?: string
    onChange: (v: string | boolean) => void
}) {
    if (meta.kind === 'toggle') {
        return (
            <label className="flex items-start gap-2.5 sm:col-span-2 cursor-pointer">
                <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={Boolean(value ?? meta.initial)}
                    onChange={e => onChange(e.target.checked)}
                />
                <span>
                    <span className="block text-xs font-semibold text-ink">{meta.label}</span>
                    {meta.hint && <span className="block text-[10px] text-ink-muted leading-relaxed">{meta.hint}</span>}
                </span>
            </label>
        )
    }
    const text = String(value ?? meta.initial ?? '')
    return (
        <Field label={meta.label} hint={error ? <span className="text-red-500">{error}</span> : meta.hint} required={meta.required}>
            {meta.kind === 'select' ? (
                <SelectField value={text} onChange={e => onChange(e.target.value)}>
                    {meta.options!.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </SelectField>
            ) : (
                <TextField
                    value={text}
                    inputMode={meta.kind === 'number' ? 'numeric' : undefined}
                    placeholder={meta.placeholder}
                    invalid={Boolean(error)}
                    onChange={e => onChange(e.target.value)}
                />
            )}
        </Field>
    )
}

/** A JSON object editor; with `template`, the placeholders insert at the caret. */
function JsonField({ meta, value, error, onChange }: {
    meta: FieldMeta
    value: string | boolean | undefined
    error?: string
    onChange: (v: string) => void
}) {
    const ref = useRef<HTMLTextAreaElement>(null)
    const text = String(value ?? meta.initial ?? '')
    const insert = (token: string) => {
        const el = ref.current
        const at = el?.selectionStart ?? text.length
        const end = el?.selectionEnd ?? at
        onChange(text.slice(0, at) + token + text.slice(end))
        requestAnimationFrame(() => {
            el?.focus()
            el?.setSelectionRange(at + token.length, at + token.length)
        })
    }
    return (
        <Field label={meta.label} hint={error ? <span className="text-red-500">{error}</span> : meta.hint} unlabelled={meta.template}>
            <TextAreaField
                // The field does not forward a ref; the caret is read from the
                // element it last focused.
                onFocus={e => { ref.current = e.currentTarget }}
                aria-label={meta.label}
                rows={5}
                spellCheck={false}
                value={text}
                placeholder={meta.placeholder}
                invalid={Boolean(error)}
                onChange={e => onChange(e.target.value)}
            />
            {meta.template && (
                <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-ink-muted">Insert</span>
                    {PLACEHOLDERS.map(p => (
                        <button
                            key={p}
                            type="button"
                            onClick={() => insert(p)}
                            className="px-1.5 py-0.5 rounded-md border border-glass-border font-mono text-[10px] text-ink-secondary hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                        >
                            {p}
                        </button>
                    ))}
                </span>
            )}
        </Field>
    )
}
