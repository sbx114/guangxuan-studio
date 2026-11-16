import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { MaskReveal, OpticalArchive, Reveal, SceneShell, clamp, fittedSize, smooth, useSceneStyle } from './shared.jsx';

export function TitleScene(props) {
  const { scene, index } = props;
  const { width, scale, portrait, palette } = useSceneStyle(props.theme);
  const frame = useCurrentFrame();
  const contentWidth = width - (portrait ? 104 : 144) * scale;
  const textWidth = portrait ? contentWidth : contentWidth * 0.57;
  return <SceneShell {...props}>
    <div style={{ display: 'grid', gridTemplateColumns: portrait ? '1fr' : '1.18fr 0.82fr', alignItems: 'center', gap: (portrait ? 26 : 16) * scale }}>
      <div style={{ minWidth: 0, order: portrait ? 2 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 * scale, marginBottom: 30 * scale }}><i style={{ width: 7 * scale, height: 7 * scale, backgroundColor: palette.brass }} /><span style={{ height: 1, width: 110 * scale, backgroundColor: palette.muted, transformOrigin: 'left', scale: `${interpolate(frame, [0, 24], [0, 1], { ...clamp, easing: smooth })} 1` }} /></div>
        <MaskReveal delay={5} duration={28} color={palette.ink} style={{ fontWeight: 700, letterSpacing: -1.6 * scale, lineHeight: 1.22, overflowWrap: 'anywhere', fontSize: fittedSize(scene.title, (portrait ? 72 : 85) * scale, textWidth, 3, 34 * scale) }}>{scene.title}</MaskReveal>
        {scene.subtitle && <Reveal delay={24} distance={14 * scale} style={{ marginTop: 30 * scale, color: palette.muted, fontSize: fittedSize(scene.subtitle, 27 * scale, textWidth, 3, 19 * scale), lineHeight: 1.7 }}>{scene.subtitle}</Reveal>}
      </div>
      <div style={{ height: (portrait ? 350 : 458) * scale, width: portrait ? 355 * scale : '100%', justifySelf: 'center', order: portrait ? 1 : 0 }}><OpticalArchive theme={props.theme} index={index} /></div>
    </div>
  </SceneShell>;
}
