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
| 4. Actions                     | Arrêt : démontrée en mode test, le réel attend les droits |
| 5. Espace membre               | Faite, mise de côté pour la V1 (`MEMBER_SPACE_ENABLED`)   |
| 6. Preuve de valeur            | En cours : l'argent sauvé (6.4) et l'accueil (6.2) faits  |
| Refonte du design (v4)         | Étape 1 sur 10 faite (jetons, montants, langue)           |

## Architecture

Un seul Worker Cloudflare sert l'interface React et l'API, sur la même origine (le jeton Whop
de l'iframe n'est envoyé qu'à cette origine) :

| Chemin                                 | Qui répond                                           |
| -------------------------------------- | ---------------------------------------------------- |
| `/dashboard/:companyId` (vue créateur) | l'app React (`apps/web`)                             |
| `/experiences/:experienceId` (membre)  | l'app React                                          |
| `/demo` (communauté imaginaire)        | l'app React seule : aucun appel au Worker            |
| `/api/*`                               | le Worker (`apps/worker`), jeton Whop vérifié        |
| `/webhooks/whop`                       | le Worker : signature vérifiée, événement enregistré |
| `/health`                              | le Worker : état de la base et de la configuration   |
| `/badge/:companyId.svg`, `/v/:proofId` | le Worker (réservés, remplis en Phases 5 et 6)       |

Base : Supabase (Postgres), schéma `stayput`, jamais exposé par l'API publique de Supabase, RLS
sur chaque table. Le Worker s'y connecte par Hyperdrive. Budget : 0 €.

### Le tableau de bord du créateur

Noir, turquoise clair et blanc, en thème sombre seulement ; les chiffres et les titres en
Satoshi, le reste en Geist. Un menu de rubriques sur le côté, qui se replie sur ses icônes ; en
haut, le logo de StayPut, la communauté (nom et logo lus chez Whop), la recherche d'un membre
(⌘K ou Ctrl K) et le **Guide** : cinq cartes animées (qui va partir, les garder, l'argent gardé,
le contrôle, Discord et Telegram), chacune avec « Montrez-moi » qui ouvre la page et en éclaire
l'endroit, quatre raccourcis et une visite en cinq étapes (le montant sauvé, l'action du jour,
l'anneau de risque du premier membre, puis une règle d'Automatisations et la connexion de
Discord, chacune sur sa page ; elle finit là où elle a commencé). La première fois qu'une communauté
ouvre StayPut, un accueil en quatre étapes : bienvenue, Discord ou Telegram, automatique ou
manuel, premier audit (puis la visite). Quand le mode test est actif, une fine barre le dit,
avec « Désactiver ». La langue (English par défaut, Français) se change **uniquement** dans
Réglages › Général, et n'est retenue que pour l'app de cette communauté : la démo s'ouvre
toujours en anglais. Les montants s'écrivent comme sur Whop, symbole et centimes compris
(« $247.00 », « 247,00 $ »). L'identifiant brut de la communauté (`biz_…`) n'apparaît que dans
Réglages › Général › « Développeur ». Sur un téléphone, les rubriques passent dans une barre en bas de l'écran. Les
couleurs, polices et animations suivent [`docs/design-tokens.md`](./docs/design-tokens.md) et
[`MOTION.md`](./MOTION.md).

| Rubrique (EN · FR)            | Onglets                                                      |
| ----------------------------- | ------------------------------------------------------------ |
| Dashboard · Tableau de bord   | une page                                                     |
| Members · Membres             | Tous les membres · Ne pas contacter                          |
| Automations · Automatisations | Règles · À valider · Programmées · Historique · Offre Alumni |
| Analytics · Analyses          | Cohortes · Leçons                                            |
| Integrations · Intégrations   | Whop · Discord · Telegram · Activité                         |
| Settings · Réglages           | Général · Score de risque · Automatisations                  |

