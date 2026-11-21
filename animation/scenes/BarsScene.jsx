import React from 'react';
import { interpolate } from 'remotion';
import { Reveal, SceneHeading, SceneShell, clamp, fittedSize, useSceneEasing, useSceneFrame, useSceneStyle } from './shared.jsx';

export function BarsScene(props) {
  const { scene } = props;
  const { width, scale, portrait, palette } = useSceneStyle(props.theme);
  const frame = useSceneFrame(), motionEasing = useSceneEasing();
  const maximum = Math.max(1, ...scene.data.map((datum) => Math.abs(datum.value)));
  const hasNegative = scene.data.some((datum) => datum.value < 0);
  return <SceneShell {...props}>
    <SceneHeading scene={scene} width={width} palette={palette} scale={scale} portrait={portrait} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: (portrait ? 31 : 25) * scale }}>
      {scene.data.map((datum, index) => {
        const extent = interpolate(frame, [20 + index * 5, 54 + index * 5], [0, Math.abs(datum.value) / maximum * (hasNegative ? 50 : 100)], { ...clamp, easing: motionEasing });
        const tip = hasNegative ? 50 + (datum.value < 0 ? -extent : extent) : extent;
        return <Reveal key={index} delay={11 + index * 4} distance={9 * scale} style={{ display: 'flex', flexDirection: 'column', gap: 12 * scale }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20 * scale, alignItems: 'baseline' }}><span style={{ fontSize: fittedSize(datum.label, 25 * scale, width - (portrait ? 220 : 260) * scale, 1, 19 * scale), lineHeight: 1.3 }}>{datum.label}</span><span style={{ fontSize: 29 * scale, fontVariantNumeric: 'tabular-nums', color: palette.muted, fontWeight: 300 }}>{datum.value.toLocaleString('zh-CN', { maximumFractionDigits: 3 })}</span></div>
          <div style={{ height: 24 * scale, backgroundColor: palette.glass, position: 'relative', borderTop: `1px solid ${palette.line}`, borderBottom: `1px solid ${palette.line}` }}>
            {Array.from({ length: 9 }, (_, tick) => <i key={tick} style={{ position: 'absolute', bottom: -5 * scale, height: 4 * scale, width: 1, left: `${tick * 12.5}%`, backgroundColor: palette.line }} />)}
            {hasNegative && <div style={{ position: 'absolute', top: -4 * scale, bottom: -5 * scale, left: '50%', width: 1, backgroundColor: palette.muted }} />}
            <div style={{ position: 'absolute', top: 3 * scale, bottom: 3 * scale, backgroundColor: palette.accent, width: `${extent}%`, ...(hasNegative ? (datum.value < 0 ? { right: '50%' } : { left: '50%' }) : { left: 0 }) }} />
            <i style={{ position: 'absolute', left: `calc(${tip}% - ${1.5 * scale}px)`, top: -3 * scale, width: 3 * scale, height: 30 * scale, backgroundColor: palette.brass, opacity: interpolate(frame, [22 + index * 5, 30 + index * 5], [0, 1], clamp) }} />
          </div>
        </Reveal>;
      })}
    </div>
  </SceneShell>;
}
