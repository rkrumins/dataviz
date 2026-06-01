/**
 * TemplateMetadataForm — reusable controlled form for template metadata.
 *
 * Used by both the "create wizard" step 1 and the inline edit dialog.
 * Parent owns the state via a single value/onChange pair so the form
 * can be embedded in any container (modal, wizard, drawer).
 */
import { Sparkles, User, FileText, Tag } from 'lucide-react'
import { IconPicker } from './IconPicker'
import { ColorPicker } from './ColorPicker'
import { TagInput } from './TagInput'
import type { ContextModelCreateRequest } from '@/services/contextModelService'

export interface TemplateMetadataValue {
    name: string
    description: string
    category: string
    icon: string
    accentColor: string
    maintainer: string
    aboutMarkdown: string
    tags: string[]
    visibility: 'private' | 'workspace' | 'enterprise'
}

export const EMPTY_METADATA: TemplateMetadataValue = {
    name: '',
    description: '',
    category: '',
    icon: 'LayoutTemplate',
    accentColor: '#6366f1',
    maintainer: '',
    aboutMarkdown: '',
    tags: [],
    visibility: 'workspace',
}

export const CATEGORY_SUGGESTIONS = [
    'data-engineering',
    'analytics',
    'data-mesh',
    'governance',
    'ml-ops',
]

interface TemplateMetadataFormProps {
    value: TemplateMetadataValue
    onChange: (next: TemplateMetadataValue) => void
    nameError?: string | null
    /** Tag suggestions from the gallery — feed the autocomplete datalist. */
    tagSuggestions?: string[]
}

export function TemplateMetadataForm({ value, onChange, nameError, tagSuggestions }: TemplateMetadataFormProps) {
    const setField = <K extends keyof TemplateMetadataValue>(key: K, val: TemplateMetadataValue[K]) =>
        onChange({ ...value, [key]: val })

    return (
        <div className="space-y-4">
            {/* Identity */}
            <Section icon={Sparkles} title="Identity">
                <Field label="Name *" error={nameError}>
                    <input
                        type="text"
                        value={value.name}
                        onChange={(e) => setField('name', e.target.value)}
                        autoFocus
                        placeholder="e.g. Lakehouse Pipeline"
                        className="input"
                    />
                </Field>
                <Field label="Short description">
                    <input
                        type="text"
                        value={value.description}
                        onChange={(e) => setField('description', e.target.value)}
                        placeholder="One-line summary shown on the gallery card"
                        className="input"
                    />
                </Field>
            </Section>

            {/* Appearance */}
            <Section icon={Sparkles} title="Appearance">
                <div className="grid grid-cols-[1fr,auto] gap-4 items-start">
                    <Field label="Icon">
                        <IconPicker
                            value={value.icon}
                            onChange={(name) => setField('icon', name)}
                            accentColor={value.accentColor}
                        />
                    </Field>
                    <Field label="Accent color">
                        <ColorPicker
                            value={value.accentColor}
                            onChange={(color) => setField('accentColor', color)}
                        />
                    </Field>
                </div>
            </Section>

            {/* Classification */}
            <Section icon={Tag} title="Classification">
                <Field label="Category">
                    <input
                        type="text"
                        list="tpl-category-suggest"
                        value={value.category}
                        onChange={(e) => setField('category', e.target.value)}
                        placeholder="e.g. data-engineering"
                        className="input"
                    />
                    <datalist id="tpl-category-suggest">
                        {CATEGORY_SUGGESTIONS.map(c => <option key={c} value={c} />)}
                    </datalist>
                </Field>
                <Field label="Tags" hint="Press Enter or comma to add. Backspace removes the last.">
                    <TagInput
                        value={value.tags}
                        onChange={(tags) => setField('tags', tags)}
                        suggestions={tagSuggestions}
                        placeholder="etl, lineage, warehouse"
                    />
                </Field>
            </Section>

            {/* Authorship */}
            <Section icon={User} title="Authorship">
                <Field label="Maintainer">
                    <input
                        type="text"
                        value={value.maintainer}
                        onChange={(e) => setField('maintainer', e.target.value)}
                        placeholder="Team or individual responsible for this template"
                        className="input"
                    />
                </Field>
                <Field label="Visibility">
                    <select
                        value={value.visibility}
                        onChange={(e) => setField('visibility', e.target.value as TemplateMetadataValue['visibility'])}
                        className="input"
                    >
                        <option value="private">Private — only the author</option>
                        <option value="workspace">Workspace — everyone in the workspace</option>
                        <option value="enterprise">Enterprise — everyone in the enterprise</option>
                    </select>
                </Field>
            </Section>

            {/* Long-form description */}
            <Section icon={FileText} title="About this template">
                <Field label="Detailed description" hint="Plain text or Markdown. Rendered in the detail drawer.">
                    <textarea
                        value={value.aboutMarkdown}
                        onChange={(e) => setField('aboutMarkdown', e.target.value)}
                        rows={5}
                        placeholder="Explain when to use this template, the assumptions it makes, and any gotchas."
                        className="input resize-none custom-scrollbar"
                    />
                </Field>
            </Section>

            <style>{`
                .input {
                    width: 100%;
                    padding: 8px 12px;
                    font-size: 14px;
                    border-radius: 8px;
                    background: var(--canvas, white);
                    border: 1px solid var(--glass-border, rgba(0,0,0,0.08));
                    color: var(--ink, currentColor);
                }
                .input:focus {
                    outline: none;
                    border-color: rgba(99, 102, 241, 0.5);
                    box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.25);
                }
            `}</style>
        </div>
    )
}

