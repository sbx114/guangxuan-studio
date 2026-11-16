import React from 'react';
import { Reveal, SceneHeading, SceneShell, fittedSize, useSceneStyle } from './shared.jsx';

export function StepsScene(props) {
  const { scene } = props;
  const { width, height, scale, portrait, palette } = useSceneStyle(props.theme);
  const contentWidth = width - (portrait ? 104 : 144) * scale;
  const rowHeight = Math.min((height - 280 * scale) / scene.items.length, (portrait ? 146 : 98) * scale);
  return <SceneShell {...props}>
    <SceneHeading scene={scene} width={width} palette={palette} scale={scale} portrait={portrait} />
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {scene.items.map((item, index) => <Reveal key={index} delay={12 + index * 7} distance={18 * scale} style={{
        display: 'grid', gridTemplateColumns: `${64 * scale}px 1fr`, alignItems: 'center',
        minHeight: rowHeight, borderTop: `${1 * scale}px solid ${palette.line}`, gap: 20 * scale, padding: `${12 * scale}px 0`, boxSizing: 'border-box',
      }}>
        <div style={{ fontSize: 34 * scale, color: palette.muted, fontVariantNumeric: 'tabular-nums', fontWeight: 300 }}>{String(index + 1).padStart(2, '0')}</div>
        <div style={{ fontSize: fittedSize(item, 31 * scale, contentWidth - 84 * scale, Math.max(2, Math.floor((rowHeight - 14 * scale) / (30 * scale))), 20 * scale), lineHeight: 1.45, overflowWrap: 'anywhere' }}>{item}</div>
      </Reveal>)}
    </div>
  </SceneShell>;
}
