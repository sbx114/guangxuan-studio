import { AppError } from './errors.mjs';

export const EDIT_LOOK_PRESETS = ['none', 'warm', 'cool', 'cinematic', 'soft', 'vivid', 'mono'];
export const EDIT_MOTION_PRESETS = ['none', 'push-in', 'pull-out', 'pan-left', 'pan-right'];

export function normalizeClipEffects(clip, { model = false } = {}) {
  const result = normalizeEditEffects({ timeline: [], ...(clip.look !== undefined ? { look: clip.look } : {}), ...(clip.fade !== undefined ? { fade: clip.fade } : {}) }, { model });
  const invalid = message => { throw new AppError(model ? 502 : 400, message, model ? 'MODEL_EFFECT_INVALID' : 'INVALID_EDIT_EFFECT'); };
  if (clip.framing !== undefined) {
    const value = clip.framing;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['mode', 'focusX', 'focusY'].includes(key)) || !['contain', 'cover'].includes(value.mode)) invalid('画面构图参数无效。');
    const x = value.focusX ?? .5, y = value.focusY ?? .5;
    if (![x, y].every(point => typeof point === 'number' && Number.isFinite(point) && point >= 0 && point <= 1)) invalid('画面焦点应为0至1的相对位置。');
    result.framing = { mode: value.mode, focusX: x, focusY: y };
  }
  if (clip.motion !== undefined) {
    const value = clip.motion;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['preset', 'amount', 'delay', 'duration'].includes(key)) || !EDIT_MOTION_PRESETS.includes(value.preset)) invalid('镜头运动不在可执行目录中。');
    const amount = value.amount ?? .08, delay = value.delay ?? 0;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > .25 || typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 30 || value.duration !== undefined && (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration < .001 || value.duration > 30)) invalid('镜头运动幅度或时间无效。');
    result.motion = { preset: value.preset, amount, delay, ...(value.duration !== undefined ? { duration: value.duration } : {}) };
  }
  return result;
}

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