La page d'accueil répond à une seule question, « Est-ce que je perds de l'argent, et que faire
aujourd'hui ? » : un bloc pour l'argent (sauvé ce mois-ci, à risque, membres à risque, et la
courbe de l'argent sauvé face à l'argent à risque sur 7, 30 ou 90 jours), l'action prioritaire du
jour en un bouton (approuver, relancer les paiements échoués, proposer une pause, écrire ; jamais
« rien d'urgent » tant qu'un paiement échoué ou un départ demeure), les cinq membres les plus
urgents avec Écrire / Pause / Offre, et ce que StayPut a fait en 30 jours. Tant que la mise en
route n'est pas finie, la pastille « Getting started » (Discord, première automatisation,
membres à risque passés en revue, limites) s'affiche sous le titre.

La page Membres est un tableau compact, une ligne par membre : son anneau de risque, son état en
un mot (Leaving · Payment failed · Inactive · Active), ce qu'il paie par mois, sa dernière
activité et son prochain renouvellement. Chaque colonne se trie ; les puces de filtre et la
recherche restent en haut pendant le défilement. Une ligne ouvre le tiroir du membre : pourquoi
il est à risque, les actions rapides, son score sur 30 jours, son abonnement et ses paiements,
son activité par plateforme, et l'interrupteur « Ne pas contacter ».

Chaque onglet a son adresse (`/dashboard/<communauté>/<rubrique>/<onglet>`) ; une adresse
inconnue ouvre le premier onglet de sa rubrique, et les anciennes (`/actions?view=history`)
mènent au bon onglet.

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
désactivé), télécharge la police Satoshi chez Fontshare (sa licence interdit de la mettre dans le
dépôt), construit l'interface, publie le Worker avec ses secrets, puis vérifie `/health`
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

**Dans le cadre de Whop du sandbox** (« App Base URL not set » sinon) : le mode localhost de
Whop charge l'app depuis l'ordinateur de celui qui regarde, et un petit relais la va chercher en
ligne. Sous Windows (Node.js 18 ou plus), dans l'Invite de commandes :

```bat
curl -sSL -o "%TEMP%\whop-frame.mjs" https://stayput.chezbenz18.workers.dev/whop-frame.mjs && node "%TEMP%\whop-frame.mjs"
```

ou dans PowerShell :

```powershell
iwr https://stayput.chezbenz18.workers.dev/whop-frame.mjs -UseBasicParsing -OutFile "$env:TEMP\whop-frame.mjs"; node "$env:TEMP\whop-frame.mjs"
```

puis, dans Whop, StayPut → bouton `</>` en haut à droite du cadre → mode **localhost**, port
3000 (`--port 3001` si le 3000 est pris). Détails : `DECISIONS.md`, « StayPut dans le cadre de
Whop du sandbox ».

### La démo

`https://stayput.chezbenz18.workers.dev/demo` montre le tableau de bord sur une communauté
imaginaire (« Atlas Trading Club ») : rien n'y est réel, rien n'est envoyé, aucun compte n'est
nécessaire. 36 membres (39 avec ceux qui sont partis), 90 jours d'historique, des annulations,
des paiements échoués et la pastille « Getting started » à 2 étapes sur 4 (elle se coche quand
on visite Membres et qu'on enregistre les limites). Pour les captures de l'App Store et pour montrer StayPut ; dans l'app, le Guide
y mène par « Explorer avec des données de démo ». La démo ne montre pas l'accueil d'elle-même :
`/demo?welcome` l'ouvre.

### Discord et Telegram (optionnels, gratuits)

Chaque module s'allume au déploiement suivant dès que ses secrets existent, et reste invisible
sinon. Réglages une fois pour toutes (détails et raisons : `DECISIONS.md`, 2026-10-01) :

- **Discord** : une application sur https://discord.com/developers/applications, son bot (jeton
  → `DISCORD_BOT_TOKEN`), son « Client Secret » (onglet OAuth2 → `DISCORD_CLIENT_SECRET`) et,
  dans OAuth2 → Redirects, l'adresse `https://stayput.chezbenz18.workers.dev/auth/discord/callback`.
  Pour voir **tous** les membres d'un serveur (pas seulement ceux qui écrivent) : Bot →
  Privileged Gateway Intents → **Server Members Intent** activé (gratuit, sans vérification
  sous 100 serveurs).
