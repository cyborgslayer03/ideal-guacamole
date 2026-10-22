// The War Table: campaign hub with the mission board, hero and companion
// selection, faction hierarchies, relationships, and the world chronicle.

import {
  availableAllies, bond, factionOf, isHostile, missionBoard, passTime, playableHeroes, relationOf,
  type Bond, type Mission, type MissionKind, type NewsItem,
} from '../../core/campaign';
import { RARITY_COLORS, combatPower, ELEMENT_COLORS } from '../../core/rules';
import type { Character } from '../../core/types';
import type { EditorContext } from '../context';
import { h } from '../dom';
import { capitalize } from '../forms';

const KIND_META: Record<MissionKind, { label: string; color: string; icon: string }> = {
  story: { label: 'Story', color: '#ffc23e', icon: '✎' },
  patrol: { label: 'Patrol', color: '#3ee8ff', icon: '⌖' },
  raid: { label: 'Raid', color: '#ff3e5c', icon: '☠' },
  hunt: { label: 'Hunt', color: '#ff8a3e', icon: '◎' },
  vendetta: { label: 'Vendetta', color: '#b05cff', icon: '⚔' },
  ally: { label: 'Ally', color: '#3eff8b', icon: '✚' },
  defense: { label: 'Defense', color: '#3e9bff', icon: '⛨' },
};

const BOND_COLORS: Record<Bond, string> = {
  nemesis: '#ff3e5c',
  rival: '#ff8a3e',
  neutral: '#8a9ac0',
  friend: '#3ee8ff',
  ally: '#3eff8b',
};

const NEWS_ICONS: Record<NewsItem['kind'], string> = {
  mission: '◆', succession: '♛', nemesis: '⚔', ally: '✚', escape: '⛓', faction: '⚑', story: '✎', betrayal: '⚠',
};

/** Relationship badge; villains with no personal history read as plain "Hostile". */
function bondTag(ctx: EditorContext, ch: Character) {
  const b = bond(relationOf(ctx.campaign, ch.id));
  const label = b === 'neutral' && isHostile(ctx.campaign, ch) ? 'Hostile' : capitalize(b);
  return h('span', { class: 'bond', style: `--c:${label === 'Hostile' ? '#ff6a6a' : BOND_COLORS[b]}` }, label);
}

