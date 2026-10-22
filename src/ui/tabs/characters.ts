import { randomAppearance, randomCharacter, randomPower, randomPowerSet, randomStats, randomAlias } from '../../core/generator';
import { newId } from '../../core/id';
import { Rng, randomSeed } from '../../core/rng';
import {
  ELEMENT_COLORS, RARITY_COLORS, SKILL_SLOTS, basicDamage, combatPower, effectiveStats, maxEnergy, maxHealth,
  POWER_INFO, POWER_LABELS, portalLife, travelRange, leapSlamRadius, powerCooldown, powerCost, powerDamage, regenRate, speedMultiplier, teleportRange,
} from '../../core/rules';
import { bundleCharacter } from '../../core/share';
import {
  BUILDS, ELEMENTS, EMBLEMS, HEAD_STYLES, MOVEMENT_KINDS, POWER_KINDS, ROLES, STAT_KEYS, isMovement, isTravel, takesSkillSlot,
  type Character, type MovementKind, type Power, type PowerKind, type StatKey, type Stats,
} from '../../core/types';
import { deleteButton, listDetail, removeById, type EditorContext } from '../context';
import { h, toast } from '../dom';
import { checkbox, chips, colorInput, field, section, select, slider, textArea, textInput, capitalize } from '../forms';
import { getPreview } from '../preview';
import { modelSection } from '../model-editor';
import { itemSummary } from '../armory';
import { MASTERY_TIERS, boostedPower, loadoutFor, masteryPicks, setMastery, unspentMastery } from '../../core/progression';
import { overlay } from '../overlay';
import { LEGENDS, legendCharacter, type LegendSpec } from '../../core/roster';

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
      model: null,
    },
    itemIds: [],
    level: 1,
    xp: 0,
    mastery: {},
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
    empty: 'No characters yet. Create one, roll a random one with 🎲, or recruit a ready-made Legend.',
    actions: h('button', { class: 'btn', title: 'Add a ready-made hero or villain', onclick: () => openLegendPicker(ctx) }, '★ Legends'),
  });
}

const MOVE_BADGE: Partial<Record<PowerKind, string>> = { flight: 'Flight', teleport: 'Teleport', superspeed: 'Super Speed', leap: 'Super Leap', swing: 'Web Swing', portal: 'Portal' };

