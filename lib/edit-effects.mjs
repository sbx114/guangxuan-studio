import { AppError } from './errors.mjs';

export const EDIT_LOOK_PRESETS = ['none', 'warm', 'cool', 'cinematic', 'soft', 'vivid', 'mono'];

/** Only declarative, bounded effects cross the model-to-editor boundary. */
export function normalizeEditEffects(plan, { model = false } = {}) {
  const invalid = () => { throw new AppError(model ? 502 : 400, '滤镜或淡入淡出参数无效，未改动工程。', model ? 'MODEL_EFFECT_INVALID' : 'INVALID_EDIT_EFFECT'); };
  const result = {};
  if (plan.look !== undefined) {
    const value = plan.look;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !EDIT_LOOK_PRESETS.includes(value.preset)) invalid();
    const strength = value.strength === undefined ? 1 : Number(value.strength);
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) invalid();
    result.look = { preset: value.preset, strength };
  }
  if (plan.fade !== undefined) {
    const value = plan.fade;
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const duration = Number(value.duration);
    if (!Number.isFinite(duration) || duration < 0 || duration > 1.5) invalid();
    result.fade = { duration };
  }
  if ((result.look || result.fade) && !Array.isArray(plan.timeline)) invalid();
  return result;
}
