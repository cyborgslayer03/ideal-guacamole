// Story mode / sandbox runtime: owns the renderer, camera, game loop, and the
// flow of chapters (dialogue -> combat objective -> rewards).

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { randomLocation } from '../core/generator';
import { Rng } from '../core/rng';
import { RARITY_COLORS, effectiveStats, grantXp, maxHealth, minionHealth, minionStats, xpReward } from '../core/rules';
import type { Appearance, Chapter, Character, Location, Story, Universe } from '../core/types';
import { h } from '../ui/dom';
import { updateEnemy } from './ai';
import { ARENA_RADIUS, buildArena, type Arena } from './arena';
import { Actor, Combat } from './combat';
import { Effects } from './effects';
import { Hud } from './hud';
import { Input } from './input';

export type SessionMode =
  | { type: 'story'; storyId: string; chapter: number }
  | { type: 'sandbox'; locationId: string | null };

export interface SessionOptions {
  container: HTMLElement;
  universe: Universe;
  characterId: string;
  mode: SessionMode;
  bloom: boolean;
  /** Called whenever progress (XP, levels, rewards) should be persisted. */
  onSave: () => void;
  onExit: () => void;
}

type Minion = 'grunt' | 'gunner' | 'brute';

interface Stage {
  arena: Arena;
  combat: Combat;
  fx: Effects;
  player: Actor;
  hud: Hud;
  location: Location;
}

interface Objective {
  chapter: Chapter;
  spawned: number;
  killed: number;
  elapsed: number;
  boss: Actor | null;
  done: boolean;
  spawnTimer: number;
}

export class GameSession {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  private readonly composer: EffectComposer | null = null;
  private readonly input: Input;
  private readonly root: HTMLElement;
  private stage: Stage | null = null;
  private objective: Objective | null = null;
  private frame = 0;
  private last = performance.now();
  private time = 0;
  private paused = false;
  private timeScale = 1;
  private slowmo = 0;
  private hitstop = 0;
  private camYaw = Math.PI;
  private camPitch = 0.35;
  private camDist = 9;
  private readonly camTarget = new THREE.Vector3();
  private godMode = false;
  private spawnLevel: number;
  private disposed = false;
  private readonly character: Character;
  private readonly onResize = () => this.resize();

