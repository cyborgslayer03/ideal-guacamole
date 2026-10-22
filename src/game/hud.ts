// In-game heads-up display: bars, skill buttons with cooldown sweeps, combo
// counter, floating damage numbers, dialogue, banners, and touch controls.

import * as THREE from 'three';
import { ELEMENT_COLORS, xpForLevel } from '../core/rules';
import type { DialogueLine, PowerKind } from '../core/types';
import { h, type Child } from '../ui/dom';
import type { Actor } from './combat';
import type { FeedEntry } from './ambient';
import type { Action, Input } from './input';

const KIND_ICON: Record<PowerKind, string> = {
  blast: '✦', beam: '═', nova: '✺', dash: '➤', shield: '⛨', heal: '✚',
  flight: '⇮', teleport: '⌖', superspeed: '≫', leap: '⤊',
};

const isTouch = () => window.matchMedia('(pointer: coarse)').matches;

interface SkillButton {
  el: HTMLElement;
  slot: number;
}

export class Hud {
  readonly root = h('div', { class: 'hud' });
  private readonly hpFill = h('div', { class: 'bar-fill hp' });
  private readonly hpGhost = h('div', { class: 'bar-ghost' });
  private readonly hpText = h('span', { class: 'bar-text' });
  private readonly enFill = h('div', { class: 'bar-fill energy' });
  private readonly xpFill = h('div', { class: 'bar-fill xp' });
  private readonly allyPanel = h('div', { class: 'hud-ally hidden' });
  private readonly allyFill = h('div', { class: 'bar-fill hp' });
  private ally: Actor | null = null;
  private readonly feedEl = h('div', { class: 'ambient-feed hidden' });
  private readonly labelLayer = h('div', { class: 'dmg-layer' });
  private labelEls = new Map<string, HTMLElement>();
  /** Floating labels pinned to world positions (portal names, etc.). */
  worldLabels: { id: string; pos: THREE.Vector3; text: string; color: string }[] = [];
  private readonly levelEl = h('div', { class: 'hud-level' });
  private readonly objectiveEl = h('div', { class: 'hud-objective' });
  private readonly bossBar = h('div', { class: 'boss-bar hidden' });
  private readonly bossFill = h('div', { class: 'bar-fill boss' });
  private readonly bossName = h('div', { class: 'boss-name' });
  private readonly comboEl = h('div', { class: 'combo hidden' });
  private readonly numbers = h('div', { class: 'dmg-layer' });
  private readonly enemyBars = h('div', { class: 'dmg-layer' });
  private readonly bannerEl = h('div', { class: 'banner' });
  private readonly dialogueEl = h('div', { class: 'dialogue hidden' });
  private readonly modalEl = h('div', { class: 'modal-layer hidden' });
  readonly sidePanel = h('div', { class: 'omni-panel hidden' });
  private skillButtons: SkillButton[] = [];
  private ultButton: HTMLElement;
  private travelButton: HTMLElement | null = null;
  private barEls = new Map<Actor, HTMLElement>();
  private combo = 0;
  private comboTimer = 0;
  private ghostHp = 1;

