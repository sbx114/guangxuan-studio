import { normalizeShotCues } from './source-analysis-cues.mjs';
import { DIRECTING_MOTION_SOURCE } from './remotion-directing-motion.mjs';

const text = (value, max = 500) => typeof value === 'string' ? value.replace(/\0/g, '').slice(0, max) : '';
const mechanisms = [
  { key: 'motion-signals', purpose: '由同一轨迹的历史位置派生头部、尾迹与跟随；方向证据来自实际前后帧', signals: /运动|流光|轨迹|粒子|汇聚|展开|收束|toward|away|paired-observation|motion|flow|trajectory/i },
  { key: 'whip-brake', purpose: '速度曲线积分控制位移；启动、主段、刹停、稳定使用同一进度', signals: /节奏|落定|快慢|速度|刹|镜头|电影|motion|camera|push|pull|pan|toward|away/i },
  { key: 'page-camera', purpose: '主体及标注共用世界坐标；不同深度响应不同相机位移，保持真实焦点', signals: /画面|构图|空间|层次|景深|特写|镜头|电影|close|detail|negativeSpace|camera|depth/i },
  { key: 'manifest-tracks', purpose: '镜头、文字、音轨和交接对应同一时间表，逐段可修改', signals: /画面|安排|剪辑|镜头|时间|素材|shot|cut|timing|edit/i },
  { key: 'type-assemble', purpose: '实测文字行宽、共同基线及主词锚点；不以通用弹入替代排版', signals: /文字|排版|标题|字幕|baseline|title|text/i },
];

/** Compact, typed source cues stay material facts; this step performs no analysis. */
export function directingMaterialCues(input) {
  const known = new Set((input.assets || []).map(asset => asset.assetId)), result = [], seen = new Set();
  for (const item of input.sourceAnalysis?.items || []) {
    if (!known.has(item.assetId) || item.summary?.kind !== 'visual-sampled') continue;
    for (const shot of item.shots || []) {
      const cue = normalizeShotCues(shot.cues, { shot, frames: item.frames || [], clean: value => text(value, 500) });
      if (!cue) continue;
      const id = `${item.assetId}:${cue.id}`; if (seen.has(id)) continue; seen.add(id);
      result.push({ ...cue, id, assetId: item.assetId, shotId: shot.id, name: text(item.name, 120), ...(item.pagination ? { analysisPage: item.pagination } : {}),
        subjects: cue.subjects.slice(0, 3), composition: { ...cue.composition, focus: text(cue.composition.focus, 220) }, motion: { ...cue.motion, description: text(cue.motion.description, 220) },
        usableSegments: cue.usableSegments.slice(0, 2).map(segment => ({ ...segment, rationale: text(segment.rationale, 180) })), uncertainties: cue.uncertainties.slice(0, 2).map(value => text(value, 180)) });
    }
  }
  const spread = count => Array.from({ length: count }, (_, index) => result[Math.round(index * (result.length - 1) / Math.max(1, count - 1))]);
  let selected = result.length > 24 ? spread(24) : result;
  while (JSON.stringify(selected).length > 24000 && selected.length > 1) selected = spread(Math.ceil(selected.length / 2));
  return selected;
}
export function directingCueText(input) {
  return directingMaterialCues(input).map(cue => [cue.subjects.map(subject => `${subject.role} ${subject.label} ${subject.position}`).join(' '),
    cue.composition.shotSize, cue.composition.negativeSpace, cue.composition.focus,
    cue.motion.status, cue.motion.direction, cue.motion.camera, cue.motion.description,
    ...cue.usableSegments.map(segment => `${segment.purpose} ${segment.rationale}`)].join(' ')).join('\n').slice(0, 12000);
}

function existingShots(input) {
  const found = (input.existingProject?.files || []).find(file => file.path === 'shot-plan.json');
  if (!found || found.content.length > 50000) return [];
  try {
    const plan = JSON.parse(found.content);
    return (Array.isArray(plan.shots) ? plan.shots : []).slice(0, 24).map(shot => ({ id: text(shot.id, 120), start: shot.start, end: shot.end,
      intent: text(shot.intent), hero: text(shot.hero), layout: text(shot.layout), action: text(shot.action), actionEnd: shot.actionEnd,
      hold: shot.hold && typeof shot.hold === 'object' ? { start: shot.hold.start, duration: shot.hold.duration } : undefined,
      transition: shot.transition && typeof shot.transition === 'object' ? { description: text(shot.transition.description), duration: shot.transition.duration } : undefined,
      materialEvidence: Array.isArray(shot.materialEvidence) ? shot.materialEvidence.slice(0, 8) : [], implementation: shot.implementation }));
  } catch { return []; }
}