export function playTab(ctx: EditorContext): HTMLElement {
  const u = ctx.universe;
  const c = ctx.campaign;
  if (!u.characters.length) {
    return h('div', { class: 'empty' }, 'Create at least one character to play.', h('br'),
      h('button', { class: 'btn primary', onclick: () => ctx.openTab('characters') }, 'Go to Characters'));
  }
  const heroes = playableHeroes(c, u);
  const hero = heroes.find((x) => x.id === ctx.selection.play) ?? heroes.find((x) => x.role === 'hero') ?? heroes[0];
  if (hero) ctx.selection.play = hero.id;
  const allies = hero ? availableAllies(c, u, hero.id) : [];
  const companion = allies.find((a) => a.id === ctx.selection.companion) ?? null;
  ctx.selection.companion = companion?.id ?? null;

  const showReport = (title: string, victory: boolean, news: NewsItem[]) => {
    ctx.report = { title, victory, news };
    ctx.rerender();
  };

  // --- Report from the last mission or time skip.
  const report = ctx.report && h('section', { class: `panel report ${ctx.report.victory ? 'win' : 'loss'}` },
    h('div', { class: 'report-head' },
      h('h3', { class: 'panel-title' }, ctx.report.title),
      h('button', { class: 'icon-btn', title: 'Dismiss', onclick: () => ((ctx.report = null), ctx.rerender()) }, '✕'),
    ),
    ctx.report.news.length ? newsList(ctx.report.news) : h('p', { class: 'muted' }, 'Nothing else changed.'),
  );

  const header = h('div', { class: 'war-head' },
    h('div', null,
      h('div', { class: 'war-kicker' }, 'War Table'),
      h('div', { class: 'war-turn' }, `Turn ${c.turn}`),
    ),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn',
        title: 'Advance the world one turn without a mission',
        onclick: () => {
          const news = passTime(c, u);
          ctx.saveCampaign();
          showReport('Time passes…', true, news);
        },
      }, '⏳ Pass time'),
      h('button', { class: 'btn', onclick: () => hero && ctx.playSandbox(null, hero.id) }, 'Omni Sandbox'),
      !ctx.quick && h('button', {
        class: 'btn danger',
        onclick: () => {
          if (!confirm('Reset the campaign? Relationships, factions, and story progress start over. Characters keep their levels.')) return;
          ctx.resetCampaign();
          ctx.report = null;
          ctx.rerender();
        },
      }, 'Reset campaign'),
    ),
  );

  // --- Hero + companion select.
  const roster = h('div', { class: 'roster' },
    ...heroes.map((ch) => rosterCard(ctx, ch, ch === hero, () => ((ctx.selection.play = ch.id), ctx.rerender()))),
  );
  const companionRow = h('div', { class: 'row companion-row' },
    h('span', { class: 'field-label' }, 'Companion'),
    h('button', { class: `chip${!companion ? ' active' : ''}`, onclick: () => ((ctx.selection.companion = null), ctx.rerender()) }, 'Solo'),
    ...allies.map((a) => h('button', { class: `chip${a === companion ? ' active' : ''}`, onclick: () => ((ctx.selection.companion = a.id), ctx.rerender()) }, a.alias)),
    !allies.length && h('span', { class: 'muted small' }, 'Earn allies by helping friends, sparing foes, or recruiting defeated bosses.'),
  );

  // --- Mission board.
  const missions = missionBoard(c, u);
  const board = h('div', { class: 'board' },
    ...missions.map((m) => missionCard(ctx, m, hero ?? null, companion)),
    missions.length === 0 && h('p', { class: 'muted' }, 'No missions available. Add locations, villains, or stories in the creator.'),
  );

  // --- Factions and hierarchy.
  const factions = h('div', { class: 'factions' },
    ...u.factions.map((f) => {
      const s = c.factions[f.id];
      if (!s) return null;
      const leader = u.characters.find((x) => x.id === s.leaderId);
      return h('div', { class: 'faction-card', style: `--c:${f.color}` },
        h('div', { class: 'faction-name' }, f.name, h('span', { class: 'muted small' }, ` · ${capitalize(f.alignment)}`)),
        h('div', { class: 'power-bar' }, h('div', { style: `width:${s.power}%` })),
        h('div', { class: 'small muted' }, `Control ${s.power}%`),
        h('div', { class: 'hierarchy' },
          h('div', { class: 'rank leader' }, '♛ ', leader ? personLabel(ctx, leader) : h('i', { class: 'muted' }, 'Leaderless')),
          ...s.lieutenantIds.map((id) => {
            const lt = u.characters.find((x) => x.id === id);
            return lt && h('div', { class: 'rank' }, '▸ ', personLabel(ctx, lt));
          }),
        ),
        !ctx.quick && h('label', { class: 'omni-row' }, h('span', { class: 'small' }, 'Omni'),
          h('input', { type: 'range', min: 0, max: 100, value: s.power, onchange: (e: Event) => ((s.power = Number((e.target as HTMLInputElement).value)), ctx.saveCampaign(), ctx.rerender()) })),
      );
    }),
  );

  // --- Relationships.
  const groups: { title: string; filter: (ch: Character) => boolean }[] = [
    { title: 'Allies & Friends', filter: (ch) => ['ally', 'friend'].includes(bond(relationOf(c, ch.id))) && relationOf(c, ch.id).state !== 'dead' },
    { title: 'Nemeses & Rivals', filter: (ch) => ['nemesis', 'rival'].includes(bond(relationOf(c, ch.id))) && relationOf(c, ch.id).state === 'free' },
    { title: 'In Prison', filter: (ch) => relationOf(c, ch.id).state === 'imprisoned' },
    { title: 'Fallen', filter: (ch) => relationOf(c, ch.id).state === 'dead' },
  ];
  const relations = h('div', { class: 'relations' },
    ...groups.map((g) => {
      const people = u.characters.filter((ch) => c.relations[ch.id] && g.filter(ch));
      return h('div', { class: 'relation-group' },
        h('div', { class: 'field-label' }, `${g.title} (${people.length})`),
        ...people.map((ch) => relationRow(ctx, ch)),
        people.length === 0 && h('div', { class: 'muted small' }, 'None'),
      );
    }),
  );

  return h('div', { class: 'play war-table' },
    report,
    header,
    h('h3', { class: 'panel-title' }, 'Choose your hero'),
    heroes.length ? roster : h('p', { class: 'warn' }, 'Every hero is imprisoned, fallen, or turned against you. Pass time, or reset the campaign.'),
    companionRow,
    h('h3', { class: 'panel-title' }, 'Missions'),
    board,
    h('div', { class: 'war-columns' },
      h('section', { class: 'panel' }, h('h3', { class: 'panel-title' }, 'Factions'), factions),
      h('section', { class: 'panel' }, h('h3', { class: 'panel-title' }, 'Relationships'), relations),
    ),
    h('section', { class: 'panel' }, h('h3', { class: 'panel-title' }, 'Chronicle'), newsList(c.news.slice(0, 15))),
    h('p', { class: 'muted small' }, 'Missions here change the world permanently. To try a story without consequences, use Play story in the Stories tab.'),
  );
}

