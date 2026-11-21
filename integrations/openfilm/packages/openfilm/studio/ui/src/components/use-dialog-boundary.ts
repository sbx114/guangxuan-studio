import React from 'react';

const inertLocks = new WeakMap<HTMLElement, { count: number; previous: boolean }>();
const scrollLocks = new WeakMap<HTMLElement, { count: number; previous: string }>();
const FOCUSABLE = 'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex],[contenteditable="true"]';
const tabStops = (panel: HTMLElement) => [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
  .filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest('[inert]') && getComputedStyle(element).visibility !== 'hidden');

/** The two card dialogs share a keyboard boundary; body portals remain usable. */
export function useDialogBoundary({ open, panel, initialFocus, onClose, canClose = true }: {
  open: boolean;
  panel: React.RefObject<HTMLElement | null>;
  initialFocus?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  canClose?: boolean;
}) {
  const latest = React.useRef({ onClose, canClose });
  latest.current = { onClose, canClose };

  React.useLayoutEffect(() => {
    const element = panel.current;
    if (!open || !element) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const body = document.body;
    // Lock existing background layers only. A menu opened by this dialog is a
    // later body portal, and keeps its own focus and Escape handling.
    const background = [...body.children].filter((node): node is HTMLElement => node instanceof HTMLElement && !node.contains(element));
    for (const node of background) {
      const lock = inertLocks.get(node) ?? { count: 0, previous: node.inert };
      lock.count++;
      inertLocks.set(node, lock);
      node.inert = true;
    }
    const scrolling = scrollLocks.get(body) ?? { count: 0, previous: body.style.overflow };
    scrolling.count++;
    scrollLocks.set(body, scrolling);
    body.style.overflow = 'hidden';
    const start = initialFocus?.current;
    (start && start.tabIndex >= 0 && !start.matches(':disabled') ? start : tabStops(element)[0] ?? element).focus({ preventScroll: true });
    return () => {
      for (const node of background) {
        const lock = inertLocks.get(node);
        if (lock && --lock.count === 0) { node.inert = lock.previous; inertLocks.delete(node); }
      }
      const scrolling = scrollLocks.get(body);
      if (scrolling && --scrolling.count === 0) { body.style.overflow = scrolling.previous; scrollLocks.delete(body); }
      if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) previousFocus.focus({ preventScroll: true });
    };
    // Callback/working changes must not take focus back on every owner render.
  }, [open, panel, initialFocus]);

  return (event: React.KeyboardEvent<HTMLElement>) => {
    // React also bubbles events from menus portaled out of the physical panel.
    // Descendant controls receive the key first; background timeline handlers do not.
    event.stopPropagation();
    const element = panel.current;
    if (event.defaultPrevented || event.nativeEvent.isComposing || !element || element.closest('[inert]')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (latest.current.canClose) latest.current.onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const stops = tabStops(element), first = stops[0], last = stops.at(-1);
    const focus = document.activeElement;
    if (!first) { event.preventDefault(); element.focus({ preventScroll: true }); }
    else if (!element.contains(focus) || (event.shiftKey ? focus === first : focus === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus({ preventScroll: true });
    }
  };
}
