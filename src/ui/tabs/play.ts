import { combatPower, ELEMENT_COLORS } from '../../core/rules';
import { capitalize } from '../forms';
import type { EditorContext } from '../context';
import { h } from '../dom';

/** Mission select: pick a character, then a story chapter or the sandbox. */
export function playTab(ctx: EditorContext): HTMLElement {
  const u = ctx.universe;
  if (!u.characters.length) {
    return h('div', { class: 'empty' }, 'Create at least one character to play.', h('br'),
      h('button', { class: 'btn primary', onclick: () => ctx.openTab('characters') }, 'Go to Characters'));
  }
  const selected = u.characters.find((c) => c.id === ctx.selection.play) ?? u.characters.find((c) => c.role !== 'villain') ?? u.characters[0];
  ctx.selection.play = selected.id;

  const roster = h('div', { class: 'roster' },
    ...u.characters.map((c) =>
      h('button', {
        class: `roster-card${c === selected ? ' active' : ''}`,
        style: `--c:${c.appearance.primary}; --a:${c.appearance.accent}`,
        onclick: () => ((ctx.selection.play = c.id), ctx.rerender()),
      },
      h('div', { class: 'roster-emblem' }, c.alias.slice(0, 1)),
      h('div', { class: 'roster-name' }, c.alias),
      h('div', { class: 'roster-meta' }, `Lv ${c.level} · ${capitalize(c.role)}`),
      h('div', { class: 'roster-cp' }, `CP ${combatPower(c, u.items).toLocaleString()}`),
      h('div', { class: 'roster-powers' }, ...c.powers.slice(0, 5).map((p) => h('i', { style: `background:${ELEMENT_COLORS[p.element]}`, title: p.name }))),
      ),
    ),
  );

  const missions = h('div', { class: 'missions' },
    h('button', {
      class: 'mission sandbox',
      onclick: () => ctx.play({ type: 'sandbox', locationId: null }, selected.id),
    }, h('b', null, 'Omni Sandbox'), h('span', null, 'Free play. Spawn enemies, summon bosses, bend reality.')),
    ...u.stories.map((s) =>
      h('div', { class: 'mission-story' },
        h('div', { class: 'mission-title' }, s.title),
        s.synopsis && h('p', { class: 'muted' }, s.synopsis),
        h('div', { class: 'chapters' },
          ...s.chapters.map((ch, i) =>
            h('button', {
              class: 'mission',
              onclick: () => ctx.play({ type: 'story', storyId: s.id, chapter: i }, selected.id),
            },
            h('b', null, `${i + 1}. ${ch.title}`),
            h('span', null, `${objectiveLabel(ch.objective.type)} · Enemy Lv ${ch.enemyLevel}`)),
          ),
        ),
      ),
    ),
    u.stories.length === 0 && h('p', { class: 'muted' }, 'No stories yet — write one in the Stories tab.'),
  );

  return h('div', { class: 'play' },
    h('h3', { class: 'panel-title' }, 'Choose your hero'), roster,
    h('h3', { class: 'panel-title' }, 'Choose your mission'), missions,
  );
}

function objectiveLabel(type: string) {
  return type === 'boss' ? 'Boss fight' : type === 'survive' ? 'Survival' : 'Assault';
}
