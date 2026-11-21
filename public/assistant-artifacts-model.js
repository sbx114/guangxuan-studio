const id = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}', uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const projectIdentifier = new RegExp('^' + id + '$');
const nativeFile = new RegExp('^/api/openfilm/exports/(' + id + ')/(' + id + ')/file$');
const remotionFile = new RegExp('^/api/projects/(' + id + ')/remotion/jobs/(' + uuid + ')/files/(?:video\\.mp4|frame-\\d{2}\\.png)$');
const managedFile = new RegExp('^/api/(?:assistant|project-bundles)/exports/(' + uuid + ')/file$');
export function normalizeAssistantArtifact(value, projectId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 255 || typeof value.downloadUrl !== 'string' || value.downloadUrl.length > 1000) return null;
  const url = value.downloadUrl;
  if (!url.startsWith('/api/') || /[\\\x00-\x20#?<>"']/.test(url) || url.includes('..') || url.includes('%')) return null;
  const target = nativeFile.exec(url) || remotionFile.exec(url), managed = managedFile.exec(url);
  if ([projectId, value.projectId].some(owner => owner != null && (typeof owner !== 'string' || !projectIdentifier.test(owner)))) return null;
  const owner = projectId ?? value.projectId ?? target?.[1];
  if (!(target || managed) || target && owner && target[1] !== owner) return null;
  if (value.projectId && owner && value.projectId !== owner) return null;
  if (managed && value.id !== undefined && value.id !== managed[1]) return null;
  const name = value.name.trim().replace(/[\x00-\x1f\x7f]/g, '');
  if (!name) return null;
  return { name, downloadUrl: url, ...(owner ? { projectId: owner } : {}),
    ...(typeof value.kind === 'string' ? { kind: value.kind.slice(0, 60) } : {}),
    ...(typeof value.id === 'string' && new RegExp('^' + uuid + '$', 'i').test(value.id) ? { id: value.id } : {}),
    ...(Number.isSafeInteger(value.size) && value.size >= 0 ? { size: value.size } : {}),
    ...(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256) ? { sha256: value.sha256.toLowerCase() } : {}),
  };
}
