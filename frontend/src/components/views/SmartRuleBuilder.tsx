/**
 * SmartRuleBuilder - Visual rule builder for layer assignment rules
 * 
 * Features:
 * - Condition groups with AND/OR logic
 * - Property autocomplete from schema
 * - Real-time matched entity count
 * - Rule templates library
 * - "Test Rule" to preview matches
 */

import { useState, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Plus,
    Trash2,
    Play,
    Sparkles,
    ChevronDown,
    Check,
    X,
    GitBranch,
    Tag,
    Type,
    Hash,
    Box,
    Layers
} from 'lucide-react'
import { cn, generateId } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'

// ============================================
// Types
// ============================================

export type ConditionOperator =
    | 'equals'
    | 'not_equals'
    | 'contains'
    | 'not_contains'
    | 'starts_with'
    | 'ends_with'
    | 'matches'
    | 'in'
    | 'not_in'
    | 'exists'
    | 'not_exists'

export type ConditionField =
    | 'type'
    | 'name'
    | 'urn'
    | 'tag'
    | 'property'

export interface RuleCondition {
    id: string
    field: ConditionField
    property?: string    // For property field, which property
    operator: ConditionOperator
    value: string
    isNegated?: boolean
}

export interface ConditionGroup {
    id: string
    logic: 'AND' | 'OR'
    conditions: RuleCondition[]
}

export interface SmartRule {
    id: string
    name: string
    description?: string
    groups: ConditionGroup[]
    groupLogic: 'AND' | 'OR'  // How groups connect to each other
    priority: number
    inheritsChildren: boolean
    isEnabled: boolean
}

interface SmartRuleBuilderProps {
    rule: SmartRule
    onUpdate: (rule: SmartRule) => void
    onRemove?: () => void
    onTest?: (rule: SmartRule) => Promise<number>
    className?: string
}

// ============================================
// Constants
// ============================================

const OPERATORS: { value: ConditionOperator; label: string; fields: ConditionField[] }[] = [
    { value: 'equals', label: 'equals', fields: ['type', 'name', 'urn', 'tag', 'property'] },
    { value: 'not_equals', label: 'not equals', fields: ['type', 'name', 'urn', 'tag', 'property'] },
    { value: 'contains', label: 'contains', fields: ['name', 'urn', 'property'] },
    { value: 'not_contains', label: 'not contains', fields: ['name', 'urn', 'property'] },
    { value: 'starts_with', label: 'starts with', fields: ['name', 'urn', 'property'] },
    { value: 'ends_with', label: 'ends with', fields: ['name', 'urn', 'property'] },
    { value: 'matches', label: 'matches regex', fields: ['name', 'urn', 'property'] },
    { value: 'in', label: 'in list', fields: ['type', 'tag'] },
    { value: 'not_in', label: 'not in list', fields: ['type', 'tag'] },
    { value: 'exists', label: 'exists', fields: ['property', 'tag'] },
    { value: 'not_exists', label: 'not exists', fields: ['property', 'tag'] },
]

const FIELD_OPTIONS: { value: ConditionField; label: string; icon: React.ReactNode }[] = [
    { value: 'type', label: 'Entity Type', icon: <Box className="w-4 h-4" /> },
    { value: 'name', label: 'Name', icon: <Type className="w-4 h-4" /> },
    { value: 'urn', label: 'URN', icon: <Hash className="w-4 h-4" /> },
    { value: 'tag', label: 'Tag', icon: <Tag className="w-4 h-4" /> },
    { value: 'property', label: 'Property', icon: <Layers className="w-4 h-4" /> },
]

