# Passage en production

StayPut tourne aujourd'hui sur le **sandbox** de Whop. La production est un **second
déploiement**, à côté du sandbox qui reste pour les essais :

|                      | Sandbox (aujourd'hui)                            | Production                                                       |
| -------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| Worker Cloudflare    | `stayput`                                        | `stayput-app`                                                    |
| Adresse              | `https://stayput.chezbenz18.workers.dev`         | `https://stayput-app.chezbenz18.workers.dev`                     |
| App Whop             | `app_rjFkp2xKgjfPxY` (sandbox.whop.com)          | une nouvelle app, sur whop.com                                   |
| Base de données      | le projet Supabase actuel                        | un **nouveau** projet Supabase (gratuit)                         |
| Hyperdrive           | `stayput-db`                                     | `stayput-db-production` (créé au premier déploiement)            |
| Secrets et variables | ceux du dépôt, sous leur nom (`SUPABASE_DB_URL`) | les mêmes, préfixés `PRODUCTION_` (`PRODUCTION_SUPABASE_DB_URL`) |
| Déployer             | Actions → Deploy → Run workflow → `sandbox`      | Actions → Deploy → Run workflow → `production`                   |

Rien n'est dans le code : chaque valeur se range dans GitHub. Les secrets ne passent jamais par
un message, un fichier du dépôt ou un journal.

**Deux garde-fous**, pour qu'une erreur de copie ne mélange jamais les deux :

- La production lit **ses propres** réglages, `PRODUCTION_…`. S'il en manque un, le déploiement
  s'arrête et le nomme : il ne prend jamais à sa place la valeur du sandbox.
- **Une base, un déploiement.** Le premier déploiement qui migre une base la réserve (table
  `stayput.app_settings`, migration 0043). Si la production reçoit par erreur l'adresse de la base
  du sandbox, ou l'inverse, elle s'arrête avant toute migration et rien n'est modifié.

## 1. Supabase : la base de production

1. [supabase.com](https://supabase.com) → **New project** : nom `stayput-production`, région
   Europe (la même que le sandbox), un mot de passe fort (gardé dans un gestionnaire de mots de
   passe, nulle part ailleurs). Le plan gratuit permet deux projets.
2. Rien à créer à la main : le premier déploiement applique toutes les migrations.
3. **Connect** → **Session pooler** → copier l'URI, mot de passe compris : c'est le secret
   `PRODUCTION_SUPABASE_DB_URL` de l'étape 3.

## 2. Whop : l'app de production

Sur **whop.com** (pas le sandbox) → **Dashboard → Developer → Create app** :

1. **Nom** `StayPut`, **icône** `docs/brand-logo-1024.png`.
2. **Hosting**, chaque valeur **tapée à la main** (le texte gris d'une case vide n'est qu'un
   exemple, il n'est pas enregistré), puis **Save** :
   - Base URL : `https://stayput-app.chezbenz18.workers.dev`
   - App path : `/experiences/[experienceId]`
   - Dashboard path : `/dashboard/[companyId]`
   - Discover path : `/discover` (la page de StayPut dans l'App Store de Whop)

   Les trois chemins sont ceux de `WHOP_VIEW_PATHS` (`packages/core/src/whop-views.ts`) : le
   déploiement les relit chez Whop et s'arrête s'ils diffèrent (étape 4).

3. **Permissions** — les mêmes que le sandbox (`packages/whop/src/permissions.ts`), **sans**
   `member:email:read` ni `member:phone:read` (StayPut ne lit ni e-mail ni téléphone) :
   - lecture : `company:basic:read`, `member:basic:read`, `access_pass:basic:read`,
     `plan:basic:read`, `payment:basic:read`, `promo_code:basic:read`, `shipment:basic:read`,
     `chat:read`, `forum:read`, `support_chat:read`, `courses:read`, `course_analytics:read` ;
   - webhooks : `webhook_receive:memberships`, `webhook_receive:payments`,
     `webhook_receive:members`, `webhook_receive:chat`, `webhook_receive:courses` ;
   - actions : `member:manage`, `payment:manage`, `promo_code:create`, `notification:create`,
     `support_chat:create`, `support_chat:message:create` (les messages aux membres partent dans
     le chat de support de la communauté : ils n'ont pas d'espace StayPut, 08/10/2026) ;
   - offre Alumni (facultative) : `access_pass:create`, `plan:create`, `experience:create`,
     `experience:attach`.
4. **Webhook** de l'app : URL `https://stayput-app.chezbenz18.workers.dev/webhooks/whop`, avec
   les événements `payment.failed`, `payment.succeeded`, `payment.requires_action`,
   `membership.activated`, `membership.deactivated`, `membership.cancel_at_period_end_changed`,
   `membership.trial_ending_soon`, `member.created`, `member.updated`,
   `course_lesson_interaction.completed`, `chat.message.created`, `chat.reaction.created`.
5. Copier la **clé API de l'app** (`apik_…`) et le **secret du webhook** (`ws_…`) directement
   dans les secrets de l'étape 3, et l'**identifiant de l'app** (`app_…`, pas un secret).
6. Fiche de l'App Store : textes et captures dans [`docs/app-store.md`](./app-store.md). Pas
   de page légale : Whop n'en demande aucune et elles sont éteintes (`LEGAL_PAGES_ENABLED`,
   décision du 10/10/2026).

## 3. GitHub : les réglages de production

**Settings → Environments** → l'environnement **`production stayput off`** (le nom choisi par le
fondateur le 07/10/2026 : les workflows Deploy et Inspect le lisent pour la cible `production`,
lettre pour lettre ; un autre nom, et GitHub leur crée un environnement vide). Cocher **Required
reviewers** = toi : aucun déploiement de production ne part sans ton accord (un bouton « Review
deployments » apparaît sur le workflow). Dans cet environnement, **Add environment secret** /
**Add environment variable** :

| Nom                              | Type     | Valeur                                                                                                                  |
| -------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PRODUCTION_SUPABASE_DB_URL`     | secret   | l'URI « Session pooler » de la base de production (étape 1)                                                             |
| `PRODUCTION_WHOP_API_KEY`        | secret   | la clé API de l'app de production (`apik_…`)                                                                            |
| `PRODUCTION_WHOP_WEBHOOK_SECRET` | secret   | le secret du webhook de production (`ws_…`)                                                                             |
| `PRODUCTION_TELEGRAM_BOT_TOKEN`  | secret   | facultatif : un **second bot** Telegram (un bot n'envoie qu'à une adresse)                                              |
| `PRODUCTION_WHOP_APP_ID`         | variable | l'identifiant de l'app de production (`app_…`)                                                                          |
| `PRODUCTION_OPERATOR_COMPANY_ID` | variable | ta communauté Whop de production (`biz_…`, dans l'adresse de son tableau de bord) : elle seule voit **Réglages › État** |
| `PRODUCTION_STAYPUT_URL`         | variable | facultatif : seulement si la production a un jour son propre domaine                                                    |

`WHOP_ENV` n'est pas à régler : le choix `production` du workflow le fixe. `CLOUDFLARE_API_TOKEN`
et `CLOUDFLARE_ACCOUNT_ID` restent ceux du dépôt (le même compte Cloudflare). Discord : la même
application sert les deux ; ajouter dans le portail Discord, onglet OAuth2, la redirection
`https://stayput-app.chezbenz18.workers.dev/auth/discord/callback` (sans rien changer d'autre), et
garder `DISCORD_BOT_TOKEN` et `DISCORD_CLIENT_SECRET` au niveau du dépôt. Sans
`PRODUCTION_TELEGRAM_BOT_TOKEN`, Telegram reste éteint en production : le bot du sandbox n'est
jamais repris (il cesserait de répondre au sandbox).

## 4. Déployer

**Actions → Deploy → Run workflow → target : production.** Le workflow vérifie que chaque
réglage `PRODUCTION_…` obligatoire existe et se lit (une adresse collée à la place d'un `biz_…`
est refusée), demande à Whop s'il accepte la clé, **relit l'app chez Whop** (ses trois chemins,
les permissions qu'elle demande : toutes celles dont StayPut a besoin, ni e-mail ni téléphone),
réserve la base de production (ou s'arrête si c'est celle du sandbox), applique les migrations,
crée la connexion Hyperdrive `stayput-db-production`, publie le Worker `stayput-app`, **relit chez
Cloudflare son déclencheur** (`scripts/deploy/check-crons.ts` : l'offre gratuite en permet 5 par
compte, partagés avec le sandbox, et chaque Worker n'en a qu'un, `docs/jobs.md`), attend que
`/health` réponde `ok`, puis **demande `/health` à travers Whop** (l'adresse de l'app chez Whop,
celle que le cadre de Whop charge) : si Whop répond « App Base URL not set », le déploiement
s'arrête en disant quoi taper (`scripts/deploy/check-app.ts`). Chaque écart est nommé, avec
l'endroit où le corriger sur whop.com ; le sandbox, lui, le signale sans s'arrêter.

La toute première publication d'une nouvelle adresse `workers.dev` peut mettre quelques minutes
à répondre : relancer le workflow si la vérification échoue de ce seul fait.

Puis **Actions → Inspect → Run workflow → target : production** : il relit l'app chez Whop comme
le déploiement, et vérifie le site, l'absence des pages légales et la démo dans Chrome, sans lire la base (ce dépôt est public, ses journaux
aussi : aucune communauté cliente ne doit y apparaître). L'état de la production se lit dans
StayPut même : **Réglages › État**, dans ta communauté.

## 5. Vérifier en vrai

1. L'app en **Non répertoriée** (Paramètres de l'app ; une app répertoriée ou non doit avoir une
   description), l'installer dans ta propre communauté par le lien
   `https://whop.com/apps/<app_…>/install` : choisir la communauté, approuver les permissions.
   L'installation passe par le **produit de l'app** (onglet **Produits** de l'app) : ne jamais le
   supprimer. S'il manque, Whop répond « This AccessPass was not found » ; en créer un dans cet
   onglet (gratuit, masqué) suffit (constaté le 07/10/2026). Puis ouvrir StayPut des trois côtés :
   le tableau de bord (la synchronisation démarre, l'accueil s'affiche), l'espace membre (avec un
   second compte, membre de la communauté) et la page Discover. Passer l'app en **Live**
   seulement quand les trois s'affichent.
2. **Réglages › État** : les tâches passent (toutes les 10 minutes, chaque heure), aucun envoi de
   Whop en échec.
3. Une nouvelle communauté démarre en **mode manuel** (rien ne part sans l'accord de l'équipe),
   le mode test désactivé, et à l'**heure de New York** (migration 0044) ; l'équipe change l'un
   et l'autre dans Settings.
4. Les pages légales sont éteintes (décision du 10/10/2026 : Whop n'en demande aucune, aucune app
   n'en montre). Pour les rallumer : compléter `OPERATOR` dans `apps/worker/src/legal.ts`, puis
   `LEGAL_PAGES_ENABLED = "true"` (`apps/worker/wrangler.toml`) et `VITE_LEGAL_PAGES_ENABLED=true`
   au build de l'app, ensemble.

## 6. Ensuite

- Rotation des clés, rejeu des webhooks, sauvegardes : [`docs/operations.md`](./operations.md).
- Le sandbox continue de servir aux essais : chaque changement s'y déploie d'abord
  (`target : sandbox`, le choix par défaut), puis en production.
