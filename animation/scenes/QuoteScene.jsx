import React from 'react';
import { Reveal, SceneShell, fittedSize, useSceneStyle } from './shared.jsx';

export function QuoteScene(props) {
  const { scene } = props;
  const { width, scale, portrait, palette } = useSceneStyle(props.theme);
  return <SceneShell {...props}>
    <Reveal delay={2} style={{ fontFamily: 'Georgia, serif', height: 82 * scale, fontSize: 146 * scale, lineHeight: 1, color: palette.accent }}>“</Reveal>
    <Reveal delay={10} distance={26 * scale} style={{
      fontSize: fittedSize(scene.title, (portrait ? 62 : 76) * scale, width - (portrait ? 104 : 144) * scale, portrait ? 7 : 4, 32 * scale),
      lineHeight: 1.4, fontWeight: 500, letterSpacing: -1 * scale, overflowWrap: 'anywhere',
    }}>{scene.title}</Reveal>
    {scene.subtitle && <Reveal delay={24} style={{ marginTop: 36 * scale, color: palette.muted, borderLeft: `${3 * scale}px solid ${palette.accent}`, paddingLeft: 22 * scale, fontSize: 25 * scale, lineHeight: 1.5 }}>{scene.subtitle}</Reveal>}
  </SceneShell>;
}