const RULE_TEMPLATES: { name: string; description: string; groups: ConditionGroup[] }[] = [
    {
        name: 'By Entity Type',
        description: 'Match entities of specific types',
        groups: [{
            id: 'g1',
            logic: 'OR',
            conditions: [
                { id: 'c1', field: 'type', operator: 'in', value: '' }
            ]
        }]
    },
    {
        name: 'By Name Pattern',
        description: 'Match entities whose name contains text',
        groups: [{
            id: 'g1',
            logic: 'AND',
            conditions: [
                { id: 'c1', field: 'name', operator: 'contains', value: '' }
            ]
        }]
    },
    {
        name: 'By Tag',
        description: 'Match entities with specific tags',
        groups: [{
            id: 'g1',
            logic: 'OR',
            conditions: [
                { id: 'c1', field: 'tag', operator: 'equals', value: '' }
            ]
        }]
    },
    {
        name: 'Complex: Type + Tag',
        description: 'Match entities of type AND with tag',
        groups: [{
            id: 'g1',
            logic: 'AND',
            conditions: [
                { id: 'c1', field: 'type', operator: 'equals', value: '' },
                { id: 'c2', field: 'tag', operator: 'equals', value: '' }
            ]
        }]
    }
]

// ============================================
// Sub-Components
// ============================================

interface ConditionEditorProps {
    condition: RuleCondition
    onUpdate: (updates: Partial<RuleCondition>) => void
    onRemove: () => void
    isFirst: boolean
    parentLogic: 'AND' | 'OR'
}

function ConditionEditor({ condition, onUpdate, onRemove, isFirst, parentLogic }: ConditionEditorProps) {
    const schema = useSchemaStore(s => s.schema)

    // Get entity types for autocomplete
    const entityTypes = useMemo(() =>
        schema?.entityTypes.map(e => e.id) ?? [],
        [schema]
    )

    // Get available operators for selected field
    const availableOperators = useMemo(() =>
        OPERATORS.filter(op => op.fields.includes(condition.field)),
        [condition.field]
    )

    return (
        <div className="flex items-center gap-2 py-2">
            {/* AND/OR badge for non-first conditions */}
            {!isFirst && (
                <span className={cn(
                    'px-2 py-0.5 text-2xs font-bold rounded-full uppercase tracking-wider',
                    parentLogic === 'AND'
                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                        : 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400'
                )}>
                    {parentLogic}
                </span>
            )}

            {/* Field Select */}
            <select
                value={condition.field}
                onChange={e => onUpdate({ field: e.target.value as ConditionField, operator: 'equals' })}
                className="px-2 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm min-w-[120px]"
            >
                {FIELD_OPTIONS.map(field => (
                    <option key={field.value} value={field.value}>{field.label}</option>
                ))}
            </select>

            {/* Property name input (only for property field) */}
            {condition.field === 'property' && (
                <input
                    type="text"
                    value={condition.property || ''}
                    onChange={e => onUpdate({ property: e.target.value })}
                    placeholder="property name"
                    className="px-2 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm w-28"
                />
            )}

            {/* Operator Select */}
            <select
                value={condition.operator}
                onChange={e => onUpdate({ operator: e.target.value as ConditionOperator })}
                className="px-2 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm min-w-[100px]"
            >
                {availableOperators.map(op => (
                    <option key={op.value} value={op.value}>{op.label}</option>
                ))}
            </select>

            {/* Value Input (not for exists/not_exists) */}
            {!['exists', 'not_exists'].includes(condition.operator) && (
                <>
                    {condition.field === 'type' ? (
                        <select
                            value={condition.value}
                            onChange={e => onUpdate({ value: e.target.value })}
                            className="px-2 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm flex-1 min-w-[120px]"
                        >
                            <option value="">Select type...</option>
                            {entityTypes.map(type => (
                                <option key={type} value={type}>{type}</option>
                            ))}
                        </select>
                    ) : (
                        <input
                            type="text"
                            value={condition.value}
                            onChange={e => onUpdate({ value: e.target.value })}
                            placeholder={condition.field === 'tag' ? 'tag name' : 'value'}
                            className="px-2 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm flex-1 min-w-[120px]"
                        />
                    )}
                </>
            )}

            {/* Remove Button */}
            <button
                onClick={onRemove}
                className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
            >
                <X className="w-4 h-4" />
            </button>
        </div>
    )
}

