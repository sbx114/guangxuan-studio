const URLS = /https?:\/\/[^\s<>"'`，。；、！？（）【】《》]+/gi;
const END_PUNCTUATION = /[，。；、！？.,;!?）)\]}】》]+$/;
const REFERENCE_LEAD = /(?:模仿|参考|仿照|照着)(?:这(?:个|段|部|份))?(?:视频|链接|网址)?\s*$/;
const CREATION_TAIL = /^,(?:请|帮我|再)?(?:(?:制作|生成|剪辑|创作)(?:一(?:个|段|部))?(?:mv|视频|短片|动画|音乐视频|宣传片|片头|片尾|成片)|(?:仅|只)(?:修改|替换|改)(?:文字|文案|字幕|文本)(?=[,，。；;!?！？]|$))/i;
function exactUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
}
function completeBilibiliReference(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) return false;
    if (!['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname.toLowerCase())) return false;
    if (!/^\/(?:(?:zh-Hans|zh-Hant|pt)\/)?video\/(?:BV[0-9A-Za-z]{10}|av\d{1,20})\/?$/i.test(url.pathname)) return false;
    if (!url.search) return true;
    const last = [...url.searchParams].at(-1);
    // These have complete, typed values. A free-text/list parameter can contain
    // the same comma and words, so it must never be treated as a command tail.
    return last?.[0] === 'vd_source' && /^[0-9a-f]{32}$/i.test(last[1]) || last?.[0] === 'p' && /^[1-9]\d{0,2}$/.test(last[1]);
  } catch { return false; }
}

/** Preserve exact user candidates; add only an unambiguous Bilibili reference prefix. */
export function extractAssistantUserUrlCandidates(instruction) {
  if (typeof instruction !== 'string') return [];
  const found = new Set();
  for (const match of instruction.matchAll(URLS)) {
    const raw = match[0].replace(END_PUNCTUATION, ''), exact = exactUrl(raw); if (exact) found.add(exact);
    if (!REFERENCE_LEAD.test(instruction.slice(0, match.index))) continue;
    for (let index = raw.indexOf(','); index >= 0; index = raw.indexOf(',', index + 1)) {
      if (!CREATION_TAIL.test(raw.slice(index))) continue;
      const prefix = raw.slice(0, index);
      if (completeBilibiliReference(prefix)) { const url = exactUrl(prefix); if (url) found.add(url); }
    }
  }
  return [...found];
}
