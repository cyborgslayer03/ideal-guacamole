// Full-screen dialog for menus outside the game (hub, publishing, sign-in).

import { h, type Child } from './dom';

export interface OverlayAction {
  label: string;
  primary?: boolean;
  danger?: boolean;
  /** Return false to keep the dialog open (e.g. after a failed submit). */
  onClick: (button: HTMLButtonElement) => void | boolean | Promise<void | boolean>;
}

export function overlay(
  title: string,
  body: Child,
  actions: OverlayAction[],
  opts: { wide?: boolean; onClose?: () => void } = {},
): { close: () => void; setError: (msg: string) => void } {
  const error = h('div', { class: 'overlay-error', role: 'alert' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    layer.remove();
    document.removeEventListener('keydown', onKey);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const buttons = actions.map((a) => {
    const btn = h('button', {
      class: `btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`,
      onclick: async () => {
        error.textContent = '';
        btn.disabled = true;
        try {
          const keep = (await a.onClick(btn)) === false;
          if (!keep) close();
        } catch (e) {
          error.textContent = e instanceof Error ? e.message : 'Something went wrong.';
        } finally {
          btn.disabled = false;
        }
      },
    }, a.label);
    return btn;
  });
  const layer = h('div', { class: 'overlay', onclick: (e: Event) => e.target === layer && close() },
    h('div', { class: `modal${opts.wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title },
      h('div', { class: 'overlay-head' },
        h('h2', null, title),
        h('button', { class: 'icon-btn', title: 'Close', onclick: close }, '✕'),
      ),
      h('div', { class: 'modal-body' }, body),
      error,
      actions.length > 0 && h('div', { class: 'modal-actions' }, ...buttons),
    ),
  );
  document.addEventListener('keydown', onKey);
  document.body.appendChild(layer);
  layer.querySelector<HTMLInputElement>('input, textarea')?.focus();
  return { close, setError: (msg) => (error.textContent = msg) };
}

/**
 * In-app replacement for window.confirm, which sandboxed pages (like embedded
 * previews) silently block. Resolves true only if the user confirms.
 */
export function confirmDialog(title: string, message: string, confirmLabel = 'Confirm', danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    overlay(title, h('p', null, message), [
      { label: 'Cancel', onClick: () => {} },
      { label: confirmLabel, primary: !danger, danger, onClick: () => ((answered = true), resolve(true)) },
    ], { onClose: () => !answered && resolve(false) });
  });
}

/** In-app replacement for window.prompt. Resolves null if cancelled. */
export function promptDialog(title: string, message: string, placeholder = '', confirmLabel = 'OK'): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = false;
    const input = h('input', { type: 'text', placeholder, class: 'prompt-input' });
    const submit = () => {
      answered = true;
      resolve(input.value.trim() || null);
    };
    const dialog = overlay(title, h('div', null, h('p', null, message), input), [
      { label: 'Cancel', onClick: () => {} },
      { label: confirmLabel, primary: true, onClick: submit },
    ], { onClose: () => !answered && resolve(null) });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      submit();
      dialog.close();
    });
  });
}
