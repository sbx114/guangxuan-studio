/** Local integration switches. Set these in the dedicated Studio worker before importing it. */
export const LOCAL_ONLY = process.env.OPENFILM_LOCAL_ONLY === '1';
export function embedOrigin() {
  const raw = process.env.OPENFILM_EMBED_ORIGIN;
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('OPENFILM_EMBED_ORIGIN must be an exact local application origin.');
  return url.origin;
}
