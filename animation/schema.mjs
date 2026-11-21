const TYPES = new Set(['title', 'steps', 'bars', 'quote', 'outro']);

export const ANIMATION_STYLE_CHOICES = Object.freeze({
  palette: Object.freeze(['original', 'ocean', 'amber', 'plum']),
  font: Object.freeze(['original', 'sans', 'serif', 'mono']),
  reveal: Object.freeze(['original', 'fade', 'rise', 'mask', 'typewriter']),
  pace: Object.freeze(['calm', 'normal', 'brisk']),
  easing: Object.freeze(['smooth', 'linear', 'out', 'inOut']),
  camera: Object.freeze(['none', 'push', 'pan-left', 'pan-right']),
  transition: Object.freeze(['original', 'cut', 'fade', 'wipe']),
});

export const SCENE_MOTION_DEFAULTS = Object.freeze({ reveal: 'original', pace: 'normal', easing: 'smooth', camera: 'none', amount: .5, transition: 'original', transitionDuration: .4 });

function styleObject(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label}含不支持的参数。`);
}
function choice(value, key, label) {
  if (typeof value !== 'string' || !ANIMATION_STYLE_CHOICES[key].includes(value)) throw new Error(`${label}不正确。`);
  return value;
}
export function validateAnimationBrand(value) {
  styleObject(value, '品牌风格', ['palette', 'font', 'background', 'ink', 'accent']);
  const result = {};
  for (const [key, label] of [['palette', '配色预设'], ['font', '字体预设']]) if (value[key] !== undefined) result[key] = choice(value[key], key, label);
  for (const [key, label] of [['background', '背景色'], ['ink', '文字色'], ['accent', '强调色']]) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || !/^#[a-f0-9]{6}$/i.test(value[key])) throw new Error(`${label}需要六位十六进制颜色。`);
    result[key] = value[key].toLowerCase();
  }
  return result;
}
export function validateSceneMotion(value) {
  styleObject(value, '场景动效', [...Object.keys(SCENE_MOTION_DEFAULTS)]);
  const result = {};
  for (const key of ['reveal', 'pace', 'easing', 'camera', 'transition']) if (value[key] !== undefined) result[key] = choice(value[key], key, '场景动效参数');
  for (const [key, min, max] of [['amount', 0, 1], ['transitionDuration', .1, 1]]) if (value[key] !== undefined) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < min || value[key] > max) throw new Error(key === 'amount' ? '镜头运动幅度应为0至1。' : '转场时长应为0.1至1秒。');
    result[key] = key === 'transitionDuration' ? Math.round(value[key] * 30) / 30 : value[key];
  }
  return result;
}

function cleanText(value, field, limit, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field}不能为空。`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${field}必须是文字。`);
  const text = value.trim();
  if ((required && !text) || text.length > limit) throw new Error(`${field}长度不符合要求。`);
  return text;
}

export function validateAnimationPlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('动画方案格式不正确。');
  if (!['16:9', '9:16', '1:1'].includes(input.aspect)) throw new Error('动画比例只支持 16:9、9:16 或 1:1。');
  if (input.fps !== 30) throw new Error('首版动画使用 30 fps。');
  if (!['paper', 'dark'].includes(input.theme)) throw new Error('动画主题不正确。');
  if (!Array.isArray(input.scenes) || input.scenes.length < 1 || input.scenes.length > 8)
    throw new Error('动画需要 1 至 8 个场景。');
  let totalDuration = 0;
  const scenes = input.scenes.map((scene, index) => {
    if (!scene || typeof scene !== 'object' || !TYPES.has(scene.type)) throw new Error(`第 ${index + 1} 场模板不正确。`);
    const duration = Number(scene.duration);
    if (!Number.isFinite(duration) || duration < 3 || duration > 12) throw new Error('每场动画时长应为 3 至 12 秒。');
    const exactDuration = Math.round(duration * 30) / 30;
    totalDuration += exactDuration;
    const result = {
      type: scene.type, duration: exactDuration,
      title: cleanText(scene.title, '场景标题', 140, true),
      subtitle: cleanText(scene.subtitle, '副标题', 240),
      note: cleanText(scene.note, '注释', 200),
    };
    if (scene.items !== undefined) {
      if (!Array.isArray(scene.items) || scene.items.length > 6) throw new Error('步骤最多 6 项。');
      result.items = scene.items.map((item) => cleanText(item, '步骤文字', 120, true));
    }
    if (scene.type === 'steps' && !result.items?.length) throw new Error('步骤场景至少需要一个步骤。');
    if (scene.data !== undefined) {
      if (!Array.isArray(scene.data) || scene.data.length > 6) throw new Error('数据条最多 6 项。');
      result.data = scene.data.map((item) => {
        if (!item || typeof item !== 'object' || typeof item.value !== 'number' || !Number.isFinite(item.value) || Math.abs(item.value) > 1e12)
          throw new Error('数据条需要有限的真实数值。');
        return { label: cleanText(item.label, '数据标签', 60, true), value: item.value };
      });
    }
    if (scene.type === 'bars' && !result.data?.length) throw new Error('数据条场景至少需要一条数据。');
    if (scene.motion !== undefined) result.motion = validateSceneMotion(scene.motion);
    return result;
  });
  if (totalDuration > 90) throw new Error('动画总时长不能超过 90 秒。');
  const result = {
    title: cleanText(input.title, '作品名称', 160, true),
    aspect: input.aspect, fps: 30, theme: input.theme, scenes,
  };
  if (input.brand !== undefined) result.brand = validateAnimationBrand(input.brand);
  return result;
}

export function animationDimensions(aspect) {
  if (aspect === '9:16') return { width: 720, height: 1280 };
  if (aspect === '1:1') return { width: 960, height: 960 };
  return { width: 1280, height: 720 };
}

export function animationFrameCount(plan) {
  return plan.scenes.reduce((total, scene) => total + Math.round(scene.duration * plan.fps), 0);
}

export function sceneMotion(scene) { return { ...SCENE_MOTION_DEFAULTS, ...(scene.motion || {}) }; }

/** Absolute project frames remain the only clock, including random/backward seeks. */
export function animationSchedule(plan) {
  let startFrame = 0;
  return plan.scenes.map((scene, index) => {
    const durationInFrames = Math.round(scene.duration * plan.fps), from = startFrame;
    startFrame += durationInFrames;
    return { index, startFrame: from, endFrame: startFrame, durationInFrames, start: from / plan.fps, end: startFrame / plan.fps, duration: durationInFrames / plan.fps, label: scene.title };
  });
}
