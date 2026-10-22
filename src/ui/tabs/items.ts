import { randomItem } from '../../core/generator';
import { newId } from '../../core/id';
import { Rng, randomSeed } from '../../core/rng';
import { RARITY_COLORS } from '../../core/rules';
import { bundleItem } from '../../core/share';
import { ITEM_SLOTS, RARITIES, STAT_KEYS, type Item } from '../../core/types';
import { deleteButton, listDetail, removeById, type EditorContext } from '../context';
import { h } from '../dom';
import { capitalize, chips, colorInput, field, section, slider, textArea, textInput } from '../forms';

export function itemsTab(ctx: EditorContext): HTMLElement {
  const u = ctx.universe;
  return listDetail(ctx, {
    key: 'items',
    items: u.items,
    noun: 'Item',
    label: (i) => i.name,
    sub: (i) => `${capitalize(i.rarity)} ${i.slot}`,
    color: (i) => RARITY_COLORS[i.rarity],
    create: (): Item => ({ id: newId('itm'), name: 'New Item', slot: 'artifact', rarity: 'rare', description: '', bonuses: { energy: 2 }, color: '#ffd23e' }),
    random: () => randomItem(new Rng(randomSeed())),
    detail: (item) => itemEditor(ctx, item),
    empty: 'No items yet. Forge legendary weapons, armor, and artifacts here.',
  });
}

function itemEditor(ctx: EditorContext, item: Item): HTMLElement {
  const u = ctx.universe;
  const holders = u.characters.filter((c) => c.itemIds.includes(item.id));
  return h('div', { class: 'editor' },
    section('Item',
      field('Name', textInput(() => item.name, (v) => ((item.name = v), ctx.changed()))),
      field('Slot', chips(ITEM_SLOTS, () => item.slot, (v) => ((item.slot = v), ctx.changed()))),
      field('Rarity', chips(RARITIES, () => item.rarity, (v) => ((item.rarity = v), ctx.changed(), ctx.rerender()))),
      !ctx.quick && field('Color', colorInput(() => item.color, (v) => ((item.color = v), ctx.changed()))),
      !ctx.quick && field('Description', textArea(() => item.description, (v) => ((item.description = v), ctx.changed()), 'Lore and legend...')),
    ),
    section('Stat bonuses',
      h('p', { class: 'muted' }, 'Bonuses stack on top of the wearer\'s attributes and can exceed the normal cap.'),
      ...STAT_KEYS.map((k) => field(capitalize(k), slider(() => item.bonuses[k] ?? 0, (v) => {
        if (v === 0) delete item.bonuses[k];
        else item.bonuses[k] = v;
        ctx.changed();
      }, -5, 5, 1, (v) => (v > 0 ? `+${v}` : String(v))))),
    ),
    holders.length > 0 && h('p', { class: 'muted' }, `Equipped by: ${holders.map((c) => c.alias).join(', ')}`),
    h('div', { class: 'row end' },
      h('button', { class: 'btn', onclick: () => ctx.publishBundle(bundleItem(u, item.id)) }, 'Publish'),
      h('button', { class: 'btn', onclick: () => ctx.exportBundle(bundleItem(u, item.id)) }, 'Export'),
      deleteButton(ctx, 'item', () => removeById(u.items, item.id)),
    ),
  );
}
