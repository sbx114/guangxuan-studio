import * as React from 'react';
import { readMusicRhythm, type RhythmState } from '@/lib/music-rhythm';
import type { TimelineBlock } from '@/lib/timeline-layout';
export const rhythmSound = (block: TimelineBlock) => ['music', 'voice', 'sfx'].includes(block.kind) && Boolean(block.src) && !block.noLength;
/** No marker writes. A new source URL, project or requested range invalidates every late response. */
export function useMusicRhythm(projectId: string, blocks: readonly TimelineBlock[], waveUrl: (src: string) => string) {
  const [states, setStates] = React.useState<ReadonlyMap<string, RhythmState>>(new Map());
  const [generation, setGeneration] = React.useState(0);
  const usedGeneration = React.useRef(0);
  const requests = React.useMemo(() => blocks.filter(rhythmSound).map(block => {
    const url = new URL(waveUrl(block.src!), location.origin); url.searchParams.set('what', 'rhythm');
    if ((block.sourceDurMs || 0) > 600000) {
      const from = Math.max(0, block.inMs || 0) / 1000, to = Math.min(block.sourceDurMs! / 1000, from + (block.endMs - block.startMs) * (block.speed || 1) / 1000);
      url.searchParams.set('from', String(from)); url.searchParams.set('to', String(to));
    }
    return { id: block.id, url: url.href };
  }), [blocks, waveUrl]);
  const signature = JSON.stringify(requests);
  React.useEffect(() => {
    let alive = true; const controller = new AbortController(), grouped = new Map<string, string[]>(), fresh = generation !== usedGeneration.current;
    usedGeneration.current = generation;
    for (const request of requests) grouped.set(request.url, [...(grouped.get(request.url) || []), request.id]);
    setStates(new Map(requests.map(request => [request.id, { status: 'loading' } as RhythmState])));
    const entries = [...grouped]; let cursor = 0;
    const worker = async () => { while (alive && cursor < entries.length) {
      const [rawUrl, ids] = entries[cursor++], url = new URL(rawUrl); if (fresh) url.searchParams.set('fresh', '1');
      let state: RhythmState;
      try {
        if (url.origin !== location.origin) throw new Error('请先将音乐收集到当前本地工程。');
        const response = await fetch(url, { signal: controller.signal }), raw = await response.json();
        if (!response.ok) throw new Error(typeof raw.error === 'string' ? raw.error : '节奏分析未完成，请重新识别。');
        const value = readMusicRhythm(raw); state = { status: value.status, value };
      } catch (error) { if (!alive || controller.signal.aborted) return; state = { status: 'error', error: error instanceof Error ? error.message : '节奏分析未完成。' }; }
      if (alive) setStates(previous => { const next = new Map(previous); for (const id of ids) next.set(id, state); return next; });
    } };
    void Promise.all([worker(), worker()]);
    return () => { alive = false; controller.abort(); };
  }, [projectId, signature, generation, waveUrl]); // Requests are identified by stable source/range URLs, not destination moves.
  return { states, retry: React.useCallback(() => setGeneration(value => value + 1), []) };
}
