// The living campaign: a War Table of missions generated from world state,
// relationships that turn characters into allies or nemeses, and faction
// hierarchies where fallen bosses are replaced by underlings or opportunists.
//
// Everything here is deterministic: randomness comes from the campaign seed,
// the turn, and the mission id, so the same choices always produce the same
// world. All functions mutate the campaign (and, for new villains and level
// changes, the universe) in place.

import { randomCharacter } from './generator';
import type { BossOption, BossOutcome, MissionPlan, MissionResult, PatrolEvent, Phase } from './missions';
import { chapterPhase, nextChapterIndex } from './missions';
import { Rng } from './rng';
import { rankUpCost, rollLoot, rollRarity, salvageValue, upgradeCost } from './progression';
import { MAX_LEVEL, MAX_STARS, clamp, combatPower, grantXp } from './rules';
import type { Character, DialogueLine, Faction, Item, Universe } from './types';

export const CAMPAIGN_SCHEMA = 1;

export type CharState = 'free' | 'imprisoned' | 'dead' | 'recruited';
export type Bond = 'nemesis' | 'rival' | 'neutral' | 'friend' | 'ally';

export interface Memory {
  turn: number;
  /** Written from the character's point of view: "was arrested by Nova". */
  text: string;
}

export interface Relationship {
  /** -100 (sworn enemy) to 100 (devoted ally), toward the player's team. */
  score: number;
  state: CharState;
  encounters: number;
  /** Times the player beat them. */
  playerWins: number;
  /** Times they beat the player. */
  theirWins: number;
  /** The hero they hold the biggest grudge against. */
  grudgeHeroId: string | null;
  memories: Memory[];
}

export interface FactionState {
  /** 0-100: how much of the world the faction controls. */
  power: number;
  leaderId: string | null;
  lieutenantIds: string[];
}

export interface StoryProgress {
  chapter: number;
  done: boolean;
}

export type NewsKind = 'mission' | 'succession' | 'nemesis' | 'ally' | 'escape' | 'faction' | 'story' | 'betrayal' | 'contract' | 'loot' | 'scheme';

export interface NewsItem {
  turn: number;
  kind: NewsKind;
  text: string;
}

export interface Campaign {
  schema: number;
  universeId: string;
  seed: number;
  turn: number;
  flags: Record<string, string>;
  factions: Record<string, FactionState>;
  relations: Record<string, Relationship>;
  stories: Record<string, StoryProgress>;
  news: NewsItem[];
  /** Ids of contracts already completed (see activeContracts). */
  contractsDone: string[];
  /** Upgrade currency from salvaged gear. */
  shards: number;
  /** Villain plots counting down on the War Table. */
  schemes: Scheme[];
  /** Character-specific rank-up material, by character id. */
  biometrics: Record<string, number>;
  /** Best Danger Room wave reached. */
  dangerBest: number;
}

export type SchemeKind = 'doomsday' | 'jailbreak' | 'takeover' | 'army';

export interface Scheme {
  id: string;
  kind: SchemeKind;
  villainId: string;
  factionId: string | null;
  locationId: string;
  /** Turns until it succeeds. */
  left: number;
  total: number;
}

export const SCHEME_META: Record<SchemeKind, { title: string; turns: number; goal: string; threat: string }> = {
  doomsday: { title: 'Doomsday Device', turns: 5, goal: 'Fight through the guards', threat: 'devastates the city: their faction surges and the villain grows far stronger' },
  jailbreak: { title: 'Mass Breakout', turns: 3, goal: 'Stop the breakout', threat: 'frees every imprisoned villain' },
  takeover: { title: 'Hostile Takeover', turns: 4, goal: 'Retake the streets', threat: 'gives their faction total control of the city' },
  army: { title: 'Raise an Army', turns: 4, goal: 'Break up the recruitment', threat: 'adds two new super-powered lieutenants to their faction' },
};

export type MissionKind = 'story' | 'patrol' | 'raid' | 'hunt' | 'vendetta' | 'ally' | 'defense' | 'teamup' | 'scheme';

export interface Mission {
  id: string;
  kind: MissionKind;
  title: string;
  brief: string;
  locationId: string;
  factionId: string | null;
  /** Bosses fought in this mission. */
  targetIds: string[];
  level: number;
  /** 1-5. */
  difficulty: number;
  xp: number;
  rewardItemId: string | null;
  storyId: string | null;
  chapter: number;
  /** Character who must fight alongside the player (ally missions). */
  allyId: string | null;
  /** Nemesis who may ambush a patrol. */
  ambushId: string | null;
  /** Team-up missions: the hero faction that assembles for it. */
  teamId: string | null;
  /** Scheme missions: the plot this mission can foil. */
  schemeId: string | null;
}

const MAX_NEWS = 60;
const MAX_MEMORIES = 8;

// --- Setup -----------------------------------------------------------------

function initialScore(c: Character): number {
  return c.role === 'hero' ? 40 : c.role === 'villain' ? -20 : c.role === 'neutral' ? 10 : 0;
}

function newRelationship(c: Character): Relationship {
  return { score: initialScore(c), state: 'free', encounters: 0, playerWins: 0, theirWins: 0, grudgeHeroId: null, memories: [] };
}

function seedFaction(u: Universe, f: Faction): FactionState {
  const members = u.characters.filter((c) => c.factionId === f.id);
  const leader = members.find((c) => c.id === f.leaderId) ?? [...members].sort((a, b) => combatPower(b, u.items) - combatPower(a, u.items))[0];
  return {
    power: f.alignment === 'hero' ? 40 : 50,
    leaderId: leader?.id ?? null,
    lieutenantIds: members.filter((c) => c !== leader).map((c) => c.id),
  };
}

export function createCampaign(u: Universe): Campaign {
  const c: Campaign = {
    schema: CAMPAIGN_SCHEMA,
    universeId: u.id,
    seed: u.seed || hash(u.id),
    turn: 1,
    flags: {},
    factions: {},
    relations: {},
    stories: {},
    news: [{ turn: 1, kind: 'faction', text: 'The War Table is online. Choose your first mission.' }],
    contractsDone: [],
    shards: 0,
    schemes: [],
    biometrics: {},
    dangerBest: 0,
  };
  syncCampaign(c, u);
  return c;
}

/**
 * Reconciles a campaign with edits made in the creator: adds new characters,
 * factions, and stories; drops references to deleted ones.
 */
export function syncCampaign(c: Campaign, u: Universe) {
  const ids = new Set(u.characters.map((x) => x.id));
  for (const ch of u.characters) c.relations[ch.id] ??= newRelationship(ch);
  for (const id of Object.keys(c.relations)) if (!ids.has(id)) delete c.relations[id];

  for (const f of u.factions) c.factions[f.id] ??= seedFaction(u, f);
  for (const id of Object.keys(c.factions)) if (!u.factions.some((f) => f.id === id)) delete c.factions[id];
  const placed = new Set<string>();
  for (const fs of Object.values(c.factions)) {
    if (fs.leaderId && !ids.has(fs.leaderId)) fs.leaderId = null;
    fs.lieutenantIds = fs.lieutenantIds.filter((id) => ids.has(id) && id !== fs.leaderId);
    if (fs.leaderId) placed.add(fs.leaderId);
    fs.lieutenantIds.forEach((id) => placed.add(id));
  }
  // Characters newly assigned to a faction in the creator join as lieutenants.
  for (const ch of u.characters) {
    const fs = ch.factionId ? c.factions[ch.factionId] : undefined;
    // Only free characters take up a post: prisoners and the fallen stay out.
    if (fs && !placed.has(ch.id) && c.relations[ch.id].state === 'free') {
      if (!fs.leaderId) fs.leaderId = ch.id;
      else fs.lieutenantIds.push(ch.id);
    }
  }

  for (const s of u.stories) {
    c.stories[s.id] ??= { chapter: nextChapterIndex(s, 0, c.flags) ?? 0, done: s.chapters.length === 0 };
  }
  for (const id of Object.keys(c.stories)) if (!u.stories.some((s) => s.id === id)) delete c.stories[id];
}

