/**
 * English, the reference: every key exists here first. `{name}` is a value filled in at
 * display time; `.one` / `.other` pairs are plural forms (Intl.PluralRules categories).
 */
export const en = {
  'app.name': 'StayPut',
  'app.tagline': 'Keep your members, and see the revenue you saved.',

  'common.loading': 'Loading…',
  'common.retry': 'Try again',
  'common.backHome': 'Back to the home page',

  'settings.language': 'Language',
  'settings.theme': 'Theme',
  'settings.theme.system': 'Automatic',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',

  'home.title': 'Retention for Whop communities',
  'home.body': 'Open StayPut from your Whop dashboard or from your community to get started.',

  'creator.title': 'Retention dashboard',
  'creator.connected': 'Connected as a team member of {companyId}.',
  'creator.setup.title': 'StayPut is getting ready',
  'creator.setup.body':
    'Your members, payments and risk scores will appear here after the first synchronization.',

  'member.title': 'Your progress space',
  'member.welcome': 'Welcome! Soon you will set a goal here and follow your progress.',

  'members.count.one': '{count} member',
  'members.count.other': '{count} members',

  'error.title': 'Something is in the way',
  'error.unauthenticated': 'Open StayPut from Whop to sign in.',
  'error.unauthenticated.login':
    'You opened StayPut outside Whop: sign in with your Whop account to continue.',
  'error.forbidden.creator': 'Only the team of this community can open this dashboard.',
  'error.forbidden.member': 'You do not have access to this space.',
  'error.invalid_request': 'This link does not look right.',
  'error.not_found': 'We could not find what you were looking for.',
  'error.payload_too_large': 'This request is too large.',
  'error.whop_unavailable': 'Whop is not answering right now. Try again in a minute.',
  'error.not_configured': 'StayPut is still being set up. Try again later.',
  'error.internal': 'Something went wrong on our side. Try again in a minute.',
  'error.network': 'No connection. Check your network and try again.',

  'auth.signIn': 'Sign in with Whop',
  'auth.failed': 'Signing in with Whop did not work. Try again.',
  'auth.signOut': 'Sign out',

  'notFound.title': 'Page not found',
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
