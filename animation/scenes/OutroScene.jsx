import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { Reveal, SceneShell, clamp, fittedSize, smooth, useSceneStyle } from './shared.jsx';

export function OutroScene(props) {
  const { scene } = props;
  const { width, scale, portrait, palette } = useSceneStyle(props.theme);
  const frame = useCurrentFrame();
  return <SceneShell {...props}>
    <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingBottom: 20 * scale }}>
      <div style={{ width: 72 * scale, height: 72 * scale, borderRadius: '50%', border: `${2 * scale}px solid ${palette.accent}`, marginBottom: 40 * scale, scale: interpolate(frame, [0, 35], [0.7, 1], { ...clamp, easing: smooth }), opacity: interpolate(frame, [0, 20], [0, 1], clamp) }} />
      <Reveal delay={8} style={{ fontSize: fittedSize(scene.title, (portrait ? 70 : 86) * scale, width - (portrait ? 104 : 144) * scale, 3, 34 * scale), fontWeight: 700, lineHeight: 1.25, overflowWrap: 'anywhere' }}>{scene.title}</Reveal>
      {scene.subtitle && <Reveal delay={22} style={{ marginTop: 30 * scale, fontSize: 28 * scale, lineHeight: 1.6, color: palette.muted, maxWidth: '90%' }}>{scene.subtitle}</Reveal>}
    </div>
  </SceneShell>;
}