function Section({
    icon: Icon, title, children,
}: {
    icon: React.ComponentType<{ className?: string }>
    title: string
    children: React.ReactNode
}) {
    return (
        <div className="space-y-2.5">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-ink-muted flex items-center gap-1.5">
                <Icon className="w-3 h-3" />
                {title}
            </h4>
            <div className="space-y-3">{children}</div>
        </div>
    )
}

function Field({
    label, hint, error, children,
}: {
    label: string
    hint?: string
    error?: string | null
    children: React.ReactNode
}) {
    return (
        <div className="space-y-1">
            <label className="text-xs font-medium text-ink-secondary block">{label}</label>
            {children}
            {error
                ? <p className="text-[11px] text-red-500">{error}</p>
                : hint
                    ? <p className="text-[11px] text-ink-muted">{hint}</p>
                    : null}
        </div>
    )
}

/** Helper to derive the form value from an existing template (edit mode). */
export function metadataFromTemplate(template: {
    name: string
    description?: string
    category?: string
    icon?: string
    accentColor?: string
    maintainer?: string
    aboutMarkdown?: string
    tags: string[]
    visibility: 'private' | 'workspace' | 'enterprise'
}): TemplateMetadataValue {
    return {
        name: template.name,
        description: template.description ?? '',
        category: template.category ?? '',
        icon: template.icon ?? EMPTY_METADATA.icon,
        accentColor: template.accentColor ?? EMPTY_METADATA.accentColor,
        maintainer: template.maintainer ?? '',
        aboutMarkdown: template.aboutMarkdown ?? '',
        tags: template.tags ?? [],
        visibility: template.visibility,
    }
}

/** Helper to derive a create-request payload from a form value. */
export function metadataToCreateRequest(
    value: TemplateMetadataValue,
    layersConfig: ContextModelCreateRequest['layersConfig'],
): ContextModelCreateRequest {
    return {
        name: value.name.trim(),
        description: value.description.trim() || undefined,
        category: value.category.trim() || undefined,
        icon: value.icon || undefined,
        accentColor: value.accentColor || undefined,
        maintainer: value.maintainer.trim() || undefined,
        aboutMarkdown: value.aboutMarkdown.trim() || undefined,
        tags: value.tags.length ? value.tags : undefined,
        visibility: value.visibility,
        layersConfig,
        isTemplate: true,
    }
}