function validScheme(x: unknown): x is Scheme {
  const o = x as Scheme;
  return !!o && typeof o === 'object' && typeof o.id === 'string' && o.kind in SCHEME_META && typeof o.villainId === 'string'
    && typeof o.locationId === 'string' && Number.isInteger(o.left) && Number.isInteger(o.total) && o.left > 0 && o.left <= o.total;
}

/** Parses a saved campaign; anything unusable starts a fresh campaign. */
export function loadCampaign(raw: unknown, u: Universe): Campaign {
  const o = raw as Partial<Campaign> | null;
  if (!o || typeof o !== 'object' || o.universeId !== u.id || typeof o.turn !== 'number' || typeof o.relations !== 'object' || typeof o.factions !== 'object') {
    return createCampaign(u);
  }
  const c: Campaign = {
    schema: CAMPAIGN_SCHEMA,
    universeId: u.id,
    seed: typeof o.seed === 'number' ? o.seed >>> 0 : u.seed,
    turn: Math.max(1, Math.floor(o.turn)),
    flags: typeof o.flags === 'object' && o.flags ? { ...(o.flags as Record<string, string>) } : {},
    factions: {},
    relations: {},
    stories: typeof o.stories === 'object' && o.stories ? { ...(o.stories as Record<string, StoryProgress>) } : {},
    news: Array.isArray(o.news) ? o.news.slice(0, MAX_NEWS) : [],
    contractsDone: Array.isArray(o.contractsDone) ? o.contractsDone.filter((x): x is string => typeof x === 'string').slice(-200) : [],
    shards: typeof o.shards === 'number' && Number.isFinite(o.shards) ? clamp(Math.floor(o.shards), 0, 1e7) : 0,
    schemes: Array.isArray(o.schemes) ? o.schemes.filter(validScheme).slice(0, 4).map((x) => ({ ...x })) : [],
    biometrics: Object.fromEntries(Object.entries(typeof o.biometrics === 'object' && o.biometrics ? o.biometrics : {})
      .filter(([, v]) => typeof v === 'number' && Number.isFinite(v)).map(([k, v]) => [k, clamp(Math.floor(v as number), 0, 1e6)])),
    dangerBest: typeof o.dangerBest === 'number' && Number.isFinite(o.dangerBest) ? clamp(Math.floor(o.dangerBest), 0, 9999) : 0,
  };
  for (const [id, r] of Object.entries(o.relations as Record<string, Relationship>)) {
    if (!r || typeof r !== 'object') continue;
    c.relations[id] = {
      score: clamp(Number(r.score) || 0, -100, 100),
      state: (['free', 'imprisoned', 'dead', 'recruited'] as const).includes(r.state) ? r.state : 'free',
      encounters: Number(r.encounters) || 0,
      playerWins: Number(r.playerWins) || 0,
      theirWins: Number(r.theirWins) || 0,
      grudgeHeroId: typeof r.grudgeHeroId === 'string' ? r.grudgeHeroId : null,
      memories: Array.isArray(r.memories) ? r.memories.slice(-MAX_MEMORIES) : [],
    };
  }
  for (const [id, f] of Object.entries(o.factions as Record<string, FactionState>)) {
    if (!f || typeof f !== 'object') continue;
    c.factions[id] = {
      power: clamp(Number(f.power) || 0, 0, 100),
      leaderId: typeof f.leaderId === 'string' ? f.leaderId : null,
      lieutenantIds: Array.isArray(f.lieutenantIds) ? f.lieutenantIds.filter((x) => typeof x === 'string') : [],
    };
  }
  syncCampaign(c, u);
  return c;
}

// --- Queries ---------------------------------------------------------------

export function bond(r: Relationship): Bond {
  if (r.state === 'recruited') return 'ally';
  if (r.score <= -60 && r.encounters >= 2) return 'nemesis';
  if (r.score <= -25) return 'rival';
  if (r.score >= 60) return 'ally';
  if (r.score >= 25) return 'friend';
  return 'neutral';
}

export function relationOf(c: Campaign, id: string): Relationship {
  const r = c.relations[id];
  if (!r) throw new Error(`No relationship for ${id}`);
  return r;
}

const isFree = (c: Campaign, id: string) => c.relations[id]?.state === 'free';

/** Characters the player's team must fight. */
export function isHostile(c: Campaign, ch: Character): boolean {
  const r = c.relations[ch.id];
  if (!r || r.state !== 'free') return false;
  const b = bond(r);
  return b === 'rival' || b === 'nemesis' || (ch.role === 'villain' && b !== 'ally' && b !== 'friend');
}

export function playableHeroes(c: Campaign, u: Universe): Character[] {
  return u.characters.filter((ch) => {
    const r = c.relations[ch.id];
    if (!r) return false;
    if (r.state === 'recruited') return true;
    return r.state === 'free' && !isHostile(c, ch);
  });
}

export function availableAllies(c: Campaign, u: Universe, heroId: string): Character[] {
  return playableHeroes(c, u).filter((ch) => ch.id !== heroId && bond(relationOf(c, ch.id)) === 'ally');
}

export function factionOf(c: Campaign, characterId: string): string | null {
  for (const [id, f] of Object.entries(c.factions)) {
    if (f.leaderId === characterId || f.lieutenantIds.includes(characterId)) return id;
  }
  return null;
}

export function nemeses(c: Campaign, u: Universe): Character[] {
  return u.characters.filter((ch) => isFree(c, ch.id) && bond(relationOf(c, ch.id)) === 'nemesis');
}

/**
 * Who actually shows up when a story calls for a boss. If the original boss
 * is gone, whoever took their place steps up instead.
 */
export function resolveBoss(c: Campaign, u: Universe, characterId: string): Character | null {
  const original = u.characters.find((x) => x.id === characterId);
  if (original && isHostile(c, original)) return original;
  const fid = original?.factionId;
  const fs = fid ? c.factions[fid] : undefined;
  const heir = fs?.leaderId ? u.characters.find((x) => x.id === fs.leaderId) : undefined;
  if (heir && isHostile(c, heir)) return heir;
  return [...u.characters].filter((x) => isHostile(c, x)).sort((a, b) => combatPower(b, u.items) - combatPower(a, u.items))[0] ?? null;
}

function rosterLevel(c: Campaign, u: Universe): number {
  return Math.max(1, ...playableHeroes(c, u).map((h) => h.level));
}

function hostileFactions(c: Campaign, u: Universe): { f: Faction; s: FactionState; leader: Character }[] {
  const out: { f: Faction; s: FactionState; leader: Character }[] = [];
  for (const f of u.factions) {
    const s = c.factions[f.id];
    const leader = s?.leaderId ? u.characters.find((x) => x.id === s.leaderId) : undefined;
    if (s && leader && isHostile(c, leader)) out.push({ f, s, leader });
  }
  return out.sort((a, b) => b.s.power - a.s.power);
}

// --- Mission board -----------------------------------------------------------