/** Pick ready-made heroes and villains to add to this universe. */
function openLegendPicker(ctx: EditorContext) {
  const u = ctx.universe;
  const added: string[] = [];
  const card = (spec: LegendSpec) => {
    const owned = () => u.characters.some((c) => c.alias === spec.alias);
    const moves = spec.powers.filter((p) => isMovement(p.kind)).map((p) => MOVE_BADGE[p.kind]);
    const btn = h('button', {
      class: 'legend-card',
      style: `--p:${spec.appearance.primary}; --a:${spec.appearance.accent}`,
      onclick: () => {
        const faction = u.factions.find((f) => f.alignment === spec.role);
        const c = legendCharacter(spec, faction?.id ?? null);
        u.characters.push(c);
        ctx.selection.characters = c.id;
        added.push(spec.alias);
        btn.classList.add('owned');
        ctx.changed();
        toast(`${spec.alias} joined ${u.name}`);
      },
    },
    h('span', { class: 'hub-face' }, spec.alias.slice(0, 1)),
    h('span', { class: 'legend-text' },
      h('b', null, spec.alias),
      h('span', { class: 'muted small' }, spec.style),
      h('span', { class: 'legend-tags' },
        ...moves.map((m) => h('span', { class: 'bond', style: '--c:#3ee8ff' }, m)),
        ...spec.powers.filter((p) => !isMovement(p.kind)).map((p) => h('i', { class: 'legend-dot', style: `background:${ELEMENT_COLORS[p.element]}`, title: `${p.name} (${POWER_LABELS[p.kind]})` })),
      ),
    ));
    if (owned()) btn.classList.add('owned');
    return btn;
  };
  overlay('Legends', h('div', { class: 'legend-picker' },
    h('p', { class: 'muted' }, 'Ready-made heroes and villains, each with their own powers and way of moving. Click to add one to this universe; you can edit them afterwards.'),
    h('div', { class: 'field-label' }, 'Heroes'),
    h('div', { class: 'legend-grid' }, ...LEGENDS.filter((l) => l.role !== 'villain').map(card)),
    h('div', { class: 'field-label' }, 'Villains'),
    h('div', { class: 'legend-grid' }, ...LEGENDS.filter((l) => l.role === 'villain').map(card)),
  ), [{ label: 'Done', primary: true, onClick: () => {} }], { wide: true, onClose: () => added.length && ctx.rerender() });
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
    h('button', { class: 'btn small', onclick: () => ((c.appearance = { ...randomAppearance(rng()), model: c.appearance.model }), ctx.changed(), ctx.rerender()) }, '🎲 Random costume'),
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

  const activeCount = c.powers.filter((p) => takesSkillSlot(p.kind)).length;
  const travelPowers = c.powers.filter((p) => isTravel(p.kind));
  const addMovement = (kind: MovementKind) => {
    c.powers.push(randomPower(rng(), kind, c.powers[0]?.element));
    changed();
    ctx.rerender();
  };
  const unspent = unspentMastery(c);
  const powers = section('Powers',
    unspent > 0 && h('p', { class: 'mastery-badge' }, `★ ${unspent} mastery ${unspent === 1 ? 'choice' : 'choices'} available below`),
    h('p', { class: 'muted' }, `Up to ${SKILL_SLOTS} attack and support powers map to Q E R F. Movement powers go on V (Flight, Teleport, Super Leap, Web Swing, Portal; hold V to aim); Super Speed and Healing Factor are always on.`),
    ...c.powers.map((p, i) => powerEditor(ctx, c, p, i, changed)),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: () => (c.powers.push(randomPower(rng())), changed(), ctx.rerender()) }, '+ Power'),
      h('button', { class: 'btn small', onclick: () => ((c.powers = randomPowerSet(rng())), changed(), ctx.rerender()) }, '🎲 Power set'),
    ),
    h('div', { class: 'row' },
      h('span', { class: 'field-label' }, 'Add movement'),
      // One V-button power (flight/teleport/leap) at a time; Super Speed stacks with any of them.
      ...MOVEMENT_KINDS.filter((k) => !c.powers.some((p) => p.kind === k) && (k === 'superspeed' || !travelPowers.length)).map((k) =>
        h('button', { class: 'chip', onclick: () => addMovement(k) }, `+ ${MOVEMENT_LABELS[k]}`),
      ),
    ),
    activeCount > SKILL_SLOTS && h('p', { class: 'warn' }, `Only the first ${SKILL_SLOTS} attack and support powers are usable in combat.`),
    travelPowers.length > 1 && h('p', { class: 'warn' }, `Only one of Flight, Teleport, Super Leap, Web Swing, or Portal works on V. ${travelPowers[0].name} is used; remove it to use ${travelPowers[1].name}.`),
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
            }, itemSummary(item));
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

  const model = modelSection(ctx, c, appearanceChanged);

  return h('div', { class: 'editor' }, header, appearance, model, stats, powers, gear, lore, actions);
}

const MOVEMENT_LABELS: Record<MovementKind, string> = {
  flight: 'Flight',
  teleport: 'Teleport',
  superspeed: 'Super Speed',
  leap: 'Super Leap',
  swing: 'Web Swing',
  portal: 'Portal',
};

