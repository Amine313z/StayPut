import type { TemplateLocale } from '@stayput/core';
import { escape } from './public-proof';

/**
 * StayPut's legal pages (SPEC Phase 8.1): the privacy policy, the terms of service and the data
 * processing agreement, in English and French. Drafts, to be reviewed before StayPut goes live:
 * each page says so. Plain HTML from the Worker, no script, as the proof and badge pages.
 */

export type LegalDocument = 'privacy' | 'terms' | 'dpa';

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = ['privacy', 'terms', 'dpa'];

/** The day the drafts last changed. */
export const LEGAL_UPDATED = '2026-10-05';

/**
 * Who runs StayPut: to be filled in by the founder before going live. Until then, the pages show
 * what is missing, in brackets.
 */
const OPERATOR: Readonly<Record<'name' | 'address' | 'email' | 'law', string | null>> = {
  name: null,
  address: null,
  email: null,
  law: null,
};

const MISSING: Readonly<Record<TemplateLocale, Record<keyof typeof OPERATOR, string>>> = {
  en: {
    name: '[operator’s legal name: to be completed]',
    address: '[registered address: to be completed]',
    email: '[contact e-mail: to be completed]',
    law: '[governing law and courts: to be completed]',
  },
  fr: {
    name: '[raison sociale de l’éditeur : à compléter]',
    address: '[adresse du siège : à compléter]',
    email: '[e-mail de contact : à compléter]',
    law: '[droit applicable et tribunaux : à compléter]',
  },
};

function operator(locale: TemplateLocale, key: keyof typeof OPERATOR): string {
  return OPERATOR[key] ?? MISSING[locale][key];
}

/** A section: a title, then paragraphs; a list of items is an array. */
interface Section {
  title: string;
  body: (string | readonly string[])[];
}

interface Text {
  title: string;
  summary: string;
  sections: Section[];
}

const UI: Readonly<
  Record<
    TemplateLocale,
    { draft: string; updated: string; other: string; names: Record<LegalDocument, string> }
  >
> = {
  en: {
    draft: 'Draft, being reviewed: it may still change before StayPut goes live.',
    updated: 'Last updated:',
    other: 'Français',
    names: {
      privacy: 'Privacy policy',
      terms: 'Terms of service',
      dpa: 'Data processing agreement',
    },
  },
  fr: {
    draft: 'Brouillon en cours de relecture : il peut encore changer avant le lancement.',
    updated: 'Dernière mise à jour\u00a0:',
    other: 'English',
    names: {
      privacy: 'Politique de confidentialité',
      terms: 'Conditions d’utilisation',
      dpa: 'Accord de traitement des données',
    },
  },
};

