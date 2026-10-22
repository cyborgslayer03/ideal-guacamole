import { randomAppearance, randomCharacter, randomPower, randomPowerSet, randomStats, randomAlias } from '../../core/generator';
import { newId } from '../../core/id';
import { Rng, randomSeed } from '../../core/rng';
import {
  ELEMENT_COLORS, RARITY_COLORS, SKILL_SLOTS, basicDamage, combatPower, effectiveStats, maxEnergy, maxHealth,
  powerCooldown, powerCost, powerDamage,
} from '../../core/rules';
import { bundleCharacter } from '../../core/share';
import {
  BUILDS, ELEMENTS, EMBLEMS, HEAD_STYLES, POWER_KINDS, ROLES, STAT_KEYS,
  type Character, type Power, type StatKey, type Stats,
} from '../../core/types';
import { deleteButton, listDetail, removeById, type EditorContext } from '../context';
import { h } from '../dom';
import { checkbox, chips, colorInput, field, section, select, slider, textArea, textInput, capitalize } from '../forms';
import { getPreview } from '../preview';

const STAT_LABELS: Record<StatKey, string> = {
  strength: 'Strength',
  speed: 'Speed',
  durability: 'Durability',
  energy: 'Energy',
  intelligence: 'Intelligence',
  combat: 'Combat',
};

const PRESETS: Record<string, Stats> = {
  Balanced: { strength: 6, speed: 6, durability: 6, energy: 6, intelligence: 6, combat: 6 },
  Bruiser: { strength: 10, speed: 4, durability: 8, energy: 3, intelligence: 3, combat: 7 },
  Speedster: { strength: 4, speed: 10, durability: 4, energy: 6, intelligence: 5, combat: 7 },
  Blaster: { strength: 3, speed: 5, durability: 4, energy: 10, intelligence: 7, combat: 5 },
  Tank: { strength: 7, speed: 3, durability: 10, energy: 5, intelligence: 4, combat: 5 },
  Genius: { strength: 3, speed: 5, durability: 5, energy: 7, intelligence: 10, combat: 5 },
  Cosmic: { strength: 10, speed: 10, durability: 10, energy: 10, intelligence: 10, combat: 10 },
};

export function blankCharacter(): Character {
  return {
    id: newId('chr'),
    name: '',
    alias: 'New Hero',
    role: 'hero',
    factionId: null,
    origin: '',
    bio: '',
    stats: { ...PRESETS.Balanced },
    powers: [{ id: newId('pow'), name: 'Energy Blast', kind: 'blast', element: 'energy', potency: 5, description: '' }],
    appearance: {
      primary: '#c0303a',
      secondary: '#1a2240',
      accent: '#ffd23e',
      build: 'athletic',
      height: 1,
      head: 'mask',
      emblem: 'star',
      cape: true,
      aura: false,
    },
    itemIds: [],
    level: 1,
    xp: 0,
  };
}

export function charactersTab(ctx: EditorContext): HTMLElement {
  const u = ctx.universe;
  return listDetail(ctx, {
    key: 'characters',
    items: u.characters,
    noun: 'Character',
    label: (c) => c.alias,
    sub: (c) => `${capitalize(c.role)} · CP ${combatPower(c, u.items).toLocaleString()}`,
    color: (c) => c.appearance.primary,
    create: blankCharacter,
    random: () => randomCharacter(new Rng(randomSeed())),
    detail: (c) => characterEditor(ctx, c),
    empty: 'No characters yet. Create one, or roll a random one with 🎲.',
  });
}

