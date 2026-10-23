import { randomItem } from '../../core/generator';
import { newId } from '../../core/id';
import { Rng, randomSeed } from '../../core/rng';
import { perkText, perkValue, PERK_LABELS } from '../../core/progression';
import { POWER_LABELS, RARITY_COLORS } from '../../core/rules';
import { bundleItem } from '../../core/share';
import { ELEMENTS, ITEM_SLOTS, MAX_ITEM_LEVEL, PERK_TYPES, POWER_KINDS, RARITIES, STAT_KEYS, takesSkillSlot, type Item, type PerkType } from '../../core/types';
import { deleteButton, listDetail, removeById, type EditorContext } from '../context';
import { h } from '../dom';
import { capitalize, chips, colorInput, field, section, select, slider, textArea, textInput } from '../forms';
import { bonusText } from '../armory';

export function itemsTab(ctx: EditorContext): HTMLElement {
  const u = ctx.universe;
  return listDetail(ctx, {
    key: 'items',
    items: u.items,
    noun: 'Item',
    label: (i) => i.name,
    sub: (i) => `${capitalize(i.rarity)} ${i.slot}`,
    color: (i) => RARITY_COLORS[i.rarity],
    create: (): Item => ({ id: newId('itm'), name: 'New Item', slot: 'artifact', rarity: 'rare', description: '', bonuses: { energy: 2 }, color: '#ffd23e', level: 0, perk: null }),
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
    perkSection(ctx, item),
    section('Upgrade',
      field('Level', slider(() => item.level, (v) => ((item.level = v), ctx.changed()), 0, MAX_ITEM_LEVEL, 1, (v) => (v ? `+${v}` : 'Base'))),
      h('p', { class: 'muted small' }, 'Each level adds 15% to the stat bonuses and strengthens the perk. In a campaign, heroes upgrade gear with shards in the Armory.'),
    ),
    holders.length > 0 && h('p', { class: 'muted' }, `Equipped by: ${holders.map((c) => c.alias).join(', ')}`),
    h('div', { class: 'row end' },
      h('button', { class: 'btn', onclick: () => ctx.publishBundle(bundleItem(u, item.id)) }, 'Publish'),
      h('button', { class: 'btn', onclick: () => ctx.exportBundle(bundleItem(u, item.id)) }, 'Export'),
      deleteButton(ctx, 'item', () => removeById(u.items, item.id)),
    ),
  );
}

const POWER_PERKS: readonly PerkType[] = ['powerDamage', 'powerCooldown', 'powerPotency'];

function perkSection(ctx: EditorContext, item: Item): HTMLElement {
  const p = item.perk;
  const preview = h('p', { class: 'item-perk' }, p ? `✦ ${perkText(p, perkValue(item))}${bonusText(item) ? ` · ${bonusText(item)}` : ''}` : '');
  const update = () => {
    if (item.perk) preview.textContent = `✦ ${perkText(item.perk, perkValue(item))}`;
    ctx.changed();
  };
  return section('Perk',
    h('p', { class: 'muted' }, 'A special effect on top of the stat bonuses, like faster Telekinesis cooldowns or lifesteal.'),
    field('Type', select([{ value: '', label: '— None —' }, ...PERK_TYPES.map((t) => ({ value: t, label: PERK_LABELS[t] }))], () => p?.type ?? '', (v) => {
      const type = v as PerkType | '';
      item.perk = type ? {
        type,
        power: POWER_PERKS.includes(type) ? p?.power ?? 'blast' : null,
        element: type === 'elementDamage' ? p?.element ?? 'energy' : null,
        value: type === 'powerPotency' ? 1 : type === 'lifesteal' ? 5 : 15,
      } : null;
      ctx.changed();
      ctx.rerender();
    })),
    p && POWER_PERKS.includes(p.type) && field('Power', select(POWER_KINDS.filter(takesSkillSlot).map((k) => ({ value: k, label: POWER_LABELS[k] })), () => p.power ?? 'blast', (v) => ((p.power = v), update()))),
    p?.type === 'elementDamage' && field('Element', select(ELEMENTS, () => p.element ?? 'energy', (v) => ((p.element = v), update()))),
    p && field('Strength', p.type === 'powerPotency'
      ? slider(() => p.value, (v) => ((p.value = v), update()), 1, 3, 1, (v) => `+${v}`)
      : slider(() => p.value, (v) => ((p.value = v), update()), 1, p.type === 'lifesteal' ? 15 : 40, 1, (v) => `${v}%`)),
    p && preview,
  );
}