/** The War Table: every mission currently available, derived from world state. */
export function missionBoard(c: Campaign, u: Universe): Mission[] {
  const rng = new Rng(mix(c.seed, c.turn));
  const base = rosterLevel(c, u);
  const missions: Mission[] = [];
  const locId = () => (u.locations.length ? rng.pick(u.locations).id : '');
  const name = (id: string) => u.characters.find((x) => x.id === id)?.alias ?? 'Unknown';
  const factionName = (id: string | null) => u.factions.find((f) => f.id === id)?.name ?? 'Unknown forces';
  const add = (m: Omit<Mission, 'id' | 'level' | 'xp' | 'rewardItemId' | 'storyId' | 'chapter' | 'allyId' | 'ambushId' | 'teamId' | 'schemeId'> & Partial<Mission>) => {
    const level = m.level ?? clamp(base + m.difficulty - 2, 1, MAX_LEVEL);
    missions.push({
      id: `${m.kind}:${c.turn}:${missions.length}`,
      level,
      xp: 60 * m.difficulty + 20 * level,
      rewardItemId: null,
      storyId: null,
      chapter: 0,
      allyId: null,
      ambushId: null,
      teamId: null,
      schemeId: null,
      ...m,
    });
  };
  const rareLoot = () => {
    const pool = u.items.filter((i) => i.rarity !== 'common');
    return pool.length ? rng.pick(pool).id : null;
  };

  // Villain schemes come first: they're on a clock.
  for (const sc of c.schemes) {
    const villain = u.characters.find((x) => x.id === sc.villainId);
    if (!villain) continue;
    const meta = SCHEME_META[sc.kind];
    add({
      kind: 'scheme',
      title: `Stop the ${meta.title}`,
      brief: `${villain.alias}'s plot succeeds in ${sc.left} ${sc.left === 1 ? 'turn' : 'turns'}: it ${meta.threat}.`,
      locationId: u.locations.some((l) => l.id === sc.locationId) ? sc.locationId : locId(),
      factionId: sc.factionId,
      targetIds: [villain.id],
      difficulty: sc.left <= 1 ? 5 : 4,
      rewardItemId: rareLoot(),
      schemeId: sc.id,
    });
  }

  // Story chapters, with bosses swapped for whoever holds their position now.
  for (const s of u.stories) {
    const p = c.stories[s.id];
    if (!p || p.done) continue;
    const ch = s.chapters[p.chapter];
    if (!ch) continue;
    const boss = ch.objective.type === 'boss' ? resolveBoss(c, u, ch.objective.characterId) : null;
    add({
      kind: 'story',
      title: `${s.title}: ${ch.title}`,
      brief: s.synopsis || `Chapter ${p.chapter + 1} of ${s.chapters.length}.`,
      locationId: ch.locationId,
      factionId: ch.enemyFactionId,
      targetIds: boss ? [boss.id] : [],
      difficulty: boss ? 4 : 2,
      level: Math.max(ch.enemyLevel, base - 1),
      rewardItemId: ch.rewardItemId,
      storyId: s.id,
      chapter: p.chapter,
    });
  }

  const hostile = hostileFactions(c, u);

  // Vendettas: nemeses come for you personally.
  for (const n of nemeses(c, u)) {
    const r = relationOf(c, n.id);
    const last = r.memories[r.memories.length - 1];
    add({
      kind: 'vendetta',
      title: `Vendetta: ${n.alias}`,
      brief: last ? `${n.alias} ${last.text}, and wants revenge.` : `${n.alias} is hunting you.`,
      locationId: locId(),
      factionId: factionOf(c, n.id),
      targetIds: [n.id],
      difficulty: 4,
      rewardItemId: rng.chance(0.5) ? rareLoot() : null,
    });
  }

  // Raid the strongest faction's stronghold: lieutenants first, then the boss.
  const raidTarget = hostile.find((h) => h.s.power >= 40);
  if (raidTarget) {
    const lts = raidTarget.s.lieutenantIds.filter((id) => isFree(c, id)).slice(0, 2);
    add({
      kind: 'raid',
      title: `Raid: ${raidTarget.f.name} Stronghold`,
      brief: `Storm the fortress. ${lts.length ? `${lts.length > 1 ? 'Lieutenants' : 'Lieutenant'} ${lts.map(name).join(' & ')} ${lts.length > 1 ? 'guard' : 'guards'} ` : 'Defeat '}${raidTarget.leader.alias}.`,
      locationId: locId(),
      factionId: raidTarget.f.id,
      targetIds: [...lts, raidTarget.leader.id],
      difficulty: 5,
      rewardItemId: rareLoot(),
    });
  }

  // Hunts for faction leaders and a lieutenant on the move.
  for (const h of hostile.slice(0, 2)) {
    if (missions.some((m) => m.kind === 'vendetta' && m.targetIds[0] === h.leader.id)) continue;
    add({
      kind: 'hunt',
      title: `Take Down ${h.leader.alias}`,
      brief: `Leader of ${h.f.name}, which controls ${h.s.power}% of the city.`,
      locationId: locId(),
      factionId: h.f.id,
      targetIds: [h.leader.id],
      difficulty: 3,
      rewardItemId: rng.chance(0.4) ? rareLoot() : null,
    });
  }
  const lieutenants = hostile.flatMap((h) => h.s.lieutenantIds.filter((id) => isFree(c, id)).map((id) => ({ id, f: h.f })));
  if (lieutenants.length) {
    const lt = rng.pick(lieutenants);
    add({
      kind: 'hunt',
      title: `Track ${name(lt.id)}`,
      brief: `A lieutenant of ${lt.f.name} was spotted. Weaken the faction from within.`,
      locationId: locId(),
      factionId: lt.f.id,
      targetIds: [lt.id],
      difficulty: 2,
    });
  }
  // Heroes who turned against you are fair game too.
  for (const rogue of u.characters.filter((x) => x.role !== 'villain' && isHostile(c, x) && !factionOf(c, x.id)).slice(0, 1)) {
    add({ kind: 'hunt', title: `Confront ${rogue.alias}`, brief: `${rogue.alias} has gone rogue.`, locationId: locId(), factionId: null, targetIds: [rogue.id], difficulty: 3 });
  }

  // Factions at full strength strike at the city.
  for (const h of hostile.filter((x) => x.s.power >= 70)) {
    const loc = locId();
    add({
      kind: 'defense',
      title: `Defend ${u.locations.find((l) => l.id === loc)?.name ?? 'the City'}`,
      brief: `${h.f.name} is attacking in force. Ignore it and their grip tightens.`,
      locationId: loc,
      factionId: h.f.id,
      targetIds: [],
      difficulty: 3,
    });
  }

  // A friend in need: helping them builds the bond until they join you.
  const friends = u.characters.filter((x) => {
    const r = c.relations[x.id];
    return r && r.state === 'free' && !isHostile(c, x) && r.score >= 0 && r.score < 60;
  });
  if (friends.length) {
    const friend = rng.pick(friends);
    const enemy = hostile.length ? rng.pick(hostile) : null;
    add({
      kind: 'ally',
      title: `${friend.alias} Needs Backup`,
      brief: `${friend.alias} is pinned down by ${enemy?.f.name ?? 'hostiles'}. Help them and they may join your team.`,
      locationId: locId(),
      factionId: enemy?.f.id ?? null,
      targetIds: [],
      difficulty: 2,
      allyId: friend.id,
    });
  }

  // Team-ups: a whole hero team assembles against a villain faction's leadership.
  for (const team of u.factions.filter((f) => f.alignment === 'hero' || f.alignment === 'antihero')) {
    const members = teamRoster(c, u, team.id);
    const enemy = hostile.find((h) => h.s.lieutenantIds.some((id) => isFree(c, id))) ?? hostile[0];
    if (members.length < 2 || !enemy) continue;
    const lts = enemy.s.lieutenantIds.filter((id) => isFree(c, id)).slice(0, 2);
    add({
      kind: 'teamup',
      title: `Team-Up: ${team.name} vs ${enemy.f.name}`,
      brief: `${members.slice(0, 4).map((x) => x.alias).join(', ')} assemble to break ${enemy.f.name}'s command.`,
      locationId: locId(),
      factionId: enemy.f.id,
      targetIds: [...lts, enemy.leader.id],
      difficulty: 5,
      level: clamp(base + 4, 1, MAX_LEVEL),
      rewardItemId: rareLoot(),
      teamId: team.id,
    });
    break;
  }

  // Patrols: open-ended sweeps with random events, sometimes an elite or an ambush.
  const patrolCount = Math.min(2, Math.max(1, u.locations.length));
  for (let i = 0; i < patrolCount; i++) {
    const enemy = hostile.length ? rng.pick(hostile) : null;
    const loc = locId();
    const nem = nemeses(c, u);
    add({
      kind: 'patrol',
      title: `Patrol ${u.locations.find((l) => l.id === loc)?.name ?? 'the City'}`,
      brief: `Sweep the area${enemy ? ` held by ${factionName(enemy.f.id)}` : ''}. Respond to whatever you find.`,
      locationId: loc,
      factionId: enemy?.f.id ?? null,
      targetIds: enemy && enemy.s.lieutenantIds.some((id) => isFree(c, id)) && rng.chance(0.6)
        ? [rng.pick(enemy.s.lieutenantIds.filter((id) => isFree(c, id)))]
        : [],
      difficulty: 1,
      ambushId: nem.length && rng.chance(0.5) ? rng.pick(nem).id : null,
    });
  }

  return missions;
}

