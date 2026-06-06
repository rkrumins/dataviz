/**
 * Permission gating helpers for action buttons.
 *
 * Two patterns across the codebase:
 *
 *   * **Hide** the button entirely when the user can't perform the
 *     action — appropriate when the permission is the entire reason
 *     the button exists (e.g. "Register provider" only makes sense
 *     for someone with provider:manage).
 *
 *   * **Disable** the button with an explanatory tooltip — appropriate
 *     when the button is part of a workflow the user is mid-way
 *     through and removing it would confuse (e.g. an edit form's
 *     Save button when they don't actually have write perms).
 *
 * The canonical pattern in the codebase is the hide variant from
 * ``RegistryConnections.tsx``:
 *
 *   const canManage = usePermission('system:admin')
 *   {canManage && <button onClick={onDelete}>Delete</button>}
 *
 * For the disable variant, spread the props returned by
 * ``gatedButtonProps()`` onto the button. The result is a tooltip
 * users can read to understand why the action isn't available.
 */

export interface GatedButtonProps {
    disabled?: true
    title?: string
    'aria-disabled'?: 'true'
}

/**
 * Spread onto a ``<button>`` to disable it with an accessible tooltip
 * when the user lacks ``requiredPerm``. Returns an empty object when
 * the user has the permission so call sites don't need to branch.
 *
 * @example
 *   const canEdit = usePermission('workspace:view:edit', workspaceId)
 *   <button
 *       {...gatedButtonProps(canEdit, 'workspace:view:edit')}
 *       onClick={onSave}
 *   >Save</button>
 */
export function gatedButtonProps(
    canPerform: boolean,
    requiredPerm: string,
): GatedButtonProps {
    if (canPerform) return {}
    return {
        disabled: true,
        title: `You need the ${requiredPerm} permission to do this.`,
        'aria-disabled': 'true',
    }
}
