// Procedural content: lets a player with no time to spare get a complete,
// playable universe in one click, and lets detailed creators randomize any
// single piece (a name, a power, a costume) as a starting point.

import { newId } from './id';
import { Rng } from './rng';
import {
  BIOMES, BUILDS, ELEMENTS, EMBLEMS, HEAD_STYLES, ITEM_SLOTS, RARITIES, SCHEMA_VERSION, STAT_KEYS,
  type Appearance, type Biome, type Chapter, type Character, type Element, type Faction, type Item,
  type ItemSlot, type Location, type Power, type PowerKind, type Rarity, type Role, type Stats,
  type Story, type Universe,
} from './types';

const ALIAS_PREFIX = [
  'Captain', 'Doctor', 'Star', 'Night', 'Iron', 'Crimson', 'Quantum', 'Shadow', 'Storm', 'Omega',
  'Solar', 'Void', 'Thunder', 'Phantom', 'Nova', 'Steel', 'Mystic', 'Atomic', 'Silver', 'Cyber',
  'Scarlet', 'Astro', 'Blaze', 'Frost', 'Hyper', 'Titan', 'Neon', 'Psi', 'Wild', 'Venom',
];
const ALIAS_SUFFIX = [
  'Hawk', 'Strike', 'Fang', 'Knight', 'Wraith', 'Pulse', 'Guardian', 'Lancer', 'Spectre', 'Bolt',
  'Fury', 'Sentinel', 'Blade', 'Comet', 'Viper', 'Warden', 'Flare', 'Shade', 'Rift', 'Volt',
  'Raven', 'Golem', 'Mantis', 'Siren', 'Reaper', 'Nexus', 'Hunter', 'Phoenix', 'Cyclone', 'Mind',
];
const SOLO_ALIAS = ['Paragon', 'Eclipse', 'Kinetix', 'Oblivion', 'Wavelength', 'Gravitas', 'Zenith', 'Mirage', 'Torrent', 'Equinox'];
const FIRST_NAMES = [
  'Alex', 'Jordan', 'Maya', 'Kai', 'Riley', 'Dana', 'Marcus', 'Elena', 'Theo', 'Imani',
  'Victor', 'Noor', 'Sam', 'Lena', 'Diego', 'Aiko', 'Owen', 'Zara', 'Felix', 'Priya',
];
const LAST_NAMES = [
  'Vance', 'Okafor', 'Reyes', 'Nakamura', 'Stone', 'Blackwood', 'Castillo', 'Hale', 'Moreau', 'Singh',
  'Kowalski', 'Adeyemi', 'Frost', 'Laurent', 'Park', 'Quinn', 'Torres', 'Volkov', 'Wright', 'Zhao',
];
const ORIGINS = [
  'Exposed to a cosmic storm during a failed space mission.',
  'Born with a dormant mutation that awakened under stress.',
  'Bonded with an alien symbiote that crashed to Earth.',
  'Built a suit of advanced armor after a near-fatal attack.',
  'Chosen by an ancient artifact to be its champion.',
  'Survived a lab accident involving experimental particles.',
  'Trained for years by a secret order of mystic warriors.',
  'The last survivor of a destroyed alien world.',
  'Volunteered for a super-soldier program that went wrong.',
  'Struck by lightning while touching a meteorite fragment.',
];
const MOTIVES: Record<Role, string[]> = {
  hero: ['protects the innocent at any cost', 'seeks to atone for a past mistake', 'fights to honor a fallen mentor'],
  villain: ['wants to remake the world in their image', 'seeks revenge on those who wronged them', 'believes only tyranny brings order'],
  antihero: ['fights crime by their own brutal rules', 'is only in it for the payday', 'protects their city, not its laws'],
  neutral: ['watches over the balance of the cosmos', 'pursues knowledge above all else', 'only intervenes when the multiverse is at stake'],
};