// --- Planning ----------------------------------------------------------------

/** Lines a character says when you meet them, based on your shared history. */
export function barks(c: Campaign, u: Universe, characterId: string, heroName: string): DialogueLine[] {
  const ch = u.characters.find((x) => x.id === characterId);
  const r = c.relations[characterId];
  if (!ch || !r) return [];
  const speaker = ch.alias;
  const last = r.memories[r.memories.length - 1];
  switch (bond(r)) {
    case 'nemesis':
      return [
        { speaker, text: `${heroName}. I've dreamed about this moment.` },
        ...(last ? [{ speaker, text: `Last time, I ${last.text}. You'll pay for that.` }] : []),
      ];
    case 'rival':
      return [{ speaker, text: last ? `Last time, I ${last.text}. This time will be different.` : `So you're ${heroName}. I expected more.` }];
    case 'ally':
    case 'friend':
      return [{ speaker, text: `I've got your back, ${heroName}.` }];
    default:
      if (last?.text.startsWith('took command')) return [{ speaker, text: `I ${last.text}. Things work differently now.` }];
      return [{ speaker, text: r.encounters ? `We meet again, ${heroName}.` : `Another hero who thinks they can stop me.` }];
  }
}

/** Free, friendly members of a hero faction, strongest first (for team-up squads). */
export function teamRoster(c: Campaign, u: Universe, teamId: string): Character[] {
  return u.characters
    .filter((x) => x.factionId === teamId && c.relations[x.id]?.state === 'free' && !isHostile(c, x))
    .sort((a, b) => combatPower(b, u.items) - combatPower(a, u.items));
}

/** The AI squad for a mission: required ally first, then the team (team-ups) or the player's picks. Max 3. */
export function missionSquad(c: Campaign, u: Universe, m: Mission, heroId: string, picks: string[]): string[] {
  const team = m.teamId ? teamRoster(c, u, m.teamId).map((x) => x.id) : [];
  // Team-ups field the team; other missions take the required ally, then the player's picks.
  const ordered = m.teamId ? [...team, ...picks] : [...(m.allyId ? [m.allyId] : []), ...picks];
  return [...new Set(ordered)].filter((id) => id !== heroId && u.characters.some((x) => x.id === id)).slice(0, 3);
}

export function planMission(c: Campaign, u: Universe, m: Mission, heroId: string, picks: string[] = []): MissionPlan {
  const hero = u.characters.find((x) => x.id === heroId);
  const heroName = hero?.alias ?? 'Hero';
  const rng = new Rng(mix(c.seed, c.turn, hash(m.id)));
  const name = (id: string) => u.characters.find((x) => x.id === id)?.alias ?? 'the boss';
  const bossPower: Record<string, number> = {};
  for (const id of [...m.targetIds, ...(m.ambushId ? [m.ambushId] : [])]) bossPower[id] = 1 + 0.2 * (c.relations[id]?.theirWins ?? 0);
  const squad = missionSquad(c, u, m, heroId, picks);
  const allyLines = squad.slice(0, 2).flatMap((id) => barks(c, u, id, heroName).slice(0, 1));
  const targetLines = m.targetIds.slice(-1).flatMap((id) => barks(c, u, id, heroName));

  let intro: DialogueLine[] = [{ speaker: 'Command', text: m.brief }];
  let outro: DialogueLine[] = [];
  let phases: Phase[];
  let choice = null;
  switch (m.kind) {
    case 'story': {
      const story = u.stories.find((s) => s.id === m.storyId)!;
      const ch = story.chapters[m.chapter];
      const original = ch.objective.type === 'boss' ? ch.objective.characterId : null;
      const boss = m.targetIds[0] ?? null;
      intro = [...ch.intro];
      if (original && boss && original !== boss) {
        intro.push({ speaker: 'Command', text: `${name(original)} is out of the picture, but ${name(boss)} has taken their place.` }, ...barks(c, u, boss, heroName));
      }
      phases = [chapterPhase(ch, boss)];
      outro = ch.outro;
      choice = ch.choice;
      break;
    }
    case 'patrol': {
      const events: PatrolEvent[] = rng.shuffle<PatrolEvent>([
        { kind: 'squad', count: 5 },
        { kind: 'rescue', seconds: 25 },
        { kind: 'squad', count: 7 },
      ]);
      if (m.targetIds[0]) events.splice(rng.int(1, events.length), 0, { kind: 'elite', bossId: m.targetIds[0] });
      phases = [{ kind: 'patrol', events }];
      break;
    }
    case 'raid': {
      const leader = m.targetIds[m.targetIds.length - 1];
      const lts = m.targetIds.slice(0, -1);
      phases = [
        { kind: 'defeat', count: 14, label: 'Breach the stronghold' },
        ...(lts.length ? [{ kind: 'bosses' as const, bossIds: lts, minions: false, label: 'Defeat the lieutenants' }] : []),
        { kind: 'bosses', bossIds: [leader], minions: true, label: `Defeat ${name(leader)}` },
      ];
      intro.push(...barks(c, u, leader, heroName));
      break;
    }
    case 'scheme': {
      const sc = c.schemes.find((x) => x.id === m.schemeId);
      const meta = SCHEME_META[sc?.kind ?? 'doomsday'];
      const villain = m.targetIds[0];
      phases = [
        { kind: 'defeat', count: 10, label: meta.goal },
        { kind: 'survive', seconds: 30, label: `Sabotage the ${meta.title}` },
        { kind: 'bosses', bossIds: [villain], minions: true, label: `Defeat ${name(villain)}` },
      ];
      intro.push(...barks(c, u, villain, heroName));
      outro = [{ speaker: 'Command', text: `The ${meta.title} is finished. Good work, ${heroName}.` }];
      break;
    }
    case 'hunt':
    case 'vendetta':
      phases = [{ kind: 'bosses', bossIds: m.targetIds, minions: true }];
      intro.push(...targetLines);
      break;
    case 'ally':
      phases = [{ kind: 'survive', seconds: 45, label: `Protect ${name(m.allyId!)}` }, { kind: 'defeat', count: 6, label: 'Clear the area' }];
      intro.push({ speaker: name(m.allyId!), text: `${heroName}! Thank goodness. They're everywhere!` });
      outro = [{ speaker: name(m.allyId!), text: `I owe you one, ${heroName}. Call me if you ever need help.` }];
      break;
    case 'teamup': {
      const leader = m.targetIds[m.targetIds.length - 1];
      const lts = m.targetIds.slice(0, -1);
      const team = u.factions.find((f) => f.id === m.teamId);
      phases = [
        { kind: 'defeat', count: 18, label: 'Clear the streets' },
        ...(lts.length ? [{ kind: 'bosses' as const, bossIds: lts, minions: true, label: 'Break the lieutenants' }] : []),
        { kind: 'bosses', bossIds: [leader], minions: true, label: `Take down ${name(leader)}` },
      ];
      intro = [
        { speaker: heroName, text: `${team?.name ?? 'Team'}, assemble!` },
        ...squad.map((id) => ({ speaker: name(id), text: rng.pick(['Ready.', 'Right behind you.', 'Let’s do this.', 'On your call.']) })),
        { speaker: 'Command', text: m.brief },
        ...barks(c, u, leader, heroName),
      ];
      outro = [{ speaker: heroName, text: `That's how ${team?.name ?? 'a team'} gets it done.` }];
      break;
    }
    case 'defense':
      phases = [{ kind: 'defeat', count: 10, label: 'Repel the assault' }, { kind: 'survive', seconds: 40, label: 'Hold the line' }];
      break;
  }

  return {
    title: m.title,
    subtitle: m.kind === 'story' ? 'Story mission' : `${m.kind[0].toUpperCase()}${m.kind.slice(1)} · Difficulty ${m.difficulty}`,
    locationId: m.locationId,
    factionId: m.factionId,
    level: m.level,
    intro: [...intro, ...(m.kind === 'story' || m.kind === 'teamup' ? [] : allyLines)],
    phases,
    outro,
    choice,
    rewardItemId: m.rewardItemId,
    xp: m.xp,
    allyIds: squad,
    teamName: m.kind === 'teamup' ? u.factions.find((f) => f.id === m.teamId)?.name ?? null : null,
    ambushId: m.ambushId,
    ambushLine: m.ambushId ? barks(c, u, m.ambushId, heroName)[0]?.text ?? '' : '',
    decideBosses: true,
    bossPower,
    ambient: m.kind === 'patrol' ? ambientCast(c, u, m, heroId, squad) : null,
  };
}

