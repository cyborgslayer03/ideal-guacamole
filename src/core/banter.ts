// Squad banter: short lines teammates say in the middle of a fight. The tone
// follows how much they like the hero (relationship score): warm, neutral, or
// prickly. `{name}` is the teammate or hero the line is about.

export type BanterEvent = 'start' | 'combo' | 'revive' | 'down' | 'enrage' | 'bossDown' | 'prop' | 'lowHp' | 'scheme';
export type Mood = 'warm' | 'neutral' | 'prickly';

const LINES: Record<BanterEvent, Record<Mood, string[]>> = {
  start: {
    warm: ['Right behind you, {name}.', 'Together, like always.', 'Let\'s show them how it\'s done, {name}.'],
    neutral: ['Ready when you are.', 'Let\'s get this done.', 'Stay sharp.'],
    prickly: ['Try to keep up, {name}.', 'Don\'t slow me down.', 'Fine. Let\'s go.'],
  },
  combo: {
    warm: ['Nice combo, {name}!', 'We make a great team!', 'Now THAT\'s teamwork!'],
    neutral: ['Good timing, {name}.', 'That worked.', 'Combo landed!'],
    prickly: ['Not bad, {name}. For once.', 'I did most of that.', 'Lucky timing.'],
  },
  revive: {
    warm: ['Got you, {name}. Up you get!', 'I\'m not losing you today.', 'Back on your feet, friend.'],
    neutral: ['You\'re okay, {name}. Move!', 'Up. We need you.', 'On your feet.'],
    prickly: ['You owe me one, {name}.', 'Try not to do that again.', 'Get up. I\'m not carrying you.'],
  },
  down: {
    warm: ['{name}! Hang on, I\'m coming!', 'No! {name} is down!', 'Cover me, I\'m going for {name}!'],
    neutral: ['{name} is down!', 'Someone get to {name}!', 'We lost {name}, regroup!'],
    prickly: ['{name} went down. Typical.', 'Great. Now I have to save {name}.', '{name}\'s out. Figures.'],
  },
  enrage: {
    warm: ['They\'re powering up! Stay close, {name}!', 'Watch the circles, I\'ve got your back!'],
    neutral: ['They\'re getting serious. Watch the ground!', 'Here comes round two.'],
    prickly: ['You made them angry, {name}.', 'Great, now they\'re mad.'],
  },
  bossDown: {
    warm: ['We did it, {name}!', 'That\'s how heroes do it!', 'Couldn\'t have done it without you.'],
    neutral: ['Target down.', 'That\'s one less problem.', 'Good work, everyone.'],
    prickly: ['I softened them up for you, {name}.', 'Finally.', 'Took you long enough.'],
  },
  prop: {
    warm: ['Remind me to never park near you, {name}.', 'Somebody\'s going to have to pay for that!'],
    neutral: ['That\'s coming out of the city budget.', 'Property damage report incoming.'],
    prickly: ['Do you HAVE to break everything, {name}?', 'Very subtle.'],
  },
  lowHp: {
    warm: ['{name}, you\'re hurt! Fall back for a second!', 'Hang in there, {name}!'],
    neutral: ['Careful, {name}, you\'re taking a beating.', 'Watch your health!'],
    prickly: ['You\'re getting sloppy, {name}.', 'Don\'t expect me to save you.'],
  },
  scheme: {
    warm: ['We stop this together, {name}.', 'Whatever they\'re planning ends here.'],
    neutral: ['Clock\'s ticking. Let\'s move.', 'Shut it down fast.'],
    prickly: ['If this blows up, it\'s on you, {name}.', 'Try not to waste time.'],
  },
};

export function moodOf(score: number): Mood {
  return score >= 40 ? 'warm' : score < 0 ? 'prickly' : 'neutral';
}

/** A line for this event and mood, picked by `roll` in [0, 1). */
export function banterLine(event: BanterEvent, score: number, about: string, roll: number): string {
  const options = LINES[event][moodOf(score)];
  return options[Math.min(options.length - 1, Math.floor(roll * options.length))].replace(/\{name\}/g, about);
}