const POWER_NAMES: Record<PowerKind, string[]> = {
  blast: ['Bolt', 'Blast', 'Barrage', 'Shot', 'Orb'],
  beam: ['Beam', 'Ray', 'Lance', 'Stream'],
  nova: ['Nova', 'Shockwave', 'Burst', 'Eruption'],
  dash: ['Rush', 'Strike', 'Charge', 'Blitz'],
  shield: ['Barrier', 'Aegis', 'Ward', 'Bulwark'],
  heal: ['Mending', 'Renewal', 'Rebirth', 'Vitality'],
  flight: ['Flight', 'Soar', 'Levitation', 'Wings'],
  teleport: ['Blink', 'Shift', 'Step', 'Warp'],
  superspeed: ['Velocity', 'Rush', 'Momentum', 'Overdrive'],
  leap: ['Leap', 'Bound', 'Vault', 'Pounce'],
};
const ELEMENT_WORDS: Record<Element, string[]> = {
  kinetic: ['Kinetic', 'Force', 'Impact'],
  energy: ['Energy', 'Photon', 'Plasma'],
  fire: ['Inferno', 'Flame', 'Solar'],
  ice: ['Frost', 'Glacial', 'Cryo'],
  lightning: ['Thunder', 'Storm', 'Volt'],
  cosmic: ['Cosmic', 'Stellar', 'Astral'],
  shadow: ['Shadow', 'Void', 'Umbral'],
  psychic: ['Psionic', 'Mind', 'Telekinetic'],
  nature: ['Verdant', 'Primal', 'Wild'],
  tech: ['Nano', 'Cyber', 'Repulsor'],
};

const FACTION_A = ['Vanguard', 'Legion', 'Order', 'Syndicate', 'Alliance', 'Brotherhood', 'Cabal', 'Initiative', 'Collective', 'Hydra'];
const FACTION_B = ['of Dawn', 'of the Void', 'Prime', 'of Iron', 'of Stars', 'Rising', 'of Ruin', 'Eternal'];

const LOCATION_NAMES: Record<Biome, string[]> = {
  metropolis: ['Neo Haven', 'Apex City', 'Meridian Bay', 'Titan Harbor', 'Nova Heights'],
  cosmic: ['The Shattered Moon', 'Event Horizon Station', 'Nebula Rim', 'The Starforge'],
  mystic: ['Sanctum Obscura', 'The Astral Gate', 'Temple of Echoes', 'The Dreaming Realm'],
  wasteland: ['The Ashlands', 'Rustbelt Ruins', 'Crater Zero', 'The Scorched Mile'],
  frozen: ['Glacier Citadel', 'The White Expanse', 'Frostspire Peaks', 'Cryo Vault'],
  jungle: ['Savage Basin', 'The Emerald Maze', 'Primeval Hollow', 'Vine City'],
};
const BIOME_PALETTE: Record<Biome, { sky: string; ground: string; glow: string }> = {
  metropolis: { sky: '#0a1030', ground: '#151a2e', glow: '#3ee8ff' },
  cosmic: { sky: '#070414', ground: '#1a1030', glow: '#b06bff' },
  mystic: { sky: '#120a24', ground: '#1e1430', glow: '#ff9a3e' },
  wasteland: { sky: '#2a1408', ground: '#3a2614', glow: '#ff6a1f' },
  frozen: { sky: '#0c1e30', ground: '#c8dcec', glow: '#8fd8ff' },
  jungle: { sky: '#081a10', ground: '#14301c', glow: '#4fff7a' },
};

const ITEM_NAMES: Record<ItemSlot, string[]> = {
  weapon: ['Blade', 'Hammer', 'Gauntlet', 'Staff', 'Shield', 'Spear'],
  armor: ['Battlesuit', 'Exo-Plate', 'Cloak', 'Nanoweave', 'Carapace'],
  artifact: ['Gem', 'Amulet', 'Crown', 'Orb', 'Codex', 'Ring'],
  gadget: ['Visor', 'Grapple', 'Drone', 'Jetpack', 'Wrist-Comp'],
};
const ITEM_ADJ = ['Infinity', 'Eternal', 'Quantum', 'Dread', 'Celestial', 'Primal', 'Phantom', 'Titan', 'Arc', 'Starborn'];