/** Extends the existing shot-plan contract, without imposing a scene menu. */
export function buildRemotionDirectingContext(input) {
  const cues = directingMaterialCues(input), cueText = directingCueText(input);
  const request = [text(input.instruction, 16000), text(input.script, 30000), cueText].join('\n');
  const supplied = new Map((input.references || []).map(reference => [reference.key, reference]));
  const bindings = mechanisms.filter(mechanism => mechanism.signals.test(request) || supplied.has(mechanism.key)).map(mechanism => ({ key: mechanism.key, purpose: mechanism.purpose,
    sourceSupplied: supplied.has(mechanism.key), ...(supplied.get(mechanism.key)?.sourceMetadata ? { source: supplied.get(mechanism.key).sourceMetadata } : {}) }));
  return {
    mode: input.existingProject ? 'refine-current-source' : 'design-from-material',
    materialCues: cues, cueCoverage: { returned: cues.length, maxCues: 24, maxChars: 24000, note: '导演cue是已有sourceAnalysis的有界子集；更多观察保留在原分析上下文，不能把未列区间当已看。' }, existingShots: existingShots(input), mechanisms: bindings,
    cueToShot: ['从可追溯cue选可用段和主要主体；technical数据不推断画面动作', 'intent说明此镜新增的关系或状态，hero指定第一视觉焦点',
      'layout按素材主次、负空间和画幅安排主视觉/必要文字/背景层', 'action只选一个主变化，camera解释为何改变观察位置或尺度',
      'actionEnd、hold、transition共用实际帧时间表，materialEvidence引用cue.id及真实帧证据'],
    choreography: {
      direction: '入射/汇聚时亮头沿正向轨迹到达目标，尾迹只采样过去位置并渐暗；同时间的向外展开不能遮蔽入射方向。到达响应与后续展开分阶段。',
      camera: '观察对象、标注和落点共用世界坐标；相机改变焦点/尺度应有信息理由。近、中、远层有不同位移、遮挡和明暗，不能用相同全局缩放冒充空间层次。',
      speed: '预备、启动、主速度、减速落定、稳定和交接分段；运动附属效果由同一轨迹速度派生，不同期全局sin/cos扰动全部主体。',
      light: '主要动作的局部高光和轨迹亮度优先；宽域模糊辉光不能抹掉轮廓、遮挡关系或主次。',
      handoff: '前镜状态/运动方向/焦点给后镜可见接点；为意义变化选择剪辑点，不能只因句子结束而换同构文字卡。',
    },
    timebase: { unit: 'Composition seconds; code uses integer frames', planFields: ['start', 'end', 'actionEnd', 'hold.start', 'hold.duration', 'transition.duration', 'qaTimes'],
      qa: ['同动作早段和推进段', '同一hold前后', '同一交接点两侧', '片尾淡出前与实际最终帧'],
      note: '同一组常量驱动Sequence、相机、主动作、字幕、转场；源素材绝对秒与Composition秒显式映射。没有听取成功音轨时不宣称拍点同步。' },
    parameterContract: { path: 'shot.implementation.parameters', examples: ['focus point/region', 'foreground/subject/background depth and bounds', 'trajectory control points and direction', 'camera from/to or keys'],
      note: '使用本片自己命名的参数；几何、层深、轨迹、相机和布局应从这个实际源码共用对象读取，而非计划写一组、组件硬编码另一组。示例不是固定镜头或必填菜单；注明world pixels或normalized units并按实际画布换算。' },
    reusableMotion: { suggestedPath: 'src/production-motion.js', exports: ['makeSpeedTrack', 'makePathTrack', 'trajectoryStateAt', 'worldToScreen', 'cameraAt', 'shotTimingFrames'],
      code: DIRECTING_MOTION_SOURCE, usage: '可把需要的完整函数适配到本工程并保留出处；不是场景模板或强制依赖，所有主体/轨迹/取景/时间参数仍由当前材料与要求决定。' },
    limitations: 'materialCues仅是已有离散观察；可用段仍需实际预览。没有cue时可以依用户明确说明原创设计，但不补造素材语义。计划与代码仅表达意图，实际采样画面另行验证。',
  };
}
