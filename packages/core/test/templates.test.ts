import { describe, expect, it } from 'vitest';
import {
  AI_WRITER_ENABLED,
  DEFAULT_TEMPLATES,
  MESSAGE_ACTIONS,
  renderMessage,
  renderTemplate,
  templateProblems,
  templateWriter,
} from '../src/templates';

describe('renderTemplate', () => {
  it('fills the variables in', () => {
    expect(
      renderTemplate('Hi {first_name}, {days_inactive} days at {creator_name}.', {
        first_name: 'Ana',
        days_inactive: 12,
        creator_name: 'Le Club',
      }),
    ).toBe('Hi Ana, 12 days at Le Club.');
  });

  it('drops an optional part when one of its values is missing, and never leaves a hole', () => {
    const template = 'Salut[[ {first_name}]], ta prochaine étape t’attend[[ : {last_lesson}]].';
    expect(renderTemplate(template, { first_name: 'Ana', last_lesson: '3. Charts' })).toBe(
      'Salut Ana, ta prochaine étape t’attend : 3. Charts.',
    );
    expect(renderTemplate(template, { first_name: ' ', last_lesson: null })).toBe(
      'Salut, ta prochaine étape t’attend.',
    );
    // A missing value outside an optional part leaves no double space.
    expect(renderTemplate('Code {offer} now', {})).toBe('Code now');
  });
});

describe('the default templates', () => {
  it('exist in English and French for every action that writes, with known variables only', () => {
    for (const locale of ['en', 'fr'] as const) {
      for (const action of MESSAGE_ACTIONS) {
        const template = DEFAULT_TEMPLATES[locale][action];
        expect(templateProblems(template.title)).toEqual([]);
        expect(templateProblems(template.body)).toEqual([]);
        const message = renderMessage(template, {});
        expect(message.title).not.toMatch(/[{}[\]]/);
        expect(message.body).not.toMatch(/[{}[\]]/);
        expect(message.body.length).toBeLessThanOrEqual(200);
      }
    }
  });

  it('read naturally with a member, and without a first name', () => {
    const values = { first_name: 'Ana', creator_name: 'Le Club', days_inactive: 12 };
    expect(renderMessage(DEFAULT_TEMPLATES.fr.high_risk_message, values)).toEqual({
      title: 'Tu nous manques, Ana',
      body: 'Ça fait 12 jours. Ta prochaine étape t’attend. Reviens quand tu peux, on est là.',
    });
    expect(
      renderMessage(DEFAULT_TEMPLATES.en.welcome_message, { creator_name: 'Le Club' }),
    ).toEqual({
      title: 'Welcome',
      body: 'Glad to have you in Le Club. The best first step: say hello to the community, then start the first lesson.',
    });
  });

  it('read naturally while StayPut does not know the community’s name yet', () => {
    const values = { first_name: 'Ana', buddy_name: 'Sam', offer: 'RETOUR-20' };
    expect(renderMessage(DEFAULT_TEMPLATES.fr.welcome_message, values).body).toBe(
      'Content de t’avoir. Le meilleur premier pas : présente-toi à la communauté, puis lance la première leçon.',
    );
    expect(renderMessage(DEFAULT_TEMPLATES.fr.payment_failed_notice, values).body).toBe(
      'Salut Ana, ton dernier paiement n’est pas passé. Mets à jour ton moyen de paiement pour garder ton accès : ça prend une minute.',
    );
    expect(renderMessage(DEFAULT_TEMPLATES.en.mentor_intro, values).body).toMatch(
      /^Sam just joined\. You know the way/,
    );
    for (const locale of ['en', 'fr'] as const) {
      for (const action of MESSAGE_ACTIONS) {
        const { title, body } = renderMessage(DEFAULT_TEMPLATES[locale][action], values);
        // Never a word left hanging before a full stop or a comma (French puts a space before
        // « ! » and « : », rightly).
        expect(`${title} ${body}`, `${locale} ${action}`).not.toMatch(/ [.,]|\s{2}|[a-z]$/);
      }
    }
  });
});

describe('templateProblems', () => {
  it('names unknown variables and optional parts left open', () => {
    expect(templateProblems('Hi {first_name} {firstname} {offer}')).toEqual(['{firstname}']);
    expect(templateProblems('Hi[[ {first_name}')).toEqual(['[[ ]]']);
    expect(templateProblems('Plain text.')).toEqual([]);
  });
});

describe('the writer', () => {
  it('writes from the templates; the AI writer is off', async () => {
    expect(AI_WRITER_ENABLED).toBe(false);
    expect(
      await templateWriter.write({
        action: 'exit_survey',
        locale: 'en',
        template: { title: 'Bye {first_name}', body: 'From {creator_name}' },
        values: { first_name: 'Bo', creator_name: 'X' },
      }),
    ).toEqual({ title: 'Bye Bo', body: 'From X' });
  });
});
