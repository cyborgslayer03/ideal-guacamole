// Locations and factions: the places and powers that shape a universe.

import { randomFaction, randomLocation } from '../../core/generator';
import { newId } from '../../core/id';
import { Rng, randomSeed } from '../../core/rng';
import type { RuleKey } from '../../core/rules';
import { BIOMES, ROLES, type Faction, type Location } from '../../core/types';
import { deleteButton, listDetail, removeById, type EditorContext } from '../context';
import { h } from '../dom';
import { capitalize, chips, colorInput, field, section, select, slider, textArea, textInput } from '../forms';

export function locationsTab(ctx: EditorContext): HTMLElement {
  const u = ctx.universe;
  return listDetail(ctx, {
    key: 'locations',
    items: u.locations,
    noun: 'Location',
    label: (l) => l.name,
    sub: (l) => capitalize(l.biome),
    color: (l) => l.glowColor,
    create: () => ({ ...randomLocation(new Rng(randomSeed()), 'metropolis'), name: 'New Location' }),
    random: () => randomLocation(new Rng(randomSeed())),
    detail: (l) => locationEditor(ctx, l),
    empty: 'No locations yet. Battles need a battlefield!',
  });
}

function locationEditor(ctx: EditorContext, l: Location): HTMLElement {
  const u = ctx.universe;
  return h('div', { class: 'editor' },
    section('Location',
      h('div', { class: 'location-swatch', style: `background:linear-gradient(180deg, ${l.skyColor}, ${l.groundColor}); --c:${l.glowColor}` }, h('span', null, l.name)),
      field('Name', textInput(() => l.name, (v) => ((l.name = v), ctx.changed()))),
      field('Biome', chips(BIOMES, () => l.biome, (v) => {
        // Switching biome adopts its palette so it looks right instantly.
        const fresh = randomLocation(new Rng(randomSeed()), v);
        Object.assign(l, { biome: v, skyColor: fresh.skyColor, groundColor: fresh.groundColor, glowColor: fresh.glowColor });
        ctx.changed();
        ctx.rerender();
      })),
      field('Density', slider(() => l.density, (v) => ((l.density = v), ctx.changed()), 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`), 'How many structures fill the arena.'),
      !ctx.quick && h('div', { class: 'grid-3' },
        field('Sky', colorInput(() => l.skyColor, (v) => ((l.skyColor = v), ctx.changed()))),
        field('Ground', colorInput(() => l.groundColor, (v) => ((l.groundColor = v), ctx.changed()))),
        field('Glow', colorInput(() => l.glowColor, (v) => ((l.glowColor = v), ctx.changed()))),
      ),
      !ctx.quick && field('Description', textArea(() => l.description, (v) => ((l.description = v), ctx.changed()))),
    ),
    localLaws(ctx, l),
    h('div', { class: 'row end' },
      u.characters.length > 0 && h('button', { class: 'btn primary', onclick: () => ctx.playSandbox(l.id, u.characters[0].id) }, '▶ Visit in sandbox'),
      deleteButton(ctx, 'location', () => removeById(u.locations, l.id)),
    ),
  );
}

const LAW_INFO: { key: RuleKey; label: string; min: number; max: number; hint: string }[] = [
  { key: 'gravity', label: 'Gravity', min: 0.2, max: 2, hint: 'Low gravity means floaty jumps and long leaps.' },
  { key: 'powerScale', label: 'Power scale', min: 0.5, max: 3, hint: 'Some places amplify or dampen superpowers.' },
  { key: 'enemyDensity', label: 'Enemy density', min: 0.5, max: 2, hint: 'How crowded fights get here.' },
];

/** Per-location overrides of the universe's laws of reality. */
function localLaws(ctx: EditorContext, l: Location): HTMLElement {
  const u = ctx.universe;
  return section('Local laws',
    h('p', { class: 'muted' }, 'Override the universe’s laws of reality in this one place. Everything else follows the Universe tab. Sandbox sessions can override these again.'),
    ...LAW_INFO.map((law) => {
      const on = l.rules[law.key] !== undefined;
      return h('div', { class: 'law-row' },
        h('label', { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: on,
            onchange: (e: Event) => {
              if ((e.target as HTMLInputElement).checked) l.rules[law.key] = u.rules[law.key];
              else delete l.rules[law.key];
              ctx.changed();
              ctx.rerender();
            },
          }),
          h('span', null, `${law.label}${on ? '' : ` (universe: ${u.rules[law.key].toFixed(2)}×)`}`),
        ),
        on && slider(() => l.rules[law.key] ?? u.rules[law.key], (v) => ((l.rules[law.key] = v), ctx.changed()), law.min, law.max, 0.05, (v) => `${v.toFixed(2)}×`),
        on && h('span', { class: 'field-hint' }, law.hint),
      );
    }),
  );
}

export function factionsTab(ctx: EditorContext): HTMLElement {
  const u = ctx.universe;
  return listDetail(ctx, {
    key: 'factions',
    items: u.factions,
    noun: 'Faction',
    label: (f) => f.name,
    sub: (f) => `${capitalize(f.alignment)} · ${u.characters.filter((c) => c.factionId === f.id).length} members`,
    color: (f) => f.color,
    create: (): Faction => ({ id: newId('fac'), name: 'New Faction', color: '#3e9bff', alignment: 'hero', description: '', leaderId: null }),
    random: () => randomFaction(new Rng(randomSeed()), new Rng(randomSeed()).pick(ROLES)),
    detail: (f) => factionEditor(ctx, f),
    empty: 'No factions yet. Teams, empires, secret societies...',
  });
}

function factionEditor(ctx: EditorContext, f: Faction): HTMLElement {
  const u = ctx.universe;
  const members = u.characters.filter((c) => c.factionId === f.id);
  return h('div', { class: 'editor' },
    section('Faction',
      field('Name', textInput(() => f.name, (v) => ((f.name = v), ctx.changed()))),
      field('Alignment', chips(ROLES, () => f.alignment, (v) => ((f.alignment = v), ctx.changed()))),
      field('Color', colorInput(() => f.color, (v) => ((f.color = v), ctx.changed())), 'Enemy troops of this faction wear this color.'),
      field('Leader', select(
        [{ value: '', label: '— Strongest member —' }, ...members.map((c) => ({ value: c.id, label: c.alias }))],
        () => f.leaderId ?? '',
        (v) => ((f.leaderId = v || null), ctx.changed()),
      ), 'Who commands the faction when a new campaign starts. Other members become lieutenants and may take over if the leader falls.'),
      !ctx.quick && field('Description', textArea(() => f.description, (v) => ((f.description = v), ctx.changed()))),
    ),
    section('Members',
      members.length
        ? h('div', { class: 'tags' }, ...members.map((c) => h('span', { class: 'tag', style: `--c:${c.appearance.primary}` }, c.alias)))
        : h('p', { class: 'muted' }, 'Assign characters to this faction from the Characters tab.'),
    ),
    h('div', { class: 'row end' }, deleteButton(ctx, 'faction', () => removeById(u.factions, f.id))),
  );
}
