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
2. **Hosting** : Base URL `https://stayput-app.chezbenz18.workers.dev`, Dashboard path
   `/dashboard/[companyId]`, Experience path `/experiences/[experienceId]`.
3. **Permissions** — les mêmes que le sandbox (`scripts/ops/whop-permissions.ts`), **sans**
   `member:email:read` ni `member:phone:read` (StayPut ne lit ni e-mail ni téléphone) :
   - lecture : `company:basic:read`, `member:basic:read`, `access_pass:basic:read`,
     `plan:basic:read`, `payment:basic:read`, `promo_code:basic:read`, `shipment:basic:read`,
     `chat:read`, `forum:read`, `support_chat:read`, `courses:read`, `course_analytics:read` ;
   - webhooks : `webhook_receive:memberships`, `webhook_receive:payments`,
     `webhook_receive:members`, `webhook_receive:chat`, `webhook_receive:courses` ;
   - actions : `member:manage`, `payment:manage`, `promo_code:create`, `notification:create` ;
   - offre Alumni (facultative) : `access_pass:create`, `plan:create`, `experience:create`,
     `experience:attach`.
4. **Webhook** de l'app : URL `https://stayput-app.chezbenz18.workers.dev/webhooks/whop`, avec
   les événements `payment.failed`, `payment.succeeded`, `payment.requires_action`,
   `membership.activated`, `membership.deactivated`, `membership.cancel_at_period_end_changed`,
   `membership.trial_ending_soon`, `member.created`, `member.updated`,
   `course_lesson_interaction.completed`, `chat.message.created`, `chat.reaction.created`.
5. Copier la **clé API de l'app** (`apik_…`) et le **secret du webhook** (`ws_…`) directement
   dans les secrets de l'étape 3, et l'**identifiant de l'app** (`app_…`, pas un secret).
6. Fiche de l'App Store : textes et captures dans [`docs/app-store.md`](./app-store.md) ;
   politique de confidentialité `https://stayput-app.chezbenz18.workers.dev/privacy`,
   conditions `https://stayput-app.chezbenz18.workers.dev/terms`.

## 3. GitHub : les réglages de production

**Settings → Environments → New environment** → `production`. Cocher **Required reviewers** =
toi : aucun déploiement de production ne part sans ton accord (un bouton « Review deployments »
apparaît sur le workflow). Dans cet environnement, **Add environment secret** / **Add
environment variable** :

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
est refusée), demande à Whop s'il accepte la clé, réserve la base de production (ou s'arrête si
c'est celle du sandbox), applique les migrations, crée la connexion Hyperdrive
`stayput-db-production`, publie le Worker `stayput-app` et attend que `/health` réponde `ok`.

La toute première publication d'une nouvelle adresse `workers.dev` peut mettre quelques minutes
à répondre : relancer le workflow si la vérification échoue de ce seul fait.

Puis **Actions → Inspect → Run workflow → target : production** : il vérifie le site, les
pages légales et la démo dans Chrome, sans lire la base (ce dépôt est public, ses journaux
aussi : aucune communauté cliente ne doit y apparaître). L'état de la production se lit dans
StayPut même : **Réglages › État**, dans ta communauté.

## 5. Vérifier en vrai

1. Installer l'app de production dans ta propre communauté Whop, l'ouvrir : la synchronisation
   démarre, l'accueil s'affiche.
2. **Réglages › État** : les tâches passent (toutes les 10 minutes, chaque heure), aucun envoi de
   Whop en échec.
3. Une nouvelle communauté démarre en **mode test** : StayPut calcule tout et n'envoie rien aux
   membres tant que le créateur ne l'a pas désactivé.
4. Compléter l'éditeur dans `apps/worker/src/legal.ts` (`OPERATOR` : raison sociale, adresse,
   e-mail, droit applicable) et faire relire les textes avant d'ouvrir l'app au public.

## 6. Ensuite

- Rotation des clés, rejeu des webhooks, sauvegardes : [`docs/operations.md`](./operations.md).
- Le sandbox continue de servir aux essais : chaque changement s'y déploie d'abord
  (`target : sandbox`, le choix par défaut), puis en production.
