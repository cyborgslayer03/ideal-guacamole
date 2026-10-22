import type { Bundle } from '../core/share';
import type { Settings } from '../core/storage';
import type { Universe } from '../core/types';
import { normalizeUniverse } from '../core/validate';
import type { Campaign, Mission, NewsItem } from '../core/campaign';
import { h, type Child } from './dom';

export interface EditorContext {
  universe: Universe;
  settings: Settings;
  readonly quick: boolean;
  /** Persist soon (debounced). Use after any edit. */
  changed(): void;
  /** Re-render the active tab (after structural edits like add/delete). */
  rerender(): void;
  /** Selected entity id per tab, kept while switching tabs. */
  selection: Record<string, string | null>;
  /** Campaign state for the War Table; persisted with saveCampaign(). */
  campaign: Campaign;
  saveCampaign(): void;
  resetCampaign(): void;
  /** Report from the last campaign mission, shown once on the War Table. */
  report: { title: string; victory: boolean; news: NewsItem[] } | null;
  playSandbox(locationId: string | null, characterId: string): void;
  /** Test-play a story outside the campaign (choices only affect this run). */
  playStory(storyId: string, chapter: number, characterId: string): void;
  /** Launch a campaign mission with up to three AI teammates. */
  playMission(mission: Mission, heroId: string, squadIds: string[]): void;
  exportBundle(bundle: Bundle | null): void;
  /** Share to the Multiverse Hub (signs in first if needed). */
  publishBundle(bundle: Bundle | null): void;
  openTab(tab: string): void;
}

/** Clears references to deleted entities by re-normalizing in place. */
export function repairReferences(ctx: EditorContext) {
  Object.assign(ctx.universe, normalizeUniverse(ctx.universe));
}

interface ListDetailOptions<T extends { id: string }> {
  key: string;
  items: T[];
  noun: string;
  label: (t: T) => string;
  sub?: (t: T) => string;
  color?: (t: T) => string;
  create: () => T;
  random?: () => T;
  detail: (t: T) => Child;
  empty: string;
  /** Extra buttons beside New and Random. */
  actions?: Child;
}

/** Shared two-pane layout: entity list on the left, editor on the right. */
export function listDetail<T extends { id: string }>(ctx: EditorContext, o: ListDetailOptions<T>): HTMLElement {
  let selected: T | null = o.items.find((i) => i.id === ctx.selection[o.key]) ?? o.items[0] ?? null;
  ctx.selection[o.key] = selected?.id ?? null;

  const add = (item: T) => {
    o.items.push(item);
    ctx.selection[o.key] = item.id;
    ctx.changed();
    ctx.rerender();
  };

  const list = h('div', { class: 'ld-list' },
    h('div', { class: 'ld-actions' },
      h('button', { class: 'btn primary', onclick: () => add(o.create()) }, `+ New ${o.noun}`),
      o.random && h('button', { class: 'btn', title: `Random ${o.noun}`, onclick: () => add(o.random!()) }, '🎲'),
      o.actions,
    ),
    ...o.items.map((item) =>
      h('button', {
        class: `ld-item${item === selected ? ' active' : ''}`,
        style: o.color ? `--c:${o.color(item)}` : undefined,
        onclick: () => {
          ctx.selection[o.key] = item.id;
          ctx.rerender();
        },
      },
      h('span', { class: 'ld-item-name' }, o.label(item) || `Unnamed ${o.noun}`),
      o.sub && h('span', { class: 'ld-item-sub' }, o.sub(item)),
      ),
    ),
  );

  selected = o.items.find((i) => i.id === ctx.selection[o.key]) ?? null;
  const detail = h('div', { class: 'ld-detail' }, selected ? o.detail(selected) : h('div', { class: 'empty' }, o.empty));
  return h('div', { class: 'list-detail' }, list, detail);
}

export function deleteButton(ctx: EditorContext, noun: string, onDelete: () => void): HTMLElement {
  return h('button', {
    class: 'btn danger',
    onclick: () => {
      if (!confirm(`Delete this ${noun}? This cannot be undone.`)) return;
      onDelete();
      repairReferences(ctx);
      ctx.changed();
      ctx.rerender();
    },
  }, `Delete ${noun}`);
}

export function removeById<T extends { id: string }>(items: T[], id: string) {
  const i = items.findIndex((x) => x.id === id);
  if (i >= 0) items.splice(i, 1);
}