function texts(locale: TemplateLocale): Record<LegalDocument, Text> {
  const name = operator(locale, 'name');
  const address = operator(locale, 'address');
  const email = operator(locale, 'email');
  const law = operator(locale, 'law');
  if (locale === 'fr') {
    return {
      privacy: {
        title: 'Politique de confidentialité',
        summary:
          'StayPut est une app que les créateurs installent dans leur communauté Whop pour garder leurs membres. Cette politique dit ce que StayPut traite, pourquoi, combien de temps, et vos droits. Elle vaut pour les créateurs qui installent StayPut et leurs équipes, et pour les membres de leurs communautés.',
        sections: [
          {
            title: 'Qui sommes-nous',
            body: [
              `StayPut est édité par ${name}, ${address} (« nous »). Contact : ${email}.`,
              'Pour les données des membres d’une communauté, c’est le créateur qui a installé StayPut qui décide pourquoi et comment elles servent : il est responsable du traitement, et nous les traitons pour son compte, comme sous-traitant (voir l’accord de traitement des données). Pour les données de compte des créateurs eux-mêmes (qui, dans leur équipe, a ouvert StayPut), nous sommes responsables du traitement.',
            ],
          },
          {
            title: 'Ce que StayPut traite',
            body: [
              [
                'De Whop, pour chaque membre d’une communauté où StayPut est installé : ses identifiants Whop, son nom affiché et son pseudo, son rôle, sa date d’arrivée et son statut ; ses abonnements (produit, offre, prix, dates de renouvellement et d’annulation, statut) ; ses paiements (montant, devise, statut, motif d’un échec, dates) ; son activité dans la communauté (le type d’action, qui, quand : un message envoyé, une leçon terminée).',
                'Jamais : les adresses e-mail, les numéros de téléphone, le contenu des messages, ni les autres champs personnels que Whop peut envoyer. Ils sont retirés avant que quoi que ce soit soit gardé.',
                'Si le créateur connecte Discord ou Telegram : les identifiants de compte, noms affichés et pseudos, et qui a été actif, où et quand, jamais ce qui a été écrit.',
                'Ce que les membres disent eux-mêmes à StayPut : leur réponse au questionnaire de départ (une raison et, s’ils le veulent, un commentaire) et l’offre choisie. Si le créateur active l’espace membre : leurs objectifs et résultats ; une capture d’écran qui appuie un résultat est lue dans le navigateur du membre et n’est jamais envoyée : seuls son empreinte (SHA-256) et les nombres lus sont gardés.',
                'Ce que StayPut calcule : un score de risque par membre et ses raisons, les actions qu’il propose ou mène (messages envoyés par Whop, pauses, offres) et leur résultat, dont l’argent sauvé.',
                'Pour chaque membre de l’équipe qui ouvre StayPut : son identifiant Whop et la date de sa dernière ouverture.',
              ],
            ],
          },
          {
            title: 'Pourquoi, et sur quelle base',
            body: [
              [
                'Rendre le service que le créateur a installé : repérer les membres à risque, agir dans les limites qu’il a fixées, mesurer ce qui a été sauvé (exécution du contrat avec le créateur ; pour les membres, l’intérêt légitime du créateur à garder sa communauté, et celui des membres à ne pas perdre leur accès, par exemple après un paiement refusé).',
                'Garder StayPut sûr et en état de marche (intérêt légitime).',
                'Les benchmarks anonymes : seulement si le créateur l’accepte ; seulement des moyennes d’au moins 5 communautés, jamais les chiffres d’une communauté ni les données de quelqu’un.',
              ],
              'Pas de publicité, pas de vente de données, aucun profilage au-delà du score de risque montré au créateur, aucune décision automatique produisant des effets juridiques : les actions suivent les règles du créateur et peuvent être arrêtées à tout moment.',
            ],
          },
          {
            title: 'Qui reçoit les données',
            body: [
              'Whop (la plateforme ; les messages et notifications partent par Whop), Cloudflare (l’hébergement du serveur de StayPut), Supabase (la base de données) et, seulement si le créateur les connecte, Discord et Telegram. Chacun les traite selon ses propres conditions et engagements de sécurité.',
              'Personne d’autre, sauf obligation légale.',
            ],
          },
          {
            title: 'Combien de temps',
            body: [
              [
                'L’activité détaillée : 12 mois, puis seulement ses comptes par jour.',
                'Les envois de Whop (webhooks) : 7 jours une fois traités, 30 jours au plus.',
                'Tout le reste : tant que StayPut est installé. Une fois désinstallé, toutes les données de la communauté sont supprimées 30 jours plus tard. Le créateur peut tout supprimer à tout moment (Réglages › Général › Vos données).',
                'Les données d’un membre supprimées à la demande du créateur : supprimées aussitôt ; il ne reste qu’une empreinte de ses identifiants, pour que StayPut ne le reprenne jamais.',
              ],
            ],
          },
          {
            title: 'Vos droits',
            body: [
              `Membres : vous pouvez demander une copie de vos données, leur correction ou leur suppression, ou vous opposer à leur usage : adressez-vous au créateur de votre communauté (il peut exporter ou supprimer vos données depuis StayPut), ou à nous : ${email}. Vous pouvez aussi demander au créateur que StayPut ne vous contacte jamais (« Ne pas contacter »).`,
              'Créateurs : exportez ou supprimez toutes les données de votre communauté dans Réglages › Général.',
              'Vous pouvez saisir l’autorité de protection des données de votre pays (en France, la CNIL).',
            ],
          },
          {
            title: 'Sécurité',
            body: [
              'Les données sont chiffrées en transit ; chaque équipe ne lit que les données de sa communauté (la base de données l’impose) ; les secrets ne sont jamais dans le code ; le serveur de StayPut ne garde que ce dont il a besoin.',
            ],
          },
          {
            title: 'Où',
            body: [
              'Nos prestataires peuvent traiter des données hors de l’Espace économique européen ; ces transferts reposent sur les garanties qu’ils offrent (comme les clauses contractuelles types de la Commission européenne).',
            ],
          },
          {
            title: 'Cookies et stockage',
            body: [
              'StayPut n’utilise aucun cookie de publicité ou de suivi. Votre navigateur garde quelques préférences sur votre appareil (la langue, ce que le guide a montré). Hors de Whop, la connexion pose un cookie de session.',
            ],
          },
          {
            title: 'Changements',
            body: [
              'StayPut dira dans l’app quand cette politique change, avec la date de la nouvelle version.',
            ],
          },
        ],
      },
      terms: {
        title: 'Conditions d’utilisation',
        summary:
          'Ces conditions régissent l’usage de StayPut par les créateurs qui l’installent dans leur communauté Whop, et par leurs équipes.',
        sections: [
          {
            title: 'Le service',
            body: [
              'StayPut aide les créateurs à garder leurs membres : il repère les membres qui risquent de partir, mène des actions (messages, relances de paiement, offres) dans les règles fixées par le créateur, et rend compte de ce qui a été sauvé.',
            ],
          },
          {
            title: 'Qui peut l’utiliser',
            body: [
              'Les créateurs qui installent StayPut dans leur entreprise Whop, et leur équipe, dans le respect des conditions de Whop. L’accès passe par Whop ; le créateur gère son équipe sur Whop et répond de ce qui est fait depuis son compte.',
            ],
          },
          {
            title: 'Offres et paiement',
            body: [
              'Les offres et leurs prix sont affichés sur la page de StayPut sur Whop ; le paiement passe par Whop.',
            ],
          },
          {
            title: 'Les engagements du créateur',
            body: [
              [
                'Disposer d’une base légale pour les données de ses membres : StayPut les traite pour son compte (voir l’accord de traitement des données).',
                'Répondre des messages et offres qu’il active ou écrit.',
                'Respecter les conditions de Whop, et de Discord et Telegram s’il les connecte.',
                'Ne pas utiliser StayPut pour envoyer des messages non sollicités ou quoi que ce soit d’illicite.',
              ],
            ],
          },
          {
            title: 'Les actions automatiques',
            body: [
              'En mode automatique, StayPut agit dans les limites réglées : plafonds de fréquence, heures de silence, liste « Ne pas contacter », mode test. Le créateur peut passer en mode manuel, en mode test ou tout arrêter à tout moment.',
            ],
          },
          {
            title: 'Les chiffres',
            body: [
              'Les scores de risque, les prévisions et « l’argent sauvé » sont des estimations calculées selon des règles affichées. StayPut ne garantit aucun résultat.',
            ],
          },
          {
            title: 'Disponibilité',
            body: [
              'Nous faisons en sorte que StayPut fonctionne en continu sans pouvoir le garantir ; des fonctions peuvent évoluer, une maintenance peut l’interrompre.',
            ],
          },
          {
            title: 'Les données',
            body: [
              'La politique de confidentialité et l’accord de traitement des données s’appliquent. Le créateur peut exporter ou supprimer ses données à tout moment ; une fois StayPut désinstallé, elles sont supprimées 30 jours plus tard.',
            ],
          },
          {
            title: 'Propriété intellectuelle',
            body: [
              'StayPut reste notre propriété ; le contenu et les données du créateur restent les siens. Nous n’utilisons des agrégats anonymes que comme décrit (les benchmarks, sur accord).',
            ],
          },
          {
            title: 'Responsabilité',
            body: [
              'Dans la mesure permise par la loi, StayPut est fourni en l’état ; notre responsabilité est limitée aux sommes payées pour StayPut dans les 12 mois précédant la réclamation ; nous ne répondons ni des pertes indirectes, ni des services de Whop, Discord ou Telegram.',
            ],
          },
          {
            title: 'Fin',
            body: [
              'Le créateur peut désinstaller StayPut à tout moment. Nous pouvons suspendre l’accès en cas de manquement grave à ces conditions.',
            ],
          },
          {
            title: 'Droit applicable',
            body: [`${law}, sous réserve des protections légales impératives.`],
          },
          { title: 'Contact', body: [`${name}, ${address}. ${email}.`] },
        ],
      },
      dpa: {
        title: 'Accord de traitement des données',
        summary:
          'Cet accord (article 28 du RGPD) fait partie des conditions d’utilisation. Il encadre les données des membres que StayPut traite pour le compte du créateur.',
        sections: [
          {
            title: 'Les parties',
            body: [
              `Le créateur qui installe StayPut est responsable du traitement ; ${name} est sous-traitant.`,
            ],
          },
          {
            title: 'Objet et durée',
            body: [
              'Le traitement nécessaire au service de StayPut, tant que StayPut est installé, puis 30 jours le temps de la suppression.',
            ],
          },
          {
            title: 'Nature et finalités',
            body: [
              'Conservation ; analyse (score de risque) ; envoi de messages et d’offres par Whop sur les instructions du créateur (ses réglages et les actions qu’il valide) ; comptes rendus.',
            ],
          },
          {
            title: 'Personnes et données concernées',
            body: [
              'Les membres de la communauté du créateur et les membres de son équipe ; les catégories de données décrites dans la politique de confidentialité (« Ce que StayPut traite »). Aucune donnée sensible n’est attendue : le créateur n’en met pas dans ses modèles de messages.',
            ],
          },
          {
            title: 'Les engagements du sous-traitant',
            body: [
              [
                'Ne traiter les données que sur les instructions documentées du créateur : ses réglages et les actions qu’il choisit.',
                'Faire respecter la confidentialité par les personnes autorisées à les traiter.',
                'Prendre les mesures de sécurité décrites dans la politique de confidentialité.',
                'Aider le créateur à répondre aux demandes des personnes : StayPut lui donne l’export et la suppression des données d’un membre.',
                'Lui notifier toute violation de données dans les meilleurs délais, au plus tard 48 heures après en avoir eu connaissance, et l’aider dans ses propres obligations.',
                'Supprimer les données à la fin : 30 jours après la désinstallation, ou aussitôt sur demande.',
                'Mettre à sa disposition les informations nécessaires pour démontrer le respect de ces engagements.',
              ],
            ],
          },
          {
            title: 'Sous-traitants ultérieurs',
            body: [
              'Whop (la plateforme), Cloudflare (l’hébergement), Supabase (la base de données) et, s’ils sont connectés, Discord et Telegram. Le créateur les autorise ; tout changement est annoncé dans StayPut 30 jours à l’avance, et le créateur qui s’y oppose peut désinstaller StayPut.',
            ],
          },
          {
            title: 'Transferts hors de l’Union',
            body: [
              'Ils reposent sur une décision d’adéquation ou sur les clauses contractuelles types de la Commission européenne.',
            ],
          },
          {
            title: 'Responsabilité et droit applicable',
            body: ['Ceux des conditions d’utilisation.'],
          },
        ],
      },
    };
  }
  return {
    privacy: {
      title: 'Privacy policy',
      summary:
        'StayPut is an app creators install in their Whop community to keep their members. This policy says what StayPut processes, why, for how long, and your rights. It applies to the creators who install StayPut and their teams, and to the members of their communities.',
      sections: [
        {
          title: 'Who we are',
          body: [
            `StayPut is operated by ${name}, ${address} (“we”). Contact: ${email}.`,
            'For the data of a community’s members, the creator who installed StayPut decides why and how it is used: they are the controller, and we process it on their behalf as their processor (see the data processing agreement). For the creators’ own account data (who on their team opened StayPut), we are the controller.',
          ],
        },
        {
          title: 'What StayPut processes',
          body: [
            [
              'From Whop, for each member of a community where StayPut is installed: their Whop identifiers, display name and username, role, join date and status; their memberships (product, plan, price, renewal and cancellation dates, status); their payments (amount, currency, status, why one failed, dates); their activity in the community (the kind of action, who, when: a message sent, a lesson completed).',
              'Never: e-mail addresses, phone numbers, the content of messages, or the other personal fields Whop may send. They are removed before anything is kept.',
              'If the creator connects Discord or Telegram: account identifiers, display names and usernames, and who was active, where and when, never what was written.',
              'What members tell StayPut themselves: their answer to the departure survey (a reason and, if they wish, a comment) and the offer they chose. If the creator turns on the member space: their goals and results; a screenshot backing a result is read in the member’s own browser and never uploaded: only its fingerprint (SHA-256) and the numbers read are kept.',
              'What StayPut computes: a risk score for each member and its reasons, the actions it proposes or takes (messages sent through Whop, pauses, offers) and what came of them, including the revenue saved.',
              'For each team member who opens StayPut: their Whop identifier and when they last opened it.',
            ],
          ],
        },
        {
          title: 'Why, and on what basis',
          body: [
            [
              'To provide the service the creator installed: find the members at risk, act within the limits they set, measure what was saved (performing the contract with the creator; for members, the creator’s legitimate interest in keeping their community, and the members’ own interest in not losing their access, after a failed payment for instance).',
              'To keep StayPut safe and working (legitimate interest).',
              'The anonymous benchmarks: only if the creator agrees; only averages over at least 5 communities, never a community’s own figures or anyone’s data.',
            ],
            'No advertising, no sale of data, no profiling beyond the risk score shown to the creator, no automated decision with legal effects: actions follow the creator’s rules and can be stopped at any time.',
          ],
        },
        {
          title: 'Who receives data',
          body: [
            'Whop (the platform; messages and notifications go out through Whop), Cloudflare (hosting StayPut’s server), Supabase (the database) and, only if the creator connects them, Discord and Telegram. Each processes data under its own terms and security commitments.',
            'Nobody else, unless the law requires it.',
          ],
        },
        {
          title: 'For how long',
          body: [
            [
              'Detailed activity: 12 months, then only its daily counts.',
              'Whop’s deliveries (webhooks): 7 days once processed, 30 days at most.',
              'Everything else: for as long as StayPut is installed. Once it is uninstalled, all of the community’s data is deleted 30 days later. The creator can delete everything at any time (Settings › General › Your data).',
              'A member’s data deleted at the creator’s request: deleted at once; only a fingerprint of their identifiers remains, so that StayPut never takes them in again.',
            ],
          ],
        },
        {
          title: 'Your rights',
          body: [
            `Members: you can ask for a copy of your data, to correct or delete it, or object to its use: ask the creator of your community (they can export or delete your data from StayPut), or us at ${email}. You can also ask the creator that StayPut never contacts you (“Do not contact”).`,
            'Creators: export or delete all of your community’s data in Settings › General.',
            'You can complain to your data protection authority (in France, the CNIL).',
          ],
        },
        {
          title: 'Security',
          body: [
            'Data is encrypted in transit; each team reads only its own community’s data (the database enforces it); secrets are never in the code; StayPut’s server keeps only what it needs.',
          ],
        },
        {
          title: 'Where',
          body: [
            'Our providers may process data outside the European Economic Area; such transfers rely on the safeguards they offer (such as the European Commission’s standard contractual clauses).',
          ],
        },
        {
          title: 'Cookies and storage',
          body: [
            'StayPut uses no advertising or tracking cookies. Your browser keeps a few preferences on your device (the language, what the guide has shown). Outside Whop, signing in sets one session cookie.',
          ],
        },
        {
          title: 'Changes',
          body: [
            'StayPut will say in the app when this policy changes, with the new version’s date.',
          ],
        },
      ],
    },
    terms: {
      title: 'Terms of service',
      summary:
        'These terms govern the use of StayPut by the creators who install it in their Whop community, and by their teams.',
      sections: [
        {
          title: 'The service',
          body: [
            'StayPut helps creators keep their members: it finds the members likely to leave, takes actions (messages, payment reminders, offers) within the rules the creator sets, and reports what was saved.',
          ],
        },
        {
          title: 'Who may use it',
          body: [
            'The creators who install StayPut in their Whop company, and their team, in keeping with Whop’s terms. Access goes through Whop; the creator manages their team on Whop and answers for what is done from their account.',
          ],
        },
        {
          title: 'Plans and payment',
          body: [
            'The plans and their prices are shown on StayPut’s page on Whop; payment goes through Whop.',
          ],
        },
        {
          title: 'The creator’s commitments',
          body: [
            [
              'Have a lawful basis for their members’ data: StayPut processes it on their behalf (see the data processing agreement).',
              'Answer for the messages and offers they turn on or write.',
              'Follow Whop’s terms, and Discord’s and Telegram’s if they connect them.',
              'Never use StayPut to send unsolicited messages or anything unlawful.',
            ],
          ],
        },
        {
          title: 'Automatic actions',
          body: [
            'In automatic mode, StayPut acts within the limits set: frequency caps, quiet hours, the “Do not contact” list, test mode. The creator can switch to manual mode or test mode, or stop everything, at any time.',
          ],
        },
        {
          title: 'The figures',
          body: [
            'Risk scores, forecasts and “revenue saved” are estimates computed by stated rules. StayPut guarantees no result.',
          ],
        },
        {
          title: 'Availability',
          body: [
            'We work for StayPut to run continuously but cannot guarantee it; features may change, and maintenance may interrupt it.',
          ],
        },
        {
          title: 'Data',
          body: [
            'The privacy policy and the data processing agreement apply. The creator can export or delete their data at any time; once StayPut is uninstalled, it is deleted 30 days later.',
          ],
        },
        {
          title: 'Intellectual property',
          body: [
            'StayPut remains ours; the creator’s content and data remain theirs. We use anonymous aggregates only as described (the benchmarks, with consent).',
          ],
        },
        {
          title: 'Liability',
          body: [
            'As far as the law allows, StayPut is provided as is; our liability is limited to the amounts paid for StayPut in the 12 months before the claim; we answer neither for indirect losses nor for Whop’s, Discord’s or Telegram’s services.',
          ],
        },
        {
          title: 'Ending',
          body: [
            'The creator can uninstall StayPut at any time. We may suspend access after a serious breach of these terms.',
          ],
        },
        { title: 'Governing law', body: [`${law}, subject to mandatory legal protections.`] },
        { title: 'Contact', body: [`${name}, ${address}. ${email}.`] },
      ],
    },
    dpa: {
      title: 'Data processing agreement',
      summary:
        'This agreement (article 28 of the GDPR) is part of the terms of service. It governs the members’ data StayPut processes on the creator’s behalf.',
      sections: [
        {
          title: 'The parties',
          body: [`The creator who installs StayPut is the controller; ${name} is the processor.`],
        },
        {
          title: 'Subject and duration',
          body: [
            'The processing StayPut’s service needs, for as long as StayPut is installed, then 30 days for the deletion.',
          ],
        },
        {
          title: 'Nature and purposes',
          body: [
            'Storage; analysis (the risk score); sending messages and offers through Whop on the creator’s instructions (their settings and the actions they approve); reporting.',
          ],
        },
        {
          title: 'People and data concerned',
          body: [
            'The members of the creator’s community and the members of their team; the categories of data the privacy policy describes (“What StayPut processes”). No sensitive data is expected: the creator puts none in their message templates.',
          ],
        },
        {
          title: 'The processor’s commitments',
          body: [
            [
              'Process the data only on the creator’s documented instructions: their settings and the actions they choose.',
              'Bind the people allowed to process it to confidentiality.',
              'Take the security measures the privacy policy describes.',
              'Help the creator answer people’s requests: StayPut gives them the export and the deletion of a member’s data.',
              'Notify them of any personal data breach without undue delay, at most 48 hours after becoming aware of it, and help them with their own obligations.',
              'Delete the data at the end: 30 days after the uninstall, or at once on request.',
              'Make available to them the information needed to show these commitments are kept.',
            ],
          ],
        },
        {
          title: 'Sub-processors',
          body: [
            'Whop (the platform), Cloudflare (hosting), Supabase (the database) and, if connected, Discord and Telegram. The creator authorizes them; any change is announced in StayPut 30 days ahead, and a creator who objects may uninstall StayPut.',
          ],
        },
        {
          title: 'Transfers outside the Union',
          body: [
            'They rely on an adequacy decision or on the European Commission’s standard contractual clauses.',
          ],
        },
        {
          title: 'Liability and governing law',
          body: ['Those of the terms of service.'],
        },
      ],
    },
  };
}

