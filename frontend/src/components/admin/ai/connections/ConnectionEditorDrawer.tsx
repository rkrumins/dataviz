/**
 * Adding or editing a model connection: where questions are sent, how the
 * platform signs in there, which models answer, and the few options that
 * make one OpenAI-compatible endpoint differ from another.
 */
import { BrainCircuit, Wand2 } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/primitives'
import { Disclosure } from '@/components/ui/Disclosure'
import { useAppNotifications } from '@/components/ui/notifications'
import { Field, FieldGrid, TextField } from '@/components/admin/sso/settings/ui'
import { aiAdminService, AI_ADMIN_KEYS, type Connection } from '@/services/aiAdminService'
import { AuthFields } from '../auth/AuthFields'
import { EditorDrawer, DrawerSection } from '../ui/EditorDrawer'
import { KeyValueEditor } from '../ui/KeyValueEditor'
import {
    PRESETS, applyPreset, useConnectionEditor, withAzurePaths, type ConnectionDraft,
} from './useConnectionEditor'

const OPTION_TOGGLES: { key: 'stream' | 'streamUsage' | 'tools' | 'jsonMode'; label: string; hint: string }[] = [
    { key: 'stream', label: 'Stream answers',
      hint: 'Off for a gateway that cannot stream; the answer then arrives whole.' },
    { key: 'streamUsage', label: 'Ask for token usage while streaming',
      hint: 'Off for an endpoint that refuses stream_options.include_usage.' },
    { key: 'tools', label: 'Tool calling',
      hint: 'Off for an endpoint without function calling. The assistant then uses a strict JSON protocol instead.' },
    { key: 'jsonMode', label: 'JSON mode',
      hint: 'Whether response_format: json_object may be sent.' },
]