  constructor(
    private readonly player: Actor,
    private readonly input: Input,
    onPause: () => void,
  ) {
    const press = (action: Action) => (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      input.press(action);
    };

    const playerPanel = h('div', { class: 'hud-player' },
      h('div', { class: 'hud-name' }, this.levelEl, h('span', null, player.name)),
      h('div', { class: 'bar big' }, this.hpGhost, this.hpFill, this.hpText),
      h('div', { class: 'bar small' }, this.enFill),
      h('div', { class: 'bar tiny' }, this.xpFill),
      this.allyPanel,
    );

    this.bossBar.append(this.bossName, h('div', { class: 'bar boss-track' }, this.bossFill));

    const keyHints = ['Q', 'E', 'R', 'F'];
    const skills = player.skills.map((s, slot) => {
      const color = ELEMENT_COLORS[s.power.element];
      const el = h('button', {
        class: `skill skill-${slot}`,
        style: `--c:${color}`,
        title: `${s.power.name} (${s.power.kind}, ${s.power.element})`,
        onpointerdown: press(`skill${slot}` as Action),
      }, h('span', { class: 'skill-icon' }, KIND_ICON[s.power.kind]), h('span', { class: 'key' }, keyHints[slot]));
      this.skillButtons.push({ el, slot });
      return el;
    });

    this.ultButton = h('button', { class: 'skill ult', onpointerdown: press('ultimate') }, h('span', { class: 'skill-icon' }, '★'), h('span', { class: 'key' }, 'X'));
    const controls = h('div', { class: 'hud-controls' },
      h('button', { class: 'skill attack', onpointerdown: press('attack') }, h('span', { class: 'skill-icon' }, '✊'), h('span', { class: 'key' }, 'J')),
      h('button', { class: 'skill dodge', onpointerdown: press('dodge') }, h('span', { class: 'skill-icon' }, '»'), h('span', { class: 'key' }, '⇧')),
      h('button', { class: 'skill jump', onpointerdown: press('jump') }, h('span', { class: 'skill-icon' }, '⤒'), h('span', { class: 'key' }, '␣')),
      this.buildTravelButton(press),
      this.ultButton,
      ...skills,
    );

    const top = h('div', { class: 'hud-top' },
      playerPanel,
      h('div', { class: 'hud-center' }, this.objectiveEl, this.bossBar),
      h('div', { class: 'hud-actions' },
        h('button', { class: 'hud-btn', onclick: onPause, title: 'Pause (Esc)' }, '❚❚'),
      ),
    );

    this.root.append(this.labelLayer, this.enemyBars, this.numbers, top, this.feedEl, this.comboEl, controls, this.sidePanel, this.bannerEl, this.dialogueEl, this.modalEl);
    if (isTouch()) this.root.append(this.buildJoystick());
    else this.root.append(h('div', { class: 'hud-hint' }, 'WASD move · J/Click attack · Shift dodge · Space jump · Q E R F powers · V movement power · X ultimate · Right-drag camera'));
  }

  private buildTravelButton(press: (a: Action) => (e: Event) => void): HTMLElement | null {
    const p = this.player.travel;
    if (!p) return null;
    this.travelButton = h('button', {
      class: 'skill fly',
      style: `--c:${ELEMENT_COLORS[p.element]}`,
      title: `${p.name} (${p.kind})`,
      onpointerdown: press('travel'),
    }, h('span', { class: 'skill-icon' }, KIND_ICON[p.kind]), h('span', { class: 'key' }, 'V'));
    return this.travelButton;
  }

  private buildJoystick(): HTMLElement {
    const knob = h('div', { class: 'stick-knob' });
    const base = h('div', { class: 'stick' }, knob);
    let id: number | null = null;
    let cx = 0;
    let cy = 0;
    const max = 50;
    const reset = () => {
      id = null;
      this.input.stick.x = this.input.stick.y = 0;
      knob.style.transform = '';
    };
    base.addEventListener('pointerdown', (e) => {
      id = e.pointerId;
      const r = base.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      base.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    base.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      let dx = e.clientX - cx;
      let dy = e.clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > max) {
        dx = (dx / len) * max;
        dy = (dy / len) * max;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.input.stick.x = dx / max;
      this.input.stick.y = -dy / max;
    });
    base.addEventListener('pointerup', reset);
    base.addEventListener('pointercancel', reset);
    return base;
  }

  setAlly(ally: Actor | null) {
    this.ally = ally;
    this.allyPanel.classList.toggle('hidden', !ally);
    if (ally) this.allyPanel.replaceChildren(h('span', null, ally.name), h('div', { class: 'bar small' }, this.allyFill));
  }

  /** Vertical list of choices with descriptions; resolves with the picked index. */
  choose(title: string, prompt: string, options: { label: string; detail?: string; disabled?: boolean }[]): Promise<number> {
    return new Promise((resolve) => {
      this.modalEl.replaceChildren(
        h('div', { class: 'modal' },
          h('h2', null, title),
          prompt && h('div', { class: 'modal-body' }, prompt),
          h('div', { class: 'choice-list' },
            ...options.map((o, i) =>
              h('button', {
                class: 'choice',
                disabled: !!o.disabled,
                onclick: () => {
                  this.modalEl.classList.add('hidden');
                  resolve(i);
                },
              }, h('b', null, o.label), o.detail && h('span', null, o.detail)),
            ),
          ),
        ),
      );
      this.modalEl.classList.remove('hidden');
    });
  }