/**
 * Who can turn up in a patrol's ambient events: hostile characters on the
 * run (the patrolled faction's own first), and friends who might call for help.
 */
function ambientCast(c: Campaign, u: Universe, m: Mission, heroId: string, squad: string[]) {
  const busy = new Set([heroId, ...squad, ...m.targetIds, m.ambushId].filter(Boolean));
  const hostile = u.characters.filter((x) => isHostile(c, x) && !busy.has(x.id));
  const own = hostile.filter((x) => factionOf(c, x.id) === m.factionId);
  const friends = u.characters.filter((x) => {
    const r = c.relations[x.id];
    return r?.state === 'free' && !busy.has(x.id) && !isHostile(c, x) && x.role !== 'villain';
  });
  return {
    villainIds: [...own, ...hostile.filter((x) => !own.includes(x))].slice(0, 6).map((x) => x.id),
    allyIds: friends.slice(0, 6).map((x) => x.id),
  };
}

export function canRecruit(c: Campaign, u: Universe, bossId: string): boolean {
  const ch = u.characters.find((x) => x.id === bossId);
  const r = c.relations[bossId];
  if (!ch || !r) return false;
  return bond(r) !== 'nemesis' && (r.score >= -10 || ch.role === 'antihero' || ch.role === 'neutral');
}

export function bossOptions(c: Campaign, u: Universe, bossId: string): BossOption[] {
  const recruitable = canRecruit(c, u, bossId);
  return [
    { id: 'arrest', label: 'Arrest', detail: 'Lock them away. They may escape someday.', disabled: false },
    { id: 'spare', label: 'Spare', detail: 'Let them go. Mercy earns respect, and they stay free.', disabled: false },
    { id: 'recruit', label: 'Recruit', detail: recruitable ? 'Offer them a place on your team.' : 'They despise you too much to listen.', disabled: !recruitable },
    { id: 'finish', label: 'Finish', detail: 'End them for good. Their allies will never forget.', disabled: false },
  ];
}

// --- Resolution --------------------------------------------------------------

class Chronicle {
  readonly items: NewsItem[] = [];
  constructor(private readonly c: Campaign) {}
  add(kind: NewsKind, text: string) {
    this.items.push({ turn: this.c.turn, kind, text });
  }
}

function remember(c: Campaign, id: string, text: string) {
  const r = c.relations[id];
  if (!r) return;
  r.memories.push({ turn: c.turn, text });
  if (r.memories.length > MAX_MEMORIES) r.memories.shift();
}

function shiftScore(c: Campaign, u: Universe, news: Chronicle, id: string, delta: number) {
  const r = c.relations[id];
  const ch = u.characters.find((x) => x.id === id);
  if (!r || !ch) return;
  const before = bond(r);
  r.score = clamp(r.score + delta, -100, 100);
  const after = bond(r);
  if (before === after || r.state !== 'free') return;
  if (after === 'nemesis') news.add('nemesis', `${ch.alias} has become your nemesis.`);
  else if (after === 'ally') news.add('ally', `${ch.alias} now considers you an ally and can join your missions.`);
  else if (after === 'rival' && ch.role !== 'villain') {
    news.add('betrayal', `${ch.alias} has lost faith in you and gone rogue!`);
    removeFromFactions(c, id);
  }
}

function removeFromFactions(c: Campaign, id: string): string | null {
  let led: string | null = null;
  for (const [fid, f] of Object.entries(c.factions)) {
    if (f.leaderId === id) {
      f.leaderId = null;
      led = fid;
    }
    f.lieutenantIds = f.lieutenantIds.filter((x) => x !== id);
  }
  return led;
}

function levelUp(ch: Character, by: number) {
  ch.level = Math.min(MAX_LEVEL, ch.level + by);
}

/** Fills an empty leadership slot: an underling steps up, an outsider seizes it, or a new threat rises. */
function succession(c: Campaign, u: Universe, rng: Rng, news: Chronicle, factionId: string, fallen: Character, how: BossOutcome, heroId: string) {
  const f = c.factions[factionId];
  const faction = u.factions.find((x) => x.id === factionId);
  if (!f || !faction || f.leaderId) return;
  const cp = (ch: Character) => combatPower(ch, u.items);
  const byId = (id: string) => u.characters.find((x) => x.id === id);

  let heir: Character | undefined;
  const outsiders = u.characters
    .filter((x) => x.id !== fallen.id && isHostile(c, x) && factionOf(c, x.id) !== factionId && !Object.values(c.factions).some((o) => o.leaderId === x.id))
    .sort((a, b) => cp(b) - cp(a));
  const underlings = f.lieutenantIds.map(byId).filter((x): x is Character => !!x && isHostile(c, x));

  if (outsiders.length && (f.power < 40 || !underlings.length) && rng.chance(underlings.length ? 0.5 : 0.8)) {
    heir = outsiders[Math.min(outsiders.length - 1, rng.int(0, 1))];
    removeFromFactions(c, heir.id);
    heir.factionId = factionId;
    news.add('succession', `${heir.alias} seized control of ${faction.name} in the power vacuum left by ${fallen.alias}.`);
  } else if (underlings.length) {
    heir = [...underlings].sort((a, b) => cp(b) * rng.float(0.85, 1.15) - cp(a) * rng.float(0.85, 1.15))[0];
    f.lieutenantIds = f.lieutenantIds.filter((x) => x !== heir!.id);
    news.add('succession', `${heir.alias} rises to lead ${faction.name} after ${fallen.alias}'s fall.`);
  } else {
    heir = randomCharacter(rng, 'villain', factionId);
    heir.level = Math.min(MAX_LEVEL, fallen.level + 1);
    u.characters.push(heir);
    c.relations[heir.id] = newRelationship(heir);
    news.add('succession', `A new threat emerges: ${heir.alias} takes command of ${faction.name}.`);
  }

  f.leaderId = heir.id;
  levelUp(heir, 2);
  remember(c, heir.id, `took command of ${faction.name}`);
  if (how === 'finish') {
    const r = relationOf(c, heir.id);
    r.grudgeHeroId = heroId;
    shiftScore(c, u, news, heir.id, -25);
  }

  // Keep the ranks filled so the faction stays a threat.
  if (f.lieutenantIds.length < 2 && rng.chance(0.5)) {
    const recruit = randomCharacter(rng, 'villain', factionId);
    recruit.level = Math.max(1, heir.level - 2);
    u.characters.push(recruit);
    c.relations[recruit.id] = newRelationship(recruit);
    f.lieutenantIds.push(recruit.id);
    news.add('faction', `${faction.name} recruits a new lieutenant: ${recruit.alias}.`);
  }
}

