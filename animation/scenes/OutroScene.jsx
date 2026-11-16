import React from 'react';
import { MaskReveal, OpticalArchive, Reveal, SceneShell, fittedSize, useSceneStyle } from './shared.jsx';

export function OutroScene(props) {
  const { scene, index } = props;
  const { width, scale, portrait, palette } = useSceneStyle(props.theme);
  const contentWidth = width - (portrait ? 104 : 144) * scale;
  const textWidth = portrait ? contentWidth : contentWidth * 0.6;
  return <SceneShell {...props}>
    <div style={{ display: 'grid', gridTemplateColumns: portrait ? '1fr' : '0.7fr 1.3fr', gap: 34 * scale, alignItems: 'center' }}>
      <div style={{ height: (portrait ? 320 : 366) * scale, width: portrait ? 292 * scale : '100%', justifySelf: 'center' }}><OpticalArchive theme={props.theme} index={index} mode="seal" /></div>
      <div>
        <Reveal delay={3} style={{ display: 'flex', gap: 12 * scale, alignItems: 'center', marginBottom: 26 * scale }}><i style={{ width: 6 * scale, height: 6 * scale, backgroundColor: palette.brass }} /><span style={{ display: 'block', width: 88 * scale, height: 1, backgroundColor: palette.line }} /></Reveal>
        <MaskReveal delay={8} duration={28} color={palette.ink} style={{ fontSize: fittedSize(scene.title, (portrait ? 65 : 78) * scale, textWidth, 3, 32 * scale), fontWeight: 650, lineHeight: 1.28, letterSpacing: -1.2 * scale, overflowWrap: 'anywhere' }}>{scene.title}</MaskReveal>
        {scene.subtitle && <Reveal delay={26} distance={13 * scale} style={{ marginTop: 30 * scale, fontSize: fittedSize(scene.subtitle, 26 * scale, textWidth, 3, 18 * scale), lineHeight: 1.7, color: palette.muted }}>{scene.subtitle}</Reveal>}
      </div>
    </div>
  </SceneShell>;
}
