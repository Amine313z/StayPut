# Architecture

StayPut est **un seul Worker Cloudflare** qui sert à la fois l'interface React et l'API, devant
**une base Postgres** (Supabase), sans autre serveur. Budget : les plans gratuits de Cloudflare,
de Supabase et de GitHub.

```
  Whop                         Discord                      Telegram
  (iframe, API, webhooks)      (API REST, OAuth2)           (Bot API, webhook)
        │                            │                            │
        ▼                            ▼                            ▼
 ┌───────────────────────── Worker Cloudflare « stayput » ─────────────────────────┐
 │ fetch     : l'API Hono (apps/worker/src/app.ts) et, pour le reste, l'app React  │
 │             construite (apps/web/dist, fichiers statiques)                       │
 │ scheduled : les tâches planifiées (apps/worker/src/cron.ts, docs/jobs.md)        │
 └─────────────────────────────────────────┬───────────────────────────────────────┘
                                           │ Hyperdrive (connexions gardées ouvertes)
                                           ▼
                        Supabase Postgres, schéma « stayput » (RLS)
```

Un second Worker, `stayput-app`, sert la production avec sa propre base (`docs/production.md`).

## Le code

Un dépôt, des espaces de travail npm, TypeScript strict partout.

| Dossier               | Rôle                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`            | React 19, Vite, Tailwind 4 : la vue créateur (`/dashboard/:companyId`), la page du membre (`/experiences/:experienceId`) et la démo (`/demo`)                                                        |
| `apps/worker`         | le Worker : l'API, les webhooks, les tâches planifiées, les pages légales, le badge                                                                                                                  |
| `packages/core`       | les règles, sans entrée ni sortie : score de risque, garde-fous, heure d'envoi, offres de départ, attribution des sauvetages, rapport du lundi, nettoyage des messages d'erreur ; les types de l'API |
| `packages/whop`       | le client de l'API Whop, la vérification du jeton de l'iframe et des webhooks, l'OAuth                                                                                                               |
| `packages/i18n`       | les textes anglais et français, les formats (nombres, montants, dates)                                                                                                                               |
| `supabase/migrations` | le schéma, migration par migration ; `supabase/install.sql` les réunit (`npm run db:bundle`)                                                                                                         |
| `scripts`             | `migrate.ts` ; `deploy/` (le workflow Deploy) ; `ops/` (le workflow Inspect, les captures) ; `seed*` (le sandbox)                                                                                    |

## Une requête du tableau de bord

1. Whop affiche StayPut dans une iframe et joint à chaque requête vers l'origine de l'app le
   jeton de l'utilisateur (`x-whop-user-token`). Ce jeton ne part que vers cette origine : d'où un
   seul Worker pour l'interface et l'API.
2. `authenticate` vérifie le jeton : signature par les clés publiques de Whop, audience = l'app
   (`WHOP_APP_ID`), date. Dans le sandbox seulement, où Whop n'affiche pas les apps, une session
   « Sign in with Whop » (OAuth, cookie signé) le remplace.
3. `requireCreator` demande à Whop le niveau d'accès de l'utilisateur à la communauté : seule son
   équipe (`admin`) ouvre la vue créateur ; `requireMember` fait de même pour une expérience.
   La réponse de Whop est gardée quelques minutes.
4. Le tableau de bord lit et écrit par `withUser` : une transaction sous le rôle `stayput_user`,
   l'utilisateur en paramètre. Les politiques RLS ne lui montrent que les communautés dont il
   est de l'équipe (`company_admins`, accès vérifié auprès de Whop depuis moins d'un jour).
5. Ce qui prend du temps (la synchronisation à l'ouverture, le classement d'un envoi de Whop,
   les appels à Discord et Telegram) part après la réponse (`waitUntil`), sur sa propre connexion.
   Un bloc de l'écran n'attend jamais Discord ou Telegram plus de quelques secondes.

## Les envois de Whop (webhooks)

`POST /webhooks/whop` vérifie la signature (Standard Webhooks, secret `ws_…`), enregistre l'envoi
tel quel dans `webhook_events` (une seule fois par identifiant) et répond ; la fonction SQL
`process_webhook_event` le classe ensuite (membres, abonnements, paiements, activité). Un envoi en
échec est rejoué toutes les 10 minutes, 5 fois au plus, et à la demande depuis Réglages › État
(`docs/operations.md`). La synchronisation horaire relit de toute façon membres, abonnements et
paiements : un envoi perdu ne laisse pas de trou durable.

## Les actions

Toute action vers un membre (message, nouvelle tentative de paiement, offre, invitation) passe
par le même moteur : planifiée en SQL depuis l'état de la communauté (`plan_actions`), passée aux
garde-fous (`packages/core` : heures silencieuses, plafonds, liste « ne pas contacter », arrêt
général, mode test), approuvée par l'équipe en mode manuel, puis envoyée par l'API de Whop à son
heure (`due_actions`). Le mode test calcule tout et n'envoie rien (`simulated`). Un sauvetage
n'est compté que pour une action réellement partie, avec sa preuve (`record_saves`).

## Discord et Telegram

- **Discord** : une application avec un bot. L'équipe l'ajoute à son serveur (OAuth2,
  `/auth/discord/callback`), choisit les salons ; StayPut lit par l'API REST (sans connexion
  permanente) la liste des membres et les messages de ces salons, à chaque synchronisation.
- **Telegram** : un bot, ajouté au groupe par un lien signé. Telegram envoie les messages à
  `/webhooks/telegram` avec un secret dérivé du jeton du bot ; le Worker règle lui-même cette
  adresse. StayPut ne garde que qui a écrit, où et quand, jamais le texte.

## La démo

`/demo` est l'app React seule : un transport dans le navigateur (`apps/web/src/demo`) répond aux
mêmes routes que le Worker, avec une communauté imaginaire. Aucun appel au Worker, aucune donnée
réelle ; les liens vers l'extérieur et les envois y sont désactivés.

## Pages publiques du Worker

`/health` (l'état de la base et de la configuration), `/privacy`, `/terms`, `/dpa` (les textes
légaux, anglais et français), `/badge/:companyId.svg` et `/verify/:companyId` (le badge de
rétention vérifiée, s'il est activé). Chaque chemin servi par le Worker est listé dans
`run_worker_first` de `apps/worker/wrangler.toml` (un test le vérifie) ; tous les autres sont
l'app React.

## Sécurité

- Les secrets ne vivent que dans GitHub (secrets du dépôt) et dans le Worker (secrets
  Cloudflare) ; jamais dans le code, un fichier du dépôt ou un journal (`docs/environment.md`).
- Le schéma `stayput` n'est pas exposé par l'API publique de Supabase : aucun droit pour `anon`,
  `authenticated` ni `service_role`. RLS sur chaque table ; les tables du Worker seul n'ont pas de
  politique (`docs/data-schema.md`).
- Une communauté ne voit jamais celle d'une autre : RLS, et chaque route vérifie l'accès auprès
  de Whop.
- Les messages d'erreur sont nettoyés avant d'être gardés (`scrubErrorMessage` : ni e-mail, ni
  identifiant de personne, ni téléphone, ni clé).
- StayPut ne lit ni e-mail ni téléphone des membres (SPEC 8.2) ; l'activité détaillée est gardée
  12 mois, les données d'une communauté désinstallée 30 jours.

## Contraintes du plan gratuit de Cloudflare

Une exécution du Worker a 50 sous-requêtes : la synchronisation avec Whop avance par tranches,
toutes les 10 minutes, en commençant par les communautés qui attendent depuis le plus longtemps,
pour que chacune soit relue chaque heure. Les choix qui en découlent sont dans `DECISIONS.md`.
