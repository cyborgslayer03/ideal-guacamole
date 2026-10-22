import { randomStory } from '../../core/generator';
import { newId } from '../../core/id';
import { Rng, randomSeed } from '../../core/rng';
import { bundleStory } from '../../core/share';
import type { Chapter, DialogueLine, Objective, Story } from '../../core/types';
import { deleteButton, listDetail, removeById, type EditorContext } from '../context';
import { h } from '../dom';
import { chips, field, section, select, slider, textArea, textInput } from '../forms';

function blankChapter(ctx: EditorContext): Chapter {
  const u = ctx.universe;
  return {
    id: newId('chp'),
    title: 'New Chapter',
    locationId: u.locations[0]?.id ?? '',
    intro: [{ speaker: 'Narrator', text: 'Trouble is brewing...' }],
    objective: { type: 'defeat', count: 10 },
    enemyFactionId: u.factions.find((f) => f.alignment === 'villain')?.id ?? null,
    enemyLevel: 1,
    outro: [],
    rewardItemId: null,
  };
}

export function storiesTab(ctx: EditorContext): HTMLElement {
  const u = ctx.universe;
  return listDetail(ctx, {
    key: 'stories',
    items: u.stories,
    noun: 'Story',
    label: (s) => s.title,
    sub: (s) => `${s.chapters.length} chapter${s.chapters.length === 1 ? '' : 's'}`,
    create: (): Story => ({ id: newId('sty'), title: 'New Story', synopsis: '', protagonistId: u.characters[0]?.id ?? null, chapters: [blankChapter(ctx)] }),
    random: () => randomStory(new Rng(randomSeed()), u),
    detail: (s) => storyEditor(ctx, s),
    empty: 'No stories yet. Write a saga, or generate one from your characters with 🎲.',
  });
}

function storyEditor(ctx: EditorContext, s: Story): HTMLElement {
  const u = ctx.universe;
  const heroOptions = [{ value: '', label: '— Player chooses —' }, ...u.characters.map((c) => ({ value: c.id, label: c.alias }))];
  const protagonist = u.characters.find((c) => c.id === s.protagonistId) ?? u.characters[0];

  return h('div', { class: 'editor' },
    section('Story',
      field('Title', textInput(() => s.title, (v) => ((s.title = v), ctx.changed()))),
      field('Synopsis', textArea(() => s.synopsis, (v) => ((s.synopsis = v), ctx.changed()), 'What is this story about?', 2)),
      field('Protagonist', select(heroOptions, () => s.protagonistId ?? '', (v) => ((s.protagonistId = v || null), ctx.changed()))),
    ),
    ...s.chapters.map((ch, i) => chapterEditor(ctx, s, ch, i)),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => (s.chapters.push(blankChapter(ctx)), ctx.changed(), ctx.rerender()) }, '+ Chapter'),
    ),
    h('div', { class: 'row end' },
      protagonist && s.chapters.length > 0 &&
        h('button', { class: 'btn primary', onclick: () => ctx.play({ type: 'story', storyId: s.id, chapter: 0 }, protagonist.id) }, '▶ Play story'),
      h('button', { class: 'btn', onclick: () => ctx.exportBundle(bundleStory(u, s.id)) }, 'Export'),
      deleteButton(ctx, 'story', () => removeById(u.stories, s.id)),
    ),
  );
}