function applyOutcome(c: Campaign, u: Universe, rng: Rng, news: Chronicle, bossId: string, outcome: BossOutcome, hero: Character) {
  const boss = u.characters.find((x) => x.id === bossId);
  const r = c.relations[bossId];
  if (!boss || !r || r.state !== 'free') return;
  r.encounters++;
  r.playerWins++;
  const fid = factionOf(c, bossId);
  const faction = u.factions.find((f) => f.id === fid);
  const heroes = u.characters.filter((x) => x.role === 'hero' && x.id !== bossId && c.relations[x.id]?.state === 'free');

  let vacated = false;
  switch (outcome) {
    case 'arrest':
      r.state = 'imprisoned';
      remember(c, bossId, `was arrested by ${hero.alias}`);
      shiftScore(c, u, news, bossId, -15);
      news.add('mission', `${boss.alias} was arrested and taken to prison.`);
      vacated = removeFromFactions(c, bossId) !== null;
      break;
    case 'spare':
      remember(c, bossId, `was spared by ${hero.alias}`);
      shiftScore(c, u, news, bossId, 30);
      for (const h of heroes) shiftScore(c, u, news, h.id, 4);
      news.add('mission', `${hero.alias} spared ${boss.alias}. They won't forget it.`);
      break;
    case 'recruit':
      if (!canRecruit(c, u, bossId)) return applyOutcome(c, u, rng, news, bossId, 'spare', hero);
      r.state = 'recruited';
      r.score = Math.max(60, r.score + 40);
      remember(c, bossId, `joined ${hero.alias}'s team`);
      vacated = removeFromFactions(c, bossId) !== null;
      boss.factionId = null;
      news.add('ally', `${boss.alias} has joined your cause!`);
      break;
    case 'finish': {
      r.state = 'dead';
      news.add('mission', `${hero.alias} ended ${boss.alias} for good.`);
      const members = u.characters.filter((x) => x.id !== bossId && x.factionId === boss.factionId && boss.factionId && c.relations[x.id]?.state === 'free');
      for (const m of members) {
        remember(c, m.id, `swore revenge on ${hero.alias} for ${boss.alias}`);
        c.relations[m.id].grudgeHeroId = hero.id;
        shiftScore(c, u, news, m.id, -30);
      }
      for (const h of heroes) shiftScore(c, u, news, h.id, -12);
      for (const a of u.characters.filter((x) => x.role === 'antihero' && c.relations[x.id]?.state === 'free')) shiftScore(c, u, news, a.id, 5);
      vacated = removeFromFactions(c, bossId) !== null;
      break;
    }
  }
  if (fid) c.factions[fid].power = clamp(c.factions[fid].power - (outcome === 'spare' ? 8 : 18), 0, 100);
  if (vacated && fid && faction) succession(c, u, rng, news, fid, boss, outcome, hero.id);
}

const KIND_POWER_HIT: Record<MissionKind, number> = { story: 10, patrol: 6, raid: 25, hunt: 8, vendetta: 6, ally: 5, defense: 15, teamup: 30, scheme: 20 };

/**
 * Applies a finished mission to the world, advances time, and returns what
 * happened as news for the mission report.
 */
export function resolveMission(c: Campaign, u: Universe, m: Mission, result: MissionResult, heroId: string): NewsItem[] {
  const hero = u.characters.find((x) => x.id === heroId);
  if (!hero) return [];
  const rng = new Rng(mix(c.seed, c.turn, hash(m.id)));
  const news = new Chronicle(c);

  if (result.victory) {
    news.add('mission', `${hero.alias} completed “${m.title}”.`);
    for (const bossId of result.defeatedBossIds) applyOutcome(c, u, rng, news, bossId, result.outcomes[bossId] ?? 'arrest', hero);
    if (m.factionId && c.factions[m.factionId]) c.factions[m.factionId].power = clamp(c.factions[m.factionId].power - KIND_POWER_HIT[m.kind], 0, 100);
    if (m.kind === 'ally' && m.allyId) {
      remember(c, m.allyId, `was saved by ${hero.alias}`);
      shiftScore(c, u, news, m.allyId, 25);
    }
    if (m.kind === 'story' && m.storyId) applyStoryChoice(c, u, news, m.storyId, m.chapter, result.choice);
    const foiled = c.schemes.find((x) => x.id === m.schemeId);
    if (foiled) {
      c.schemes = c.schemes.filter((x) => x !== foiled);
      remember(c, foiled.villainId, `had their ${SCHEME_META[foiled.kind].title} foiled by ${hero.alias}`);
      news.add('scheme', `${hero.alias} foiled the ${SCHEME_META[foiled.kind].title}!`);
    }
    if (result.ambient?.completed) {
      news.add('mission', `${hero.alias} handled ${result.ambient.completed} ${result.ambient.completed === 1 ? 'incident' : 'incidents'} along the way.`);
      if (m.factionId && c.factions[m.factionId]) c.factions[m.factionId].power = clamp(c.factions[m.factionId].power - Math.min(10, result.ambient.completed * 2), 0, 100);
    }
    for (const id of result.ambient?.helpedAllyIds ?? []) {
      remember(c, id, `was rescued by ${hero.alias} on patrol`);
      shiftScore(c, u, news, id, 10);
    }
  } else {
    news.add('mission', `${hero.alias} was defeated during “${m.title}”.`);
    // A failed attempt buys the villain time.
    const sc = c.schemes.find((x) => x.id === m.schemeId);
    if (sc && sc.left > 1) {
      sc.left--;
      news.add('scheme', `The ${SCHEME_META[sc.kind].title} speeds up after the setback.`);
    }
    for (const bossId of result.survivingBossIds) {
      const boss = u.characters.find((x) => x.id === bossId);
      const r = c.relations[bossId];
      if (!boss || !r) continue;
      r.encounters++;
      r.theirWins++;
      r.grudgeHeroId ??= hero.id;
      remember(c, bossId, `defeated ${hero.alias}`);
      levelUp(boss, 1);
      shiftScore(c, u, news, bossId, -20);
      news.add('nemesis', `${boss.alias} grows stronger after defeating ${hero.alias}.`);
    }
    if (m.factionId && c.factions[m.factionId]) c.factions[m.factionId].power = clamp(c.factions[m.factionId].power + 10, 0, 100);
  }
  // Ignoring a faction's assault lets it grow.
  if (m.kind !== 'defense') {
    for (const f of hostileFactions(c, u)) if (f.s.power >= 70) f.s.power = clamp(f.s.power + 3, 0, 100);
  }

  awardBiometrics(c, u, news, heroId, result.victory ? (result.grade === 'S' ? 6 : 4) : 1, result.victory ? result.squadIds ?? [] : [], result.victory ? result.defeatedBossIds : []);
  if (result.victory) {
    completeContracts(c, u, m, result, hero, news);
    for (const item of dropLoot(rng, m, result, hero)) {
      u.items.push(item);
      news.add('loot', `Loot: ${item.name} (${item.rarity} ${item.slot}). Equip it from the hero's Gear, or salvage it in the Armory.`);
    }
  }
  // Teammates who fought alongside you grow closer.
  if (result.victory) for (const id of result.squadIds ?? []) if (id !== heroId) shiftScore(c, u, news, id, 3);
  advanceWorld(c, u, rng, news);
  c.news = [...news.items].reverse().concat(c.news).slice(0, MAX_NEWS);
  return news.items;
}

// --- Ranks and biometrics -----------------------------------------------------------

/** Biometrics for whoever fought (and for the bosses beaten, toward recruiting and ranking them later). */
function awardBiometrics(c: Campaign, u: Universe, news: Chronicle | null, heroId: string, heroAmount: number, squadIds: string[], bossIds: string[]) {
  const add = (id: string, n: number) => {
    if (n > 0 && u.characters.some((x) => x.id === id)) c.biometrics[id] = (c.biometrics[id] ?? 0) + n;
  };
  add(heroId, heroAmount);
  for (const id of squadIds) if (id !== heroId) add(id, 2);
  for (const id of bossIds) add(id, 3);
  const hero = u.characters.find((x) => x.id === heroId);
  if (news && hero && heroAmount > 0) news.add('loot', `🧬 +${heroAmount} ${hero.alias} biometrics${squadIds.length ? `, +2 for each teammate` : ''}.`);
}

/** Spends biometrics to raise a character one star. Returns false if it can't. */
export function rankUp(c: Campaign, u: Universe, charId: string): boolean {
  const ch = u.characters.find((x) => x.id === charId);
  const cost = ch ? rankUpCost(ch.stars) : null;
  if (!ch || cost === null || ch.stars >= MAX_STARS || (c.biometrics[charId] ?? 0) < cost) return false;
  c.biometrics[charId] -= cost;
  ch.stars++;
  return true;
}