export function ConnectionEditorDrawer({
    connection, onClose, onSaved,
}: {
    /** Null to add one. */
    connection: Connection | null
    onClose: () => void
    onSaved: (saved: Connection) => void
}) {
    const fieldsQ = useQuery({ queryKey: AI_ADMIN_KEYS.authTypes, queryFn: aiAdminService.authTypes, staleTime: Infinity })
    const ed = useConnectionEditor(connection, fieldsQ.data)
    const { notify } = useAppNotifications()
    const d = ed.draft
    const setModel = (k: keyof ConnectionDraft['models'], v: string) => ed.set('models', { ...d.models, [k]: v })
    const setOption = <K extends keyof ConnectionDraft['options']>(k: K, v: ConnectionDraft['options'][K]) =>
        ed.set('options', { ...d.options, [k]: v })

    async function submit() {
        const saved = await ed.save()
        if (!saved) return
        notify('success', connection
            ? `Saved ${saved.name}`
            : `Added ${saved.name}. Test it to see what it can do.`)
        onSaved(saved)
        onClose()
    }

    return (
        <EditorDrawer
            icon={BrainCircuit}
            title={d.name.trim() || (connection ? connection.name : 'New connection')}
            subtitle={d.baseUrl || 'OpenAI-compatible endpoint'}
            badges={!d.enabled && <Badge tone="neutral">Off</Badge>}
            dirty={ed.dirty}
            changedCount={ed.changedCount}
            valid={ed.valid}
            saving={ed.saving}
            saveError={ed.saveError ?? (fieldsQ.error ? (fieldsQ.error as Error).message : null)}
            saveLabel={connection ? 'Save changes' : 'Add connection'}
            onSave={() => { void submit() }}
            onClose={onClose}
        >
            {ed.creating && (
                <DrawerSection title="Start from" blurb="Fills in the usual values for that kind of endpoint. You can change any of them.">
                    <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Presets">
                        {PRESETS.map(p => (
                            <button
                                key={p.id}
                                type="button"
                                onClick={() => ed.setDraft(prev => applyPreset(prev, p))}
                                className="text-left rounded-xl border border-glass-border px-3 py-2.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
                            >
                                <span className="block text-xs font-semibold text-ink">{p.label}</span>
                                <span className="block text-[11px] text-ink-muted">{p.blurb}</span>
                            </button>
                        ))}
                    </div>
                </DrawerSection>
            )}

            <DrawerSection
                title="Endpoint"
                blurb="Questions and the metadata they need are sent to this endpoint. Any service that speaks the OpenAI Chat Completions API works."
            >
                <FieldGrid>
                    <Field label="Name" required hint={ed.errors.name ? <Err>{ed.errors.name}</Err> : 'Shown to people as “Answers by …”.'}>
                        <TextField mono={false} value={d.name} invalid={Boolean(ed.errors.name)}
                            placeholder="Corporate gateway" onChange={e => ed.set('name', e.target.value)} />
                    </Field>
                    <Field
                        label="Base URL"
                        required
                        hint={ed.errors.baseUrl
                            ? <Err>{ed.errors.baseUrl}</Err>
                            : 'Everything before /chat/completions. A private address must also be allowed by your operator (AI_EGRESS_ALLOWED_HOSTS).'}
                    >
                        <TextField value={d.baseUrl} invalid={Boolean(ed.errors.baseUrl)}
                            placeholder="https://my-resource.openai.azure.com" onChange={e => ed.set('baseUrl', e.target.value)} />
                    </Field>
                </FieldGrid>
                <label className="flex items-start gap-2.5 cursor-pointer">
                    <input type="checkbox" className="mt-0.5" checked={d.enabled} onChange={e => ed.set('enabled', e.target.checked)} />
                    <span>
                        <span className="block text-xs font-semibold text-ink">On</span>
                        <span className="block text-[10px] text-ink-muted">Off keeps the settings but sends nothing here; a role it serves stops answering.</span>
                    </span>
                </label>
            </DrawerSection>

            <DrawerSection title="Sign-in" blurb="How the platform proves who it is to this endpoint. Secrets are stored encrypted and never shown again.">
                <AuthFields
                    draft={d.auth}
                    onChange={next => ed.set('auth', next)}
                    fields={fieldsQ.data}
                    errors={ed.errors.auth ?? {}}
                    storedType={connection?.authType}
                />
            </DrawerSection>

            <DrawerSection title="Models" blurb="The model names this endpoint knows — for Azure OpenAI, your deployment names.">
                <FieldGrid>
                    <Field label="Chat model" required hint={ed.errors.chat ? <Err>{ed.errors.chat}</Err> : 'Answers questions and plans the steps to find the answer.'}>
                        <TextField value={d.models.chat} invalid={Boolean(ed.errors.chat)} placeholder="gpt-4o"
                            onChange={e => setModel('chat', e.target.value)} />
                    </Field>
                    <Field label="Fast model" hint="Small jobs such as titles. The chat model does them when this is empty.">
                        <TextField value={d.models.fast} placeholder="gpt-4o-mini" onChange={e => setModel('fast', e.target.value)} />
                    </Field>
                    <Field label="Embedding model" hint="Turns the guide and views into vectors, to find them by meaning. Empty: found by their words only.">
                        <TextField value={d.models.embedding} placeholder="text-embedding-3-small"
                            onChange={e => setModel('embedding', e.target.value)} />
                    </Field>
                    <Field
                        label="Embedding dimensions"
                        hint={ed.errors.embeddingDimensions
                            ? <Err>{ed.errors.embeddingDimensions}</Err>
                            : 'Asked of models that can shorten their vectors. Empty: the model’s own size.'}
                    >
                        <TextField value={d.models.embeddingDimensions} inputMode="numeric" placeholder="1536"
                            invalid={Boolean(ed.errors.embeddingDimensions)}
                            onChange={e => setModel('embeddingDimensions', e.target.value)} />
                    </Field>
                </FieldGrid>
            </DrawerSection>

            <Disclosure
                summary={<span className="text-sm font-bold text-ink">Advanced options</span>}
                defaultOpen={Boolean(d.options.chatPath || d.queryParams.length || d.extraHeaders.length)}
            >
                <div className="mt-4 space-y-4">
                    <div className="flex items-center justify-between gap-3">
                        <p className="text-xs text-ink-muted">Paths are relative to the base URL; {'{model}'} is replaced by the model name.</p>
                        <button
                            type="button"
                            onClick={() => ed.setDraft(prev => withAzurePaths(prev))}
                            className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-glass-border text-[11px] text-ink-secondary hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                        >
                            <Wand2 className="w-3 h-3" aria-hidden /> Azure OpenAI paths
                        </button>
                    </div>
                    <FieldGrid>
                        <Field label="Chat path">
                            <TextField value={d.options.chatPath} placeholder="/chat/completions"
                                onChange={e => setOption('chatPath', e.target.value)} />
                        </Field>
                        <Field label="Embeddings path">
                            <TextField value={d.options.embeddingsPath} placeholder="/embeddings"
                                onChange={e => setOption('embeddingsPath', e.target.value)} />
                        </Field>
                    </FieldGrid>
                    <Field label="Query parameters" hint="Added to every call — Azure OpenAI’s api-version, for example." unlabelled>
                        <KeyValueEditor label="Query parameters" pairs={d.queryParams} keyPlaceholder="api-version"
                            valuePlaceholder="2024-10-21" addLabel="Add a parameter" onChange={v => ed.set('queryParams', v)} />
                    </Field>
                    <Field
                        label="Extra headers"
                        hint={ed.errors.extraHeaders ? <Err>{ed.errors.extraHeaders}</Err> : 'Sent on every call, e.g. a routing or tenant header your gateway expects. Not for credentials.'}
                        unlabelled
                    >
                        <KeyValueEditor label="Extra headers" pairs={d.extraHeaders} keyPlaceholder="X-Tenant"
                            addLabel="Add a header" onChange={v => ed.set('extraHeaders', v)} />
                    </Field>
                    <div className="grid gap-3 sm:grid-cols-2">
                        {OPTION_TOGGLES.map(t => (
                            <label key={t.key} className="flex items-start gap-2.5 cursor-pointer">
                                <input type="checkbox" className="mt-0.5" checked={d.options[t.key]}
                                    onChange={e => setOption(t.key, e.target.checked)} />
                                <span>
                                    <span className="block text-xs font-semibold text-ink">{t.label}</span>
                                    <span className="block text-[10px] text-ink-muted leading-relaxed">{t.hint}</span>
                                </span>
                            </label>
                        ))}
                    </div>
                    <FieldGrid>
                        <Field
                            label="Retries"
                            hint={ed.errors.maxRetries ? <Err>{ed.errors.maxRetries}</Err> : 'Of a 429 or 5xx before any of the answer arrived, honouring Retry-After. Default 2.'}
                        >
                            <TextField value={d.options.maxRetries} inputMode="numeric" placeholder="2"
                                invalid={Boolean(ed.errors.maxRetries)} onChange={e => setOption('maxRetries', e.target.value)} />
                        </Field>
                    </FieldGrid>
                </div>
            </Disclosure>
        </EditorDrawer>
    )
}

function Err({ children }: { children: string }) {
    return <span className="text-red-500">{children}</span>
}
