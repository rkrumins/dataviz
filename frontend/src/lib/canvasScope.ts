/** The workspace id that scopes canvas versioning state: the view's OWN workspace.
 *  MUST match what CanvasVersioningBar passes to useResolveGraph/setResolved — which
 *  also uses the active view's workspaceId (CanvasRouter renders it gated on that id) —
 *  or draft state becomes invisible to the canvas. Deliberately does NOT fall back to
 *  the global active workspace: a view is self-scoping, and coupling its draft scope to
 *  the global selection let a lagging/divergent selection resolve the wrong branch. */
export function canvasScopeWorkspaceId(
  viewWorkspaceId: string | null | undefined,
): string | null {
  return viewWorkspaceId ?? null
}
