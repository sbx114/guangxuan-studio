import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { MaskReveal, Reveal, SceneHeading, SceneShell, clamp, fittedSize, smooth, useSceneStyle } from './shared.jsx';

export function StepsScene(props) {
  const { scene } = props;
  const { width, height, scale, portrait, palette } = useSceneStyle(props.theme);
  const frame = useCurrentFrame();
  const contentWidth = width - (portrait ? 104 : 144) * scale;
  const rowHeight = Math.min((height - 294 * scale) / scene.items.length, (portrait ? 142 : 97) * scale);
  return <SceneShell {...props}>
    <SceneHeading scene={scene} width={width} palette={palette} scale={scale} portrait={portrait} />
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {scene.items.map((item, index) => <div key={index} style={{ position: 'relative', display: 'grid', gridTemplateColumns: `${62 * scale}px 1fr ${10 * scale}px`, alignItems: 'center', minHeight: rowHeight, gap: 18 * scale, padding: `${12 * scale}px 0`, boxSizing: 'border-box' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 1, backgroundColor: palette.line, transformOrigin: 'left', scale: `${interpolate(frame, [7 + index * 4, 32 + index * 4], [0, 1], { ...clamp, easing: smooth })} 1` }} />
        <Reveal delay={10 + index * 4} distance={9 * scale} style={{ fontSize: 30 * scale, color: palette.muted, fontVariantNumeric: 'tabular-nums', fontWeight: 300 }}>{String(index + 1).padStart(2, '0')}</Reveal>
        <MaskReveal delay={10 + index * 4} duration={22} color={palette.accent} style={{ fontSize: fittedSize(item, 30 * scale, contentWidth - 108 * scale, Math.max(2, Math.floor((rowHeight - 14 * scale) / (30 * scale))), 20 * scale), lineHeight: 1.45, overflowWrap: 'anywhere' }}>{item}</MaskReveal>
        <span style={{ width: 5 * scale, height: 5 * scale, backgroundColor: palette.brass, opacity: interpolate(frame, [26 + index * 4, 34 + index * 4], [0, 1], clamp) }} />
      </div>)}
    </div>
  </SceneShell>;
}
