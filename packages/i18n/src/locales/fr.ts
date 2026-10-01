import type { Messages } from './en';

/** French: typed on the English keys, so a missing or extra key does not compile. */
export const fr: Messages = {
  'app.name': 'StayPut',
  'app.tagline': 'Gardez vos membres, et voyez les revenus que vous avez sauvés.',

  'common.loading': 'Chargement…',
  'common.retry': 'Réessayer',
  'common.backHome': "Retour à l'accueil",

  'settings.language': 'Langue',
  'settings.theme': 'Thème',
  'settings.theme.system': 'Automatique',
  'settings.theme.light': 'Clair',
  'settings.theme.dark': 'Sombre',

  'home.title': 'La rétention pour les communautés Whop',
  'home.body':
    'Ouvrez StayPut depuis votre tableau de bord Whop ou depuis votre communauté pour commencer.',

  'creator.title': 'Tableau de bord de rétention',
  'creator.connected': "Connecté en tant que membre de l'équipe de {companyId}.",
  'creator.setup.title': 'StayPut se prépare',
  'creator.setup.body':
    'Vos membres, vos paiements et les scores de risque apparaîtront ici après la première synchronisation.',

  'member.title': 'Votre espace de progression',
  'member.welcome': 'Bienvenue ! Bientôt, vous fixerez ici un objectif et suivrez vos progrès.',

  'members.count.one': '{count} membre',
  'members.count.other': '{count} membres',

  'error.title': 'Un obstacle',
  'error.unauthenticated': 'Ouvrez StayPut depuis Whop pour vous connecter.',
  'error.unauthenticated.login':
    'Vous avez ouvert StayPut hors de Whop : connectez-vous avec votre compte Whop pour continuer.',
  'error.forbidden.creator': "Seule l'équipe de cette communauté peut ouvrir ce tableau de bord.",
  'error.forbidden.member': "Vous n'avez pas accès à cet espace.",
  'error.invalid_request': "Ce lien n'a pas l'air correct.",
  'error.not_found': "Nous n'avons pas trouvé ce que vous cherchiez.",
  'error.payload_too_large': 'Cette demande est trop volumineuse.',
  'error.whop_unavailable': 'Whop ne répond pas pour le moment. Réessayez dans une minute.',
  'error.not_configured': 'StayPut est encore en cours de configuration. Réessayez plus tard.',
  'error.internal': 'Un problème est survenu de notre côté. Réessayez dans une minute.',
  'error.network': 'Pas de connexion. Vérifiez votre réseau et réessayez.',

  'auth.signIn': 'Se connecter avec Whop',
  'auth.failed': "La connexion avec Whop n'a pas abouti. Réessayez.",
  'auth.signOut': 'Se déconnecter',

  'notFound.title': 'Page introuvable',
};
