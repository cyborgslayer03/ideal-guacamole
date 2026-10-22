# Omniverse Forge

A superhero universe creator and action RPG. You are **the One Above All**: build universes with heroes, villains, powers, gear, worlds and stories, then step inside and fight as your characters.

Runs in the browser on desktop and mobile (touch controls included). Built with TypeScript, Three.js and Vite. It has no other runtime dependencies, and all art is procedural.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit + headless combat simulation tests
npm run build      # typecheck + production build into dist/
```

## Game modes

### The One Above All (creator)
- **Instant Universe:** one click rolls factions, heroes, villains, locations, gear and a three-chapter story.
- **Quick / Full detail toggle:** Quick shows the essentials plus 🎲 randomizers for every piece. Full detail adds backstories, secret identities, custom palettes, power descriptions and dialogue writing.
- **Characters:** a live 3D preview with costume colors, build, head style, emblem, cape and aura. Six attributes with archetype presets, up to 4 active powers plus flight, 4 gear slots, and a CP (combat power) rating.
- **Powers:** 7 types (blast, beam, nova, dash, shield, heal, flight) × 10 elements. Each element has its own effect: fire burns, ice slows, lightning and psychic stun, shadow and nature drain life, cosmic and tech amplify damage, kinetic knocks back, and energy refunds energy.
- **Stories:** chapters with a location, enemy faction, objective (defeat N, survive, or boss fight against any character), enemy level, reward item, and intro/outro dialogue.
- **Laws of reality:** universe-wide power scale, gravity and enemy density.

### Story mode (action RPG)
- 4-hit melee combo with soft-lock lunge, dodge with i-frames, double jump, flight, 4 power skills, and an ultimate that charges as you deal damage.
- Grunts, gunners and brutes (with telegraphed slams), plus bosses built from your own characters that use their real powers.
- XP and leveling, item rewards that auto-equip, damage numbers, combo counter, boss bars, and bloom-lit neon arenas generated from each location's biome.

### War Table (campaign)
Every universe has a living campaign. The mission board is generated from the current world state, so it changes as your choices reshape the world:

| Mission | What happens |
| --- | --- |
| **Story** | Your authored chapters. Bosses who are gone are replaced by whoever holds their position now. |
| **Patrol** | Roam a location and respond to beacons: enemy squads, civilians to protect, elite lieutenants. Nemeses may ambush you. |
| **Raid** | A multi-phase stronghold assault: waves, then the lieutenants together, then the faction leader. |
| **Hunt** | Track down a faction leader, a lieutenant, or a hero who went rogue. |
| **Vendetta** | A nemesis comes for you personally. |
| **Ally** | A friend is pinned down. Help them and they may become a companion. |
| **Defense** | A faction at full strength attacks. Ignoring it lets them grow. |

- **Boss verdicts:** after a boss falls, you choose **Arrest** (they may escape later), **Spare** (earns respect), **Recruit** (they join you if they don't hate you) or **Finish** (permanent, and their faction swears revenge).
- **Rotating bosses:** when a leader falls, a lieutenant rises to replace them. If the faction is weak, an outsider may seize the power vacuum, and if nobody is left, a brand-new villain is generated. Escaped prisoners can reclaim their throne, and ambitious lieutenants stage coups.
- **Ally / nemesis system:** every character has a relationship score, memories ("was arrested by Nova"), and a win/loss record against you. Bosses who beat you level up and become stronger **nemeses** with personal dialogue. Friends and recruits become **companions** who fight beside you with their own powers. Heroes who disapprove of your methods can **go rogue**.
- **Branching stories:** chapters can end with a choice that sets a flag, and later chapters can require a flag. Instant universes include a branching story to show how it works.
- **Deterministic:** the world runs on the campaign seed, so the same choices always lead to the same outcomes.
- **Omni controls** (in Full detail): override faction power and relationship scores, pass time, or reset the campaign.

### Omni Sandbox
Free play in any location. Spawn troops or waves at any level, summon any character as a boss, and bend time, gravity and power on the fly.

## Controls

| Action | Keyboard / mouse | Touch |
| --- | --- | --- |
| Move | WASD | Left joystick |
| Attack (combo) | J / left click | ✊ |
| Dodge | Shift | » |
| Jump / double jump | Space | ⤒ |
| Powers | Q E R F (or 1–4) | Skill buttons |
| Ultimate | X | ★ |
| Toggle flight | V (Space/C rise/fall) | ⇮ |
| Camera | Right-drag, arrow keys, wheel | Drag |
| Pause | Esc / P | ❚❚ |

## Sharing

Universes, characters, items and stories export as `.json` bundles. A story bundle carries every character, location, item and faction it uses. Imports are validated and sanitized (`src/core/validate.ts`) and get fresh ids, so content from other players can never collide with or corrupt yours. This bundle format is what the future online hub will upload and download.

## Project layout

```
src/core/   Pure game data and logic: types, rules/balance, generator, validation, storage, sharing,
            campaign (War Table, factions, relationships), mission plans
src/game/   Three.js runtime: models, arenas, combat, AI, effects, HUD, input, session loop
src/ui/     Creator UI: home/library, editor shell, tabs, forms, 3D preview
tests/      Vitest: core logic, campaign rules and fuzzing, and a headless combat simulation
```

`src/core` has no DOM or WebGL dependencies, so it can be reused by a backend later.

## Roadmap

- **Multiverse Hub (online):** accounts, publish/browse/download universes, characters, stories and items, with ratings and remixing. The `UniverseLibrary` / `KeyValueStore` seam and the bundle format are already in place for it.
- Cutscene camera moves, voiced barks, and companion banter based on relationships.
- More enemy archetypes, elite modifiers, co-op heroes and team-up attacks.
- Imported 3D models/animations (glTF) alongside the procedural ones.
- Packaging as an installable mobile/desktop app (PWA or Capacitor/Tauri).