/** Danger Room rewards: shards and biometrics scale with waves cleared; the best run is kept. */
export function resolveDangerRoom(c: Campaign, u: Universe, heroId: string, squadIds: string[], waves: number): NewsItem[] {
  const news = new Chronicle(c);
  const hero = u.characters.find((x) => x.id === heroId);
  const record = waves > c.dangerBest;
  c.dangerBest = Math.max(c.dangerBest, waves);
  const shards = waves * 6;
  c.shards += shards;
  news.add('mission', `${hero?.alias ?? 'Your hero'} survived ${waves} ${waves === 1 ? 'wave' : 'waves'} in the Danger Room${record ? ' (a new record!)' : ''}.`);
  if (shards) news.add('loot', `◈ +${shards} shards.`);
  awardBiometrics(c, u, news, heroId, Math.ceil(waves * 1.5), squadIds, []);
  c.news = [...news.items].reverse().concat(c.news).slice(0, MAX_NEWS);
  return news.items;
}

// --- Loot and the Armory ------------------------------------------------------------

const LOOT_DROPS: Record<MissionKind, number> = { story: 1, patrol: 0, raid: 2, hunt: 1, vendetta: 1, ally: 0, defense: 0, teamup: 1, scheme: 2 };
const GRADE_LUCK: Record<string, number> = { S: 0.6, A: 0.35, B: 0.15, C: 0 };

/** Gear dropped by a won mission: more and better for harder missions and higher grades. */
export function dropLoot(rng: Rng, m: Mission, result: MissionResult, hero: Character): Item[] {
  // Patrols and smaller jobs drop something half the time.
  let count = LOOT_DROPS[m.kind] || (rng.chance(0.5) ? 1 : 0);
  if (result.grade === 'S') count++;
  const luck = (m.difficulty - 1) * 0.12 + (GRADE_LUCK[result.grade ?? 'C'] ?? 0);
  return Array.from({ length: Math.min(3, count) }, () => rollLoot(rng, rollRarity(rng, luck), hero));
}

/** Breaks an item down into shards. It's unequipped from everyone first. */
export function salvageItem(c: Campaign, u: Universe, itemId: string): number {
  const i = u.items.findIndex((x) => x.id === itemId);
  if (i < 0) return 0;
  const value = salvageValue(u.items[i]);
  u.items.splice(i, 1);
  for (const ch of u.characters) ch.itemIds = ch.itemIds.filter((id) => id !== itemId);
  c.shards += value;
  return value;
}

/** Spends shards to raise an item one level. Returns false if it can't. */
export function upgradeItem(c: Campaign, u: Universe, itemId: string): boolean {
  const item = u.items.find((x) => x.id === itemId);
  const cost = item ? upgradeCost(item) : null;
  if (!item || cost === null || c.shards < cost) return false;
  c.shards -= cost;
  item.level++;
  return true;
}

// --- Contracts -------------------------------------------------------------------

export type ContractKind = 'teamup' | 'arrest' | 'spare' | 'rescue' | 'raid' | 'grade' | 'incidents' | 'patrol' | 'squad' | 'combo';

export interface Contract {
  id: string;
  kind: ContractKind;
  title: string;
  detail: string;
  xp: number;
}

const CONTRACTS: Record<ContractKind, Omit<Contract, 'id' | 'kind'>> = {
  teamup: { title: 'Assemble', detail: 'Win a Team-Up mission.', xp: 600 },
  arrest: { title: 'Due Process', detail: 'Arrest a defeated villain.', xp: 300 },
  spare: { title: 'Mercy', detail: 'Spare a defeated villain.', xp: 300 },
  rescue: { title: 'First Responder', detail: 'Rescue an ally during a patrol.', xp: 350 },
  raid: { title: 'Stronghold Breaker', detail: 'Win a raid.', xp: 500 },
  grade: { title: 'Flawless', detail: 'Earn an S grade on any mission.', xp: 450 },
  incidents: { title: 'Busy Night', detail: 'Handle 3 incidents in one patrol.', xp: 400 },
  patrol: { title: 'Beat Cop', detail: 'Complete a patrol.', xp: 200 },
  squad: { title: 'Strength in Numbers', detail: 'Win a mission with a squad of 3 or more heroes.', xp: 350 },
  combo: { title: 'Synergy', detail: 'Trigger 3 team combos in one mission.', xp: 450 },
};

/** Three contracts that rotate every three turns (deterministic per campaign). */
export function activeContracts(c: Campaign): Contract[] {
  const window = Math.floor((c.turn - 1) / 3);
  const rng = new Rng(mix(c.seed, window, 0xc0ffee));
  return rng.shuffle(Object.keys(CONTRACTS) as ContractKind[]).slice(0, 3).map((kind) => ({ id: `${kind}:${window}`, kind, ...CONTRACTS[kind] }));
}

function contractMet(kind: ContractKind, m: Mission, r: MissionResult): boolean {
  const outcomes = Object.values(r.outcomes);
  switch (kind) {
    case 'teamup':
      return m.kind === 'teamup';
    case 'arrest':
      return outcomes.includes('arrest');
    case 'spare':
      return outcomes.includes('spare');
    case 'rescue':
      return (r.ambient?.helpedAllyIds.length ?? 0) > 0;
    case 'raid':
      return m.kind === 'raid';
    case 'grade':
      return r.grade === 'S';
    case 'incidents':
      return (r.ambient?.completed ?? 0) >= 3;
    case 'patrol':
      return m.kind === 'patrol';
    case 'squad':
      return (r.squadIds?.length ?? 0) >= 2;
    case 'combo':
      return (r.combos ?? 0) >= 3;
  }
}

function completeContracts(c: Campaign, u: Universe, m: Mission, r: MissionResult, hero: Character, news: Chronicle) {
  for (const contract of activeContracts(c)) {
    if (c.contractsDone.includes(contract.id) || !contractMet(contract.kind, m, r)) continue;
    c.contractsDone.push(contract.id);
    grantXp(hero, contract.xp);
    news.add('contract', `Contract complete: ${contract.title} (+${contract.xp} XP for ${hero.alias}).`);
  }
  void u;
}

/** Story choices write flags and shift relationships; progress follows the flags. */
export function applyStoryChoice(c: Campaign, u: Universe, news: Chronicle | null, storyId: string, chapter: number, choice: number | null) {
  const story = u.stories.find((s) => s.id === storyId);
  const p = c.stories[storyId];
  if (!story || !p) return;
  const ch = story.chapters[chapter];
  const opt = ch?.choice && choice !== null ? ch.choice.options[choice] : undefined;
  if (ch?.choice && opt) {
    c.flags[ch.choice.flag] = opt.value;
    if (opt.relationshipId && opt.relationshipDelta) {
      if (news) shiftScore(c, u, news, opt.relationshipId, opt.relationshipDelta);
      else c.relations[opt.relationshipId].score = clamp(c.relations[opt.relationshipId].score + opt.relationshipDelta, -100, 100);
    }
    news?.add('story', `You chose: ${opt.label}.`);
  }
  const next = nextChapterIndex(story, chapter + 1, c.flags);
  if (next === null) {
    p.done = true;
    news?.add('story', `Story complete: ${story.title}.`);
  } else p.chapter = next;
}

