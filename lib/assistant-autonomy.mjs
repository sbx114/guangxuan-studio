import { AppError } from './errors.mjs';
const transient = new Set(['UPSTREAM_HTTP_408', 'UPSTREAM_HTTP_429', 'UPSTREAM_HTTP_500', 'UPSTREAM_HTTP_502', 'UPSTREAM_HTTP_503', 'UPSTREAM_HTTP_504', 'UPSTREAM_TIMEOUT', 'UPSTREAM_NETWORK_ERROR']);
export function assistantModelRetry(error, completedRetries = 0) {
  if (!transient.has(error?.code) || completedRetries >= 2) return null;
  const hinted = Number(error.retryAfterMs);
  return { code: error.code, attempt: completedRetries + 1, delayMs: Number.isFinite(hinted) && hinted >= 0 ? Math.min(30000, hinted) : [300, 1200][completedRetries] };
}
export function waitAssistantRetry(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(new AppError(499, '操作已取消。', 'REQUEST_CANCELLED'));
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new AppError(499, '操作已取消。', 'REQUEST_CANCELLED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, milliseconds);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
export function normalizeAutonomySnapshot(value, clean = String) {
  const secret = /^(settings|api_?key|authorization|access_?token|refresh_?token|password|secret|client_?secret|credentials|cookies?|imageBatch|images|dataUrl|writingPreferences|styleSample|identity)$/i;
  const visit = (item, depth = 0) => {
    if (depth > 16) return null;
    if (typeof item === 'string') return /^data:image\//.test(item) ? null : clean(item).slice(0, 24000);
    if (Array.isArray(item)) return item.slice(0, 256).map(child => visit(child, depth + 1));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).filter(([key]) => !secret.test(key)).map(([key, child]) => [key, visit(child, depth + 1)]));
  };
  const result = visit(value);
  if (!result || typeof result !== 'object' || Array.isArray(result) || JSON.stringify(result).length > 128000) throw new AppError(400, '任务恢复快照不正确或过大。', 'ASSISTANT_CHECKPOINT_INVALID');
  return result;
}
