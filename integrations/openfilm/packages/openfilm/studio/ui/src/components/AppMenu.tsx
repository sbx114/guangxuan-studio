/** Local application actions. The original popover and keyboard navigation stay intact. */
import React from 'react';
import { Keyboard, Settings2 } from 'lucide-react';
import { useT } from '@/i18n';
import { useClickOpen } from '@/lib/click-open';
import { menuStep } from '@/lib/menu-position';
import { BrandLogo } from './BrandLogo';
import { Popover } from './Popover';
import type { SettingsSection } from './settings/SettingsModal';
import styles from './AppMenu.module.css';

export function AppMenu({ onSettings }: { onSettings: (section: SettingsSection) => void }) {
  const t = useT();
  const popup = useClickOpen();
  const trigger = React.useRef<HTMLButtonElement>(null);
  const panel = React.useRef<HTMLDivElement>(null);
  const focused = React.useRef(false);
  const focusFrame = React.useRef<number | null>(null);
  const id = React.useId();
  const items = () => Array.from(panel.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
  const focusItem = (item: HTMLElement | undefined) => { item?.focus({ preventScroll: true }); item?.scrollIntoView({ block: 'nearest' }); };
  const queueFocus = (last = false, panelOnly = false) => {
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = null;
      if (panelOnly) panel.current?.focus({ preventScroll: true });
      else { const rows = items(); focusItem(rows[last ? rows.length - 1 : 0]); }
    });
  };
  const dismiss = (restore = false) => {
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = null; popup.dismiss();
    if (restore) trigger.current?.focus({ preventScroll: true });
    focused.current = false;
  };
  React.useEffect(() => {
    if (!popup.open) { focused.current = false; if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current); focusFrame.current = null; }
  }, [popup.open]);
  React.useEffect(() => () => { if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current); }, []);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Tab') { dismiss(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const rows = items(), current = rows.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : menuStep(current, event.key === 'ArrowUp' ? -1 : 1, rows.length);
    focusItem(rows[next]);
  };

  return <Popover open={popup.open} onOpenChange={(next) => { if (next) popup.setOpen(true); else dismiss(focused.current); }} layer={10060}
    onEscapeKeyDown={(event) => { event.stopPropagation(); dismiss(focused.current); }}
    trigger={<button ref={trigger} type="button" aria-label={t('project.appMenu')} aria-haspopup="menu" aria-expanded={popup.open} aria-controls={popup.open ? id : undefined}
      onClick={(event) => { event.stopPropagation(); popup.toggle(); if (!popup.open) queueFocus(false, event.detail !== 0); }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault(); event.stopPropagation(); popup.setOpen(true); queueFocus(event.key === 'ArrowUp');
      }}
      className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] outline-none transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus-visible:ring-1 focus-visible:ring-[var(--accent)] ${popup.open ? 'bg-[var(--bg-hover)] text-[var(--text)]' : ''}`}>
      <BrandLogo size={15} />
    </button>}>
    <div ref={panel} id={id} data-app-menu role="menu" tabIndex={-1} aria-label={t('project.appMenu')}
      onKeyDown={onKeyDown} onFocusCapture={() => { focused.current = true; }}
      onBlur={(event) => { const next = event.relatedTarget as Node | null; if (next && !panel.current?.contains(next) && next !== trigger.current) dismiss(); }} className={styles.menu}>
      <button type="button" role="menuitem" tabIndex={-1} className={styles.row} onClick={() => { dismiss(true); onSettings('general'); }}>
        <Settings2 size={15} className={styles.icon} aria-hidden /><span className={styles.label}>{t('settings.title')}</span>
      </button>
      <button type="button" role="menuitem" tabIndex={-1} className={styles.row} onClick={() => { dismiss(true); onSettings('shortcuts'); }}>
        <Keyboard size={15} className={styles.icon} aria-hidden /><span className={styles.label}>{t('settings.sections.shortcuts')}</span>
      </button>
    </div>
  </Popover>;
}
