// Locations and factions: the places and powers that shape a universe.

import { randomFaction, randomLocation } from '../../core/generator';
import { newId } from '../../core/id';
import { Rng, randomSeed } from '../../core/rng';
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
    h('div', { class: 'row end' },
      u.characters.length > 0 && h('button', { class: 'btn primary', onclick: () => ctx.playSandbox(l.id, u.characters[0].id) }, '▶ Visit in sandbox'),
      deleteButton(ctx, 'location', () => removeById(u.locations, l.id)),
    ),
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
