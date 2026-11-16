import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { Reveal, SceneHeading, SceneShell, clamp, fittedSize, smooth, useSceneStyle } from './shared.jsx';

export function BarsScene(props) {
  const { scene } = props;
  const { width, scale, portrait, palette } = useSceneStyle(props.theme);
  const frame = useCurrentFrame();
  const maximum = Math.max(1, ...scene.data.map((datum) => Math.abs(datum.value)));
  const hasNegative = scene.data.some((datum) => datum.value < 0);
  return <SceneShell {...props}>
    <SceneHeading scene={scene} width={width} palette={palette} scale={scale} portrait={portrait} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: (portrait ? 30 : 22) * scale }}>
      {scene.data.map((datum, index) => <Reveal key={index} delay={10 + index * 5} style={{ display: 'flex', flexDirection: 'column', gap: 10 * scale }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20 * scale, alignItems: 'baseline' }}>
          <span style={{ fontSize: fittedSize(datum.label, 26 * scale, width - (portrait ? 220 : 260) * scale, 1, 19 * scale), lineHeight: 1.3 }}>{datum.label}</span>
          <span style={{ fontSize: 28 * scale, fontVariantNumeric: 'tabular-nums', color: palette.muted }}>{datum.value.toLocaleString('zh-CN', { maximumFractionDigits: 3 })}</span>
        </div>
        <div style={{ height: 24 * scale, backgroundColor: palette.soft, position: 'relative' }}>
          {hasNegative && <div style={{ position: 'absolute', top: -3 * scale, bottom: -3 * scale, left: '50%', width: scale, backgroundColor: palette.muted }} />}
          <div style={{
            position: 'absolute', height: '100%', backgroundColor: palette.accent,
            width: `${interpolate(frame, [16 + index * 6, 56 + index * 6], [0, Math.abs(datum.value) / maximum * (hasNegative ? 50 : 100)], { ...clamp, easing: smooth })}%`,
            ...(hasNegative ? (datum.value < 0 ? { right: '50%' } : { left: '50%' }) : { left: 0 }),
          }} />
        </div>
      </Reveal>)}
    </div>
  </SceneShell>;
}