  constructor(private readonly opts: SessionOptions) {
    const character = opts.universe.characters.find((c) => c.id === opts.characterId);
    if (!character) throw new Error('Character not found');
    this.character = character;
    this.spawnLevel = character.level;

    this.root = h('div', { class: 'game' });
    opts.container.appendChild(this.root);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.root.appendChild(this.renderer.domElement);
    this.input = new Input(this.renderer.domElement);

    if (opts.bloom) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.4, 0.88));
      this.composer.addPass(new OutputPass());
    }
    window.addEventListener('resize', this.onResize);
    this.resize();

    this.loop = this.loop.bind(this);
    this.frame = requestAnimationFrame(this.loop);

    if (opts.mode.type === 'story') void this.runChapter(opts.mode.storyId, opts.mode.chapter);
    else this.startSandbox(opts.mode.locationId);
  }

  // --- Setup ---------------------------------------------------------------

  private resize() {
    const w = this.root.clientWidth || window.innerWidth;
    const hgt = this.root.clientHeight || window.innerHeight;
    this.renderer.setSize(w, hgt);
    this.composer?.setSize(w, hgt);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
  }

  private resolveLocation(id: string | null): Location {
    const u = this.opts.universe;
    return u.locations.find((l) => l.id === id) ?? u.locations[0] ?? randomLocation(new Rng(u.seed), 'metropolis');
  }

  private buildStage(location: Location) {
    this.teardownStage();
    const u = this.opts.universe;
    const sky = new THREE.Color(location.skyColor);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 40, 150);

    const arena = buildArena(location, u.seed ^ hashString(location.id));
    this.scene.add(arena.group);
    const fx = new Effects(this.scene);
    const combat = new Combat(this.scene, fx, arena.obstacles);
    combat.powerScale = u.rules.powerScale;
    combat.gravityScale = u.rules.gravity;

    const c = this.character;
    const stats = effectiveStats(c, u.items);
    const player = new Actor(c.alias, 'player', 'hero', stats, c.level, c.appearance, c.powers, undefined, c);
    player.pos.set(0, 0, 0);
    combat.add(player);

    const hud = new Hud(player, this.input, () => this.togglePause());
    this.root.appendChild(hud.root);

    combat.onDamage = (e) => {
      const kind = e.heal ? 'heal' : e.target === player ? 'taken' : e.crit ? 'crit' : 'normal';
      hud.damageNumber(e.target.center.add(new THREE.Vector3(0, 0.6, 0)), this.camera, e.amount, kind);
      if (e.source === player && !e.heal) {
        hud.addCombo();
        if (e.crit) this.hitstop = Math.max(this.hitstop, 0.035);
      }
      if (e.target === player && !e.heal) fx.shake(0.15);
    };
    combat.onKill = (target) => this.onKill(target);

    this.stage = { arena, combat, fx, player, hud, location };
    this.camYaw = Math.PI;
    this.camTarget.copy(player.center);
  }

  private teardownStage() {
    if (!this.stage) return;
    const s = this.stage;
    s.combat.clear();
    s.fx.clear();
    this.scene.remove(s.arena.group);
    s.arena.dispose();
    s.hud.root.remove();
    this.stage = null;
    this.objective = null;
  }

  // --- Spawning ------------------------------------------------------------

  private factionColor(factionId: string | null): string {
    return this.opts.universe.factions.find((f) => f.id === factionId)?.color ?? '#c02838';
  }

  private spawnMinion(type: Minion, level: number, factionId: string | null) {
    const s = this.stage;
    if (!s) return;
    const color = this.factionColor(factionId);
    const appearance: Appearance = {
      primary: color,
      secondary: '#1a1c24',
      accent: type === 'gunner' ? '#ff4040' : '#30343c',
      build: type === 'brute' ? 'heavy' : 'athletic',
      height: type === 'brute' ? 1.1 : 0.95,
      head: type === 'gunner' ? 'visor' : 'helmet',
      emblem: 'none',
      cape: false,
      aura: false,
    };
    const stats = minionStats(level, type);
    const name = type === 'brute' ? 'Brute' : type === 'gunner' ? 'Gunner' : 'Trooper';
    const e = new Actor(name, 'enemy', type, stats, level, appearance, [], minionHealth(stats, level, type));
    const a = Math.random() * Math.PI * 2;
    const d = 18 + Math.random() * 12;
    e.pos.set(s.player.pos.x + Math.cos(a) * d, 0, s.player.pos.z + Math.sin(a) * d);
    const r = Math.hypot(e.pos.x, e.pos.z);
    if (r > ARENA_RADIUS - 3) e.pos.multiplyScalar((ARENA_RADIUS - 3) / r);
    e.ai.spawn = 0.8;
    s.combat.add(e);
    s.fx.flare(e.center, color, 2.5, 0.4);
    s.fx.ring(e.pos, color, 2.5);
  }

  private spawnBoss(character: Character, level: number): Actor | null {
    const s = this.stage;
    if (!s) return null;
    const stats = effectiveStats(character, this.opts.universe.items);
    const lvl = Math.max(character.level, level);
    const boss = new Actor(character.alias, 'enemy', 'boss', stats, lvl, character.appearance, character.powers, maxHealth(stats, lvl) * 4, character);
    boss.pos.set(s.player.pos.x, 0, s.player.pos.z - 16);
    boss.faceToward(s.player.pos);
    boss.ai.spawn = 1.5;
    boss.ai.slam = 4;
    s.combat.add(boss);
    s.fx.flare(boss.center, character.appearance.accent, 5, 0.6);
    s.fx.ring(boss.pos, character.appearance.accent, 6, 0.6);
    s.fx.shake(0.5);
    s.hud.setBoss(boss);
    return boss;
  }

  private pickMinion(level: number): Minion {
    const r = Math.random();
    if (level >= 3 && r < 0.15) return 'brute';
    if (r < 0.45) return 'gunner';
    return 'grunt';
  }

  // --- Story flow ----------------------------------------------------------

  private story(storyId: string): Story | undefined {
    return this.opts.universe.stories.find((s) => s.id === storyId);
  }

  private async runChapter(storyId: string, index: number) {
    const story = this.story(storyId);
    const chapter = story?.chapters[index];
    if (!story || !chapter) {
      this.exit();
      return;
    }
    this.buildStage(this.resolveLocation(chapter.locationId));
    const s = this.stage!;
    s.hud.setObjective('');
    s.hud.banner(`Chapter ${index + 1}`, chapter.title, 2.6);
    this.paused = true;
    await wait(1200);
    if (this.disposed) return;
    await s.hud.dialogue(chapter.intro, this.opts.universe.accent);
    if (this.disposed || this.stage !== s) return;
    this.paused = false;
    this.objective = { chapter, spawned: 0, killed: 0, elapsed: 0, boss: null, done: false, spawnTimer: 0 };
    if (chapter.objective.type === 'boss') {
      const id = chapter.objective.characterId;
      const bossChar = this.opts.universe.characters.find((c) => c.id === id);
      if (bossChar) this.objective.boss = this.spawnBoss(bossChar, chapter.enemyLevel);
    }
    s.hud.banner('Mission Start', objectiveText(chapter), 1.8);
  }

  private updateObjective(dt: number) {
    const o = this.objective;
    const s = this.stage;
    if (!o || !s || o.done) return;
    const ch = o.chapter;
    const density = this.opts.universe.rules.enemyDensity;
    const alive = s.combat.actors.filter((a) => a.team === 'enemy' && a.alive && a.archetype !== 'boss').length;
    const maxAlive = Math.round((ch.objective.type === 'boss' ? 3 : 6) * density);
    o.elapsed += dt;
    o.spawnTimer -= dt;

    const canSpawn = o.spawnTimer <= 0 && alive < maxAlive;
    switch (ch.objective.type) {
      case 'defeat': {
        const goal = Math.max(1, Math.round(ch.objective.count * density));
        if (canSpawn && o.spawned < goal) {
          this.spawnMinion(this.pickMinion(ch.enemyLevel), ch.enemyLevel, ch.enemyFactionId);
          o.spawned++;
          o.spawnTimer = 0.6;
        }
        s.hud.setObjective(`Defeat enemies  ${Math.min(o.killed, goal)} / ${goal}`);
        if (o.killed >= goal) void this.completeChapter();
        break;
      }
      case 'survive': {
        const left = Math.max(0, ch.objective.seconds - o.elapsed);
        if (canSpawn) {
          this.spawnMinion(this.pickMinion(ch.enemyLevel), ch.enemyLevel, ch.enemyFactionId);
          o.spawnTimer = 1.2;
        }
        s.hud.setObjective(`Survive  ${formatTime(left)}`);
        if (left <= 0) void this.completeChapter();
        break;
      }
      case 'boss': {
        if (canSpawn && o.elapsed > 8) {
          this.spawnMinion('grunt', ch.enemyLevel, ch.enemyFactionId);
          o.spawnTimer = 6;
        }
        s.hud.setObjective(o.boss ? `Defeat ${o.boss.name}` : 'Defeat the boss');
        if (!o.boss || !o.boss.alive) void this.completeChapter();
        break;
      }
    }
  }

  private async completeChapter() {
    const o = this.objective;
    const s = this.stage;
    if (!o || !s || o.done || this.opts.mode.type !== 'story') return;
    o.done = true;
    s.hud.setObjective('');
    s.hud.setBoss(null);
    this.slowmo = 1.2;
    // Remaining minions flee/vanish.
    for (const a of s.combat.actors) {
      if (a.team === 'enemy' && a.alive) {
        s.fx.flare(a.center, '#ffffff', 2, 0.4);
        a.alive = false;
      }
    }
    s.hud.banner('Mission Complete', o.chapter.title, 2.4);
    await wait(2200);
    if (this.disposed) return;
    this.paused = true;
    await s.hud.dialogue(o.chapter.outro, this.opts.universe.accent);
    if (this.disposed) return;

    // Rewards.
    const u = this.opts.universe;
    const bonusXp = xpReward(o.chapter.enemyLevel, true);
    const levels = grantXp(this.character, bonusXp);
    const reward = u.items.find((i) => i.id === o.chapter.rewardItemId);
    let rewardNote = '';
    if (reward) {
      if (this.character.itemIds.includes(reward.id)) rewardNote = `${reward.name} (already equipped)`;
      else if (this.character.itemIds.length < 4) {
        this.character.itemIds.push(reward.id);
        rewardNote = `${reward.name} — equipped!`;
      } else rewardNote = `${reward.name} (gear slots full)`;
    }
    this.opts.onSave();

    const mode = this.opts.mode;
    const story = this.story(mode.storyId);
    const next = mode.chapter + 1;
    const hasNext = !!story && next < story.chapters.length;
    s.hud.modal(
      hasNext ? 'Chapter Complete' : 'Story Complete',
      h('div', { class: 'rewards' },
        h('div', null, `+${bonusXp} XP`),
        levels > 0 && h('div', { class: 'reward-level' }, `LEVEL UP! Now level ${this.character.level}`),
        reward && h('div', { style: `color:${RARITY_COLORS[reward.rarity]}` }, `Reward: ${rewardNote}`),
      ),
      [
        ...(hasNext ? [{ label: 'Next Chapter', primary: true, onClick: () => this.gotoChapter(mode.storyId, next) }] : []),
        { label: 'Replay', onClick: () => this.gotoChapter(mode.storyId, mode.chapter) },
        { label: 'Exit', primary: !hasNext, onClick: () => this.exit() },
      ],
    );
  }

  private gotoChapter(storyId: string, index: number) {
    this.stage?.hud.modal('', null, []);
    this.opts.mode = { type: 'story', storyId, chapter: index };
    void this.runChapter(storyId, index);
  }

  private onKill(target: Actor) {
    const s = this.stage;
    if (!s) return;
    if (target === s.player) {
      if (this.opts.mode.type === 'sandbox') {
        s.hud.banner('Down!', 'Respawning...', 1.6);
        setTimeout(() => this.respawnPlayer(), 1500);
        return;
      }
      this.slowmo = 1.5;
      setTimeout(() => {
        if (this.disposed || this.stage !== s) return;
        this.paused = true;
        const mode = this.opts.mode;
        s.hud.modal('Defeated', 'Even legends fall. Get back up?', [
          { label: 'Retry', primary: true, onClick: () => mode.type === 'story' && this.gotoChapter(mode.storyId, mode.chapter) },
          { label: 'Exit', onClick: () => this.exit() },
        ]);
      }, 1400);
      return;
    }
    if (this.objective) this.objective.killed++;
    if (target.archetype === 'boss') this.slowmo = 1;
    const levels = grantXp(this.character, xpReward(target.level, target.archetype === 'boss'));
    if (levels > 0) this.applyLevelUp();
    s.combat.schedule(1.4, () => {
      if (this.stage === s) s.combat.remove(target);
    });
  }

  private applyLevelUp() {
    const s = this.stage;
    if (!s) return;
    const p = s.player;
    p.level = this.character.level;
    p.maxHp = maxHealth(p.stats, p.level);
    p.hp = p.maxHp;
    p.energy = p.maxEnergy;
    s.hud.banner('Level Up!', `Level ${p.level}`, 1.8);
    s.fx.flare(p.center, '#ffd23e', 4, 0.6);
    s.fx.ring(p.pos, '#ffd23e', 5, 0.6);
    this.opts.onSave();
  }

  private respawnPlayer() {
    const s = this.stage;
    if (!s || this.disposed) return;
    const p = s.player;
    p.alive = true;
    p.hp = p.maxHp;
    p.energy = p.maxEnergy;
    p.invuln = 2;
    p.model.root.rotation.x = 0;
    p.pos.set(0, 0, 0);
    s.fx.flare(p.center, '#ffffff', 3, 0.5);
  }

  // --- Sandbox -------------------------------------------------------------

  private startSandbox(locationId: string | null) {
    this.buildStage(this.resolveLocation(locationId));
    const s = this.stage!;
    s.hud.banner('Omni Sandbox', 'You are the One Above All', 2.4);
    s.hud.setObjective('Free play');
    this.buildOmniPanel(s);
  }

  private buildOmniPanel(s: Stage) {
    const u = this.opts.universe;
    const panel = s.hud.sidePanel;
    panel.classList.remove('hidden');
    const levelLabel = h('span', null, String(this.spawnLevel));
    const bosses = u.characters.filter((c) => c.id !== this.character.id);
    const bossSelect = h('select', null, ...bosses.map((c) => h('option', { value: c.id }, `${c.alias} (${c.role})`)));
    const slider = (label: string, min: number, max: number, step: number, value: number, set: (v: number) => void) => {
      const out = h('span', null, value.toFixed(2));
      return h('label', { class: 'omni-row' }, h('span', null, label),
        h('input', {
          type: 'range', min, max, step, value,
          oninput: (e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            out.textContent = v.toFixed(2);
            set(v);
          },
        }), out);
    };
    const body = h('div', { class: 'omni-body' },
      h('div', { class: 'omni-section' }, 'Spawn'),
      h('label', { class: 'omni-row' }, h('span', null, 'Level'),
        h('input', {
          type: 'range', min: 1, max: 60, step: 1, value: this.spawnLevel,
          oninput: (e: Event) => {
            this.spawnLevel = Number((e.target as HTMLInputElement).value);
            levelLabel.textContent = String(this.spawnLevel);
          },
        }), levelLabel),
      h('div', { class: 'omni-grid' },
        h('button', { class: 'btn', onclick: () => this.spawnMinion('grunt', this.spawnLevel, null) }, '+ Trooper'),
        h('button', { class: 'btn', onclick: () => this.spawnMinion('gunner', this.spawnLevel, null) }, '+ Gunner'),
        h('button', { class: 'btn', onclick: () => this.spawnMinion('brute', this.spawnLevel, null) }, '+ Brute'),
        h('button', { class: 'btn', onclick: () => { for (let i = 0; i < 8; i++) this.spawnMinion(this.pickMinion(this.spawnLevel), this.spawnLevel, null); } }, '+ Wave'),
      ),
      bosses.length > 0 && h('div', { class: 'omni-row' }, bossSelect,
        h('button', {
          class: 'btn primary',
          onclick: () => {
            const c = bosses.find((b) => b.id === bossSelect.value);
            if (c) this.spawnBoss(c, this.spawnLevel);
          },
        }, 'Summon')),
      h('button', { class: 'btn', onclick: () => this.clearEnemies() }, 'Clear enemies'),
      h('div', { class: 'omni-section' }, 'Reality'),
      slider('Time', 0.1, 2, 0.05, this.timeScale, (v) => (this.timeScale = v)),
      slider('Gravity', 0.2, 2, 0.05, s.combat.gravityScale, (v) => (s.combat.gravityScale = v)),
      slider('Power', 0.5, 3, 0.05, s.combat.powerScale, (v) => (s.combat.powerScale = v)),
      h('label', { class: 'omni-row' },
        h('input', { type: 'checkbox', checked: this.godMode, onchange: (e: Event) => (this.godMode = (e.target as HTMLInputElement).checked) }),
        h('span', null, 'Invincible')),
      h('button', { class: 'btn', onclick: () => { s.player.hp = s.player.maxHp; s.player.energy = s.player.maxEnergy; s.player.ultimate = 100; } }, 'Restore & charge ultimate'),
    );
    const toggle = h('button', { class: 'omni-toggle', onclick: () => panel.classList.toggle('collapsed') }, '⚙ OMNI');
    panel.replaceChildren(toggle, body);
    if (window.innerWidth < 800 || window.innerHeight < 600) panel.classList.add('collapsed');
  }

  private clearEnemies() {
    const s = this.stage;
    if (!s) return;
    for (const a of [...s.combat.actors]) {
      if (a.team === 'enemy') {
        s.fx.flare(a.center, '#ffffff', 2, 0.3);
        s.combat.remove(a);
      }
    }
    s.hud.setBoss(null);
  }

  // --- Loop ----------------------------------------------------------------

  private togglePause() {
    const s = this.stage;
    if (!s || this.objective?.done) return;
    if (this.paused) {
      this.paused = false;
      s.hud.modal('', null, []);
      return;
    }
    this.paused = true;
    s.hud.modal('Paused', h('div', { class: 'pause-help' },
      h('p', null, 'WASD / joystick — move · Space — jump (double jump)'),
      h('p', null, 'J / click — combo attack · Shift — dodge'),
      h('p', null, 'Q E R F — powers · X — ultimate · V — toggle flight (Space/C to rise/fall)'),
      h('p', null, 'Right-drag or arrow keys — camera · Wheel — zoom'),
    ), [
      { label: 'Resume', primary: true, onClick: () => this.togglePause() },
      { label: 'Exit', onClick: () => this.exit() },
    ]);
  }

  private loop(now: number) {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    const realDt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.input.consume('pause')) this.togglePause();

    const s = this.stage;
    if (!s) return;

    let dt = this.paused ? 0 : realDt * this.timeScale;
    if (this.slowmo > 0) {
      this.slowmo -= realDt;
      dt *= 0.3;
    }
    if (this.hitstop > 0) {
      this.hitstop -= realDt;
      dt *= 0.05;
    }
    this.time += dt;

    if (!this.paused) {
      this.controlPlayer(s, dt);
      for (const a of s.combat.actors) if (a.team === 'enemy') updateEnemy(a, s.combat, dt);
      s.combat.update(dt);
      if (this.godMode) s.player.hp = s.player.maxHp;
      this.updateObjective(dt);
      // Dead actors topple and sink.
      for (const a of s.combat.actors) {
        if (!a.alive) {
          a.model.root.rotation.x = Math.max(-Math.PI / 2, a.model.root.rotation.x - dt * 5);
          if (a.model.root.rotation.x <= -Math.PI / 2 + 0.01) a.model.root.position.y -= dt * 0.8;
        }
      }
    }
    s.arena.update(this.time);
    const shake = s.fx.update(dt);
    this.updateCamera(s, realDt, shake);
    s.hud.update(realDt, this.camera, s.combat.actors.filter((a) => a.team === 'enemy'));

    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  private controlPlayer(s: Stage, dt: number) {
    const p = s.player;
    const input = this.input;
    input.keyOrbit(dt);
    const move = input.movement();
    const fwd = new THREE.Vector3(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw));
    const right = new THREE.Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
    p.moveIntent.copy(fwd.multiplyScalar(move.y)).addScaledVector(right, move.x);
    p.flyIntent = input.held('Space') ? 1 : input.held('KeyC') || input.held('ControlLeft') ? -1 : 0;

    if (!p.alive) {
      // Drain queued presses so nothing fires on respawn.
      for (const a of ['attack', 'dodge', 'jump', 'flight', 'ultimate', 'skill0', 'skill1', 'skill2', 'skill3'] as const) input.consume(a);
      p.moveIntent.set(0, 0, 0);
      return;
    }
    if (input.consume('jump')) {
      if (p.flying) p.vel.y = 9;
      else s.combat.jump(p);
    }
    if (input.consume('flight')) s.combat.toggleFlight(p);
    if (input.consume('dodge')) s.combat.dodge(p);
    if (input.consume('ultimate') && s.combat.ultimate(p)) this.slowmo = 0.5;
    for (let i = 0; i < 4; i++) if (input.consume(`skill${i}` as 'skill0')) s.combat.castPower(p, i);
    if (input.consume('attack')) s.combat.basicAttack(p);
  }

  private updateCamera(s: Stage, dt: number, shake: THREE.Vector3) {
    const input = this.input;
    this.camYaw -= input.orbitX;
    this.camPitch = THREE.MathUtils.clamp(this.camPitch + input.orbitY, 0.05, 1.2);
    this.camDist = THREE.MathUtils.clamp(this.camDist + input.zoom * 0.8, 5, 18);
    input.orbitX = input.orbitY = input.zoom = 0;

    const target = s.player.center;
    this.camTarget.lerp(target, Math.min(1, dt * 10));
    const offset = new THREE.Vector3(
      Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      Math.cos(this.camYaw) * Math.cos(this.camPitch),
    ).multiplyScalar(this.camDist);
    this.camera.position.copy(this.camTarget).add(offset).add(shake);
    this.camera.position.y = Math.max(0.5, this.camera.position.y);
    this.camera.lookAt(this.camTarget.clone().add(new THREE.Vector3(0, 0.6, 0)));
  }

  private exit() {
    this.opts.onSave();
    this.dispose();
    this.opts.onExit();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    window.removeEventListener('resize', this.onResize);
    this.teardownStage();
    this.input.dispose();
    this.composer?.dispose();
    this.renderer.dispose();
    this.root.remove();
  }
}

function objectiveText(ch: Chapter): string {
  switch (ch.objective.type) {
    case 'defeat':
      return `Defeat ${ch.objective.count} enemies`;
    case 'survive':
      return `Survive for ${formatTime(ch.objective.seconds)}`;
    case 'boss':
      return 'Defeat the boss';
  }
}

function formatTime(seconds: number): string {
  const s = Math.ceil(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
