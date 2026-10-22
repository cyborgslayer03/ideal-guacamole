// Hand-designed "Legends": a ready-made cast of original heroes and villains,
// each with a distinct power set and a distinct way of getting around.

import { emptyUniverse } from './generator';
import { newId } from './id';
import type { Appearance, Character, Element, Faction, Item, Location, PowerKind, Role, Stats, Story, Universe } from './types';

interface PowerSpec {
  name: string;
  kind: PowerKind;
  element: Element;
  potency: number;
  description: string;
}

export interface LegendSpec {
  key: string;
  alias: string;
  name: string;
  role: Role;
  /** Short line for pickers: what makes them play differently. */
  style: string;
  origin: string;
  bio: string;
  stats: Stats;
  appearance: Appearance;
  powers: PowerSpec[];
}

const s = (strength: number, speed: number, durability: number, energy: number, intelligence: number, combat: number): Stats =>
  ({ strength, speed, durability, energy, intelligence, combat });

export const LEGENDS: LegendSpec[] = [
  // --- Heroes ------------------------------------------------------------------
  {
    key: 'aegis',
    alias: 'Aegis Prime',
    name: 'Commander Rhea Castellan',
    role: 'hero',
    style: 'Shield-bearing tank who leaps into the fight and slams down',
    origin: 'A soldier fused with an alien alloy shield during a meteor strike on her base.',
    bio: 'Aegis Prime leads from the front line and has never left a teammate behind.',
    stats: s(8, 5, 10, 5, 6, 9),
    appearance: { primary: '#1f6f8b', secondary: '#d8dde6', accent: '#f2b632', build: 'heavy', height: 1.08, head: 'helmet', emblem: 'star', cape: false, aura: false, model: null },
    powers: [
      { name: 'Ricochet Disc', kind: 'blast', element: 'kinetic', potency: 6, description: 'Hurls her shield in a banking arc.' },
      { name: 'Bastion Charge', kind: 'dash', element: 'kinetic', potency: 7, description: 'A shield-first charge that scatters crowds.' },
      { name: 'Aegis Barrier', kind: 'shield', element: 'kinetic', potency: 8, description: 'Plants the shield and shrugs off nearly everything.' },
      { name: 'Shockwave Slam', kind: 'nova', element: 'kinetic', potency: 7, description: 'Strikes the ground with the shield rim.' },
      { name: 'Siege Leap', kind: 'leap', element: 'kinetic', potency: 8, description: 'Vaults across the battlefield and lands like artillery.' },
    ],
  },
  {
    key: 'voltstream',
    alias: 'Voltstream',
    name: 'Mateo Ruiz',
    role: 'hero',
    style: 'Lightning speedster: the fastest runner in the multiverse',
    origin: 'Struck by lightning while racing a particle accelerator test.',
    bio: 'Voltstream talks fast, thinks faster, and is always the first one on the scene.',
    stats: s(5, 10, 5, 7, 6, 8),
    appearance: { primary: '#d6a31a', secondary: '#7a1020', accent: '#ffe93e', build: 'slim', height: 0.98, head: 'visor', emblem: 'bolt', cape: false, aura: true, model: null },
    powers: [
      { name: 'Static Barrage', kind: 'blast', element: 'lightning', potency: 6, description: 'A flurry of sparks thrown at a dead sprint.' },
      { name: 'Thunder Rush', kind: 'dash', element: 'lightning', potency: 8, description: 'Becomes a bolt of lightning and tears through a line of foes.' },
      { name: 'Storm Cyclone', kind: 'nova', element: 'lightning', potency: 6, description: 'Runs circles fast enough to make a storm.' },
      { name: 'Lightspeed', kind: 'superspeed', element: 'lightning', potency: 10, description: 'Always running at the edge of the speed of sound.' },
    ],
  },
  {
    key: 'seraph',
    alias: 'Seraph',
    name: 'Amara Okonkwo',
    role: 'hero',
    style: 'Solar flier who blasts from the sky and heals allies',
    origin: 'Chosen by a dying star as the vessel for its last light.',
    bio: 'Seraph believes everyone deserves a second dawn, even her enemies.',
    stats: s(5, 7, 6, 10, 7, 6),
    appearance: { primary: '#f1e6c8', secondary: '#c4642a', accent: '#ffc23e', build: 'athletic', height: 1.02, head: 'bare', emblem: 'circle', cape: true, aura: true, model: null },
    powers: [
      { name: 'Dawnfire Bolt', kind: 'blast', element: 'fire', potency: 7, description: 'Spears of condensed sunlight.' },
      { name: 'Solar Lance', kind: 'beam', element: 'fire', potency: 8, description: 'A continuous beam hot enough to cut steel.' },
      { name: 'Radiant Renewal', kind: 'heal', element: 'nature', potency: 7, description: 'Bathes herself in restoring light.' },
      { name: 'Wings of Morning', kind: 'flight', element: 'fire', potency: 8, description: 'Wings of light carry her anywhere.' },
    ],
  },
  {
    key: 'nightveil',
    alias: 'Nightveil',
    name: 'Kenji Arashiro',
    role: 'hero',
    style: 'Shadow assassin who teleports between targets',
    origin: 'Trained by a hidden order that walks between shadows.',
    bio: 'Nightveil strikes once, vanishes, and is already behind you.',
    stats: s(6, 9, 4, 6, 8, 10),
    appearance: { primary: '#1b1730', secondary: '#0b0b12', accent: '#8a5cff', build: 'slim', height: 1.0, head: 'cowl', emblem: 'diamond', cape: true, aura: false, model: null },
    powers: [
      { name: 'Shadow Shuriken', kind: 'blast', element: 'shadow', potency: 6, description: 'Blades of solid darkness that drain life.' },
      { name: 'Eclipse Strike', kind: 'dash', element: 'shadow', potency: 8, description: 'A blur of cuts through everyone in the way.' },
      { name: 'Veil of Night', kind: 'shield', element: 'shadow', potency: 6, description: 'Wraps himself in shadow to slip past blows.' },
      { name: 'Umbral Step', kind: 'teleport', element: 'shadow', potency: 8, description: 'Steps into one shadow and out of another.' },
    ],
  },
  {
    key: 'mindwarden',
    alias: 'Mindwarden',
    name: 'Dr. Elise Varga',
    role: 'hero',
    style: 'Psychic controller who stuns crowds and blinks across the field',
    origin: 'A neuroscientist whose mind expanded after a failed consciousness experiment.',
    bio: 'Mindwarden sees every move a second before it happens.',
    stats: s(3, 6, 5, 9, 10, 6),
    appearance: { primary: '#5b2a86', secondary: '#20123a', accent: '#ff4fd8', build: 'slim', height: 1.0, head: 'visor', emblem: 'triangle', cape: true, aura: true, model: null },
    powers: [
      { name: 'Psi Lance', kind: 'beam', element: 'psychic', potency: 7, description: 'A focused thought that locks enemies in place.' },
      { name: 'Mind Quake', kind: 'nova', element: 'psychic', potency: 8, description: 'A psychic scream that stuns everyone nearby.' },
      { name: 'Telekinetic Hurl', kind: 'blast', element: 'kinetic', potency: 6, description: 'Throws debris with her mind.' },
      { name: 'Thought Shield', kind: 'shield', element: 'psychic', potency: 6, description: 'A barrier of pure willpower.' },
      { name: 'Farsight Shift', kind: 'teleport', element: 'psychic', potency: 6, description: 'Thinks herself somewhere else.' },
    ],
  },
  {
    key: 'ironclad',
    alias: 'Ironclad Ranger',
    name: 'Marcus Hale',
    role: 'hero',
    style: 'Armored inventor with repulsors and jet-powered flight',
    origin: 'Built a combat suit from salvaged war machines to defend his city.',
    bio: 'Ironclad Ranger has a gadget for everything, and a backup for the gadget.',
    stats: s(7, 6, 8, 7, 9, 5),
    appearance: { primary: '#8c1c1c', secondary: '#3a3f4a', accent: '#3ee8ff', build: 'athletic', height: 1.05, head: 'helmet', emblem: 'circle', cape: false, aura: false, model: null },
    powers: [
      { name: 'Repulsor Volley', kind: 'blast', element: 'tech', potency: 7, description: 'Palm-mounted energy cannons.' },
      { name: 'Arc Cannon', kind: 'beam', element: 'energy', potency: 8, description: 'The chest reactor fires at full output.' },
      { name: 'Nano Repair', kind: 'heal', element: 'tech', potency: 6, description: 'Nanites patch the suit and the pilot.' },
      { name: 'Jet Boots', kind: 'flight', element: 'tech', potency: 7, description: 'Thrusters for sustained flight.' },
    ],
  },

  // --- Villains ----------------------------------------------------------------
  {
    key: 'kryos',
    alias: 'Overlord Kryos',
    name: 'Vladimir Kryos',
    role: 'villain',
    style: 'Ice tyrant who rules the sky on frozen wings',
    origin: 'A deposed monarch who returned from an arctic exile with a heart of ice.',
    bio: 'Kryos wants a silent, frozen world where nothing can ever change again.',
    stats: s(7, 5, 9, 9, 8, 6),
    appearance: { primary: '#bfe4ff', secondary: '#1d3b5c', accent: '#8fd8ff', build: 'heavy', height: 1.12, head: 'helmet', emblem: 'diamond', cape: true, aura: true, model: null },
    powers: [
      { name: 'Glacial Beam', kind: 'beam', element: 'ice', potency: 8, description: 'Freezes everything in a long line.' },
      { name: 'Absolute Zero', kind: 'nova', element: 'ice', potency: 9, description: 'The air itself freezes around him.' },
      { name: 'Cryo Shards', kind: 'blast', element: 'ice', potency: 7, description: 'A spread of razor icicles.' },
      { name: 'Permafrost Barrier', kind: 'shield', element: 'ice', potency: 7, description: 'Encases himself in unbreakable ice.' },
      { name: 'Frozen Wings', kind: 'flight', element: 'ice', potency: 7, description: 'Wings of ice that never melt.' },
    ],
  },
  {
    key: 'hexmother',
    alias: 'Hexmother',
    name: 'Morgana Vey',
    role: 'villain',
    style: 'Void sorceress who warps space and drains her foes',
    origin: 'Sold her shadow to an entity beyond the stars in exchange for its power.',
    bio: 'Hexmother collects heroes the way others collect curios.',
    stats: s(4, 6, 6, 10, 9, 6),
    appearance: { primary: '#2a0f3a', secondary: '#0d0614', accent: '#b06bff', build: 'slim', height: 1.04, head: 'cowl', emblem: 'triangle', cape: true, aura: true, model: null },
    powers: [
      { name: 'Hex Bolt', kind: 'blast', element: 'cosmic', potency: 8, description: 'Orbs of starless void.' },
      { name: 'Void Rift', kind: 'nova', element: 'shadow', potency: 8, description: 'Tears open space and drinks the life around her.' },
      { name: 'Dark Pact', kind: 'heal', element: 'shadow', potency: 7, description: 'Calls in a favor from the void.' },
      { name: 'Riftwalk', kind: 'teleport', element: 'cosmic', potency: 9, description: 'Folds space to appear wherever she wishes.' },
    ],
  },
  {
    key: 'juggernox',
    alias: 'Juggernox',
    name: 'Brutus Kane',
    role: 'villain',
    style: 'Unstoppable brute who crashes in from across the arena',
    origin: 'A prison experiment in muscle-density serum that worked far too well.',
    bio: 'Juggernox does not stop. He has never needed to.',
    stats: s(10, 4, 10, 4, 3, 8),
    appearance: { primary: '#6b3a1e', secondary: '#2a2a2a', accent: '#ff6a1f', build: 'heavy', height: 1.2, head: 'helmet', emblem: 'none', cape: false, aura: false, model: null },
    powers: [
      { name: 'Rampage', kind: 'dash', element: 'kinetic', potency: 9, description: 'A charge through walls, cars, and heroes.' },
      { name: 'Earthshatter', kind: 'nova', element: 'kinetic', potency: 9, description: 'Splits the ground with both fists.' },
      { name: 'Boulder Hurl', kind: 'blast', element: 'kinetic', potency: 7, description: 'Rips up the street and throws it.' },
      { name: 'Meteor Drop', kind: 'leap', element: 'kinetic', potency: 9, description: 'Jumps a city block and lands like a meteor.' },
    ],
  },
  {
    key: 'blitzkrieg',
    alias: 'Blitzkrieg',
    name: 'Dax Vorne',
    role: 'villain',
    style: 'Speedster arsonist who burns trails across the city',
    origin: 'Stole the experimental speed formula meant for a hero program.',
    bio: 'Blitzkrieg wants to be the fastest thing alive, and to watch everything else burn.',
    stats: s(6, 10, 5, 7, 5, 8),
    appearance: { primary: '#2b2b2b', secondary: '#7a1a0a', accent: '#ff6a1f', build: 'slim', height: 0.98, head: 'mask', emblem: 'bolt', cape: false, aura: true, model: null },
    powers: [
      { name: 'Scorch Dash', kind: 'dash', element: 'fire', potency: 8, description: 'A blur that leaves a wall of fire behind.' },
      { name: 'Flame Cyclone', kind: 'nova', element: 'fire', potency: 7, description: 'Runs a burning ring around his victims.' },
      { name: 'Ember Volley', kind: 'blast', element: 'fire', potency: 6, description: 'Flicks burning embers at high speed.' },
      { name: 'Afterburn', kind: 'superspeed', element: 'fire', potency: 9, description: 'Faster than any hero, and he knows it.' },
      { name: 'Firestorm Vault', kind: 'leap', element: 'fire', potency: 6, description: 'Uses his momentum to launch himself skyward.' },
    ],
  },
  {
    key: 'paradox',
    alias: 'Doctor Paradox',
    name: 'Dr. Silas Thorne',
    role: 'villain',
    style: 'Chrono-scientist with drones and time-skipping teleports',
    origin: 'Trapped himself in a time loop and came back with a thousand years of plans.',
    bio: 'Doctor Paradox has already seen how this fight ends. Probably.',
    stats: s(4, 6, 6, 8, 10, 6),
    appearance: { primary: '#1d4d4a', secondary: '#101a1a', accent: '#3eff8b', build: 'athletic', height: 1.0, head: 'visor', emblem: 'circle', cape: true, aura: false, model: null },
    powers: [
      { name: 'Chrono Beam', kind: 'beam', element: 'energy', potency: 8, description: 'Ages whatever it touches.' },
      { name: 'Drone Swarm', kind: 'blast', element: 'tech', potency: 7, description: 'A swarm of explosive micro-drones.' },
      { name: 'Temporal Shield', kind: 'shield', element: 'energy', potency: 8, description: 'Attacks arrive a moment too late.' },
      { name: 'Time Skip', kind: 'teleport', element: 'energy', potency: 7, description: 'Skips the seconds between here and there.' },
    ],
  },
  {
    key: 'venomancer',
    alias: 'Venomancer',
    name: 'Ivy Malkin',
    role: 'villain',
    style: 'Toxic predator who pounces from cover and regrows from wounds',
    origin: 'A botanist who merged with the poison garden she was trying to save.',
    bio: 'Venomancer will return the cities to the jungle, one hero at a time.',
    stats: s(6, 8, 7, 7, 6, 7),
    appearance: { primary: '#2f6b2a', secondary: '#16240f', accent: '#b6ff3e', build: 'athletic', height: 1.0, head: 'mask', emblem: 'diamond', cape: false, aura: true, model: null },
    powers: [
      { name: 'Toxic Spit', kind: 'blast', element: 'nature', potency: 7, description: 'Corrosive venom that heals her as it burns.' },
      { name: 'Spore Cloud', kind: 'nova', element: 'nature', potency: 7, description: 'A choking burst of spores.' },
      { name: 'Regrowth', kind: 'heal', element: 'nature', potency: 8, description: 'Regenerates like a weed.' },
      { name: 'Predator Pounce', kind: 'leap', element: 'nature', potency: 7, description: 'Springs from cover onto her prey.' },
      { name: 'Vine Sprint', kind: 'superspeed', element: 'nature', potency: 4, description: 'Moves through the undergrowth with ease.' },
    ],
  },
];

