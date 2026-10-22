// Bound form controls: each takes a getter and a setter so editors can wire
// fields straight to universe data.

import { h, type Child } from './dom';

export function field(label: string, control: Child, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint && h('span', { class: 'field-hint' }, hint));
}

export function textInput(get: () => string, set: (v: string) => void, placeholder = '', maxLength = 80): HTMLInputElement {
  return h('input', { type: 'text', value: get(), placeholder, maxLength, oninput: (e: Event) => set((e.target as HTMLInputElement).value) });
}

export function textArea(get: () => string, set: (v: string) => void, placeholder = '', rows = 3): HTMLTextAreaElement {
  return h('textarea', { value: get(), placeholder, rows, maxLength: 4000, oninput: (e: Event) => set((e.target as HTMLTextAreaElement).value) });
}

export function slider(get: () => number, set: (v: number) => void, min: number, max: number, step = 1, format: (v: number) => string = String): HTMLElement {
  const out = h('span', { class: 'slider-value' }, format(get()));
  const input = h('input', {
    type: 'range',
    min,
    max,
    step,
    value: get(),
    oninput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      out.textContent = format(v);
      set(v);
    },
  });
  return h('div', { class: 'slider' }, input, out);
}

export function colorInput(get: () => string, set: (v: string) => void): HTMLInputElement {
  return h('input', { type: 'color', value: get(), oninput: (e: Event) => set((e.target as HTMLInputElement).value) });
}

export type Option<T extends string> = T | { value: T; label: string };

export function select<T extends string>(options: readonly Option<T>[], get: () => T, set: (v: T) => void): HTMLSelectElement {
  const el = h('select', { onchange: (e: Event) => set((e.target as HTMLSelectElement).value as T) },
    ...options.map((o) => {
      const value = typeof o === 'string' ? o : o.value;
      const label = typeof o === 'string' ? capitalize(o) : o.label;
      return h('option', { value, selected: value === get() }, label);
    }),
  );
  return el;
}

export function checkbox(get: () => boolean, set: (v: boolean) => void, label: string): HTMLElement {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: get(), onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }), h('span', null, label));
}

/** Pill-style single choice, nicer than a select for small option sets. */
export function chips<T extends string>(options: readonly Option<T>[], get: () => T, set: (v: T) => void): HTMLElement {
  const wrap = h('div', { class: 'chips' });
  const render = () => {
    wrap.replaceChildren(
      ...options.map((o) => {
        const value = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? capitalize(o) : o.label;
        return h('button', {
          type: 'button',
          class: `chip${value === get() ? ' active' : ''}`,
          onclick: () => {
            set(value);
            render();
          },
        }, label);
      }),
    );
  };
  render();
  return wrap;
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'panel' }, h('h3', { class: 'panel-title' }, title), ...children);
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
