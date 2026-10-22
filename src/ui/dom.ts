// Tiny DOM builder so the UI stays dependency-free.

export type Child = Node | string | number | null | undefined | false | Child[];

type Props = {
  class?: string;
  style?: string | Partial<CSSStyleDeclaration>;
  [key: string]: unknown;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'style') {
        if (typeof value === 'string') el.style.cssText = value;
        else Object.assign(el.style, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key in el && key !== 'list') {
        (el as unknown as Record<string, unknown>)[key] = value;
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Like replaceChildren, but accepts the same optional children as h(). */
export function setChildren(el: Element, ...children: Child[]) {
  clear(el);
  append(el, children);
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function toast(message: string, kind: 'info' | 'error' = 'info') {
  const el = h('div', { class: `toast toast-${kind}` }, message);
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, 2600);
}

export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept = '.json'): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      resolve(file ? await file.text() : null);
    });
    input.click();
  });
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'export';
}