function chapterEditor(ctx: EditorContext, s: Story, ch: Chapter, index: number): HTMLElement {
  const u = ctx.universe;
  const move = (delta: number) => {
    const j = index + delta;
    if (j < 0 || j >= s.chapters.length) return;
    [s.chapters[index], s.chapters[j]] = [s.chapters[j], s.chapters[index]];
    ctx.changed();
    ctx.rerender();
  };
  const locationOptions = [{ value: '', label: '— Default —' }, ...u.locations.map((l) => ({ value: l.id, label: l.name }))];
  const factionOptions = [{ value: '', label: '— Generic thugs —' }, ...u.factions.map((f) => ({ value: f.id, label: f.name }))];
  const rewardOptions = [{ value: '', label: '— None —' }, ...u.items.map((i) => ({ value: i.id, label: i.name }))];
  const villains = u.characters;

  const setObjective = (type: Objective['type']) => {
    if (type === 'defeat') ch.objective = { type, count: 10 };
    else if (type === 'survive') ch.objective = { type, seconds: 60 };
    else if (villains.length) ch.objective = { type, characterId: (villains.find((c) => c.role === 'villain') ?? villains[0]).id };
    ctx.changed();
    ctx.rerender();
  };

  const obj = ch.objective;
  const objectiveParam =
    obj.type === 'defeat' ? field('Enemies to defeat', slider(() => obj.count, (v) => ((obj.count = v), ctx.changed()), 1, 100))
    : obj.type === 'survive' ? field('Seconds to survive', slider(() => obj.seconds, (v) => ((obj.seconds = v), ctx.changed()), 10, 600, 5))
    : field('Boss', select(villains.map((c) => ({ value: c.id, label: c.alias })), () => obj.characterId, (v) => ((obj.characterId = v), ctx.changed())));

  return section(`Chapter ${index + 1}`,
    h('div', { class: 'row chapter-tools' },
      h('button', { class: 'icon-btn', title: 'Move up', onclick: () => move(-1) }, '▲'),
      h('button', { class: 'icon-btn', title: 'Move down', onclick: () => move(1) }, '▼'),
      h('button', { class: 'icon-btn', title: 'Remove chapter', onclick: () => (s.chapters.splice(index, 1), ctx.changed(), ctx.rerender()) }, '✕'),
    ),
    field('Title', textInput(() => ch.title, (v) => ((ch.title = v), ctx.changed()))),
    h('div', { class: 'grid-2' },
      field('Location', select(locationOptions, () => ch.locationId, (v) => ((ch.locationId = v), ctx.changed()))),
      field('Enemy faction', select(factionOptions, () => ch.enemyFactionId ?? '', (v) => ((ch.enemyFactionId = v || null), ctx.changed()))),
    ),
    field('Objective', chips(
      [{ value: 'defeat', label: 'Defeat' }, { value: 'survive', label: 'Survive' }, ...(villains.length ? [{ value: 'boss' as const, label: 'Boss fight' }] : [])],
      () => obj.type,
      setObjective,
    )),
    objectiveParam,
    h('div', { class: 'grid-2' },
      field('Enemy level', slider(() => ch.enemyLevel, (v) => ((ch.enemyLevel = v), ctx.changed()), 1, 60)),
      field('Reward', select(rewardOptions, () => ch.rewardItemId ?? '', (v) => ((ch.rewardItemId = v || null), ctx.changed()))),
    ),
    ctx.quick
      ? h('p', { class: 'muted' }, `${ch.intro.length + ch.outro.length} dialogue lines · switch to Full detail to write dialogue`)
      : [dialogueEditor(ctx, 'Intro dialogue', ch.intro), dialogueEditor(ctx, 'Outro dialogue', ch.outro)],
  );
}

function dialogueEditor(ctx: EditorContext, title: string, lines: DialogueLine[]): HTMLElement {
  const speakers = [...new Set(['Narrator', 'Command', ...ctx.universe.characters.map((c) => c.alias)])];
  const listId = newId('spk');
  return h('div', { class: 'dialogue-edit' },
    h('div', { class: 'field-label' }, title),
    h('datalist', { id: listId }, ...speakers.map((sp) => h('option', { value: sp }))),
    ...lines.map((line, i) =>
      h('div', { class: 'dialogue-line' },
        h('input', { type: 'text', value: line.speaker, placeholder: 'Speaker', list: listId, maxLength: 80, oninput: (e: Event) => ((line.speaker = (e.target as HTMLInputElement).value), ctx.changed()) }),
        h('input', { type: 'text', value: line.text, placeholder: 'Line...', maxLength: 600, oninput: (e: Event) => ((line.text = (e.target as HTMLInputElement).value), ctx.changed()) }),
        h('button', { class: 'icon-btn', onclick: () => (lines.splice(i, 1), ctx.changed(), ctx.rerender()) }, '✕'),
      ),
    ),
    h('button', { class: 'btn small', onclick: () => (lines.push({ speaker: lines[lines.length - 1]?.speaker ?? 'Narrator', text: '' }), ctx.changed(), ctx.rerender()) }, '+ Line'),
  );
}
