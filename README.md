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
- **Legends Universe:** start with twelve hand-made heroes and villains (see below), their two factions, four locations, signature gear, and the branching story *Legends Assemble*.
- **Instant Universe:** one click rolls factions, heroes, villains, locations, gear and a three-chapter story.
- **Quick / Full detail toggle:** Quick shows the essentials plus 🎲 randomizers for every piece. Full detail adds backstories, secret identities, custom palettes, power descriptions and dialogue writing.
- **Characters:** a live 3D preview with costume colors, build, head style, emblem, cape and aura, or an imported 3D model. Six attributes with archetype presets, up to 4 active powers (27 power types) plus movement powers and passives, 4 gear slots, and a CP (combat power) rating.
- **Powers:** 6 attack and support types (blast, beam, nova, dash, shield, heal) and 4 movement types (flight, teleport, super speed, super leap), across 10 elements. Each element has its own effect: fire burns, ice slows, lightning and psychic stun, shadow and nature drain life, cosmic and tech amplify damage, kinetic knocks back, and energy refunds energy.
- **Stories:** chapters with a location, enemy faction, objective (defeat N, survive, or boss fight against any character), enemy level, reward item, and intro/outro dialogue.
- **Laws of reality:** universe-wide power scale, gravity and enemy density, with per-location **local laws** that override them (the Legends' orbital station runs at 0.35× gravity).

### Movement powers
Movement powers sit on **V** (or the travel button on touch) and never take a Q/E/R/F slot.

| Power | What it does |
| --- | --- |
| **Flight** | Toggle flight; Space and C to rise and fall. |
| **Teleport** | Blink to your target (or 9–17 m the way you're steering), shocking enemies where you land. Short cooldown. |
| **Super Leap** | A huge arcing jump onto your target that slams down in an area on landing. |
| **Super Speed** | Always on: run up to 75% faster, leaving afterimages. Stacks with any of the others. |
| **Web Swing** | Shoot a line to an anchor overhead and swing toward your target or onto rooftops. Works mid-air, so swings chain. |

Bosses and AI companions use them too. Teleporting villains blink in beside you, and leapers crash down from across the arena.

### Power types
Besides blasts, beams, novas, dashes, shields and heals, characters can have powers inspired by the classic comic-book archetypes:

| Power | What it does |
| --- | --- |
| **Optic Blast** | Instant piercing twin eye-beams with knockback. |
| **Web Shot** | A sticky shot that roots and slows its target. |
| **Telekinesis** | Lifts a minion into the air, then slams it down. Bosses and brutes are too heavy, so they're crushed in place. |
| **Reality Warp** | Shrinks the target (half damage dealt, more taken), or rewrites a minion onto your side. |
| **Mind Control** | A minion fights for you for a while. Bosses and heroes resist and are only stunned. |
| **Summon Echoes** | Up to 3 ghostly duplicates of you fight alongside you, then fade. |
| **Life Drain** | A short-range channel that heals you for part of the damage. |
| **Gravity Well** | A well that drags enemies in and crushes them for 3 seconds. |
| **Storm Call** | Lightning strikes on enemies around you. |
| **Time Stop** | Freezes nearby enemies completely; bosses only briefly. |
| **Phasing** | Become intangible: attacks pass through you. |
| **Sonic Scream** | A cone that stuns and blows enemies away. |
| **Giant Growth** | Grow 60%: hit 50% harder, take 25% less, no knockback. |
| **Stealth** | Turn invisible: enemies lose track of you, and your next hit lands double. |
| **Stretch Grab** | Yank a minion to you, or pull yourself to a boss. |
| **Healing Factor** | Passive (no slot): regenerate whenever you avoid damage for a few seconds. |

AI bosses, companions, and enemies use all of them, and only when they make sense (no Time Stop with nobody nearby).

### Legends roster
| Heroes | Movement | Villains | Movement |
| --- | --- | --- | --- |
| **Aegis Prime**: shield tank | Super Leap | **Overlord Kryos**: ice tyrant | Flight |
| **Voltstream**: lightning speedster with Storm Call | Super Speed | **Hexmother**: void sorceress with Reality Warp | Teleport |
| **Seraph**: solar flier with Optic Blast, and a healer | Flight | **Juggernox**: brute with Giant Growth and Healing Factor | Super Leap |
| **Nightveil**: shadow assassin with Stealth | Teleport | **Blitzkrieg**: fire speedster with Sonic Scream | Super Speed + Leap |
| **Mindwarden**: Telekinesis and Mind Control | Teleport | **Doctor Paradox**: chrono-scientist with Time Stop | Teleport |
| **Silkstrider**: web-slinger with Web Shot and Stretch Grab | Web Swing | **Venomancer**: toxic predator with Venom Web | Web Swing + Speed |
| **Ironclad Ranger**: armored inventor with Summon drones | Flight | | |

Add any of them to any universe with **★ Legends** in the Characters tab. Every legend is fully editable once added.

### 3D models (Mixamo, Quaternius, any glTF/FBX)
Any character can swap the procedural body for a rigged 3D model in the **3D model** section of the Characters tab:

- **Built in:** the CC0 Quaternius robot (`public/models/robot.glb`, credits in `public/models/CREDITS.md`).
- **Import** a `.glb`, `.gltf` (embedded) or `.fbx` file. Files are stored in your browser's IndexedDB, up to 60 MB each.
- **From link:** any `https://` URL to a model on a server that allows cross-origin downloads.

Animation clips are matched to actions automatically by name (Idle, Walk, Run, Jump, Fly, Attack, Power, Hurt, Death), and you can override each one. **Quaternius** packs already include these clips. For **Mixamo**, download the character as FBX "With Skin", then download each animation as FBX "Without Skin" with "In Place" checked, and import it next to the action it should play. Mixamo bone names (`mixamorig:Hips`, `mixamorigHips`, ...) are matched for you, and root motion is stripped so animations play in place. Size, facing and an optional costume-color tint are adjustable. Models load before a mission starts, and if one can't load, the character uses the procedural body instead.

Characters exported or shared through the hub keep built-in and linked models. Imported files stay on the device that imported them.

### Story mode (action RPG)
- 4-hit melee combo with soft-lock lunge, dodge with i-frames, double jump, movement powers, 4 power skills, and an ultimate that charges as you deal damage.
- Grunts, gunners and brutes (with telegraphed slams), plus bosses built from your own characters that use their real powers.
- XP and leveling, item rewards that auto-equip, damage numbers, combo counter, boss bars, and bloom-lit neon arenas generated from each location's biome.

### War Table (campaign)
Every universe has a living campaign. The mission board is generated from the current world state, so it changes as your choices reshape the world:

| Mission | What happens |
| --- | --- |
| **Story** | Your authored chapters. Bosses who are gone are replaced by whoever holds their position now. |
| **Patrol** | Roam a location and respond to beacons: enemy squads, civilians to protect, elite lieutenants. Nemeses may ambush you, and optional ambient events pop up around you (see below). |
| **Raid** | A multi-phase stronghold assault: waves, then the lieutenants together, then the faction leader. |
| **Hunt** | Track down a faction leader, a lieutenant, or a hero who went rogue. |
| **Vendetta** | A nemesis comes for you personally. |
| **Ally** | A friend is pinned down. Help them and they may become a companion. |
| **Defense** | A faction at full strength attacks. Ignoring it lets them grow. |
| **Team-Up** | A whole hero team (any hero faction, e.g. the Legends' Vanguard) assembles against a villain faction's lieutenants and leader. |

- **Boss verdicts:** after a boss falls, you choose **Arrest** (they may escape later), **Spare** (earns respect), **Recruit** (they join you if they don't hate you) or **Finish** (permanent, and their faction swears revenge).
- **Rotating bosses:** when a leader falls, a lieutenant rises to replace them. If the faction is weak, an outsider may seize the power vacuum, and if nobody is left, a brand-new villain is generated. Escaped prisoners can reclaim their throne, and ambitious lieutenants stage coups.
- **Ally / nemesis system:** every character has a relationship score, memories ("was arrested by Nova"), and a win/loss record against you. Bosses who beat you level up and become stronger **nemeses** with personal dialogue. Friends and recruits become **companions** who fight beside you with their own powers. Heroes who disapprove of your methods can **go rogue**.
- **Branching stories:** chapters can end with a choice that sets a flag, and later chapters can require a flag. Instant universes include a branching story to show how it works.
- **Deterministic:** the world runs on the campaign seed, so the same choices always lead to the same outcomes.
- **Omni controls** (in Full detail): override faction power and relationship scores, pass time, or reset the campaign.

### Team-ups and squads
Bring up to **3 AI teammates** on any mission (pick them on the War Table from heroes who count you as an ally), or let **Team-Up** missions field a whole team. In the sandbox, **Recruit** heroes from the Omni panel.

- **Autonomous AI by role:** each teammate reads their own kit. **Tanks** take bosses and brutes and raise shields, **strikers** dive in with dashes, leaps and teleports, **ranged** heroes keep their distance and kite, and **supports** stay with whoever is hurt and heal the team. The squad spreads across targets instead of piling on one, peels enemies off you, and uses movement powers to keep up.
- **Tag-switching:** **Tab** (or tap a teammate's card) hands control to another hero mid-fight, and XP is shared by the whole squad.
- **Downed and revive:** in squad play, heroes go down instead of out. A teammate standing beside them for 2.5 s revives them; otherwise they bleed out after 25 s. If your hero goes down, control passes to someone still standing. The mission fails only when the whole squad is down.
- **Squad orders (G):** Free fight → Focus my target → Follow me → Hold position.
- **Team Assault (T):** the squad's combined damage fills a gauge; when it's full, every nearby hero unleashes their strongest attack at once.
- **Team heals:** heal powers now restore every teammate in range.

### Combat polish
- **Perfect dodge:** dodge just as a hit lands for a slow-motion moment and +15 ultimate charge.
- **Mission grades:** S / A / B / C from time against par, damage taken, best combo and downs. Better grades give bonus XP (up to +50%).
- **Contracts:** three rotating War Table challenges every three turns (for example "Win a Team-Up", "Earn an S grade", "Rescue an ally on patrol"), each paying a one-time XP reward.

### Ambient events (patrols and sandbox)
While you patrol, optional incidents appear nearby and show up in the **Nearby** feed. They expire if you ignore them.

| Event | What to do | Payoff |
| --- | --- | --- |
| **Street crime** | Break up a gang. | XP |
| **Rooftop snipers** | Get up to their perch and clear it. | XP |
| **Supply drop** | Reach the crate before it's taken. | Health, energy, ultimate charge |
| **Villain on the run** | Catch a fleeing villain before they escape. They flee and use their movement powers to break away. | XP, and a **boss verdict** in campaigns |
| **Ally in distress** | Save a friend fighting off a squad. | XP, and **relationship +10** with a memory of the rescue |
| **Unstable rift** | Hold the zone for 15 seconds while enemies pour out. | XP |

In the campaign, incidents you handle also weaken the patrolled faction.

### Omni Sandbox
Free play, layered:
- **Vertical levels:** every arena has a climbable **spire** (steps a double jump apart), a **skybridge**, and a floating **skydeck** above the center. City rooftops and rocky outcrops are walkable, and platforms are one-way (jump up through them, land on top). Gunners take rooftop perches, grunts jump up ledges after you, and leap and teleport reach targets on any level.
- **Connected zones:** walk through a **portal** at the arena edge, or pick a zone in the Omni panel, to travel to any other location in the universe without leaving the session.
- **Threat tiers:** Street → City → Nation → Global → Cosmic scale enemy level, health, damage, elite chance (gold-trimmed Elites) and XP.
- **Layers of control:** rules stack as Universe → Location (each location can set **local laws** for gravity, power scale and enemy density) → Session overrides. The Omni panel shows every layer and which one is in effect, with ↺ to drop a session override.
- Spawn troops or waves, summon any character as a boss, toggle **ambient events** or trigger one now, and set the time scale or invincibility.

## Controls

| Action | Keyboard / mouse | Touch |
| --- | --- | --- |
| Move | WASD | Left joystick |
| Attack (combo) | J / left click | ✊ |
| Dodge | Shift | » |
| Jump / double jump | Space | ⤒ |
| Powers | Q E R F (or 1–4) | Skill buttons |
| Ultimate | X | ★ |
| Movement power (fly / teleport / leap / swing) | V (Space/C rise/fall when flying) | Travel button |
| Switch hero (squad) | Tab | Tap a teammate |
| Squad order | G | Tap the order badge |
| Team Assault | T | ⚡ |
| Camera | Right-drag, arrow keys, wheel | Drag |
| Pause | Esc / P | ❚❚ |

## Multiverse Hub (online)

The hub is where players publish and download universes, characters, stories and items.
- **Browse:** filter by type, search names, heroes, tags and creators, and sort by newest, top rated or most downloaded.
- **Download:** a universe arrives as a new universe. A character, story or item can go into any of your universes, or into a new one.
- **Publish:** use the **Publish** button next to any Export button. A free account (handle and password) is needed to publish or like. Browsing and downloading need none.
- **Manage:** republishing to one of your listings bumps its version. You can delete your own listings, and listings that several players report are hidden pending review.

### Running it
```bash
npm run hub        # API on http://localhost:8787 (data in ./hub-data)
npm run dev        # game on :5173; /api is proxied to the hub
npm start          # production: build everything and serve game + API on one port
```

Environment variables for `server/main.ts`: `PORT`, `DATABASE_URL` (PostgreSQL; otherwise file storage), `DATABASE_SSL=1` (TLS for external database URLs), `HUB_DATA_DIR`, `STATIC_DIR` (serve the built game), `CORS_ORIGIN` (allow a game hosted elsewhere), and `TRUST_PROXY=1` (behind a reverse proxy). To point a game at a hub on another host, set **Settings → Hub server** on the home screen, e.g. `https://hub.example.com/api`.

### Deploying to Render
`render.yaml` is a Render Blueprint that creates one **web service** (the game and hub API on one port) and one **PostgreSQL** database, with `DATABASE_URL` wired between them.

1. Sign in at [render.com](https://render.com) and connect your GitHub account.
2. Click **New → Blueprint**, pick this repository, and pick the branch to deploy (`main` once the PR is merged).
3. Review the two resources and click **Apply**. The first build takes a few minutes.
4. Open the service's `onrender.com` URL. `/api/health` should return `{"ok":true}`.

Every push to the deployed branch redeploys automatically. Database migrations run on startup and are safe if several instances start at once.

Plans: the Blueprint uses Render's free tiers. Free web services sleep when idle, so the first visit after a while takes about a minute. Free databases expire after Render's trial period, so change the database `plan` in `render.yaml` (for example `basic-256mb`) or in the dashboard before inviting real players.

### Hub storage
- With `DATABASE_URL` set, the hub uses **PostgreSQL** (`server/pg-store.ts`): users, sessions (expire after 30 days), listings with their bundles as `jsonb`, likes and reports, and numbered migrations under an advisory lock.
- Without it, the hub stores everything in JSON files under `HUB_DATA_DIR`, which is fine for local play.
- To run the hub tests against a real database, point `HUB_TEST_DATABASE_URL` at a disposable Postgres database (its tables are dropped): `HUB_TEST_DATABASE_URL=postgres://localhost/hub_test npm test`.

### How it's built
- `server/` is plain `node:http` with no web framework. Storage goes through the async `HubStore` interface, which has two implementations: PostgreSQL for production and JSON files for local use.
- Every upload is validated with the same `parseBundle` / `normalizeUniverse` code the game uses for imports. Downloads are validated again on the client.
- Passwords are hashed with scrypt, and session tokens are random and stored only as SHA-256 hashes. Request bodies are capped at 2 MB, and requests are rate-limited per IP, with tighter limits on writes.
- `src/online/protocol.ts` is the API contract shared by `src/online/client.ts` and the server.

## Sharing

Universes, characters, items and stories export as `.json` bundles. A story bundle carries every character, location, item and faction it uses. Imports are validated and sanitized (`src/core/validate.ts`) and get fresh ids, so content from other players can never collide with or corrupt yours. The Multiverse Hub uploads and downloads this same bundle format.

## Project layout

```
src/core/   Pure game data and logic: types, rules/balance, generator, validation, storage, sharing,
            campaign (War Table, factions, relationships), mission plans
src/game/   Three.js runtime: procedural and imported models (glTF/FBX loader, IndexedDB asset store),
            arenas, combat, AI, effects, HUD, input, session loop
src/online/ Multiverse Hub API contract and browser client
src/ui/     Creator UI: home/library, editor shell, tabs, forms, 3D preview, hub screens
server/     Multiverse Hub server (node:http, file storage)
tests/      Vitest: core logic, campaign rules and fuzzing, and a headless combat simulation
```

`src/core` has no DOM or WebGL dependencies, so it can be reused by a backend later.

## Roadmap

- **Hub, next steps:** comments, follows and creator profiles, remix credits, moderator tools, and cloud sync of your own library.
- Cutscene camera moves, voiced barks, and companion banter based on relationships.
- More enemy archetypes, elite modifiers, co-op heroes and team-up attacks.
- Uploading imported model files to the hub so shared characters keep their look everywhere.
- Packaging as an installable mobile/desktop app (PWA or Capacitor/Tauri).
