import { rhythmStatusText, type RhythmState } from '@/lib/music-rhythm';
export function MusicRhythmPanel({ state, shown, toggle, retry, cut, undo, busy, message, managed }: {
  state?: RhythmState; shown: boolean; toggle: (shown: boolean) => void; retry: () => void;
  cut: () => void; undo?: () => void; busy: boolean; message: string; managed: boolean;
}) {
  const ready = state?.status === 'ready' && state.value?.status === 'ready' && state.value.tempoConfidence >= .55 && state.value.beats.length >= 2;
  const button = 'rounded border border-[var(--border)] px-2 py-1.5 hover:bg-[var(--bg-hover)] disabled:cursor-default disabled:opacity-40';
  const warningText = (warning: string) => warning.startsWith('No meter or downbeat is inferred.') ? '没有推断拍号或强拍位置；评分表示节奏证据强度，不是准确率保证。' : warning;
  return <section data-music-rhythm-panel="" className="shrink-0 border-b border-[var(--border)] p-3 text-[12px]">
    <div className="flex items-center justify-between gap-2"><strong>音乐节奏</strong><label className="flex items-center gap-1"><input type="checkbox" checked={shown} onChange={event => toggle(event.target.checked)} aria-label="显示音乐节奏点" />节奏点</label></div>
    <p role="status" data-music-rhythm-status="" className="my-2">{rhythmStatusText(state)}</p>
    {state?.value?.warnings.map((warning, index) => <p key={index} className="text-[var(--text-muted)]">{warningText(warning)}</p>)}
    <p className="text-[var(--text-muted)]">青色线为自动节奏点，虚线为推断补点；不会覆盖手工标记。</p>
    <div className="mt-2 flex flex-wrap gap-2"><button type="button" className={button} data-rhythm-retry="" disabled={busy || state?.status === 'loading'} onClick={retry}>重新识别</button>
      <button type="button" className={button} data-rhythm-cut="" disabled={!managed || !ready || busy} onClick={cut}>按音乐自动卡点</button>
      {undo ? <button type="button" className={button} data-rhythm-undo="" disabled={busy} onClick={undo}>撤销卡点</button> : null}</div>
    {!managed ? <p className="mt-1 text-[var(--text-muted)]">自动卡点需要 Gx 宿主；此处仍可查看节奏点并手工剪辑。</p> : null}
    {message ? <p data-music-cut-status="" role="status" className="mt-2">{message}</p> : null}
  </section>;
}
