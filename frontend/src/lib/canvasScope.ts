/** The workspace id that scopes canvas versioning state: the view's own workspace,
 *  falling back to the global selection. MUST match what CanvasVersioningBar passes
 *  to useResolveGraph/setResolved, or draft state becomes invisible to the canvas. */
export function canvasScopeWorkspaceId(
  viewWorkspaceId: string | null | undefined,
  globalActiveWorkspaceId: string | null | undefined,
): string | null {
  return viewWorkspaceId ?? globalActiveWorkspaceId ?? null
}