const STORY_TITLES = ['Crisis on Infinite Fronts', 'The Rising Dark', 'Secret Wars', 'Age of Ruin', 'Fractured Destiny', 'The Omega Protocol', 'Dawn of Legends'];

export function randomAlias(rng: Rng): string {
  if (rng.chance(0.15)) return rng.pick(SOLO_ALIAS);
  return `${rng.pick(ALIAS_PREFIX)} ${rng.pick(ALIAS_SUFFIX)}`;
}

export function randomCivilianName(rng: Rng): string {
  return `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
}

export function randomStats(rng: Rng, budget = 33): Stats {
  const stats = Object.fromEntries(STAT_KEYS.map((k) => [k, 1])) as Stats;
  let remaining = budget - STAT_KEYS.length;
  while (remaining > 0) {
    const key = rng.pick(STAT_KEYS);
    if (stats[key] < 10) {
      stats[key]++;
      remaining--;
    }
  }
  return stats;
}

export function randomPower(rng: Rng, kind?: PowerKind, element?: Element): Power {
  const k = kind ?? rng.pick(['blast', 'blast', 'beam', 'nova', 'dash', 'shield', 'heal'] as const);
  const el = element ?? rng.pick(ELEMENTS);
  const name = k === 'flight' && rng.chance(0.5) ? 'Flight' : `${rng.pick(ELEMENT_WORDS[el])} ${rng.pick(POWER_NAMES[k])}`;
  return {
    id: newId('pow'),
    name,
    kind: k,
    element: el,
    potency: rng.int(3, 9),
    description: '',
  };
}

/** A themed power set: one signature element, varied attack kinds, and usually a way to get around. */
export function randomPowerSet(rng: Rng): Power[] {
  const element = rng.pick(ELEMENTS);
  const kinds = rng.shuffle(['beam', 'nova', 'dash', 'shield', 'heal'] as const).slice(0, rng.int(1, 3));
  const powers = [randomPower(rng, 'blast', element), ...kinds.map((k) => randomPower(rng, k, rng.chance(0.7) ? element : undefined))];
  if (rng.chance(0.75)) {
    const move = rng.pick(['flight', 'teleport', 'leap', 'superspeed'] as const);
    powers.push(randomPower(rng, move, element));
    // Speedsters sometimes pair their speed with a jump.
    if (move === 'superspeed' && rng.chance(0.3)) powers.push(randomPower(rng, 'leap', element));
  }
  return powers;
}

export function randomAppearance(rng: Rng): Appearance {
  return {
    primary: rng.color(0.3, 0.55),
    secondary: rng.color(0.15, 0.4),
    accent: rng.color(0.55, 0.7),
    build: rng.pick(BUILDS),
    height: Math.round(rng.float(0.9, 1.15) * 100) / 100,
    head: rng.pick(HEAD_STYLES),
    emblem: rng.pick(EMBLEMS),
    cape: rng.chance(0.35),
    aura: rng.chance(0.3),
  };
}

export function randomCharacter(rng: Rng, role: Role = rng.pick(['hero', 'hero', 'villain', 'antihero'] as const), factionId: string | null = null): Character {
  const alias = randomAlias(rng);
  const name = randomCivilianName(rng);
  const origin = rng.pick(ORIGINS);
  return {
    id: newId('chr'),
    name,
    alias,
    role,
    factionId,
    origin,
    bio: `${alias} ${rng.pick(MOTIVES[role])}.`,
    stats: randomStats(rng),
    powers: randomPowerSet(rng),
    appearance: randomAppearance(rng),
    itemIds: [],
    level: 1,
    xp: 0,
  };
}

const RARITY_BONUS: Record<Rarity, number> = { common: 1, rare: 2, epic: 3, legendary: 4, mythic: 5 };

export function randomItem(rng: Rng, slot: ItemSlot = rng.pick(ITEM_SLOTS), rarity: Rarity = rng.pick(RARITIES)): Item {
  const bonuses: Partial<Stats> = {};
  const picks = rng.shuffle(STAT_KEYS).slice(0, slot === 'artifact' ? 3 : 2);
  for (const key of picks) bonuses[key] = rng.int(1, RARITY_BONUS[rarity]);
  return {
    id: newId('itm'),
    name: `${rng.pick(ITEM_ADJ)} ${rng.pick(ITEM_NAMES[slot])}`,
    slot,
    rarity,
    description: '',
    bonuses,
    color: rng.color(0.5, 0.65),
  };
}

export function randomLocation(rng: Rng, biome: Biome = rng.pick(BIOMES)): Location {
  const palette = BIOME_PALETTE[biome];
  return {
    id: newId('loc'),
    name: rng.pick(LOCATION_NAMES[biome]),
    biome,
    description: '',
    skyColor: palette.sky,
    groundColor: palette.ground,
    glowColor: palette.glow,
    density: Math.round(rng.float(0.3, 0.8) * 100) / 100,
  };
}

export function randomFaction(rng: Rng, alignment: Role): Faction {
  return {
    id: newId('fac'),
    name: `${alignment === 'villain' ? 'The ' : ''}${rng.pick(FACTION_A)} ${rng.pick(FACTION_B)}`,
    color: rng.color(0.45, 0.6),
    alignment,
    description: '',
    leaderId: null,
  };
}

export function randomStory(rng: Rng, universe: Pick<Universe, 'characters' | 'locations' | 'factions' | 'items'>): Story {
  const heroes = universe.characters.filter((c) => c.role === 'hero' || c.role === 'antihero');
  const villains = universe.characters.filter((c) => c.role === 'villain');
  const protagonist = heroes.length ? rng.pick(heroes) : null;
  const boss = villains.length ? rng.pick(villains) : null;
  const enemyFaction = universe.factions.find((f) => f.alignment === 'villain') ?? null;
  const locations = universe.locations;
  const pickLocation = () => (locations.length ? rng.pick(locations).id : '');
  const heroName = protagonist?.alias ?? 'Hero';
  const bossName = boss?.alias ?? 'the enemy';
  const factionName = enemyFaction?.name ?? 'the enemy';
  const reward = () => (universe.items.length && rng.chance(0.6) ? rng.pick(universe.items).id : null);
  const storyId = newId('sty');
  const flag = `${storyId}.approach`;
  const chapter = (c: Omit<Chapter, 'id' | 'enemyFactionId' | 'rewardItemId' | 'requires' | 'choice'> & Partial<Chapter>): Chapter => ({
    id: newId('chp'),
    enemyFactionId: enemyFaction?.id ?? null,
    rewardItemId: reward(),
    requires: null,
    choice: null,
    ...c,
  });

  const chapters: Chapter[] = [
    chapter({
      title: 'First Contact',
      locationId: pickLocation(),
      intro: [
        { speaker: 'Command', text: `${heroName}, ${factionName} forces are attacking. Push them back!` },
        { speaker: heroName, text: 'On my way.' },
      ],
      objective: { type: 'defeat', count: 12 },
      enemyLevel: 1,
      outro: [{ speaker: heroName, text: `These weren't random thugs. Someone is pulling the strings.` }],
    }),
    chapter({
      title: 'Hold the Line',
      locationId: pickLocation(),
      intro: [{ speaker: 'Command', text: `They're sending wave after wave. Survive until reinforcements arrive!` }],
      objective: { type: 'survive', seconds: 60 },
      enemyLevel: 3,
      outro: [{ speaker: 'Command', text: `We traced the signal. It's ${bossName}. But their troops are moving on the city.` }],
      // The player's decision here picks which of the following chapters play.
      choice: boss
        ? {
            prompt: `${bossName} is escaping and civilians are in danger. What do you do?`,
            flag,
            options: [
              { label: `Chase ${bossName}`, value: 'pursue', relationshipId: boss.id, relationshipDelta: -15 },
              { label: 'Protect the civilians', value: 'protect', relationshipId: protagonist?.id ?? null, relationshipDelta: 10 },
            ],
          }
        : null,
    }),
  ];
  if (boss) {
    chapters.push(
      chapter({
        title: `Showdown with ${bossName}`,
        locationId: pickLocation(),
        intro: [
          { speaker: bossName, text: `You left the city to burn just to catch me? Bold.` },
          { speaker: heroName, text: `It ends here, ${bossName}.` },
        ],
        objective: { type: 'boss', characterId: boss.id },
        enemyLevel: 5,
        outro: [{ speaker: heroName, text: `Got them. Now let's hope the city held.` }],
        requires: { flag, value: 'pursue' },
      }),
      chapter({
        title: 'Last Stand',
        locationId: pickLocation(),
        intro: [{ speaker: 'Command', text: `The civilians are evacuating. Hold this position!` }],
        objective: { type: 'survive', seconds: 45 },
        enemyLevel: 4,
        outro: [{ speaker: 'Command', text: `Everyone is safe. And ${bossName} just showed their face.` }],
        requires: { flag, value: 'protect' },
      }),
      chapter({
        title: 'Final Confrontation',
        locationId: pickLocation(),
        intro: [
          { speaker: bossName, text: `You chose the weak over me. That will be your undoing.` },
          { speaker: heroName, text: `Protecting people isn't weakness, ${bossName}.` },
        ],
        objective: { type: 'boss', characterId: boss.id },
        enemyLevel: 6,
        outro: [{ speaker: heroName, text: 'The city is safe... for now.' }],
        requires: { flag, value: 'protect' },
      }),
    );
  }
  return {
    id: storyId,
    title: rng.pick(STORY_TITLES),
    synopsis: `${heroName} must stop ${factionName}${boss ? ` and their leader ${bossName}` : ''}.`,
    protagonistId: protagonist?.id ?? null,
    chapters,
  };
}

