# StayPut

L'app de rétention pour les créateurs Whop : elle prédit quel membre va partir, agit pour le
garder, fait progresser les membres vers leurs objectifs et prouve au créateur combien d'argent
il a sauvé.

- **Cahier des charges** : [`SPEC.md`](./SPEC.md). Le travail avance phase par phase, avec un
  arrêt et une validation à la fin de chacune.
- **Phase 0, vérification de l'API Whop** :
  [`docs/whop-api-verification.md`](./docs/whop-api-verification.md).
- **Décisions techniques** (et leurs raisons) : [`DECISIONS.md`](./DECISIONS.md).

## État

| Phase                          | Statut                                                    |
| ------------------------------ | --------------------------------------------------------- |
| 0. Vérification de l'API Whop  | Validée le 30/09/2026                                     |
| 1. Fondations                  | Validée le 01/10/2026                                     |
| 2. Collecte des données        | Faite (Whop, Discord, Telegram), en attente de validation |
| 3. Détection (score de risque) | Faite, en attente de validation                           |
| 4. Actions                     | En cours (reste l'offre Alumni)                           |

## Architecture

Un seul Worker Cloudflare sert l'interface React et l'API, sur la même origine (le jeton Whop
de l'iframe n'est envoyé qu'à cette origine) :

| Chemin                                 | Qui répond                                           |
| -------------------------------------- | ---------------------------------------------------- |
| `/dashboard/:companyId` (vue créateur) | l'app React (`apps/web`)                             |
| `/experiences/:experienceId` (membre)  | l'app React                                          |
| `/api/*`                               | le Worker (`apps/worker`), jeton Whop vérifié        |
| `/webhooks/whop`                       | le Worker : signature vérifiée, événement enregistré |
| `/health`                              | le Worker : état de la base et de la configuration   |
| `/badge/:companyId.svg`, `/v/:proofId` | le Worker (réservés, remplis en Phases 5 et 6)       |

Base : Supabase (Postgres), schéma `stayput`, jamais exposé par l'API publique de Supabase, RLS
sur chaque table. Le Worker s'y connecte par Hyperdrive. Budget : 0 €.

```
apps/worker      API, webhooks, crons (Hono)          packages/core   logique métier pure
apps/web         vue créateur + vue membre (React)    packages/whop   client Whop typé
supabase/        migrations + install.sql             packages/i18n   textes EN / FR
scripts/         migrations, bundle                   docs/           rapports techniques
```

## Commandes

Node 22 et npm.

```bash
npm install
npm run check          # TypeScript, ESLint, Prettier et tous les tests : avant chaque commit
npm test               # les tests seuls (Vitest ; la base tourne dans PGlite, sans Docker)
npm run build          # construit l'interface (apps/web/dist)

# Développement local : le Worker (port 8787) et l'interface (port 5173, relaie /api au Worker)
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # puis le remplir
npm run dev:worker
npm run dev:web

# Base de données
npm run db:bundle      # après avoir ajouté une migration : régénère supabase/install.sql
npm run db:migrate     # applique les migrations (DATABASE_URL, voir .env.example)
```

## Déploiement

Par GitHub Actions, sans rien installer : **Actions → Deploy → Run workflow**
([`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)). Le workflow vérifie le code,
applique les migrations manquantes, crée la connexion Hyperdrive au premier passage (cache
désactivé), construit l'interface, publie le Worker avec ses secrets, puis vérifie `/health`
(jusqu'à 3 minutes).

Adresse actuelle (sandbox Whop) : **https://stayput.chezbenz18.workers.dev**. La toute première
publication a mis environ 8 minutes à répondre (Cloudflare affichait `error code: 1042`) : si
une nouvelle adresse ne répond pas encore, relancer le workflow quelques minutes plus tard.

Tout se range dans **Settings → Secrets and variables → Actions** du dépôt, jamais dans le code :

| Nom                     | Type     | Contenu                                                                       | Requis            |
| ----------------------- | -------- | ----------------------------------------------------------------------------- | ----------------- |
| `CLOUDFLARE_API_TOKEN`  | secret   | jeton « Edit Cloudflare Workers » + permission Hyperdrive : Edit              | oui               |
| `CLOUDFLARE_ACCOUNT_ID` | secret   | identifiant du compte Cloudflare                                              | oui               |
| `SUPABASE_DB_URL`       | secret   | URI « Session pooler » de Supabase, mot de passe compris                      | oui               |
| `WHOP_API_KEY`          | secret   | clé API **de l'app** Whop (pas celle du compte)                               | pour l'API Whop   |
| `WHOP_WEBHOOK_SECRET`   | secret   | secret `ws_…` du webhook de l'app                                             | pour les webhooks |
| `DISCORD_BOT_TOKEN`     | secret   | jeton du bot de l'application Discord de StayPut                              | pour Discord      |
| `DISCORD_CLIENT_SECRET` | secret   | « Client Secret » de la même application (onglet OAuth2)                      | pour Discord      |
| `TELEGRAM_BOT_TOKEN`    | secret   | jeton du bot Telegram donné par @BotFather                                    | pour Telegram     |
| `WHOP_ENV`              | variable | `production` au passage en production (sinon `sandbox`, dans `wrangler.toml`) | non               |
| `WHOP_APP_ID`           | variable | l'app de production (`app_…`) ; celle du sandbox est dans `wrangler.toml`     | en production     |

Sans GitHub Actions : `supabase/install.sql` dans le SQL Editor de Supabase, puis depuis
`apps/worker` `npx wrangler hyperdrive create stayput-db --connection-string="…" --caching-disabled`
(recopier l'`id` dans un bloc `[[hyperdrive]]` de `wrangler.toml`), `npx wrangler secret put …`
et `npm run deploy` à la racine. `.dev.vars` et `.env` sont ignorés par Git.

### L'app Whop du sandbox

Créée le 30/09/2026 par l'API du sandbox (compte « StayPut Test », `biz_2whAzkbCRpcGqQ`), avec
la clé de compte `WHOP_SANDBOX_API_KEY` :

- app **`app_rjFkp2xKgjfPxY`** « StayPut », type `b2b_app`, statut `hidden` ; URL de base
  `https://stayput.chezbenz18.workers.dev`, vue tableau de bord `/dashboard/[companyId]`, vue
  expérience `/experiences/[experienceId]` (`POST /apps` puis `PATCH /apps/{id}`) ;
- webhook **`hook_M3uOKxSzLzx8u`** de l'app vers `/webhooks/whop`, version épinglée
  `2026-09-29`, avec les 10 événements de `docs/whop-api-verification.md` (section 5)
  (`POST /webhooks`, `resource_id` = l'app), plus `chat.message.created` et
  `chat.reaction.created` depuis le 01/10/2026 (`PATCH /webhooks/{id}`, Phase 2) ;
- faits au tableau de bord (`https://sandbox.whop.com/dashboard/developer` → StayPut) : la clé
  API de l'app et le secret du webhook, rangés dans les secrets GitHub ; l'installation dans
  « StayPut Test » (`https://sandbox.whop.com/apps/app_rjFkp2xKgjfPxY/install`) ; les 19
  **permissions** de lecture de la Phase 2 (l'API les refuse aux clés : il faut une session).

Le guide sandbox de Whop déconseille les apps et la messagerie dans le sandbox (« Known
limitations »). Constaté le 30/09/2026 : l'app s'installe, mais Whop affiche « App Base URL not set »
à la place de ses vues, alors que l'URL est bien enregistrée.

### Tester l'interface avec le sandbox

StayPut s'ouvre dans un onglet normal, avec « Se connecter avec Whop » (sandbox seulement) :

- tableau de bord du créateur : `https://stayput.chezbenz18.workers.dev/dashboard/biz_2whAzkbCRpcGqQ` ;
- espace membre : `https://stayput.chezbenz18.workers.dev/experiences/<exp_…>` ;
- **Se connecter avec Whop** → page de connexion du sandbox → retour sur la page, connecté ;
  **Se déconnecter** pour revenir avec un autre compte du sandbox (un membre, par exemple).

Les accès sont vérifiés chez Whop comme dans l'iframe. Réglage de l'app (fait par l'API) :
adresse de retour `https://stayput.chezbenz18.workers.dev/auth/callback`, client OAuth public.

### Discord et Telegram (optionnels, gratuits)

Chaque module s'allume au déploiement suivant dès que ses secrets existent, et reste invisible
sinon. Réglages une fois pour toutes (détails et raisons : `DECISIONS.md`, 2026-10-01) :

- **Discord** : une application sur https://discord.com/developers/applications, son bot (jeton
  → `DISCORD_BOT_TOKEN`), son « Client Secret » (onglet OAuth2 → `DISCORD_CLIENT_SECRET`) et,
  dans OAuth2 → Redirects, l'adresse `https://stayput.chezbenz18.workers.dev/auth/discord/callback`.
  Aucun intent privilégié n'est nécessaire.
- **Telegram** : un bot créé avec @BotFather (jeton → `TELEGRAM_BOT_TOKEN`), **mode
  confidentialité désactivé** (@BotFather → `/setprivacy` → Disable) avant de l'ajouter à un
  groupe. Le webhook se déclare tout seul à la première demande de lien. Un **canal** compte
  par son groupe de discussion (les commentaires des membres) : activer les commentaires du
  canal (Gérer → Discussion), puis y ajouter le bot.

Le créateur connecte ensuite son serveur ou ses groupes depuis **Sources d'activité** dans le
tableau de bord ; chaque membre relie son Telegram depuis la vue membre.

À chaque déploiement, la dernière étape demande à Discord et à Telegram s'ils **acceptent** ces
secrets, et vérifie l'adresse de retour, le bot public, le mode confidentialité et le webhook.
Le résultat est dans le résumé de l'exécution (« Discord and Telegram ») ; un problème y est un
avertissement avec la correction à faire, jamais un échec du déploiement.

### Données du sandbox : synchronisation, inspection, membres fictifs

- **Synchronisation** : automatique toutes les 10 minutes, et en arrière-plan à l'ouverture du
  tableau de bord ; le bouton **Synchroniser maintenant** du tableau de bord lit tout de suite ce
  qui est dû (au plus une fois par minute). Détails : `DECISIONS.md`, « Phase 2 ».
- **Inspect** (**Actions → Inspect → Run workflow**) : l'état de la base en chiffres seulement
  (version du schéma, flux de synchronisation et leurs erreurs, nombre de lignes par table,
  actions par type et par statut, réglages des actions : mode, mode test, arrêts, fuseau et
  heures, webhooks reçus par type). Aucun nom, aucune adresse, aucun contenu. Le rapport
  s'affiche dans le résumé de l'exécution.
- **Seed sandbox** (**Actions → Seed sandbox → Run workflow**, `seed`, `remove` ou `report`) :
  25 membres fictifs avec 60 jours d'historique dans « StayPut Test » (8 actifs, 5 en déclin,
  4 inactifs, 3 paiements échoués, 3 annulations programmées, 2 nouveaux dont un qui n'a encore
  rien fait). L'API de Whop ne sait pas créer d'utilisateurs : ils vivent dans la base de
  StayPut, identifiants commençant par `seed`, et `remove` les retire tous. Refusé en
  production. Leurs scores de risque et les analyses sont calculés dès `seed` ; `report` les
  recalcule avec les règles du code déployé et liste les membres du score le plus haut au plus
  bas, avec leurs raisons, dans le résumé de l'exécution.

### Score de risque (Phase 3)

Chaque membre a un score de 0 à 100, recalculé chaque heure, avec ses deux raisons en clair
(« Aucune activité depuis 21 jours »). **Membres** les trie du plus à risque au moins à risque,
**Analyses** montre les mois d'arrivée qui partent plus vite et les leçons bloquantes (une fois
par semaine), **Réglages** choisit la niche, les poids et les seuils. Détails et raisons :
`DECISIONS.md`, « Phase 3 ».

### Actions (Phase 4)

**Actions** liste ce que StayPut propose pour chaque membre (à valider en mode manuel), ce qui
est programmé et ce qui s'est passé ; tout passe par les garde-fous, et le mode test calcule
sans rien envoyer. Dans la **vue membre**, un membre qui a programmé son annulation dit pourquoi
en un clic et reçoit l'offre qui répond à sa raison (pause, code promo, aide, jours offerts) ;
un membre dont le paiement attend voit le bouton pour le régler. L'équipe y voit un aperçu, où
rien n'est enregistré. Détails : `DECISIONS.md`, « Phase 4 ».

## Outils de la Phase 0

```bash
# Essai de « Invite to a Membership » dans le sandbox Whop. La clé de compte sandbox vient de la
# variable d'environnement WHOP_SANDBOX_API_KEY ; NODE_USE_ENV_PROXY=1 derrière un proxy
# (sessions cloud). Résultat du 30/09/2026 : docs/whop-api-verification.md, section 11.
NODE_USE_ENV_PROXY=1 node scripts/sandbox/check-invite.mjs you+test@example.com --cleanup
```
