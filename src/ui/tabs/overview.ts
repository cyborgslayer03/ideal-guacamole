import { randomCharacter, randomFaction, randomItem, randomLocation, randomStory } from '../../core/generator';
import { Rng, randomSeed } from '../../core/rng';
import { bundleUniverse, mergeBundle, parseBundle, BundleError } from '../../core/share';
import type { EditorContext } from '../context';
import { h, pickFile, toast } from '../dom';
import { colorInput, field, section, slider, textArea, textInput } from '../forms';

export function overviewTab(ctx: EditorContext): HTMLElement {
  const u = ctx.universe;
  const rng = () => new Rng(randomSeed());
  const add = (label: string, fn: () => void) =>
    h('button', { class: 'btn', onclick: () => (fn(), ctx.changed(), ctx.rerender(), toast(`${label} added`)) }, `🎲 ${label}`);

  const counts = [
    ['Characters', u.characters.length, 'characters'],
    ['Stories', u.stories.length, 'stories'],
    ['Locations', u.locations.length, 'locations'],
    ['Items', u.items.length, 'items'],
    ['Factions', u.factions.length, 'factions'],
  ] as const;

  return h('div', { class: 'editor' },
    h('div', { class: 'stat-cards' },
      ...counts.map(([label, n, tab]) => h('button', { class: 'stat-card', onclick: () => ctx.openTab(tab) }, h('b', null, String(n)), h('span', null, label))),
    ),
    section('Identity',
      field('Universe name', textInput(() => u.name, (v) => ((u.name = v), ctx.changed()))),
      field('Tagline', textInput(() => u.tagline, (v) => ((u.tagline = v), ctx.changed()), 'One line that sells it', 200)),
      field('Creator', textInput(() => u.author, (v) => ((u.author = v), ctx.changed()), 'Your name or handle')),
      field('Theme color', colorInput(() => u.accent, (v) => ((u.accent = v), ctx.changed()))),
      !ctx.quick && field('Description', textArea(() => u.description, (v) => ((u.description = v), ctx.changed()), 'History, tone, the state of the world...', 5)),
    ),
    section('Laws of reality',
      h('p', { class: 'muted' }, 'As the One Above All, you decide how this universe works.'),
      field('Power scale', slider(() => u.rules.powerScale, (v) => ((u.rules.powerScale = v), ctx.changed()), 0.5, 3, 0.05, (v) => `${v.toFixed(2)}×`), 'Multiplies all superpower damage.'),
      field('Gravity', slider(() => u.rules.gravity, (v) => ((u.rules.gravity = v), ctx.changed()), 0.2, 2, 0.05, (v) => `${v.toFixed(2)}×`)),
      field('Enemy density', slider(() => u.rules.enemyDensity, (v) => ((u.rules.enemyDensity = v), ctx.changed()), 0.5, 2, 0.05, (v) => `${v.toFixed(2)}×`), 'How many foes appear in missions.'),
    ),
    section('Quick add',
      h('p', { class: 'muted' }, 'Short on time? Roll new content into this universe instantly.'),
      h('div', { class: 'row wrap' },
        add('Hero', () => u.characters.push(randomCharacter(rng(), 'hero', u.factions.find((f) => f.alignment === 'hero')?.id ?? null))),
        add('Villain', () => u.characters.push(randomCharacter(rng(), 'villain', u.factions.find((f) => f.alignment === 'villain')?.id ?? null))),
        add('Location', () => u.locations.push(randomLocation(rng()))),
        add('Item', () => u.items.push(randomItem(rng()))),
        add('Faction', () => u.factions.push(randomFaction(rng(), rng().pick(['hero', 'villain'] as const)))),
        add('Story', () => u.stories.push(randomStory(rng(), u))),
      ),
    ),
    section('Share',
      h('p', { class: 'muted' }, 'Export bundles to share with friends. Import characters, items, stories, or whole universes made by others.'),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn', onclick: () => ctx.exportBundle(bundleUniverse(u)) }, 'Export universe'),
        h('button', {
          class: 'btn',
          onclick: async () => {
            const text = await pickFile();
            if (!text) return;
            try {
              const bundle = parseBundle(text);
              mergeBundle(u, bundle);
              ctx.changed();
              ctx.rerender();
              toast(`Imported ${bundle.kind} “${bundle.name}”`);
            } catch (e) {
              toast(e instanceof BundleError ? e.message : 'Import failed.', 'error');
            }
          },
        }, 'Import into this universe'),
      ),
    ),
  );
}
