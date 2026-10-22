// Gear display shared by the creator and the War Table, plus the Armory:
// equip loot on the chosen hero, upgrade it with shards, or salvage it.

import { salvageItem, upgradeItem } from '../core/campaign';
import { perkText, perkValue, salvageValue, upgradeCost } from '../core/progression';
import { RARITY_COLORS, upgradedBonus } from '../core/rules';
import { MAX_ITEM_LEVEL, RARITIES, STAT_KEYS, type Character, type Item } from '../core/types';
import type { EditorContext } from './context';
import { h, toast } from './dom';
import { capitalize } from './forms';
import { confirmDialog } from './overlay';

const STAT_SHORT: Record<string, string> = { strength: 'STR', speed: 'SPD', durability: 'DUR', energy: 'ENG', intelligence: 'INT', combat: 'CMB' };

export function levelStars(item: Item): string {
  return item.level ? ` ${'★'.repeat(item.level)}${'☆'.repeat(MAX_ITEM_LEVEL - item.level)}` : '';
}

/** "+3 STR · +2 SPD" with upgrades applied. */
export function bonusText(item: Item): string {
  return STAT_KEYS.filter((k) => item.bonuses[k]).map((k) => {
    const v = upgradedBonus(item, k);
    return `${v > 0 ? '+' : ''}${v} ${STAT_SHORT[k]}`;
  }).join(' · ');
}

/** Name, rarity, stats and perk for an item. */
export function itemSummary(item: Item): HTMLElement {
  return h('div', { class: 'item-summary', style: `--c:${RARITY_COLORS[item.rarity]}` },
    h('div', { class: 'item-name' }, item.name, h('span', { class: 'item-stars' }, levelStars(item))),
    h('div', { class: 'item-meta' }, `${capitalize(item.rarity)} ${item.slot}${bonusText(item) ? ` · ${bonusText(item)}` : ''}`),
    item.perk && h('div', { class: 'item-perk' }, `✦ ${perkText(item.perk, perkValue(item))}`),
  );
}

const rank = (i: Item) => RARITIES.indexOf(i.rarity) * 10 + i.level;

export function armoryPanel(ctx: EditorContext, hero: Character | null): HTMLElement {
  const u = ctx.universe;
  const c = ctx.campaign;
  const items = [...u.items].sort((a, b) => rank(b) - rank(a));
  const row = (item: Item) => {
    const equipped = !!hero?.itemIds.includes(item.id);
    const holders = u.characters.filter((x) => x !== hero && x.itemIds.includes(item.id)).map((x) => x.alias);
    const cost = upgradeCost(item);
    return h('div', { class: `armory-row${equipped ? ' equipped' : ''}` },
      itemSummary(item),
      holders.length > 0 && h('span', { class: 'muted small' }, `Worn by ${holders.join(', ')}`),
      h('div', { class: 'row' },
        hero && h('button', {
          class: `btn small${equipped ? ' primary' : ''}`,
          disabled: !equipped && hero.itemIds.length >= 4,
          title: !equipped && hero.itemIds.length >= 4 ? 'Gear slots full: unequip something first' : '',
          onclick: () => {
            hero.itemIds = equipped ? hero.itemIds.filter((id) => id !== item.id) : [...hero.itemIds, item.id];
            ctx.changed();
            ctx.rerender();
          },
        }, equipped ? 'Equipped' : 'Equip'),
        h('button', {
          class: 'btn small',
          disabled: cost === null || c.shards < cost,
          onclick: () => {
            if (!upgradeItem(c, u, item.id)) return;
            ctx.saveCampaign();
            ctx.changed();
            toast(`${item.name} upgraded to +${item.level}`);
            ctx.rerender();
          },
        }, cost === null ? 'Max level' : `Upgrade · ${cost} ◈`),
        h('button', {
          class: 'btn small danger',
          onclick: async () => {
            if (!(await confirmDialog('Salvage gear?', `Salvage ${item.name} for ${salvageValue(item)} shards? It's destroyed and removed from anyone wearing it.`, 'Salvage'))) return;
            const gained = salvageItem(c, u, item.id);
            ctx.saveCampaign();
            ctx.changed();
            toast(`+${gained} shards`);
            ctx.rerender();
          },
        }, `Salvage · ${salvageValue(item)} ◈`),
      ),
    );
  };
  return h('section', { class: 'panel armory' },
    h('div', { class: 'report-head' },
      h('h3', { class: 'panel-title' }, 'Armory'),
      h('span', { class: 'shards', title: 'Shards: salvage gear to earn them, spend them on upgrades' }, `◈ ${c.shards.toLocaleString()} shards`),
    ),
    h('p', { class: 'muted small' }, hero
      ? `Gear for ${hero.alias} (${hero.itemIds.length}/4 equipped). Missions drop loot, and better grades drop better gear. Each upgrade adds 15% to an item's stats and strengthens its perk.`
      : 'Missions drop loot. Upgrade it with shards, or salvage what you don\'t need.'),
    items.length ? h('div', { class: 'armory-list' }, ...items.map(row)) : h('p', { class: 'muted' }, 'No gear yet. Win missions to find some.'),
  );
}