const STYLE = [
  ':root{color-scheme:light dark;--bg:#f6f7f5;--card:#fff;--fg:#111a17;--muted:#56625d;',
  '--accent:#0f7a5c;--line:#dfe4e1}',
  '@media (prefers-color-scheme:dark){:root{--bg:#0d1412;--card:#152019;--fg:#eef3f0;',
  '--muted:#a3b2ab;--accent:#4fd1a5;--line:#26332d}}',
  '*{box-sizing:border-box}',
  'body{margin:0;padding:24px;background:var(--bg);color:var(--fg);',
  'font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}',
  'main{max-width:760px;margin:0 auto;background:var(--card);border:1px solid var(--line);',
  'border-radius:20px;padding:32px}',
  'nav{display:flex;flex-wrap:wrap;gap:8px 16px;margin:0 0 20px;font-size:14px}',
  'nav a{color:var(--muted)}nav a[aria-current]{color:var(--fg);font-weight:600}',
  'a{color:var(--accent)}',
  '.draft{margin:0 0 20px;padding:10px 14px;border:1px solid var(--line);border-radius:12px;',
  'color:var(--muted);font-size:14px}',
  'h1{margin:0 0 6px;font-size:28px;line-height:1.25}',
  '.updated{margin:0 0 20px;color:var(--muted);font-size:14px}',
  'h2{margin:28px 0 8px;font-size:18px}',
  'p,li{margin:0 0 10px}ul{padding-left:22px;margin:0 0 10px}',
  '@media (max-width:480px){body{padding:12px}main{padding:20px}h1{font-size:23px}}',
].join('');

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A legal page, in its language: the draft notice, the three documents, the other language. */
export async function legalPage(
  document: LegalDocument,
  locale: TemplateLocale,
): Promise<Response> {
  const text = texts(locale)[document];
  const ui = UI[locale];
  const other: TemplateLocale = locale === 'fr' ? 'en' : 'fr';
  const updated = new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${LEGAL_UPDATED}T12:00:00Z`));
  const nav = [
    ...LEGAL_DOCUMENTS.map(
      (d) =>
        `<a href="/${d}?lang=${locale}"${d === document ? ' aria-current="page"' : ''}>${escape(ui.names[d])}</a>`,
    ),
    `<a href="/${document}?lang=${other}" hreflang="${other}" lang="${other}">${escape(ui.other)}</a>`,
  ].join('');
  const sections = text.sections
    .map((section) => {
      const body = section.body
        .map((part) =>
          typeof part === 'string'
            ? `<p>${escape(part)}</p>`
            : `<ul>${part.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>`,
        )
        .join('');
      return `<h2>${escape(section.title)}</h2>${body}`;
    })
    .join('');
  const html = [
    '<!doctype html>',
    `<html lang="${locale}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(`${text.title} · StayPut`)}</title>`,
    `<meta name="description" content="${escape(text.summary)}">`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body><main>',
    `<nav aria-label="StayPut">${nav}</nav>`,
    `<p class="draft">${escape(ui.draft)}</p>`,
    `<h1>${escape(text.title)}</h1>`,
    `<p class="updated">${escape(`${ui.updated} ${updated}`)}</p>`,
    `<p>${escape(text.summary)}</p>`,
    sections,
    '</main></body>',
    '</html>',
  ].join('\n');
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      // Without `?lang=`, the browser's language chose the page.
      Vary: 'Accept-Language',
      'Content-Security-Policy':
        `default-src 'none'; style-src 'sha256-${await sha256Base64(STYLE)}'; ` +
        "base-uri 'none'; form-action 'none'",
    },
  });
}

/** The language a legal page opens in: the one asked (`?lang=`), else the browser's, else English. */
export function legalLocale(lang: string | undefined, acceptLanguage: string): TemplateLocale {
  if (lang === 'fr' || lang === 'en') return lang;
  return /^fr\b/i.test(acceptLanguage) ? 'fr' : 'en';
}
