// Team combos: when one hero's power marks an enemy and a teammate follows up
// with a matching power, the two detonate together. Recipes match on power
// type or element ('*' matches anything); any two different elements still
// make a smaller Crossfire.

import type { Element, Power, PowerKind } from '../core/types';

/** A power type, an element as `el:<element>`, or '*' for anything. */
export type ComboTag = PowerKind | `el:${Element}` | '*';

export interface ComboRecipe {
  name: string;
  a: ComboTag;
  b: ComboTag;
  /** Multiplier on the combo's base damage. */
  mult: number;
  radius: number;
  /** Seconds of stun on everything caught. */
  stun: number;
  /** Seconds before it detonates (Time Bomb). */
  delay: number;
  color: string;
}

/** Seconds a mark stays open for a teammate's follow-up. */
export const COMBO_WINDOW = 3;
/** Seconds before the same enemy can be comboed again. */
export const COMBO_COOLDOWN = 4;

const r = (name: string, a: ComboTag, b: ComboTag, mult: number, radius: number, stun: number, color: string, delay = 0): ComboRecipe =>
  ({ name, a, b, mult, radius, stun, delay, color });

export const COMBOS: readonly ComboRecipe[] = [
  r('Cocoon Hurl', 'web', 'telekinesis', 3, 3, 2, '#f4f4ff'),
  r('Web Bomb', 'web', 'nova', 2.2, 5, 1.5, '#f4f4ff'),
  r('Slingshot', 'stretch', 'dash', 2.5, 3, 0.8, '#ffb347'),
  r('Lightning Vortex', 'gravity', 'el:lightning', 2.6, 6, 1.2, '#ffe93e'),
  r('Lightning Vortex', 'gravity', 'storm', 2.6, 6, 1.2, '#ffe93e'),
  r('Thunderclap', 'sonic', 'storm', 2.4, 7, 1, '#ffe93e'),
  r('Time Bomb', 'timestop', '*', 3, 4, 0.5, '#dff4ff', 1),
  r('Shatter', 'el:ice', 'el:kinetic', 2.8, 3.5, 0, '#8fd8ff'),
  r('Plasma Burst', 'el:fire', 'el:lightning', 2.4, 5, 0.6, '#ff9a3e'),
  r('Toxic Bloom', 'el:nature', 'el:fire', 2.2, 5, 0, '#9aff4f'),
  r('Supernova', 'el:cosmic', 'el:energy', 2.6, 6, 0.5, '#d6a8ff'),
  r('Nightmare', 'el:psychic', 'el:shadow', 1.8, 3, 3, '#a23dff'),
  r('Nightmare', 'mindcontrol', 'el:shadow', 1.8, 3, 3, '#a23dff'),
  r('Reality Collapse', 'reality', '*', 2.5, 4.5, 1, '#b06bff'),
];

export const CROSSFIRE: ComboRecipe = r('Crossfire', '*', '*', 1.5, 2.5, 0, '#ffffff');

function tags(p: Power): ComboTag[] {
  return [p.kind, `el:${p.element}`, '*'];
}

/** The combo two powers make (in either order), if any. */
export function findCombo(first: Power, second: Power): ComboRecipe | null {
  const ta = tags(first);
  const tb = tags(second);
  const exact = COMBOS.find((c) => (ta.includes(c.a) && tb.includes(c.b) && c.a !== '*') || (tb.includes(c.a) && ta.includes(c.b) && c.a !== '*'));
  if (exact) return exact;
  return first.element !== second.element ? CROSSFIRE : null;
}
