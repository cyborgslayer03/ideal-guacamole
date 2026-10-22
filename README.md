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
src/core/   Pure game data and logic: types, rules/balance, generator, validation, storage, sharing
src/game/   Three.js runtime: models, arenas, combat, AI, effects, HUD, input, session loop
src/ui/     Creator UI: home/library, editor shell, tabs, forms, 3D preview
tests/      Vitest: core logic plus a headless combat simulation
```

`src/core` has no DOM or WebGL dependencies, so it can be reused by a backend later.

## Roadmap

- **Multiverse Hub (online):** accounts, publish/browse/download universes, characters, stories and items, with ratings and remixing. The `UniverseLibrary` / `KeyValueStore` seam and the bundle format are already in place for it.
- Story progress tracking, branching dialogue choices, and cutscene camera moves.
- More enemy archetypes, elite modifiers, co-op heroes and team-up attacks.
- Imported 3D models/animations (glTF) alongside the procedural ones.
- Packaging as an installable mobile/desktop app (PWA or Capacitor/Tauri).
