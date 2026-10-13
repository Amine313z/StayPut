/**
 * The message to whoever installs StayPut (decision of 2026-10-13), sent once per community at
 * its first opening: in the support chat of StayPut's own community, from where the founder
 * answers, or, when Whop will not open that chat, as a Whop notification to the community's team.
 */
export type InstallMessageLocale = 'en' | 'fr';

/** A name as the chat shows it: no Markdown of its own, 60 characters at most. */
function plainName(name: string | null | undefined): string | null {
  const plain = (name ?? '')
    .replace(/[*_`~[\]()<>#|\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain ? plain.slice(0, 60) : null;
}

/** The support chat's message (Markdown), to the person who installed StayPut. */
export function installChatMessage(
  locale: InstallMessageLocale,
  name: string | null | undefined,
): string {
  const who = plainName(name);
  if (locale === 'fr') {
    return [
      `${who ? `Bonjour ${who}` : 'Bonjour'} 👋 Merci d’avoir installé **StayPut** !`,
      'StayPut surveille maintenant votre communauté : qui est sur le point de partir, pourquoi, et quoi faire pour le garder.',
      [
        'Pour en tirer le meilleur :',
        '1. Connectez Discord ou Telegram dans **Intégrations**',
        '2. Choisissez le mode manuel ou automatique dans **Automatisations**',
        '3. Ouvrez **Membres** pour voir qui risque de partir',
      ].join('\n'),
      'Une question, un bug, une idée ? Répondez ici, je lis chaque message.',
    ].join('\n\n');
  }
  return [
    `${who ? `Hey ${who}` : 'Hey there'} 👋 Thanks for installing **StayPut**!`,
    'StayPut now watches your community: who is about to leave, why, and what to do to keep them.',
    [
      'To get the most out of it:',
      '1. Connect Discord or Telegram in **Integrations**',
      '2. Choose manual or automatic in **Automations**',
      '3. Open **Members** to see who is at risk',
    ].join('\n'),
    'Questions, bugs or ideas? Reply right here, I read every message.',
  ].join('\n\n');
}

/** The notification to the community's team, when the support chat could not be opened. */
export function installNotification(locale: InstallMessageLocale): {
  title: string;
  content: string;
} {
  return locale === 'fr'
    ? {
        title: 'Bienvenue sur StayPut',
        content:
          'StayPut surveille maintenant votre communauté. Pour commencer : connectez Discord ou Telegram dans Intégrations, choisissez le mode manuel ou automatique dans Automatisations, puis ouvrez Membres pour voir qui risque de partir.',
      }
    : {
        title: 'Welcome to StayPut',
        content:
          'StayPut now watches your community. To start: connect Discord or Telegram in Integrations, choose manual or automatic in Automations, then open Members to see who is at risk.',
      };
}
