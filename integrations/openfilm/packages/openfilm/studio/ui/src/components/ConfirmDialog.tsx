import React from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/i18n';
import { Card, CardActions, CardButton } from './Card';
import { useDialogBoundary } from './use-dialog-boundary';

/** A centered confirmation, in the card shell. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger = false,
  altLabel,
  onAlt,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** a second answer besides confirming, between Cancel and the confirm button */
  altLabel?: string;
  onAlt?: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const cancelButtonRef = React.useRef<HTMLButtonElement>(null);
  const confirmButtonRef = React.useRef<HTMLButtonElement>(null);
  const confirm = React.useRef(onConfirm);
  confirm.current = onConfirm;
  const boundary = useDialogBoundary({ open, panel: dialogRef, initialFocus: confirmButtonRef, onClose: onCancel });

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10100] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      style={{ animation: 'openfilm-rise 0.16s ease-out both' }}
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-full max-w-[420px]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          boundary(e);
          if (e.defaultPrevented || e.nativeEvent.isComposing || e.key !== 'Enter') return;
          // Other buttons keep their own native Enter action (Cancel or the
          // alternate answer); the initially focused primary button confirms.
          const button = e.target instanceof Element ? e.target.closest('button') : null;
          if (button && button !== confirmButtonRef.current) return;
          e.preventDefault();
          confirm.current();
        }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <Card title={title} body={description} onClose={onCancel}>
          <CardActions>
            <CardButton ref={cancelButtonRef} weight="quiet" onClick={onCancel}>
              {cancelLabel ?? t('confirm.cancel')}
            </CardButton>
            {altLabel && onAlt ? <CardButton onClick={onAlt}>{altLabel}</CardButton> : null}
            <CardButton ref={confirmButtonRef} weight={danger ? 'danger' : 'primary'} onClick={onConfirm}>
              {confirmLabel ?? t('confirm.ok')}
            </CardButton>
          </CardActions>
        </Card>
      </div>
    </div>,
    document.body,
  );
}