  /** Optional side events, nearest first. Pass an empty list to hide the feed. */
  setFeed(entries: FeedEntry[]) {
    this.feedEl.classList.toggle('hidden', entries.length === 0);
    if (!entries.length) return;
    this.feedEl.replaceChildren(
      h('div', { class: 'feed-title' }, 'Nearby'),
      ...entries.map((e) =>
        h('div', { class: 'feed-item', style: `--c:${e.color}` },
          h('b', null, e.label),
          h('span', null, `${e.detail} · ${e.distance}m`),
        ),
      ),
    );
  }

  setObjective(text: string) {
    this.objectiveEl.textContent = text;
    this.objectiveEl.classList.toggle('hidden', !text);
  }

  setBoss(boss: Actor | null) {
    this.bossBar.classList.toggle('hidden', !boss);
    if (boss) this.bossName.textContent = `${boss.title ? `${boss.title} · ` : ''}${boss.name}  ·  Lv ${boss.level}`;
    this.bossTarget = boss;
  }
  private bossTarget: Actor | null = null;

  addCombo() {
    this.combo++;
    this.comboTimer = 2.5;
    this.comboEl.classList.remove('hidden', 'pop');
    void this.comboEl.offsetWidth;
    this.comboEl.classList.add('pop');
    this.comboEl.replaceChildren(h('b', null, String(this.combo)), h('span', null, 'HITS'));
  }

  damageNumber(world: THREE.Vector3, camera: THREE.Camera, amount: number, kind: 'normal' | 'crit' | 'heal' | 'taken') {
    const p = world.clone().project(camera);
    if (p.z > 1) return;
    const el = h('div', { class: `dmg dmg-${kind}` }, kind === 'heal' ? `+${amount}` : String(amount));
    el.style.left = `${(p.x * 0.5 + 0.5) * 100 + (Math.random() - 0.5) * 4}%`;
    el.style.top = `${(-p.y * 0.5 + 0.5) * 100}%`;
    this.numbers.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  banner(title: string, subtitle = '', duration = 2.2) {
    this.bannerEl.replaceChildren(h('div', { class: 'banner-title' }, title), subtitle && h('div', { class: 'banner-sub' }, subtitle));
    this.bannerEl.classList.remove('show');
    void this.bannerEl.offsetWidth;
    this.bannerEl.classList.add('show');
    this.bannerEl.style.animationDuration = `${duration}s`;
  }

  /** Shows dialogue lines one at a time; resolves when the player has read them all. */
  dialogue(lines: DialogueLine[], accent: string): Promise<void> {
    return new Promise((resolve) => {
      if (!lines.length) return resolve();
      let i = 0;
      const show = () => {
        const line = lines[i];
        this.dialogueEl.replaceChildren(
          h('div', { class: 'dialogue-speaker', style: `color:${accent}` }, line.speaker || '???'),
          h('div', { class: 'dialogue-text' }, line.text),
          h('div', { class: 'dialogue-next' }, i < lines.length - 1 ? 'Tap / Enter ▸' : 'Begin ▸'),
        );
      };
      const advance = (e?: Event) => {
        if (e instanceof KeyboardEvent && e.code !== 'Enter' && e.code !== 'Space') return;
        e?.preventDefault();
        e?.stopPropagation();
        i++;
        if (i >= lines.length) {
          this.dialogueEl.classList.add('hidden');
          this.dialogueEl.removeEventListener('pointerdown', advance);
          window.removeEventListener('keydown', advance, true);
          resolve();
        } else show();
      };
      this.dialogueEl.classList.remove('hidden');
      this.dialogueEl.addEventListener('pointerdown', advance);
      window.addEventListener('keydown', advance, true);
      show();
    });
  }

  /** Modal dialog with action buttons. Pass an empty list to close it. */
  modal(title: string, body: Child, actions: { label: string; primary?: boolean; onClick: () => void }[]) {
    if (!actions.length) {
      this.modalEl.classList.add('hidden');
      return;
    }
    this.modalEl.replaceChildren(
      h('div', { class: 'modal' },
        h('h2', null, title),
        h('div', { class: 'modal-body' }, body),
        h('div', { class: 'modal-actions' }, ...actions.map((a) => h('button', { class: a.primary ? 'btn primary' : 'btn', onclick: a.onClick }, a.label))),
      ),
    );
    this.modalEl.classList.remove('hidden');
  }

  update(dt: number, camera: THREE.Camera, enemies: Actor[]) {
    const p = this.player;
    const c = p.character;
    const hpRatio = p.hp / p.maxHp;
    this.ghostHp = Math.max(hpRatio, this.ghostHp - dt * 0.4);
    this.hpFill.style.width = `${hpRatio * 100}%`;
    this.hpGhost.style.width = `${this.ghostHp * 100}%`;
    this.hpText.textContent = `${Math.ceil(p.hp)} / ${p.maxHp}`;
    this.enFill.style.width = `${(p.energy / p.maxEnergy) * 100}%`;
    if (c) {
      this.levelEl.textContent = `Lv ${c.level}`;
      this.xpFill.style.width = `${(c.xp / xpForLevel(c.level)) * 100}%`;
    }
    this.root.classList.toggle('low-hp', hpRatio < 0.3);

    for (const b of this.skillButtons) {
      const s = p.skills[b.slot];
      b.el.style.setProperty('--cd', String(s.remaining / s.cooldown));
      b.el.classList.toggle('no-energy', p.energy < s.cost);
      b.el.dataset.cd = s.remaining > 0 ? s.remaining.toFixed(s.remaining < 1 ? 1 : 0) : '';
    }
    this.ultButton.style.setProperty('--cd', String(1 - p.ultimate / 100));
    if (this.travelButton) {
      this.travelButton.style.setProperty('--cd', p.travelCooldown ? String(p.travelRemaining / p.travelCooldown) : '0');
      this.travelButton.dataset.cd = p.travelRemaining > 0 ? p.travelRemaining.toFixed(1) : '';
      this.travelButton.classList.toggle('active', p.flying);
    }
    this.ultButton.classList.toggle('ready', p.ultimate >= 100);

    if (this.ally) {
      this.allyFill.style.width = `${(this.ally.hp / this.ally.maxHp) * 100}%`;
      this.allyPanel.classList.toggle('down', !this.ally.alive);
    }
    if (this.bossTarget) this.bossFill.style.width = `${(this.bossTarget.hp / this.bossTarget.maxHp) * 100}%`;

    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.combo = 0;
        this.comboEl.classList.add('hidden');
      }
    }

