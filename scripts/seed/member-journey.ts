/**
 * The stop of SPEC Phase 5: one fake member's whole way through the member space, from the goal
 * to the testimonial card, through the Worker's own functions (the same SQL and rules as a real
 * member's clicks). Léa Moreau (`user_seed01`, one of the fake members `seed` adds) sets a goal,
 * records three results (the second backed by a screenshot), reaches her milestones and badges,
 * then makes the card of her backed result: its public page goes online.
 *
 * The screenshot is read in a member's browser (Tesseract.js, tested in a real browser): here the
 * journey gives what the browser sends, the image's fingerprint and the numbers read on it.
 */

import { createHash } from 'node:crypto';
import type { Db } from '../../apps/worker/src/db';
import { makeCard, readMemberSpace, recordResult, setGoal } from '../../apps/worker/src/space';

export const JOURNEY_USER = 'user_seed01';

const HOUR = 3_600_000;

/** Runs the journey and says each step, as the run's summary shows it. */
export async function runJourney(
  db: Db,
  companyId: string,
  now: Date,
  origin: string,
): Promise<string[]> {
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR);
  const lines: string[] = [];
  const say = (line: string) => lines.push(line);

  const [member] = await db.query<{ name: string | null }>(
    `select display_name as name from stayput.members
      where company_id = $1 and user_id = $2 and status = 'joined'`,
    [companyId, JOURNEY_USER],
  );
  if (!member) throw new Error(`No fake member ${JOURNEY_USER}: run the seed first.`);
  say(`### Le parcours de ${member.name ?? JOURNEY_USER}`);

  // 1. The goal, among those the creator proposes for an online business, or her own.
  const targetDate = new Date(now.getTime() + 60 * 24 * HOUR).toISOString().slice(0, 10);
  const set = await setGoal(
    db,
    companyId,
    JOURNEY_USER,
    {
      title: 'Atteindre 3 000 € de chiffre d’affaires mensuel',
      unit: '€',
      category: 'income',
      entry: 'total',
      start: 0,
      target: 3000,
      targetDate,
    },
    at(72),
  );
  if (!set) throw new Error('The goal was refused.');
  const space = () =>
    readMemberSpace(db, companyId, JOURNEY_USER, { locale: 'fr', preview: false });
  const goalId = (await space()).goal?.id;
  if (!goalId) throw new Error('No goal under way after setting it.');
  say(`1. Objectif fixé : 0 € → 3 000 € d’ici le ${targetDate}.`);

  // 2. Three results; the second backed by a screenshot of her dashboard.
  const screenshot = {
    sha256: createHash('sha256').update(`stayput-journey-${now.toISOString()}`).digest('hex'),
    numbers: [1650, 42, 39.29],
  };
  const steps: { value: number; hoursAgo: number; proof?: typeof screenshot }[] = [
    { value: 800, hoursAgo: 60 },
    { value: 1650, hoursAgo: 36, proof: screenshot },
    { value: 2400, hoursAgo: 2 },
  ];
  let n = 1;
  for (const step of steps) {
    n += 1;
    const answer = await recordResult(
      db,
      companyId,
      JOURNEY_USER,
      { goalId, value: step.value, ...(step.proof ? { proof: step.proof } : {}) },
      at(step.hoursAgo),
    );
    if (!answer) throw new Error(`The result ${step.value} was refused.`);
    say(
      `${n}. Résultat ${step.value} €` +
        (answer.proof ? ` (capture : ${answer.proof})` : '') +
        (answer.milestones.length > 0 ? ` — jalons : ${answer.milestones.join(', ')} %` : '') +
        (answer.badges.length > 0 ? ` — badges : ${answer.badges.join(', ')}` : ''),
    );
  }

  // 3. The card of the backed result, her name shown: its public page goes online.
  const after = await space();
  const backed = after.results.find((r) => r.proof === 'justified');
  if (!backed) throw new Error('No result backed by the screenshot.');
  const card = await makeCard(
    db,
    companyId,
    JOURNEY_USER,
    { resultId: backed.id, showName: true, affiliateUrl: null },
    now,
    origin,
  );
  if (!card) throw new Error('The card was refused.');
  n += 1;
  say(`${n}. Carte témoignage créée : ${card.url}`);
  say(`   Progression ${after.goal?.progress ?? 0} %, ${after.badges.length} badges.`);
  say('');
  say('Carte (pour la dessiner) :');
  say(`    ${JSON.stringify(card)}`);
  return lines;
}