interface ConditionGroupEditorProps {
    group: ConditionGroup
    groupIndex: number
    onUpdate: (updates: Partial<ConditionGroup>) => void
    onRemove: () => void
    isFirst: boolean
    parentLogic: 'AND' | 'OR'
}

function ConditionGroupEditor({ group, groupIndex, onUpdate, onRemove, isFirst, parentLogic }: ConditionGroupEditorProps) {
    const handleAddCondition = useCallback(() => {
        const newCondition: RuleCondition = {
            id: generateId(),
            field: 'type',
            operator: 'equals',
            value: ''
        }
        onUpdate({ conditions: [...group.conditions, newCondition] })
    }, [group.conditions, onUpdate])

    const handleUpdateCondition = useCallback((conditionId: string, updates: Partial<RuleCondition>) => {
        onUpdate({
            conditions: group.conditions.map(c =>
                c.id === conditionId ? { ...c, ...updates } : c
            )
        })
    }, [group.conditions, onUpdate])

    const handleRemoveCondition = useCallback((conditionId: string) => {
        onUpdate({
            conditions: group.conditions.filter(c => c.id !== conditionId)
        })
    }, [group.conditions, onUpdate])

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="relative"
        >
            {/* Group connector */}
            {!isFirst && (
                <div className="flex items-center gap-2 py-2">
                    <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                    <span className={cn(
                        'px-3 py-1 text-xs font-bold rounded-full uppercase',
                        parentLogic === 'AND'
                            ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                            : 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400'
                    )}>
                        {parentLogic}
                    </span>
                    <div className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                </div>
            )}

            {/* Group Card */}
            <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700">
                {/* Group Header */}
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-slate-500 uppercase">Group {groupIndex + 1}</span>
                        <button
                            onClick={() => onUpdate({ logic: group.logic === 'AND' ? 'OR' : 'AND' })}
                            className={cn(
                                'px-2 py-0.5 text-2xs font-bold rounded-full uppercase cursor-pointer hover:opacity-80 transition-opacity',
                                group.logic === 'AND'
                                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                                    : 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400'
                            )}
                        >
                            Match {group.logic}
                        </button>
                    </div>
                    <button
                        onClick={onRemove}
                        className="p-1 text-slate-400 hover:text-red-500 transition-colors"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>

                {/* Conditions */}
                <div className="space-y-1">
                    {group.conditions.map((condition, idx) => (
                        <ConditionEditor
                            key={condition.id}
                            condition={condition}
                            onUpdate={(updates) => handleUpdateCondition(condition.id, updates)}
                            onRemove={() => handleRemoveCondition(condition.id)}
                            isFirst={idx === 0}
                            parentLogic={group.logic}
                        />
                    ))}
                </div>

                {/* Add Condition */}
                <button
                    onClick={handleAddCondition}
                    className="mt-2 flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium"
                >
                    <Plus className="w-3 h-3" /> Add condition
                </button>
            </div>
        </motion.div>
    )
}

// ============================================
// Main Component
// ============================================