- **Telegram** : un bot créé avec @BotFather (jeton → `TELEGRAM_BOT_TOKEN`), **mode
  confidentialité désactivé** (@BotFather → `/setprivacy` → Disable) avant de l'ajouter à un
  groupe. Le webhook se déclare tout seul à la première demande de lien. Telegram ne donne aux
  bots aucune liste des membres : StayPut connaît ceux qui écrivent, ceux qui arrivent après le
  bot et les administrateurs (un bot **administrateur** voit en plus chaque arrivée et chaque
  départ). Un **canal** compte
  par son groupe de discussion (les commentaires des membres) : activer les commentaires du
  canal (Gérer → Discussion), puis y ajouter le bot.

Le créateur connecte ensuite son serveur ou ses groupes depuis **Intégrations** (onglets Discord
et Telegram) dans le tableau de bord ; chaque membre relie son Telegram depuis la vue membre.

À chaque déploiement, la dernière étape demande à Discord et à Telegram s'ils **acceptent** ces
secrets, et vérifie l'adresse de retour, le bot public, le Server Members Intent, le mode
confidentialité et le webhook.
Le résultat est dans le résumé de l'exécution (« Discord and Telegram ») ; un problème y est un
avertissement avec la correction à faire, jamais un échec du déploiement.

### Données du sandbox : synchronisation, inspection, membres fictifs

- **Synchronisation** : automatique toutes les 10 minutes, et en arrière-plan à l'ouverture du
  tableau de bord ; le bouton **Synchroniser maintenant** (Intégrations › Whop) lit tout de suite
  ce qui est dû (au plus une fois par minute). Détails : `DECISIONS.md`, « Phase 2 ».
- **Inspect** (**Actions → Inspect → Run workflow**) : l'état de la base en chiffres seulement
  (version du schéma, flux de synchronisation et leurs erreurs, nombre de lignes par table,
  actions par type et par statut, réglages des actions : mode, mode test, arrêts, fuseau et
  heures, webhooks reçus par type). Aucun nom, aucune adresse, aucun contenu. Il demande aussi
  au Worker en ligne ce qu'un navigateur reçoit (une page de chaque vue, son script, le relais
  `whop-frame.mjs`, `/health`, et `/api` sans jeton, qui doit être refusé). Le rapport
  s'affiche dans le résumé de l'exécution. Son job **look** ouvre la démo en ligne dans Chrome
  (bureau et téléphone), vérifie que Satoshi et Geist se chargent et que le graphique a ses
  données, et échoue sinon ; ses captures du Tableau de bord sont gardées sur la branche
  `screenshots` du dépôt.
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
rien n'est enregistré. L'**offre Alumni** (Automatisations → Offre Alumni) se crée en un clic sur Whop : une
offre gratuite et cachée où les anciens membres gardent le contact. 7, 30 et 60 jours après leur
départ, ils y reçoivent des nouvelles de la communauté avec un code de retour à usage unique, et
le retrouvent dans leur vue de l'espace Alumni avec le bouton pour revenir. Détails :
`DECISIONS.md`, « Phase 4 ».

### Espace membre (Phase 5)

> **Mis de côté pour la V1** (décision du 2 octobre 2026). Le code reste dans le dépôt, éteint par
> `MEMBER_SPACE_ENABLED = "false"` (Worker, `apps/worker/wrangler.toml`) et
> `VITE_MEMBER_SPACE_ENABLED` (absent au build du site) : ni rubrique, ni onglet, ses routes
> répondent 404 et les pages publiques des cartes disent qu'elles n'existent plus. La vue membre
> garde l'abonnement : le questionnaire de départ et ses offres (pause, jours offerts, code promo,
> aide, lien d'affiliation), le paiement à régler, l'Alumni et le lien Telegram. Pour le
> rallumer : les deux variables à `true`, puis redéployer. Ce qui suit décrit l'espace allumé.

