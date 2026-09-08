import { useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Overlay primitives: modal dialogs, confirmations and disclosures.
 *
 * The modal renders through a portal onto `document.body`. That matters
 * because the sticky masthead uses `backdrop-filter`, and any ancestor with a
 * filter or transform becomes the containing block for `position: fixed`,
 * which would otherwise clip the dialog.
 */

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */

/** Elements that can hold focus, for the focus trap. */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  eyebrow,
  footer,
  width = 'default',
  tone = 'default',
  flush = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  eyebrow?: string;
  footer?: ReactNode;
  width?: 'narrow' | 'default' | 'wide';
  tone?: 'default' | 'danger';
  flush?: boolean;
  children: ReactNode;
}): ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const headingId = useId();

  // Remember what had focus so it can be handed back on close, and move
  // focus into the dialog so keyboard users aren't left behind it.
  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();

    return () => restoreFocusTo.current?.focus?.();
  }, [open]);

  // Escape closes; Tab cycles within the dialog rather than escaping it.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (n) => n.offsetParent !== null,
      );
      if (nodes.length === 0) return;

      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  // Stop the page behind the dialog from scrolling.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        // Only a click on the backdrop itself closes — not a drag that
        // happens to end there.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal${width === 'wide' ? ' modal--wide' : width === 'narrow' ? ' modal--narrow' : ''}${
          tone === 'danger' ? ' modal--danger' : ''
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="modal__strip" aria-hidden="true" />

        <header className="modal__head">
          <div className="modal__head-text">
            {eyebrow && <span className="sw-label">{eyebrow}</span>}
            <h2 id={headingId}>{title}</h2>
            {subtitle && <div className="modal__sub">{subtitle}</div>}
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="Close">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div className={`modal__body${flush ? ' modal__body--flush' : ''}`}>{children}</div>

        {footer && <footer className="modal__foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ *
 * Confirmation
 * ------------------------------------------------------------------ */

export interface ConfirmRequest {
  title: string;
  /** The consequence, spelled out. */
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  /** Extra step for genuinely irreversible actions: type this to proceed. */
  requireTyping?: string;
}

/**
 * Confirmation dialogs, driven by a promise so callers read like
 * `if (await confirm({...})) { … }` rather than juggling dialog state.
 * Replaces `window.confirm`, which cannot be branded or explained.
 */
export function useConfirm(): {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  dialog: ReactElement | null;
} {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [typed, setTyped] = useState('');
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmRequest) => {
    setTyped('');
    setRequest(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setRequest(null);
    setTyped('');
  }, []);

  const blocked = Boolean(request?.requireTyping && typed.trim() !== request.requireTyping);

  const dialog = request ? (
    <Modal
      open
      onClose={() => settle(false)}
      title={request.title}
      tone={request.tone ?? 'default'}
      width="narrow"
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={() => settle(false)}>
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={`btn ${request.tone === 'danger' ? 'btn--danger-solid' : 'btn--primary'}`}
            onClick={() => settle(true)}
            disabled={blocked}
          >
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </>
      }
    >
      <div>{request.message}</div>
      {request.requireTyping && (
        <label className="field" style={{ marginTop: 14, marginBottom: 0 }}>
          <span className="sw-label">
            Type <strong className="sw-mono">{request.requireTyping}</strong> to confirm
          </span>
          <input
            className="field__input sw-mono"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      )}
    </Modal>
  ) : null;

  return { confirm, dialog };
}

/* ------------------------------------------------------------------ *
 * Disclosure
 * ------------------------------------------------------------------ */

export function Disclosure({
  summary,
  meta,
  defaultOpen = false,
  flush = false,
  children,
}: {
  summary: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  flush?: boolean;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <div className="disclosure" data-open={open}>
      <button
        type="button"
        className="disclosure__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className="disclosure__chevron" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 5l7 7-7 7" />
          </svg>
        </span>
        <span className="grow">{summary}</span>
        {meta}
      </button>
      {open && (
        <div className={`disclosure__body${flush ? ' disclosure__body--flush' : ''}`} id={bodyId}>
          {children}
        </div>
      )}
    </div>
  );
}