function characterEditor(ctx: EditorContext, c: Character): HTMLElement {
  const u = ctx.universe;
  const rng = () => new Rng(randomSeed());
  const preview = getPreview();
  const cpEl = h('div', { class: 'cp' });
  const derivedEl = h('div', { class: 'derived' });

  const refresh = () => {
    const stats = effectiveStats(c, u.items);
    cpEl.replaceChildren(h('span', null, 'CP'), h('b', null, combatPower(c, u.items).toLocaleString()));
    derivedEl.replaceChildren(
      derived('Health', maxHealth(stats, c.level)),
      derived('Energy', maxEnergy(stats)),
      derived('Attack', basicDamage(stats, c.level)),
    );
  };
  const changed = () => {
    refresh();
    ctx.changed();
  };
  const appearanceChanged = () => {
    preview.setAppearance(c.appearance, u.accent);
    ctx.changed();
  };
  preview.setAppearance(c.appearance, u.accent);
  preview.start();
  refresh();

  const a = c.appearance;
  const factionOptions = [{ value: '', label: '— None —' }, ...u.factions.map((f) => ({ value: f.id, label: f.name }))];

  const header = h('div', { class: 'char-header' },
    h('div', { class: 'preview-wrap' }, preview.canvas, cpEl),
    h('div', { class: 'char-identity' },
      field('Hero name', textInput(() => c.alias, (v) => ((c.alias = v), ctx.changed()), 'e.g. Captain Nova')),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => ((c.alias = randomAlias(rng())), ctx.changed(), ctx.rerender()) }, '🎲 Name'),
        h('button', {
          class: 'btn small',
          onclick: () => {
            const r = rng();
            Object.assign(c, { ...randomCharacter(r, c.role, c.factionId), id: c.id, level: c.level, xp: c.xp, itemIds: c.itemIds });
            ctx.changed();
            ctx.rerender();
          },
        }, '🎲 Everything'),
      ),
      !ctx.quick && field('Secret identity', textInput(() => c.name, (v) => ((c.name = v), ctx.changed()), 'Real name')),
      field('Role', chips(ROLES, () => c.role, (v) => ((c.role = v), ctx.changed()))),
      field('Faction', select(factionOptions, () => c.factionId ?? '', (v) => ((c.factionId = v || null), ctx.changed()))),
      derivedEl,
    ),
  );

  const appearance = section('Costume',
    h('div', { class: 'grid-3' },
      field('Primary', colorInput(() => a.primary, (v) => ((a.primary = v), appearanceChanged()))),
      field('Secondary', colorInput(() => a.secondary, (v) => ((a.secondary = v), appearanceChanged()))),
      field('Accent / glow', colorInput(() => a.accent, (v) => ((a.accent = v), appearanceChanged()))),
    ),
    field('Build', chips(BUILDS, () => a.build, (v) => ((a.build = v), appearanceChanged()))),
    field('Head', chips(HEAD_STYLES, () => a.head, (v) => ((a.head = v), appearanceChanged()))),
    field('Emblem', chips(EMBLEMS, () => a.emblem, (v) => ((a.emblem = v), appearanceChanged()))),
    h('div', { class: 'row' },
      checkbox(() => a.cape, (v) => ((a.cape = v), appearanceChanged()), 'Cape'),
      checkbox(() => a.aura, (v) => ((a.aura = v), appearanceChanged()), 'Power aura'),
    ),
    !ctx.quick && field('Height', slider(() => a.height, (v) => ((a.height = v), appearanceChanged()), 0.8, 1.3, 0.01, (v) => `${Math.round(v * 183)} cm`)),
    h('button', { class: 'btn small', onclick: () => ((c.appearance = randomAppearance(rng())), ctx.changed(), ctx.rerender()) }, '🎲 Random costume'),
  );

  const stats = section('Attributes',
    h('div', { class: 'chips' },
      ...Object.entries(PRESETS).map(([name, preset]) =>
        h('button', { type: 'button', class: 'chip', onclick: () => ((c.stats = { ...preset }), changed(), ctx.rerender()) }, name),
      ),
      h('button', { type: 'button', class: 'chip', onclick: () => ((c.stats = randomStats(rng())), changed(), ctx.rerender()) }, '🎲'),
    ),
    ...STAT_KEYS.map((k) => field(STAT_LABELS[k], slider(() => c.stats[k], (v) => ((c.stats[k] = v), changed()), 1, 10))),
    !ctx.quick && field('Level', slider(() => c.level, (v) => ((c.level = v), (c.xp = 0), changed()), 1, 60)),
  );

  const activeCount = c.powers.filter((p) => p.kind !== 'flight').length;
  const powers = section('Powers',
    h('p', { class: 'muted' }, `Up to ${SKILL_SLOTS} active powers map to the Q E R F skill buttons. Flight is passive.`),
    ...c.powers.map((p, i) => powerEditor(ctx, c, p, i, changed)),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: () => (c.powers.push(randomPower(rng())), changed(), ctx.rerender()) }, '+ Power'),
      !c.powers.some((p) => p.kind === 'flight') &&
        h('button', { class: 'btn small', onclick: () => (c.powers.push(randomPower(rng(), 'flight', c.powers[0]?.element)), changed(), ctx.rerender()) }, '+ Flight'),
      h('button', { class: 'btn small', onclick: () => ((c.powers = randomPowerSet(rng())), changed(), ctx.rerender()) }, '🎲 Power set'),
    ),
    activeCount > SKILL_SLOTS && h('p', { class: 'warn' }, `Only the first ${SKILL_SLOTS} active powers are usable in combat.`),
  );

  const gear = section('Gear',
    u.items.length === 0
      ? h('p', { class: 'muted' }, 'No items in this universe yet. Forge some in the Items tab.')
      : h('div', { class: 'gear-grid' },
          ...u.items.map((item) => {
            const on = c.itemIds.includes(item.id);
            return h('button', {
              class: `gear${on ? ' active' : ''}`,
              style: `--c:${RARITY_COLORS[item.rarity]}`,
              onclick: () => {
                if (on) c.itemIds = c.itemIds.filter((x) => x !== item.id);
                else if (c.itemIds.length < 4) c.itemIds.push(item.id);
                changed();
                ctx.rerender();
              },
            }, h('b', null, item.name), h('span', null, `${capitalize(item.rarity)} ${item.slot}`));
          }),
        ),
    h('p', { class: 'muted' }, `${c.itemIds.length} / 4 equipped`),
  );

  const lore = !ctx.quick && section('Backstory',
    field('Origin', textArea(() => c.origin, (v) => ((c.origin = v), ctx.changed()), 'How did they get their powers?')),
    field('Bio', textArea(() => c.bio, (v) => ((c.bio = v), ctx.changed()), 'Personality, motives, relationships...', 4)),
  );

  const actions = h('div', { class: 'row end' },
    h('button', { class: 'btn primary', onclick: () => ctx.playSandbox(null, c.id) }, '▶ Test in sandbox'),
    h('button', { class: 'btn', onclick: () => ctx.publishBundle(bundleCharacter(u, c.id)) }, 'Publish'),
    h('button', { class: 'btn', onclick: () => ctx.exportBundle(bundleCharacter(u, c.id)) }, 'Export'),
    h('button', {
      class: 'btn',
      onclick: () => {
        const copy: Character = { ...structuredClone(c), id: newId('chr'), alias: `${c.alias} (Copy)` };
        copy.powers.forEach((p) => (p.id = newId('pow')));
        u.characters.push(copy);
        ctx.selection.characters = copy.id;
        ctx.changed();
        ctx.rerender();
      },
    }, 'Duplicate'),
    deleteButton(ctx, 'character', () => removeById(u.characters, c.id)),
  );

  return h('div', { class: 'editor' }, header, appearance, stats, powers, gear, lore, actions);
}

