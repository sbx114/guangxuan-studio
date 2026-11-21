const KEY = 'gx-writing-preferences-v1';
const LIMITS = { voice: 600, identity: 500, styleSample: 6000, avoidWords: 1200, preferredTerms: 1200 };
let current = null, remembered = false;
export function normalizeWritingPreferences(input = {}) {
  return Object.fromEntries(Object.entries(LIMITS).map(([key, limit]) => [key, (Array.isArray(input?.[key]) ? input[key].filter(value => typeof value === 'string').join('，') : typeof input?.[key] === 'string' ? input[key] : '').slice(0, limit)]));
}
function initialize() {
  if (current) return;
  try { const saved = JSON.parse(localStorage.getItem(KEY) || 'null'); current = normalizeWritingPreferences(saved?.preferences || saved || {}); remembered = Boolean(saved); }
  catch { current = normalizeWritingPreferences(); remembered = false; }
}
export function readWritingPreferences() { initialize(); return { ...current }; }
export function writingPreferencesRemembered() { initialize(); return remembered; }
export function saveWritingPreferences(input, { remember = true } = {}) {
  current = normalizeWritingPreferences(input); remembered = false;
  try { if (remember) { localStorage.setItem(KEY, JSON.stringify({ version: 1, preferences: current })); remembered = true; } else localStorage.removeItem(KEY); } catch {}
  return { preferences: { ...current }, remembered };
}
export function clearWritingPreferences() { current = normalizeWritingPreferences(); remembered = false; try { localStorage.removeItem(KEY); } catch {} return { ...current }; }
