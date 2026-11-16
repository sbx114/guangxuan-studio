const TYPES = new Set(['title', 'steps', 'bars', 'quote', 'outro']);

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
    return result;
  });
  if (totalDuration > 90) throw new Error('动画总时长不能超过 90 秒。');
  return {
    title: cleanText(input.title, '作品名称', 160, true),
    aspect: input.aspect, fps: 30, theme: input.theme, scenes,
  };
}

export function animationDimensions(aspect) {
  if (aspect === '9:16') return { width: 720, height: 1280 };
  if (aspect === '1:1') return { width: 960, height: 960 };
  return { width: 1280, height: 720 };
}

export function animationFrameCount(plan) {
  return plan.scenes.reduce((total, scene) => total + Math.round(scene.duration * plan.fps), 0);
}
