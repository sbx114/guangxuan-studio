// Keep enough floating-point precision for millisecond rounding and time arithmetic.
// This is a numeric representation bound, independent of an asset or film length.
export const MAX_TIME_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000);

export function parseTimecode(value) {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0 && value <= MAX_TIME_SECONDS) return Math.round(value * 1000) / 1000;
    throw new RangeError('请输入可精确表示的非负时间。');
  }
  const text = String(value ?? '').trim().replaceAll('：', ':');
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d{1,3})?$/.test(text)) throw new RangeError('请输入秒数或 时:分:秒，例如 12.5 或 00:12.500。');
  const parts = text.split(':').map(Number);
  if (parts.length > 1 && parts.slice(1).some(part => part >= 60)) throw new RangeError('时间码中的分和秒需小于 60。');
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return parseTimecode(seconds);
}

export function normalizeTimeRange(input, { label = '区间', duration } = {}) {
  if (input === null || input === undefined) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['start', 'end'].includes(key)) || typeof input.start !== 'number' || typeof input.end !== 'number') throw new RangeError(`${label}需包含起点和终点。`);
  const start = parseTimecode(input.start), end = parseTimecode(input.end);
  if (!(end > start)) throw new RangeError(`${label}终点需晚于起点。`);
  if (Number.isFinite(duration) && end > duration + 0.001) throw new RangeError(`${label}不能超过素材时长。`);
  return { start, end };
}

export function formatTimecode(value) {
  const milliseconds = Math.round(parseTimecode(value) * 1000);
  const hours = Math.floor(milliseconds / 3600000), minutes = Math.floor(milliseconds / 60000) % 60;
  const seconds = String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0');
  const fraction = milliseconds % 1000;
  return `${hours ? String(hours).padStart(2, '0') + ':' : ''}${String(minutes).padStart(2, '0')}:${seconds}${fraction ? '.' + String(fraction).padStart(3, '0') : ''}`;
}

export function formatTimeRange(range, fallback = '全片') {
  return range ? `${formatTimecode(range.start)}–${formatTimecode(range.end)}` : fallback;
}

export function rangesOverlap(a, b) { return !a || !b || (a.start < b.end && b.start < a.end); }