function powerEditor(ctx: EditorContext, c: Character, p: Power, index: number, changed: () => void): HTMLElement {
  const stats = effectiveStats(c, ctx.universe.items);
  const info = h('div', { class: 'power-info' });
  const refreshInfo = () => {
    const dmg = powerDamage(p, stats, c.level, ctx.universe.rules.powerScale);
    switch (p.kind) {
      case 'flight':
        info.textContent = 'Movement · V to take off and land';
        break;
      case 'superspeed':
        info.textContent = `Passive · run ${Math.round((speedMultiplier([p]) - 1) * 100)}% faster`;
        break;
      case 'teleport':
        info.textContent = `Movement · V to blink ${Math.round(teleportRange(p))}m · ${dmg} dmg on arrival · ${powerCooldown(p, stats)}s cooldown`;
        break;
      case 'leap':
        info.textContent = `Movement · V to leap · ${dmg} dmg landing slam (${leapSlamRadius(p).toFixed(1)}m) · ${powerCooldown(p, stats)}s cooldown`;
        break;
      case 'swing':
        info.textContent = `Movement · V to swing (hold V to aim), chain swings in the air · ${powerCooldown(p, stats)}s cooldown`;
        break;
      case 'portal':
        info.textContent = `Movement · hold V to aim a portal up to ${Math.round(travelRange(p))}m away; open ${Math.round(portalLife(p))}s for allies and enemies alike · ${powerCooldown(p, stats)}s cooldown`;
        break;
      case 'regeneration':
        info.textContent = `Passive · heal ${(regenRate([p]) * 100).toFixed(1)}% health per second when not taking damage`;
        break;
      default: {
        // Show the numbers with mastery and gear applied.
        const m = loadoutFor(c, ctx.universe.items).mods[p.id];
        const bp = m ? boostedPower(p, m) : p;
        const d = Math.round(powerDamage(bp, stats, c.level, ctx.universe.rules.powerScale) * (m?.damage ?? 1));
        const cd = Math.round(powerCooldown(bp, stats) * (m?.cooldown ?? 1) * 10) / 10;
        info.textContent = `${POWER_INFO[p.kind]} ${d > 0 ? `${d} dmg · ` : ''}${cd}s cooldown · ${Math.round(powerCost(bp) * (m?.cost ?? 1))} energy`;
      }
    }
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
      field('Type', select(POWER_KINDS.map((k) => ({ value: k, label: POWER_LABELS[k] })), () => p.kind, (v) => ((p.kind = v), update()))),
      field('Element', select(ELEMENTS, () => p.element, (v) => {
        p.element = v;
        card.style.setProperty('--c', ELEMENT_COLORS[v]);
        update();
      })),
      field('Potency', slider(() => p.potency, (v) => ((p.potency = v), update()), 1, 10)),
    ),
    !ctx.quick && field('Description', textInput(() => p.description, (v) => ((p.description = v), ctx.changed()), 'What does it look like?', 200)),
    info,
    takesSkillSlot(p.kind) && masteryTree(c, p, update),
  );
  return card;
}

function derived(label: string, value: number): HTMLElement {
  return h('div', { class: 'derived-stat' }, h('span', null, label), h('b', null, value.toLocaleString()));
}

/** Three tiers per power, unlocked by level; pick one option in each. Picks can be changed any time. */
function masteryTree(c: Character, p: Power, changed: () => void): HTMLElement {
  const wrap = h('div', { class: 'mastery' });
  const render = () => {
    const picks = c.mastery[p.id] ?? [];
    wrap.replaceChildren(
      h('div', { class: 'field-label' }, `Mastery${masteryPicks(c, p).length ? ` · ${masteryPicks(c, p).length}/${MASTERY_TIERS.length}` : ''}`),
      ...MASTERY_TIERS.map((tier, i) => {
        const locked = c.level < tier.level;
        return h('div', { class: 'mastery-tier' },
          h('span', { class: 'tier-label' }, locked ? `🔒 Lv ${tier.level}` : `Lv ${tier.level}`),
          ...tier.options.map((opt, j) => {
            const value = (j + 1) as 1 | 2;
            const active = picks[i] === value;
            return h('button', {
              type: 'button',
              class: `mastery-opt${active && !locked ? ' active' : ''}`,
              disabled: locked,
              title: locked ? `Reach level ${tier.level} to unlock` : '',
              onclick: () => {
                setMastery(c, p.id, i, active ? 0 : value);
                render();
                changed();
              },
            }, h('b', null, opt.label), opt.text);
          }),
        );
      }),
    );
  };
  render();
  return wrap;
}