function powerEditor(ctx: EditorContext, c: Character, p: Power, index: number, changed: () => void): HTMLElement {
  const stats = effectiveStats(c, ctx.universe.items);
  const info = h('div', { class: 'power-info' });
  const refreshInfo = () => {
    const dmg = powerDamage(p, stats, c.level, ctx.universe.rules.powerScale);
    info.textContent = p.kind === 'flight'
      ? 'Passive · press V to fly'
      : `${dmg > 0 ? `${dmg} dmg · ` : ''}${powerCooldown(p, stats)}s cooldown · ${powerCost(p)} energy`;
  };
  refreshInfo();
  const update = () => {
    refreshInfo();
    changed();
  };
  const card = h('div', { class: 'power', style: `--c:${ELEMENT_COLORS[p.element]}` },
    h('div', { class: 'power-head' },
      textInput(() => p.name, (v) => ((p.name = v), ctx.changed()), 'Power name'),
      h('button', { class: 'icon-btn', title: 'Remove power', onclick: () => (c.powers.splice(index, 1), changed(), ctx.rerender()) }, '✕'),
    ),
    h('div', { class: 'grid-3' },
      field('Type', select(POWER_KINDS, () => p.kind, (v) => ((p.kind = v), update()))),
      field('Element', select(ELEMENTS, () => p.element, (v) => {
        p.element = v;
        card.style.setProperty('--c', ELEMENT_COLORS[v]);
        update();
      })),
      field('Potency', slider(() => p.potency, (v) => ((p.potency = v), update()), 1, 10)),
    ),
    !ctx.quick && field('Description', textInput(() => p.description, (v) => ((p.description = v), ctx.changed()), 'What does it look like?', 200)),
    info,
  );
  return card;
}

function derived(label: string, value: number): HTMLElement {
  return h('div', { class: 'derived-stat' }, h('span', null, label), h('b', null, value.toLocaleString()));
}
