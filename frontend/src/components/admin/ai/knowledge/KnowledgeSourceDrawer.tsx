/**
 * Adding or editing an external knowledge source: an MCP server the Help
 * persona also asks, the tool it calls there, and where the answer's parts
 * are in what comes back.
 */
import { BookOpenText } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAppNotifications } from '@/components/ui/notifications'
import { Field, FieldGrid, TextField } from '@/components/admin/sso/settings/ui'
import { aiAdminService, AI_ADMIN_KEYS, type KnowledgeSource } from '@/services/aiAdminService'
import { AuthFields } from '../auth/AuthFields'
import { EditorDrawer, DrawerSection } from '../ui/EditorDrawer'
import { KeyValueEditor } from '../ui/KeyValueEditor'
import { PERSONAS, useKnowledgeSourceEditor, type SourceDraft } from './useKnowledgeSourceEditor'

const RESULT_FIELDS: { key: keyof SourceDraft['resultMap']; label: string; hint: string; placeholder: string }[] = [
    { key: 'items', label: 'List of results', placeholder: 'results', hint: 'Where the list is in the tool’s answer. Empty when the answer is the list.' },
    { key: 'title', label: 'Title', placeholder: 'title', hint: 'In each result.' },
    { key: 'text', label: 'Text', placeholder: 'content', hint: 'In each result: what the assistant reads.' },
    { key: 'url', label: 'Link', placeholder: 'url', hint: 'In each result: where people can read more.' },
]

export function KnowledgeSourceDrawer({ source, onClose }: { source: KnowledgeSource | null; onClose: () => void }) {
    const fieldsQ = useQuery({ queryKey: AI_ADMIN_KEYS.authTypes, queryFn: aiAdminService.authTypes, staleTime: Infinity })
    const ed = useKnowledgeSourceEditor(source, fieldsQ.data)
    const { notify } = useAppNotifications()
    const d = ed.draft
    const bad = (m?: string) => (m ? <span className="text-red-500">{m}</span> : undefined)

    async function submit() {
        const saved = await ed.save()
        if (!saved) return
        notify('success', source ? `Saved ${saved.name}` : `Added ${saved.name}. Test it to check the mapping.`)
        onClose()
    }

    return (
        <EditorDrawer
            icon={BookOpenText}
            title={d.name.trim() || (source ? source.name : 'New knowledge source')}
            subtitle={d.url || 'MCP server'}
            dirty={ed.dirty}
            changedCount={ed.changedCount}
            valid={ed.valid}
            saving={ed.saving}
            saveError={ed.saveError ?? (fieldsQ.error ? (fieldsQ.error as Error).message : null)}
            saveLabel={source ? 'Save changes' : 'Add source'}
            onSave={() => { void submit() }}
            onClose={onClose}
        >
            <DrawerSection title="Source" blurb="The person’s question is sent here as a search. Answers are shown with this name and trust label.">
                <FieldGrid>
                    <Field label="Name" required hint={bad(ed.errors.name) ?? 'Shown beside every answer that uses it: “From …”.'}>
                        <TextField mono={false} value={d.name} invalid={Boolean(ed.errors.name)} placeholder="Engineering wiki"
                            onChange={e => ed.set('name', e.target.value)} />
                    </Field>
                    <Field label="MCP endpoint" required hint={bad(ed.errors.url) ?? 'Streamable HTTP.'}>
                        <TextField value={d.url} invalid={Boolean(ed.errors.url)} placeholder="https://wiki.example.com/mcp"
                            onChange={e => ed.set('url', e.target.value)} />
                    </Field>
                    <Field label="Trust label" hint="Says how far to rely on it, e.g. “Team-maintained, not reviewed”.">
                        <TextField mono={false} value={d.trustLabel} placeholder="Unreviewed" onChange={e => ed.set('trustLabel', e.target.value)} />
                    </Field>
                    <Field label="Time limit (ms)" hint={bad(ed.errors.timeoutMs) ?? 'An answer that takes longer is left out; the others still arrive.'}>
                        <TextField value={d.timeoutMs} inputMode="numeric" invalid={Boolean(ed.errors.timeoutMs)}
                            onChange={e => ed.set('timeoutMs', e.target.value)} />
                    </Field>
                </FieldGrid>
                <div role="group" aria-label="Used by" className="flex flex-wrap items-center gap-4">
                    <span className="text-xs font-semibold text-ink">Asked by</span>
                    {PERSONAS.map(p => (
                        <label key={p.value} className="flex items-center gap-1.5 text-xs text-ink cursor-pointer">
                            <input
                                type="checkbox"
                                checked={d.personas.includes(p.value)}
                                onChange={e => ed.set('personas', e.target.checked
                                    ? [...d.personas, p.value]
                                    : d.personas.filter(x => x !== p.value))}
                            />
                            {p.label}
                        </label>
                    ))}
                    <label className="flex items-center gap-1.5 text-xs text-ink cursor-pointer ml-auto">
                        <input type="checkbox" checked={d.enabled} onChange={e => ed.set('enabled', e.target.checked)} />
                        On
                    </label>
                </div>
            </DrawerSection>

            <DrawerSection title="Sign-in" blurb="The same methods as a model connection. Secrets are stored encrypted and never shown again.">
                <AuthFields
                    draft={d.auth}
                    onChange={next => ed.set('auth', next)}
                    fields={fieldsQ.data}
                    errors={ed.errors.auth ?? {}}
                    storedType={source?.authType}
                />
            </DrawerSection>

            <DrawerSection title="The tool" blurb="Which tool on that server answers a search, what it is called with, and where the results are in its answer.">
                <Field label="Tool name" required hint={bad(ed.errors.toolName) ?? 'As the server lists it, e.g. search.'}>
                    <TextField value={d.toolName} invalid={Boolean(ed.errors.toolName)} placeholder="search"
                        onChange={e => ed.set('toolName', e.target.value)} />
                </Field>
                <Field
                    label="Arguments"
                    hint="Left: what the assistant provides (query, limit). Right: the tool’s own name for it."
                    unlabelled
                >
                    <KeyValueEditor label="Arguments" pairs={d.argumentMap} keyPlaceholder="query" valuePlaceholder="q"
                        addLabel="Add an argument" onChange={v => ed.set('argumentMap', v)} />
                </Field>
                <FieldGrid>
                    {RESULT_FIELDS.map(f => (
                        <Field key={f.key} label={f.label} hint={(f.key === 'text' && bad(ed.errors.text)) || f.hint}>
                            <TextField value={d.resultMap[f.key]} placeholder={f.placeholder}
                                invalid={f.key === 'text' && Boolean(ed.errors.text)}
                                onChange={e => ed.set('resultMap', { ...d.resultMap, [f.key]: e.target.value })} />
                        </Field>
                    ))}
                </FieldGrid>
            </DrawerSection>
        </EditorDrawer>
    )
}