function rosterCard(ctx: EditorContext, ch: Character, active: boolean, onClick: () => void) {
  const u = ctx.universe;
  const r = ctx.campaign.relations[ch.id];
  return h('button', { class: `roster-card${active ? ' active' : ''}`, style: `--c:${ch.appearance.primary}; --a:${ch.appearance.accent}`, onclick: onClick },
    h('div', { class: 'roster-emblem' }, ch.alias.slice(0, 1)),
    h('div', { class: 'roster-name' }, ch.alias),
    h('div', { class: 'roster-meta' }, `Lv ${ch.level} · ${capitalize(ch.role)}`, r?.state === 'recruited' ? ' · Recruit' : ''),
    h('div', { class: 'roster-cp' }, `CP ${combatPower(ch, u.items).toLocaleString()}`),
    h('div', { class: 'roster-powers' }, ...ch.powers.slice(0, 5).map((p) => h('i', { style: `background:${ELEMENT_COLORS[p.element]}`, title: p.name }))),
  );
}

function missionCard(ctx: EditorContext, m: Mission, hero: Character | null, companion: Character | null) {
  const u = ctx.universe;
  const meta = KIND_META[m.kind];
  const reward = u.items.find((i) => i.id === m.rewardItemId);
  const required = m.allyId ? u.characters.find((x) => x.id === m.allyId) : null;
  const ambusher = m.ambushId ? u.characters.find((x) => x.id === m.ambushId) : null;
  // You can't rescue yourself: ally missions need a different hero.
  const blocked = !hero || m.allyId === hero.id;
  return h('button', {
    class: 'mission-card',
    style: `--c:${meta.color}`,
    disabled: blocked,
    onclick: () => hero && ctx.playMission(m, hero.id, m.allyId ?? companion?.id ?? null),
  },
  h('div', { class: 'mission-top' },
    h('span', { class: 'mission-kind' }, `${meta.icon} ${meta.label}`),
    h('span', { class: 'pips' }, '●'.repeat(m.difficulty), h('i', null, '●'.repeat(5 - m.difficulty))),
  ),
  h('div', { class: 'mission-name' }, m.title),
  h('div', { class: 'mission-brief' }, m.brief),
  m.targetIds.length > 0 && h('div', { class: 'targets' },
    ...m.targetIds.map((id) => {
      const t = u.characters.find((x) => x.id === id);
      return t && h('span', { class: 'target' }, t.alias, ' ', bondTag(ctx, t), ` Lv ${t.level}`);
    }),
  ),
  required && h('div', { class: 'small', style: 'color:#3eff8b' }, m.allyId === hero?.id ? `Pick another hero to help ${required.alias}` : `Fights alongside ${required.alias}`),
  ambusher && h('div', { class: 'small', style: 'color:#ff8a9c' }, `⚠ ${ambusher.alias} has been seen nearby`),
  h('div', { class: 'mission-foot' },
    h('span', null, `Lv ${m.level}`),
    h('span', null, `+${m.xp} XP`),
    reward && h('span', { style: `color:${RARITY_COLORS[reward.rarity]}` }, reward.name),
  ),
  );
}

function personLabel(ctx: EditorContext, ch: Character) {
  const r = ctx.campaign.relations[ch.id];
  const stateNote = r && r.state !== 'free' ? ` (${r.state})` : '';
  return h('span', null, `${ch.alias} Lv ${ch.level}${stateNote} `, r && r.state === 'free' && bondTag(ctx, ch));
}

function relationRow(ctx: EditorContext, ch: Character) {
  const c = ctx.campaign;
  const r = relationOf(c, ch.id);
  const last = r.memories[r.memories.length - 1];
  const faction = ctx.universe.factions.find((f) => f.id === factionOf(c, ch.id));
  return h('div', { class: 'relation' },
    h('div', { class: 'relation-head' },
      h('b', null, ch.alias),
      bondTag(ctx, ch),
      h('span', { class: 'muted small' }, faction ? faction.name : capitalize(ch.role)),
    ),
    h('div', { class: 'score-bar' }, h('div', { style: `left:${(Math.min(r.score, 0) + 100) / 2}%; width:${Math.abs(r.score) / 2}%; background:${r.score < 0 ? '#ff3e5c' : '#3eff8b'}` })),
    last && h('div', { class: 'muted small' }, `Last: ${ch.alias} ${last.text}.`),
    h('div', { class: 'muted small' }, `Encounters ${r.encounters} · You won ${r.playerWins} · They won ${r.theirWins}`),
    !ctx.quick && h('input', {
      type: 'range', min: -100, max: 100, value: r.score, title: 'Omni override: relationship score',
      onchange: (e: Event) => ((r.score = Number((e.target as HTMLInputElement).value)), ctx.saveCampaign(), ctx.rerender()),
    }),
  );
}

function newsList(items: NewsItem[]) {
  return h('ul', { class: 'news' }, ...items.map((n) => h('li', { class: `news-${n.kind}` }, h('span', { class: 'news-icon' }, NEWS_ICONS[n.kind]), h('span', null, n.text), h('span', { class: 'news-turn' }, `T${n.turn}`))));
}