export function SmartRuleBuilder({
    rule,
    onUpdate,
    onRemove,
    onTest,
    className
}: SmartRuleBuilderProps) {
    const [showTemplates, setShowTemplates] = useState(false)
    const [testResult, setTestResult] = useState<number | null>(null)
    const [isTesting, setIsTesting] = useState(false)

    // Handlers
    const handleAddGroup = useCallback(() => {
        const newGroup: ConditionGroup = {
            id: generateId(),
            logic: 'AND',
            conditions: [{
                id: generateId(),
                field: 'type',
                operator: 'equals',
                value: ''
            }]
        }
        onUpdate({ ...rule, groups: [...rule.groups, newGroup] })
    }, [rule, onUpdate])

    const handleUpdateGroup = useCallback((groupId: string, updates: Partial<ConditionGroup>) => {
        onUpdate({
            ...rule,
            groups: rule.groups.map(g => g.id === groupId ? { ...g, ...updates } : g)
        })
    }, [rule, onUpdate])

    const handleRemoveGroup = useCallback((groupId: string) => {
        onUpdate({
            ...rule,
            groups: rule.groups.filter(g => g.id !== groupId)
        })
    }, [rule, onUpdate])

    const handleApplyTemplate = useCallback((template: typeof RULE_TEMPLATES[0]) => {
        const groups: ConditionGroup[] = template.groups.map(g => ({
            ...g,
            id: generateId(),
            conditions: g.conditions.map(c => ({ ...c, id: generateId() }))
        }))
        onUpdate({ ...rule, groups })
        setShowTemplates(false)
    }, [rule, onUpdate])

    const handleTestRule = useCallback(async () => {
        if (!onTest) return
        setIsTesting(true)
        setTestResult(null)
        try {
            const count = await onTest(rule)
            setTestResult(count)
        } finally {
            setIsTesting(false)
        }
    }, [rule, onTest])

    return (
        <div className={cn('space-y-4', className)}>
            {/* Rule Header */}
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white">
                    <GitBranch className="w-5 h-5" />
                </div>
                <div className="flex-1">
                    <input
                        type="text"
                        value={rule.name}
                        onChange={e => onUpdate({ ...rule, name: e.target.value })}
                        placeholder="Rule name"
                        className="text-lg font-bold bg-transparent border-none outline-none focus:ring-1 focus:ring-blue-500 rounded px-1 -mx-1"
                    />
                    <input
                        type="text"
                        value={rule.description || ''}
                        onChange={e => onUpdate({ ...rule, description: e.target.value })}
                        placeholder="Add description..."
                        className="block text-sm text-slate-500 bg-transparent border-none outline-none focus:ring-1 focus:ring-blue-500 rounded px-1 -mx-1 w-full"
                    />
                </div>
                <div className="flex items-center gap-2">
                    {/* Toggle enabled */}
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={rule.isEnabled}
                            onChange={e => onUpdate({ ...rule, isEnabled: e.target.checked })}
                            className="sr-only peer"
                        />
                        <div className={cn(
                            'w-9 h-5 rounded-full transition-colors',
                            rule.isEnabled ? 'bg-green-500' : 'bg-slate-300 dark:bg-slate-600'
                        )}>
                            <div className={cn(
                                'w-4 h-4 rounded-full bg-white shadow transition-transform mt-0.5',
                                rule.isEnabled ? 'translate-x-4' : 'translate-x-0.5'
                            )} />
                        </div>
                    </label>
                    {onRemove && (
                        <button
                            onClick={onRemove}
                            className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                    )}
                </div>
            </div>

            {/* Templates */}
            <div className="relative">
                <button
                    onClick={() => setShowTemplates(!showTemplates)}
                    className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700 font-medium"
                >
                    <Sparkles className="w-4 h-4" />
                    Start from template
                    <ChevronDown className={cn('w-4 h-4 transition-transform', showTemplates && 'rotate-180')} />
                </button>

                <AnimatePresence>
                    {showTemplates && (
                        <motion.div
                            initial={{ opacity: 0, y: -10, height: 0 }}
                            animate={{ opacity: 1, y: 0, height: 'auto' }}
                            exit={{ opacity: 0, y: -10, height: 0 }}
                            className="overflow-hidden"
                        >
                            <div className="grid grid-cols-2 gap-2 mt-3 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-xl">
                                {RULE_TEMPLATES.map((template, i) => (
                                    <button
                                        key={i}
                                        onClick={() => handleApplyTemplate(template)}
                                        className="p-3 text-left bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-700 transition-colors"
                                    >
                                        <p className="font-medium text-sm text-slate-800 dark:text-slate-200">{template.name}</p>
                                        <p className="text-xs text-slate-500">{template.description}</p>
                                    </button>
                                ))}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Group Logic Toggle */}
            {rule.groups.length > 1 && (
                <div className="flex items-center gap-3 p-3 bg-slate-100 dark:bg-slate-800 rounded-lg">
                    <span className="text-sm text-slate-600 dark:text-slate-400">Groups connect with:</span>
                    <button
                        onClick={() => onUpdate({ ...rule, groupLogic: rule.groupLogic === 'AND' ? 'OR' : 'AND' })}
                        className={cn(
                            'px-3 py-1 text-sm font-bold rounded-full uppercase',
                            rule.groupLogic === 'AND'
                                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                                : 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400'
                        )}
                    >
                        {rule.groupLogic}
                    </button>
                </div>
            )}

            {/* Condition Groups */}
            <div className="space-y-2">
                <AnimatePresence>
                    {rule.groups.map((group, idx) => (
                        <ConditionGroupEditor
                            key={group.id}
                            group={group}
                            groupIndex={idx}
                            onUpdate={(updates) => handleUpdateGroup(group.id, updates)}
                            onRemove={() => handleRemoveGroup(group.id)}
                            isFirst={idx === 0}
                            parentLogic={rule.groupLogic}
                        />
                    ))}
                </AnimatePresence>
            </div>

            {/* Add Group */}
            <button
                onClick={handleAddGroup}
                className="w-full flex items-center justify-center gap-2 p-3 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl text-sm text-slate-500 hover:border-blue-300 hover:text-blue-600 transition-colors"
            >
                <Plus className="w-4 h-4" /> Add condition group
            </button>

            {/* Options */}
            <div className="flex items-center gap-4 pt-4 border-t border-slate-200 dark:border-slate-700">
                <div className="flex items-center gap-2">
                    <label className="text-sm text-slate-600 dark:text-slate-400">Priority:</label>
                    <input
                        type="number"
                        value={rule.priority}
                        onChange={e => onUpdate({ ...rule, priority: parseInt(e.target.value) || 1 })}
                        min={1}
                        max={100}
                        className="w-16 px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-sm text-center"
                    />
                </div>

                <label className="flex items-center gap-2 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={rule.inheritsChildren}
                        onChange={e => onUpdate({ ...rule, inheritsChildren: e.target.checked })}
                        className="rounded"
                    />
                    <span className="text-sm text-slate-600 dark:text-slate-400">Apply to children</span>
                </label>

                <div className="flex-1" />

                {/* Test Rule */}
                {onTest && (
                    <button
                        onClick={handleTestRule}
                        disabled={isTesting}
                        className={cn(
                            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                            isTesting
                                ? 'bg-slate-100 text-slate-400'
                                : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50'
                        )}
                    >
                        {isTesting ? (
                            <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        ) : (
                            <Play className="w-4 h-4" />
                        )}
                        Test Rule
                    </button>
                )}
            </div>

            {/* Test Result */}
            <AnimatePresence>
                {testResult !== null && (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0 }}
                        className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800"
                    >
                        <Check className="w-5 h-5 text-green-600" />
                        <span className="text-sm text-green-700 dark:text-green-400">
                            <strong>{testResult}</strong> entities match this rule
                        </span>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

// ============================================
// Helper: Create empty rule
// ============================================

export function createEmptySmartRule(name = 'New Rule'): SmartRule {
    return {
        id: generateId(),
        name,
        groups: [{
            id: generateId(),
            logic: 'AND',
            conditions: [{
                id: generateId(),
                field: 'type',
                operator: 'equals',
                value: ''
            }]
        }],
        groupLogic: 'AND',
        priority: 1,
        inheritsChildren: true,
        isEnabled: true
    }
}

export default SmartRuleBuilder
