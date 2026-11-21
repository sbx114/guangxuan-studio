import React from 'react';
import { AbsoluteFill, Composition, Sequence, interpolate, registerRoot, useCurrentFrame } from 'remotion';
import { animationDimensions, animationFrameCount, animationSchedule, sceneMotion } from './schema.mjs';
import { animationPalette } from './styles.mjs';
import { SceneStyleContext, clamp, useSceneEasing } from './scenes/shared.jsx';
import { TitleScene } from './scenes/TitleScene.jsx';
import { StepsScene } from './scenes/StepsScene.jsx';
import { BarsScene } from './scenes/BarsScene.jsx';
import { QuoteScene } from './scenes/QuoteScene.jsx';
import { OutroScene } from './scenes/OutroScene.jsx';

const SCENES = { title: TitleScene, steps: StepsScene, bars: BarsScene, quote: QuoteScene, outro: OutroScene };
const DEFAULT_PLAN = { title: '新建动画', aspect: '16:9', fps: 30, theme: 'paper', scenes: [{ type: 'title', duration: 5, title: '让想法成为画面', subtitle: '光宣工作台', note: '' }] };

function Dissolve({ children, first, endFrames, last, motion }) {
  const frame = useCurrentFrame();
  const easing = useSceneEasing(), duration = Math.max(1, Math.round(motion.transitionDuration * 30));
  let opacity = first && motion.transition === 'original' || ['cut', 'wipe'].includes(motion.transition) ? 1 : interpolate(frame, [0, duration], [0, 1], { ...clamp, ...(motion.transition === 'original' ? {} : { easing }) });
  if (last) opacity *= interpolate(frame, [endFrames - 10, endFrames - 1], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ opacity, ...(motion.transition === 'wipe' ? { clipPath: `inset(0 ${interpolate(frame, [0, duration], [100, 0], { ...clamp, easing })}% 0 0)` } : {}) }}>{children}</AbsoluteFill>;
}

function MotionCamera({ children, motion, durationInFrames, width }) {
  const frame = useCurrentFrame(), easing = useSceneEasing();
  if (motion.camera === 'none' || motion.amount === 0) return children;
  return <AbsoluteFill style={{ overflow: 'hidden' }}><AbsoluteFill style={{
    scale: motion.camera === 'push' ? interpolate(frame, [0, durationInFrames - 1], [1, 1 + .05 * motion.amount], { ...clamp, easing, output: 'perceptual-scale' }) : 1 + .05 * motion.amount,
    ...(motion.camera.startsWith('pan-') ? { translate: `${interpolate(frame, [0, durationInFrames - 1], motion.camera === 'pan-left' ? [.01 * width * motion.amount, -.01 * width * motion.amount] : [-.01 * width * motion.amount, .01 * width * motion.amount], { ...clamp, easing })}px 0` } : {}),
  }}>{children}</AbsoluteFill></AbsoluteFill>;
}

function AnimatedPlan({ plan }) {
  const projectFrame = useCurrentFrame(), schedule = animationSchedule(plan), dimensions = animationDimensions(plan.aspect);
  const branded = plan.brand && (plan.brand.background || plan.brand.ink || plan.brand.accent || plan.brand.palette && plan.brand.palette !== 'original');
  return <AbsoluteFill style={{ backgroundColor: branded ? animationPalette(plan.theme, plan.brand).background : plan.theme === 'dark' ? '#151713' : '#e8e5e1' }}>
    {plan.scenes.map((scene, index) => {
      const { startFrame: start, durationInFrames: frames } = schedule[index], motion = sceneMotion(scene);
      const Scene = SCENES[scene.type];
      const last = index === plan.scenes.length - 1;
      const next = last ? null : sceneMotion(plan.scenes[index + 1]), overlap = !next || next.transition === 'cut' ? 0 : Math.round(next.transitionDuration * 30);
      return <Sequence key={index} from={start} durationInFrames={frames + overlap} name={scene.title}>
        <SceneStyleContext.Provider value={{ brand: plan.brand || null, motion, projectFrame, startFrame: start, durationInFrames: frames }}>
          <Dissolve first={index === 0} endFrames={frames} last={last} motion={motion}>
            <MotionCamera motion={motion} durationInFrames={frames} width={dimensions.width}><Scene scene={scene} index={index} count={plan.scenes.length} theme={plan.theme} /></MotionCamera>
          </Dissolve>
        </SceneStyleContext.Provider>
      </Sequence>;
    })}
  </AbsoluteFill>;
}

function RemotionRoot() {
  return <Composition id="GuangxuanAnimation" component={AnimatedPlan}
    durationInFrames={150} fps={30} width={1280} height={720}
    defaultProps={{ plan: DEFAULT_PLAN }}
    calculateMetadata={({ props }) => ({ durationInFrames: animationFrameCount(props.plan), fps: props.plan.fps, ...animationDimensions(props.plan.aspect) })}
  />;
}

registerRoot(RemotionRoot);