/** One tick of world simulation: factions grow, prisoners escape, ambitious underlings strike. */
export function advanceWorld(c: Campaign, u: Universe, rng: Rng, news: Chronicle = new Chronicle(c)) {
  c.turn++;
  const byId = (id: string) => u.characters.find((x) => x.id === id);
  const cp = (ch: Character) => combatPower(ch, u.items);

  for (const f of u.factions) {
    const s = c.factions[f.id];
    if (!s || f.alignment === 'hero') continue;
    const leader = s.leaderId ? byId(s.leaderId) : undefined;
    if (leader && isHostile(c, leader)) s.power = clamp(s.power + 4, 0, 100);
  }

  // Prison breaks.
  for (const ch of u.characters) {
    const r = c.relations[ch.id];
    if (r?.state !== 'imprisoned' || !rng.chance(0.12 + 0.04 * r.theirWins)) continue;
    r.state = 'free';
    remember(c, ch.id, `escaped from prison`);
    shiftScore(c, u, news, ch.id, -15);
    const fs = ch.factionId ? c.factions[ch.factionId] : undefined;
    const faction = u.factions.find((f) => f.id === ch.factionId);
    if (fs && faction) {
      const current = fs.leaderId ? byId(fs.leaderId) : undefined;
      fs.lieutenantIds = fs.lieutenantIds.filter((id) => id !== ch.id);
      if (!current || cp(ch) > cp(current)) {
        if (current) fs.lieutenantIds.push(current.id);
        fs.leaderId = ch.id;
        news.add('escape', `${ch.alias} escaped from prison and ${current ? `reclaimed ${faction.name} from ${current.alias}` : `took control of ${faction.name}`}!`);
      } else {
        fs.lieutenantIds.push(ch.id);
        news.add('escape', `${ch.alias} escaped from prison and rejoined ${faction.name} under ${current.alias}.`);
      }
    } else news.add('escape', `${ch.alias} escaped from prison!`);
  }

  tickSchemes(c, u, rng, news);

  // Coups: a lieutenant who outgrows their boss may take over.
  for (const f of u.factions) {
    const s = c.factions[f.id];
    const leader = s?.leaderId ? byId(s.leaderId) : undefined;
    if (!s || !leader || !isHostile(c, leader)) continue;
    const rival = s.lieutenantIds.map(byId).filter((x): x is Character => !!x && isHostile(c, x)).sort((a, b) => cp(b) - cp(a))[0];
    if (rival && cp(rival) > cp(leader) * 1.05 && rng.chance(0.25)) {
      s.lieutenantIds = s.lieutenantIds.filter((x) => x !== rival.id).concat(leader.id);
      s.leaderId = rival.id;
      remember(c, rival.id, `overthrew ${leader.alias}`);
      news.add('succession', `${rival.alias} overthrew ${leader.alias} and now leads ${f.name}!`);
    }
  }
}

// --- Villain schemes ---------------------------------------------------------------

const MAX_SCHEMES = 2;

/** Counts schemes down, resolves the ones that run out, and lets villains start new ones. */
function tickSchemes(c: Campaign, u: Universe, rng: Rng, news: Chronicle) {
  const byId = (id: string) => u.characters.find((x) => x.id === id);
  for (const sc of [...c.schemes]) {
    const villain = byId(sc.villainId);
    const meta = SCHEME_META[sc.kind];
    if (!villain || !isHostile(c, villain) || c.relations[villain.id]?.state !== 'free') {
      c.schemes = c.schemes.filter((x) => x !== sc);
      news.add('scheme', `The ${meta.title} falls apart without ${villain?.alias ?? 'its mastermind'}.`);
      continue;
    }
    sc.left--;
    if (sc.left > 0) {
      if (sc.left === 1) news.add('scheme', `⚠ ${villain.alias}'s ${meta.title} completes next turn!`);
      continue;
    }
    c.schemes = c.schemes.filter((x) => x !== sc);
    executeScheme(c, u, rng, news, sc, villain);
  }

  if (c.schemes.length >= MAX_SCHEMES || !rng.chance(0.35)) return;
  const busy = new Set(c.schemes.map((x) => x.villainId));
  const candidates = u.characters
    .filter((ch) => isHostile(c, ch) && c.relations[ch.id]?.state === 'free' && !busy.has(ch.id))
    .filter((ch) => Object.values(c.factions).some((f) => f.leaderId === ch.id) || bond(relationOf(c, ch.id)) === 'nemesis')
    .sort((a, b) => combatPower(b, u.items) - combatPower(a, u.items));
  const villain = candidates[0];
  if (!villain) return;
  const anyoneJailed = u.characters.some((ch) => c.relations[ch.id]?.state === 'imprisoned' && ch.role === 'villain');
  const kinds: SchemeKind[] = ['doomsday', 'takeover', 'army', ...(anyoneJailed ? ['jailbreak', 'jailbreak'] as const : [])];
  const kind = rng.pick(kinds);
  const meta = SCHEME_META[kind];
  const scheme: Scheme = {
    id: `sch:${c.turn}:${hash(villain.id) % 100000}`,
    kind,
    villainId: villain.id,
    factionId: villain.factionId,
    locationId: u.locations.length ? rng.pick(u.locations).id : '',
    left: meta.turns,
    total: meta.turns,
  };
  c.schemes.push(scheme);
  remember(c, villain.id, `began the ${meta.title}`);
  news.add('scheme', `${villain.alias} has begun the ${meta.title}! Stop it within ${meta.turns} turns or it ${meta.threat}.`);
}

function executeScheme(c: Campaign, u: Universe, rng: Rng, news: Chronicle, sc: Scheme, villain: Character) {
  const fs = sc.factionId ? c.factions[sc.factionId] : undefined;
  const faction = u.factions.find((f) => f.id === sc.factionId);
  const where = u.locations.find((l) => l.id === sc.locationId)?.name ?? 'the city';
  remember(c, villain.id, `completed the ${SCHEME_META[sc.kind].title}`);
  switch (sc.kind) {
    case 'doomsday':
      if (fs) fs.power = clamp(fs.power + 30, 0, 100);
      for (const f of u.factions) if (f.alignment === 'hero' && c.factions[f.id]) c.factions[f.id].power = clamp(c.factions[f.id].power - 15, 0, 100);
      levelUp(villain, 3);
      news.add('scheme', `💥 The Doomsday Device devastated ${where}! ${villain.alias} grows stronger (Lv ${villain.level}).`);
      break;
    case 'jailbreak': {
      const freed = u.characters.filter((ch) => c.relations[ch.id]?.state === 'imprisoned');
      for (const ch of freed) {
        c.relations[ch.id].state = 'free';
        remember(c, ch.id, `was broken out by ${villain.alias}`);
        const home = ch.factionId ? c.factions[ch.factionId] : undefined;
        if (home && home.leaderId !== ch.id && !home.lieutenantIds.includes(ch.id)) home.lieutenantIds.push(ch.id);
      }
      news.add('scheme', `💥 ${villain.alias}'s Mass Breakout freed ${freed.length ? freed.map((x) => x.alias).join(', ') : 'the whole cell block'}!`);
      break;
    }
    case 'takeover':
      if (fs) fs.power = 100;
      if (fs && faction && fs.leaderId !== villain.id && villain.factionId === faction.id) {
        if (fs.leaderId) fs.lieutenantIds.push(fs.leaderId);
        fs.lieutenantIds = fs.lieutenantIds.filter((id) => id !== villain.id);
        fs.leaderId = villain.id;
      }
      news.add('scheme', `💥 ${villain.alias} seized ${where}: ${faction?.name ?? 'their gang'} now controls the city!`);
      break;
    case 'army': {
      const recruits = [0, 1].map(() => {
        const ch = randomCharacter(rng, 'villain', villain.factionId);
        ch.id = `chr_army${rng.int(0, 2 ** 30).toString(36)}`;
        levelUp(ch, Math.max(0, villain.level - 2));
        return ch;
      });
      u.characters.push(...recruits);
      syncCampaign(c, u);
      if (fs) for (const r of recruits) if (!fs.lieutenantIds.includes(r.id) && fs.leaderId !== r.id) fs.lieutenantIds.push(r.id);
      news.add('scheme', `💥 ${villain.alias} raised an army: ${recruits.map((x) => x.alias).join(' and ')} joined ${faction?.name ?? 'the cause'}.`);
      break;
    }
  }
}

/** Lets time pass without a mission (the board refreshes). */
export function passTime(c: Campaign, u: Universe): NewsItem[] {
  const news = new Chronicle(c);
  advanceWorld(c, u, new Rng(mix(c.seed, c.turn, 0x7a11)), news);
  c.news = [...news.items].reverse().concat(c.news).slice(0, MAX_NEWS);
  return news.items;
}

// --- Hashing -------------------------------------------------------------------

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mix(...parts: number[]): number {
  let h = 0x9e3779b9;
  for (const p of parts) h = Math.imul(h ^ (p >>> 0), 2654435761) ^ (h >>> 13);
  return h >>> 0;
}
