/** Shared material identity for the writing UI and application tools. */
export function writingSourceFingerprint(source) {
  const text = JSON.stringify(['title', 'text', 'url'].map(key => typeof source?.[key] === 'string' ? source[key] : ''));
  let hash = 2166136261;
  for (const char of text) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16);
}

export function normalizeWritingReferenceSelection(value = {}) {
  return { enabled: value?.enabled === true, purpose: ['auto', 'content', 'style'].includes(value?.purpose) ? value.purpose : 'auto', text: typeof value?.text === 'string' ? value.text : '', projectId: typeof value?.projectId === 'string' ? value.projectId : '', projectPart: value?.projectPart === 'material' ? 'material' : 'work', projectCreatedAt: typeof value?.projectCreatedAt === 'string' ? value.projectCreatedAt : '' };
}

/** Shared plain text representation, without UI, media URLs or instructions. */
export function writingOutputText(channel, output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return '';
  const array = value => Array.isArray(value) ? value : [], strings = value => array(value).filter(item => typeof item === 'string');
  if (channel === 'article') return [output.title, output.lead, output.body].filter(Boolean).join('\n\n');
  if (channel === 'social') return [output.title, output.text, strings(output.tags).map(tag => '#' + tag.replace(/^#/, '')).join(' ')].filter(Boolean).join('\n\n');
  if (channel === 'poster') return [output.eyebrow, output.title, output.subtitle, strings(output.highlights).join('\n'), array(output.details).filter(Boolean).map(item => [item.label, item.value].filter(Boolean).join('：')).join('\n'), output.footer].filter(Boolean).join('\n\n');
  if (channel === 'video') return [output.title, ...array(output.shots).filter(Boolean).map((shot, index) => [`镜头${index + 1}（${shot.duration || 0}秒）`, shot.visual ? '画面：' + shot.visual : '', shot.narration ? '旁白：' + shot.narration : '', shot.caption ? '字幕：' + shot.caption : ''].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n');
  return '';
}