    // World labels.
    const seenLabels = new Set<string>();
    for (const l of this.worldLabels) {
      seenLabels.add(l.id);
      let el = this.labelEls.get(l.id);
      if (!el) {
        el = h('div', { class: 'world-label', style: `--c:${l.color}` }, l.text);
        this.labelLayer.appendChild(el);
        this.labelEls.set(l.id, el);
      }
      const p = l.pos.clone().project(camera);
      el.style.display = p.z < 1 ? '' : 'none';
      el.style.left = `${(p.x * 0.5 + 0.5) * 100}%`;
      el.style.top = `${(-p.y * 0.5 + 0.5) * 100}%`;
    }
    for (const [id, el] of this.labelEls) {
      if (!seenLabels.has(id)) {
        el.remove();
        this.labelEls.delete(id);
      }
    }

    // Floating enemy health bars.
    const seen = new Set<Actor>();
    for (const e of enemies) {
      if (!e.alive || (e.archetype === 'boss' && e === this.bossTarget)) continue;
      seen.add(e);
      let el = this.barEls.get(e);
      if (!el) {
        el = h('div', { class: 'enemy-bar' }, h('div', { class: 'enemy-bar-fill' }));
        this.enemyBars.appendChild(el);
        this.barEls.set(e, el);
      }
      const pos = e.pos.clone().setY(e.pos.y + e.model.height * e.model.root.scale.y + 0.4).project(camera);
      const visible = pos.z < 1 && e.sinceHit < 6;
      el.style.display = visible ? '' : 'none';
      if (visible) {
        el.style.left = `${(pos.x * 0.5 + 0.5) * 100}%`;
        el.style.top = `${(-pos.y * 0.5 + 0.5) * 100}%`;
        (el.firstChild as HTMLElement).style.width = `${(e.hp / e.maxHp) * 100}%`;
      }
    }
    for (const [actor, el] of this.barEls) {
      if (!seen.has(actor)) {
        el.remove();
        this.barEls.delete(actor);
      }
    }
  }
}
