import * as React from 'react';
import { placeRhythmBeats, type RhythmClip, type RhythmState } from '@/lib/music-rhythm';
/** Cyan automatic rhythm guides. Dashed, faint guides were inferred; manual marker pins remain separate. */
export function MusicRhythmLines({ state, clip, pxPerMs, top = 0 }: { state?: RhythmState; clip: RhythmClip; pxPerMs: number; top?: number }) {
  const points = React.useMemo(() => state?.value ? placeRhythmBeats(state.value, clip) : [], [state, clip.startMs, clip.endMs, clip.inMs, clip.speed, clip.sourceDurMs, clip.loop]);
  if (!points.length || state?.status === 'error' || state?.status === 'loading') return null;
  return <span data-music-rhythm-lines="" aria-label="自动音乐节奏点，非手工标记" className="pointer-events-none absolute inset-x-0 bottom-0 z-[5]" style={{ top }}>
    {points.map((beat, index) => <span key={`${beat.ms}:${index}`} data-rhythm-point={beat.ms} data-rhythm-kind={beat.inferred ? 'inferred' : 'measured'} className="absolute top-0 bottom-0" style={{ left: (beat.ms - clip.startMs) * pxPerMs, borderLeft: `${beat.inferred ? '1px dashed' : '1px solid'} #67e8f9`, opacity: state?.status === 'uncertain' ? .25 : Math.max(.3, beat.confidence) }} title={`节奏点 ${((beat.ms - clip.startMs) / 1000).toFixed(3)}s${beat.inferred ? ' · 推断补点' : ''}`} />)}
  </span>;
}