/** A fresh copy of a legend with new ids, ready to add to any universe. */
export function legendCharacter(spec: LegendSpec, factionId: string | null = null): Character {
  return {
    id: newId('chr'),
    name: spec.name,
    alias: spec.alias,
    role: spec.role,
    factionId,
    origin: spec.origin,
    bio: spec.bio,
    stats: { ...spec.stats },
    powers: spec.powers.map((p) => ({ id: newId('pow'), ...p })),
    appearance: { ...spec.appearance },
    itemIds: [],
    level: 1,
    xp: 0,
  };
}

export function findLegend(key: string): LegendSpec | undefined {
  return LEGENDS.find((l) => l.key === key);
}

/** A complete universe starring the Legends, with a branching story. */
export function legendsUniverse(): Universe {
  const u = emptyUniverse('Legends of the Omniverse');
  u.tagline = 'The original heroes and villains of Omniverse Forge.';
  u.description = 'The Vanguard stands between the city and the Obsidian Court, a coalition of villains led by Overlord Kryos.';
  u.accent = '#3ee8ff';

  const vanguard: Faction = { id: newId('fac'), name: 'The Vanguard', color: '#1f8fb0', alignment: 'hero', description: 'Earth’s front line.', leaderId: null };
  const court: Faction = { id: newId('fac'), name: 'The Obsidian Court', color: '#a3203a', alignment: 'villain', description: 'Villains united under one icy crown.', leaderId: null };
  u.factions.push(vanguard, court);

  const byKey = new Map<string, Character>();
  for (const spec of LEGENDS) {
    const c = legendCharacter(spec, spec.role === 'hero' ? vanguard.id : court.id);
    byKey.set(spec.key, c);
    u.characters.push(c);
  }
  vanguard.leaderId = byKey.get('aegis')!.id;
  court.leaderId = byKey.get('kryos')!.id;

  const loc = (name: string, biome: Location['biome'], skyColor: string, groundColor: string, glowColor: string, density: number): Location =>
    ({ id: newId('loc'), name, biome, description: '', skyColor, groundColor, glowColor, density, rules: {} });
  const city = loc('Neo Haven', 'metropolis', '#0a1030', '#151a2e', '#3ee8ff', 0.6);
  const peaks = loc('Frostspire Peaks', 'frozen', '#0c1e30', '#c8dcec', '#8fd8ff', 0.5);
  const sanctum = loc('Sanctum Obscura', 'mystic', '#120a24', '#1e1430', '#b06bff', 0.45);
  const station = loc('Event Horizon Station', 'cosmic', '#070414', '#1a1030', '#3eff8b', 0.4);
  // Local laws: the orbital station has a third of normal gravity.
  station.rules = { gravity: 0.35 };
  u.locations.push(city, peaks, sanctum, station);

  const item = (name: string, slot: Item['slot'], rarity: Item['rarity'], bonuses: Item['bonuses'], color: string, description: string): Item =>
    ({ id: newId('itm'), name, slot, rarity, bonuses, color, description });
  const crown = item('Crown of Winter', 'artifact', 'mythic', { energy: 4, durability: 3, intelligence: 2 }, '#bfe4ff', 'Kryos’s crown. It hums with cold.');
  const gauntlet = item('Vanguard Gauntlet', 'weapon', 'legendary', { strength: 3, combat: 3 }, '#f2b632', 'Forged from Aegis’s shield alloy.');
  const cloak = item('Riftweave Cloak', 'armor', 'epic', { speed: 2, durability: 2 }, '#b06bff', 'Stitched from folded space.');
  u.items.push(crown, gauntlet, cloak);

  const id = (k: string) => byKey.get(k)!.id;
  const flag = 'legends.path';
  const story: Story = {
    id: newId('sty'),
    title: 'Legends Assemble',
    synopsis: 'Overlord Kryos unites the Obsidian Court to freeze Neo Haven. The Vanguard must decide how to strike back.',
    protagonistId: id('aegis'),
    chapters: [
      {
        id: newId('chp'), title: 'Cold Open', locationId: city.id,
        intro: [
          { speaker: 'Mindwarden', text: 'Temperature is dropping across Neo Haven. This is no storm.' },
          { speaker: 'Aegis Prime', text: 'Court troops in the streets. Vanguard, move!' },
        ],
        objective: { type: 'defeat', count: 12 }, enemyFactionId: court.id, enemyLevel: 1,
        outro: [{ speaker: 'Voltstream', text: 'They were guarding something. Juggernox is tearing up the old freeway!' }],
        rewardItemId: null, requires: null, choice: null,
      },
      {
        id: newId('chp'), title: 'Unstoppable', locationId: city.id,
        intro: [{ speaker: 'Juggernox', text: 'Nobody gets past me. NOBODY.' }],
        objective: { type: 'boss', characterId: id('juggernox') }, enemyFactionId: court.id, enemyLevel: 3,
        outro: [{ speaker: 'Nightveil', text: 'He was a distraction. Hexmother is opening a rift in the Sanctum, and Kryos is at the Peaks.' }],
        rewardItemId: gauntlet.id, requires: null,
        choice: {
          prompt: 'Two threats, one team. Where does the Vanguard strike first?',
          flag,
          options: [
            { label: 'Close Hexmother’s rift', value: 'rift', relationshipId: id('hexmother'), relationshipDelta: -10 },
            { label: 'Storm Frostspire Peaks', value: 'peaks', relationshipId: id('kryos'), relationshipDelta: -10 },
          ],
        },
      },
      {
        id: newId('chp'), title: 'The Rift', locationId: sanctum.id,
        intro: [
          { speaker: 'Hexmother', text: 'Heroes, in my sanctum? How delightful. Stay forever.' },
          { speaker: 'Seraph', text: 'Light finds its way into every shadow, Hexmother.' },
        ],
        objective: { type: 'boss', characterId: id('hexmother') }, enemyFactionId: court.id, enemyLevel: 5,
        outro: [{ speaker: 'Mindwarden', text: 'The rift is sealed, but Kryos used the time to finish his storm engine.' }],
        rewardItemId: cloak.id, requires: { flag, value: 'rift' }, choice: null,
      },
      {
        id: newId('chp'), title: 'Avalanche', locationId: peaks.id,
        intro: [{ speaker: 'Ironclad Ranger', text: 'Storm engine is shielded. We hold the pass while I break in.' }],
        objective: { type: 'survive', seconds: 50 }, enemyFactionId: court.id, enemyLevel: 5,
        outro: [{ speaker: 'Ironclad Ranger', text: 'Engine down! But Hexmother escaped through her rift, and Kryos is coming.' }],
        rewardItemId: null, requires: { flag, value: 'peaks' }, choice: null,
      },
      {
        id: newId('chp'), title: 'Long Winter', locationId: peaks.id,
        intro: [
          { speaker: 'Overlord Kryos', text: 'You cannot stop winter. You can only endure it.' },
          { speaker: 'Aegis Prime', text: 'Then we endure. Vanguard, together!' },
        ],
        objective: { type: 'boss', characterId: id('kryos') }, enemyFactionId: court.id, enemyLevel: 7,
        outro: [{ speaker: 'Aegis Prime', text: 'The Court is broken, for now. Somebody will try to take that crown.' }],
        rewardItemId: crown.id, requires: null, choice: null,
      },
    ],
  };
  u.stories.push(story);
  return u;
}
