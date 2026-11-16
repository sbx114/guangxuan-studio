import React from 'react';
import { AbsoluteFill, Composition, Sequence, interpolate, registerRoot, useCurrentFrame } from 'remotion';
import { animationDimensions, animationFrameCount } from './schema.mjs';
import { TitleScene } from './scenes/TitleScene.jsx';
import { StepsScene } from './scenes/StepsScene.jsx';
import { BarsScene } from './scenes/BarsScene.jsx';
import { QuoteScene } from './scenes/QuoteScene.jsx';
import { OutroScene } from './scenes/OutroScene.jsx';

const SCENES = { title: TitleScene, steps: StepsScene, bars: BarsScene, quote: QuoteScene, outro: OutroScene };
const DEFAULT_PLAN = { title: '新建动画', aspect: '16:9', fps: 30, theme: 'paper', scenes: [{ type: 'title', duration: 5, title: '让想法成为画面', subtitle: '光宣工作台', note: '' }] };

function Dissolve({ children, first, endFrames, last }) {
  const frame = useCurrentFrame();
  let opacity = first ? 1 : interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (last) opacity *= interpolate(frame, [endFrames - 10, endFrames - 1], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
}

function AnimatedPlan({ plan }) {
  let cursor = 0;
  return <AbsoluteFill style={{ backgroundColor: plan.theme === 'dark' ? '#151713' : '#e8e5e1' }}>
    {plan.scenes.map((scene, index) => {
      const start = cursor;
      const frames = Math.round(scene.duration * plan.fps);
      cursor += frames;
      const Scene = SCENES[scene.type];
      const last = index === plan.scenes.length - 1;
      return <Sequence key={index} from={start} durationInFrames={frames + (last ? 0 : 12)} name={scene.title}>
        <Dissolve first={index === 0} endFrames={frames} last={last}>
          <Scene scene={scene} index={index} count={plan.scenes.length} theme={plan.theme} />
        </Dissolve>
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