Dans la **vue membre**, le membre choisit son objectif parmi ceux du créateur (ou écrit le sien)
avec une cible, une unité et une date, puis note ses résultats en un geste : où il en est, ou ce
qu'il ajoute (« Ajouter 1 »). Il voit sa progression, les jalons de 25, 50, 75 et 100 % et ses
badges (premier résultat, première preuve, 7 jours d'affilée, chaque jalon), avec une petite fête à
chaque étape. Une capture d'écran peut appuyer un résultat : le navigateur du membre la lit
(Tesseract.js) et propose les nombres qu'il y voit ; seuls l'empreinte de l'image et ces nombres
partent, jamais l'image. Si le créateur les allume (Réglages → Espace membre → Jours mérités), un
jalon atteint offre des jours gratuits sur l'abonnement (3 à 50 %, 7 à 100 % par défaut), une fois
par membre et par jalon, par les garde-fous comme toute action. Si le créateur choisit un endroit
(Réglages → Espace membre → Annonces des jalons : un chat Whop, un salon Discord, un groupe
Telegram), le membre peut partager un jalon atteint avec la communauté, après avoir vu le texte
exact (son prénom, son objectif et le jalon, jamais ses chiffres). Le membre crée aussi la **carte
témoignage** d'un résultat : une image à télécharger (PNG), dessinée dans son navigateur, avec un QR
code vers sa page publique `/v/…` (le résultat, son niveau de preuve, sa date ; son nom seulement
s'il l'a coché ; son lien d'affiliation Whop s'il en a un). Il peut retirer la page à tout moment.
Si le créateur les allume (Réglages → Espace membre → Binômes), chaque nouveau membre est associé à
un vétéran engagé (même type d'objectif si possible, 3 nouveaux au plus) ; les deux reçoivent une
présentation et se voient dans leur espace, et le vétéran gagne le badge Mentor si le nouveau est
toujours là 30 jours plus tard. Chacun peut refuser. Avec les **défis de sauvetage** (Réglages →
Espace membre → Défis de sauvetage), un membre inactif depuis 14 jours devient un défi que les
autres voient sans son nom, avec un lien vers son dernier message ; s'il revient, ceux qui s'en sont
occupés gagnent le badge Sauveteur.
Chaque ouverture de l'espace et chaque résultat comptent comme de l'activité dans le score. Le
créateur choisit les objectifs proposés dans **Réglages** (ceux de sa niche par défaut) ; dans
la vue membre, l'équipe essaie l'espace sans rien enregistrer.

Dans le **tableau de bord**, la rubrique **Espace membre** réunit tout cela au même endroit : les
chiffres sur 30 jours (objectifs en cours, résultats notés et appuyés par une capture, membres
actifs dans leur espace, badges, cartes en ligne), les cartes témoignage publiées par les membres,
dessinées avec leur QR code et le lien de leur page, l'état des binômes et des défis de
sauvetage, puis l'espace des membres à essayer (le questionnaire de départ et ses offres,
l'objectif, la carte, les badges), sans rien enregistrer. Détails : `DECISIONS.md`, « Phase 5 ».

## Outils de la Phase 0

```bash
# Essai de « Invite to a Membership » dans le sandbox Whop. La clé de compte sandbox vient de la
# variable d'environnement WHOP_SANDBOX_API_KEY ; NODE_USE_ENV_PROXY=1 derrière un proxy
# (sessions cloud). Résultat du 30/09/2026 : docs/whop-api-verification.md, section 11.
NODE_USE_ENV_PROXY=1 node scripts/sandbox/check-invite.mjs you+test@example.com --cleanup
```
