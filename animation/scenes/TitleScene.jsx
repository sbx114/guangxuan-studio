import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { Reveal, SceneShell, clamp, fittedSize, smooth, useSceneStyle } from './shared.jsx';

export function TitleScene(props) {
  const { scene } = props;
  const { width, scale, portrait, palette } = useSceneStyle(props.theme);
  const frame = useCurrentFrame();
  return <SceneShell {...props}>
    <div style={{ marginBottom: 34 * scale, width: 74 * scale, height: 5 * scale, backgroundColor: palette.accent, scale: `${interpolate(frame, [0, 28], [0, 1], { ...clamp, easing: smooth })} 1`, transformOrigin: 'left' }} />
    <Reveal delay={5} distance={42 * scale} style={{ maxWidth: '100%', position: 'relative' }}>
      <div style={{ fontWeight: 700, letterSpacing: -2 * scale, lineHeight: 1.15, overflowWrap: 'anywhere', fontSize: fittedSize(scene.title, (portrait ? 76 : 104) * scale, width - (portrait ? 104 : 144) * scale, 3, 38 * scale) }}>{scene.title}</div>
    </Reveal>
    {scene.subtitle && <Reveal delay={16} style={{ marginTop: 32 * scale, color: palette.muted, fontSize: 29 * scale, lineHeight: 1.65, maxWidth: portrait ? '100%' : '84%' }}>{scene.subtitle}</Reveal>}
  </SceneShell>;
}
