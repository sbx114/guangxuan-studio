export const archiveWorkspaces = [
  { view: 'video', kind: 'video', label: '视频剪辑', lane: 0 },
  { view: 'writer', kind: 'writing', label: '文案写作', lane: 1 },
  { view: 'science', kind: 'science', label: '科普', lane: 2 },
] as const;
export type ArchiveWorkspace = typeof archiveWorkspaces[number]['view'];
export const isArchiveWorkspace = (value: unknown): value is ArchiveWorkspace => archiveWorkspaces.some(item => item.view === value);
export function workspaceLane(workspace: ArchiveWorkspace) { return archiveWorkspaces.find(item => item.view === workspace)!.lane; }
export function workspaceForLane(lane: number): ArchiveWorkspace | null { return archiveWorkspaces.find(item => item.lane === lane)?.view ?? null; }
export function workspaceForKind(kind: unknown): ArchiveWorkspace {
  return archiveWorkspaces.find(item => item.kind === kind)?.view || 'video';
}
export function nextWorkspace(current: ArchiveWorkspace, direction: number): ArchiveWorkspace {
  const index = archiveWorkspaces.findIndex(item => item.view === current);
  return archiveWorkspaces[(index + Math.sign(direction) + archiveWorkspaces.length) % archiveWorkspaces.length].view;
}
export function workspaceProjects(projects: unknown[], workspace: ArchiveWorkspace) {
  const kind = archiveWorkspaces.find(item => item.view === workspace)!.kind;
  return projects.filter(value => value && typeof value === 'object' && (value as Record<string, unknown>).kind === kind);
}