export function emptyUniverse(name = 'Untitled Universe', seed = 0): Universe {
  const now = Date.now();
  return {
    schema: SCHEMA_VERSION,
    id: newId('uni'),
    name,
    tagline: '',
    description: '',
    author: '',
    seed,
    accent: '#3ee8ff',
    rules: { powerScale: 1, gravity: 1, enemyDensity: 1 },
    factions: [],
    characters: [],
    items: [],
    locations: [],
    stories: [],
    createdAt: now,
    updatedAt: now,
  };
}

const UNIVERSE_PREFIX = ['Earth', 'Terra', 'Realm', 'Sector', 'Dimension'];

export function generateUniverse(seed: number): Universe {
  const rng = new Rng(seed);
  const universe = emptyUniverse(`${rng.pick(UNIVERSE_PREFIX)}-${rng.int(100, 9999)}`, seed);
  universe.tagline = 'A universe forged in an instant.';
  universe.accent = rng.color(0.55, 0.65);

  const heroFaction = randomFaction(rng, 'hero');
  const villainFaction = randomFaction(rng, 'villain');
  universe.factions.push(heroFaction, villainFaction);

  for (let i = 0; i < 3; i++) universe.characters.push(randomCharacter(rng, 'hero', heroFaction.id));
  universe.characters.push(randomCharacter(rng, 'antihero'));
  for (let i = 0; i < 2; i++) universe.characters.push(randomCharacter(rng, 'villain', villainFaction.id));

  universe.locations.push(randomLocation(rng, 'metropolis'));
  for (const biome of rng.shuffle(BIOMES.filter((b) => b !== 'metropolis')).slice(0, 2)) {
    universe.locations.push(randomLocation(rng, biome));
  }

  for (let i = 0; i < 5; i++) universe.items.push(randomItem(rng));

  universe.stories.push(randomStory(rng, universe));
  return universe;
}
