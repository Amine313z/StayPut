# Décisions techniques

Chaque choix non évident, avec sa raison. Les plus récents en bas.

## 2026-09-30 — Phase 1 : architecture

### Un seul Worker sert l'interface et l'API (au lieu de Pages + Worker)

`SPEC.md` prévoit le frontend sur Cloudflare Pages et l'API sur un Worker. On déploie les deux
dans **un seul Worker** : il sert le build React (`apps/web/dist`, « static assets ») et répond
lui-même aux chemins `/api/*`, `/webhooks/*`, `/health`, `/badge/*` et `/v/*`
(`run_worker_first`).

- **Même origine, par construction.** Whop n'envoie le jeton de l'utilisateur
  (`x-whop-user-token`) qu'aux requêtes vers l'origine de l'iframe (rapport de la Phase 0,
  section 3). Avec Pages + Worker, il faudrait un domaine commun (payant) ou un relais `/api/*`
  dans Pages Functions.
- **Moitié moins de requêtes facturées** : avec un relais, chaque appel d'API compte deux fois
  dans les 100 000 requêtes/jour gratuites. Les fichiers statiques sont gratuits et illimités.
- **Recommandation de Cloudflare** : pour un nouveau projet, Workers plutôt que Pages ; « all of
  our investment, optimizations, and feature work will be dedicated to improving Workers ».
- La structure du dépôt ne change pas : `apps/web` (React) et `apps/worker` (API, webhooks,
  cron) restent séparés ; le Worker pointe vers le build du web.

### Base de données : Hyperdrive + postgres.js, schéma `stayput`, lectures sous RLS

- **Connexion** : Hyperdrive (gratuit, 100 000 requêtes/jour) devant Supabase, pilote
  postgres.js (≥ 3.4.5), option `nodejs_compat`. Hyperdrive garde les connexions ouvertes : pas
  de poignée de main TLS ni d'authentification SCRAM à chaque requête, ce qui compte avec
  **10 ms de CPU** par exécution sur l'offre gratuite. **Le cache de requêtes d'Hyperdrive est
  désactivé** : il ne tient pas compte du rôle ni de l'utilisateur de la transaction.
- **Schéma `stayput`, pas `public`** : l'API de données de Supabase (PostgREST) n'expose que
  `public` ; nos tables ne sont donc pas atteignables avec la clé publique `anon`, même en cas
  d'erreur de politique RLS. Et les privilèges par défaut que Supabase accorde à `anon` et
  `authenticated` dans `public` ne s'appliquent pas ici.
- **RLS effective** : le Worker écrit avec sa connexion serveur (propriétaire des tables), mais
  les lectures du tableau de bord et de l'espace membre passent par `asUser` : une transaction
  qui prend le rôle `stayput_user` et fixe `stayput.user_id` ; les politiques RLS décident alors
  des lignes visibles (un créateur ne voit que ses entreprises, un membre que ses données). Le
  filtre `company_id` côté serveur reste systématique : la RLS s'y ajoute.

### Client Whop maison, types du SDK

Le SDK `@whop/sdk` 2.0.0 pèse ~900 Ko une fois empaqueté (391 opérations) pour une vingtaine
d'appels utiles, dans un Worker limité à 10 ms de CPU. `packages/whop` est donc un petit client
`fetch` (URL sandbox/production, `Api-Version-Date`, pagination, erreurs, nouvelles tentatives
avec délai exponentiel sur 429 et 5xx) qui reprend les **types** du SDK par `import type` : ils
disparaissent à la compilation, 0 octet dans le Worker.

### Jeton de l'iframe : les clés dépendent de `WHOP_ENV`

Le sandbox signe avec ses propres clés (`https://sandbox-api.whop.com/.well-known/jwks.json`),
différentes de la production (`https://api.whop.com/.well-known/jwks.json`). Le Worker prend le
JWKS de l'environnement choisi ; l'ancien StayPut avait figé la clé de production.

### Outils

- **TypeScript 6.0**, pas 7.0 : `typescript-eslint` n'accepte pas encore la 7 (compilateur réécrit
  en Go), et on garde la vérification des promesses non attendues, importante dans un Worker.
- **npm workspaces** (pas de gestionnaire en plus), **Vitest** pour tous les paquets, **PGlite**
  (Postgres en WASM) pour tester les migrations et la RLS sans Docker, comme l'ancien StayPut.
- **i18n maison** (`packages/i18n`) : un dictionnaire anglais de référence, le français typé
  dessus ; TypeScript refuse une clé manquante, un test refuse un texte en dur dans les écrans.

### Sécurité des pages

- Fichiers statiques : `apps/web/public/_headers` (CSP stricte `default-src 'self'`, nosniff,
  referrer). Réponses du Worker : `Cache-Control: no-store` et nosniff (`apps/worker/src/http.ts`).
- **`frame-ancestors` volontairement absent** tant que l'origine exacte qui encadre l'app dans
  Whop n'est pas vérifiée dans le sandbox : une valeur fausse empêcherait l'app de s'afficher.
  Le risque de clickjacking est faible (hors du proxy de Whop, aucun jeton, donc aucune action
  possible).
- Webhooks : signature vérifiée avant toute lecture du contenu, 256 Ko au plus, enregistrement
  idempotent (`webhook-id`) ; 503 tant que le secret ou la base manquent, pour que Whop réessaie.

### Mode développement

Hors de l'iframe Whop, pas de jeton : avec `ENVIRONMENT=development` (uniquement dans
`.dev.vars`, jamais déployé), le Worker agit comme `DEV_USER_ID`, avec `DEV_ACCESS_LEVEL`. Un
test vérifie que ces réglages sont ignorés partout ailleurs.

### Limites de l'offre gratuite à garder en tête (Phases 2 à 4)

10 ms de CPU par exécution (cron compris), 50 appels externes par exécution, 5 crons par compte,
100 000 requêtes/jour. Conséquences : le score se calcule en SQL, la synchronisation avance par
petits lots avec un curseur par créateur, et les grosses réponses de Whop sont passées telles
quelles à Postgres (`jsonb`) plutôt qu'analysées dans le Worker.

## 2026-09-30 — Premier déploiement

### Déploiement par GitHub Actions, vérifié par `/health`

- Le workflow `Deploy` (lancé à la main) vérifie le code, applique les migrations, crée
  Hyperdrive (`stayput-db`, cache désactivé) au premier passage, publie le Worker avec ses
  secrets, puis interroge `/health` jusqu'à 3 minutes. Rien à installer chez le fondateur :
  tout vient des secrets et variables du dépôt.
- La première publication de l'adresse `workers.dev` a mis environ 8 minutes à répondre : d'abord
  `404 error code: 1042` (avant même le Worker), puis des requêtes sans réponse, puis `ok`.
  D'autres utilisateurs signalent le même délai sur le forum de Cloudflare : ce n'est pas une
  erreur du code. D'où l'attente dans la vérification plutôt qu'un échec immédiat.
- `/health` n'attend jamais la base plus de 5 s (`database: "timeout"`) : une base muette se
  distingue ainsi d'une adresse qui ne répond pas encore.
- `CLOUDFLARE_ACCOUNT_ID` peut contenir une adresse du tableau de bord Cloudflare collée par
  erreur : l'étape de préparation en extrait l'identifiant de 32 caractères.

### L'app Whop du sandbox, créée par l'API

- L'app (`app_rjFkp2xKgjfPxY`) et son webhook (`hook_M3uOKxSzLzx8u`) ont été créés par l'API du
  sandbox avec la clé de compte déjà fournie pour la Phase 0, plutôt qu'à la main : les adresses
  et les 10 événements sont exacts du premier coup, et le fondateur n'a plus qu'à copier deux
  secrets. Le webhook est épinglé sur la version `2026-09-29` (celle du client `packages/whop`) :
  les événements portent `account_id` (les webhooks non épinglés disent encore `company_id` ;
  `companyIdOf` lit les deux).
- L'identifiant de l'app sandbox est dans `wrangler.toml` (ce n'est pas un secret) : une variable
  GitHub de moins. Les variables `WHOP_ENV` et `WHOP_APP_ID` du dépôt remplacent ces valeurs au
  passage en production, et le déploiement refuse `WHOP_ENV=production` sans `WHOP_APP_ID` (sinon
  les jetons de production seraient vérifiés contre l'app du sandbox, donc tous refusés).
- Les permissions de l'app restent à cocher au tableau de bord : l'API les refuse aux clés. La
  Phase 1 n'en a pas besoin (la vérification d'accès ne demande que la clé de l'app) ; elles
  seront réglées au début de la Phase 2, avec la liste de `docs/whop-api-verification.md`
  (section 10).
- Le guide sandbox de Whop dit de ne pas utiliser les apps ni la messagerie dans le sandbox
  (« Known limitations »). Essayé quand même (règle 4 du cahier des charges), le 30/09/2026 :
  l'app s'installe, mais son iframe affiche « App Base URL not set » alors que l'URL est bien
  enregistrée (défaut connu du relais de Whop, voir `docs/whop-api-verification.md`, section 11).
  Conséquences : l'affichage dans Whop ne peut se vérifier que sur un compte de production, et les
  démonstrations sur les données du sandbox (Phases 2 à 5) demanderont un autre accès à
  l'interface. Les deux choix reviennent au fondateur.

## 2026-10-01 — Tester dans le sandbox sans l'iframe de Whop

### « Se connecter avec Whop », réservé au sandbox

Le sandbox de Whop ne peut pas afficher les vues de l'app (section précédente). Or toutes les
phases se testent sur ses membres fictifs. StayPut s'ouvre donc aussi **hors de l'iframe**, dans
un onglet normal, avec la connexion officielle de Whop (OAuth 2.1 + PKCE) :

- `/auth/login` envoie le navigateur sur la page de connexion du sandbox
  (`https://sandbox-api.whop.com/oauth/authorize`, qui renvoie vers `sandbox.whop.com`) ;
  `/auth/callback` échange le code (vérificateur PKCE) contre un jeton, lit l'utilisateur
  (`/oauth/userinfo`), **révoque** le jeton (StayPut n'en garde aucun) et pose un cookie de
  session ; `/auth/logout` le retire.
- Ensuite, **les mêmes vérifications que dans l'iframe** : l'identifiant Whop de l'utilisateur,
  puis l'accès réel vérifié chez Whop (admin pour la vue créateur, accès à l'expérience pour la
  vue membre). Se connecter n'ouvre aucun droit à soi seul. On teste comme créateur, puis comme
  membre en se reconnectant avec un autre compte du sandbox.
- **Uniquement dans le sandbox** (`WHOP_ENV=sandbox`) : en production, StayPut ne s'ouvre que
  dans Whop, et `/auth/*` répond 404.
- App OAuth **publique** (PKCE, sans secret client) : l'API ne donne pas le secret client, et
  le vérificateur PKCE protège l'échange. Adresse de retour déclarée sur l'app :
  `https://stayput.chezbenz18.workers.dev/auth/callback` (réglage fait par l'API).
- Cookies `__Host-` (HTTPS, tout le site, illisibles par les scripts, `SameSite=Lax`), signés
  HMAC-SHA256 avec une clé **dérivée de la clé API de l'app** (HKDF) : aucun secret de plus à
  ranger ; changer la clé déconnecte tout le monde. Session de 12 h ; le passage par Whop dure
  au plus 10 min (état et vérificateur PKCE dans un cookie signé).
- Toute requête `/api` qui modifie quelque chose, venant d'un navigateur connecté, doit porter
  l'en-tête `x-stayput-csrf` (qu'une page étrangère ne peut pas poser) ; l'adresse de retour
  après connexion n'accepte qu'un chemin du site (jamais un autre site).

### Hyperdrive branché sur la connexion directe de Supabase

Après plusieurs déploiements, la base ne répondait plus pendant 2 à 4 minutes (`/health` :
`database: "timeout"`), alors que les migrations passaient juste avant. Cause : deux pools de
connexions en cascade. Hyperdrive garde ses propres connexions vers l'origine (environ 20 sur
l'offre gratuite, 10 minutes d'inactivité) ; derrière le pooler de Supabase en mode session (un
client = une connexion Postgres, environ 15 pour le plus petit projet), les connexions en trop
font la queue jusqu'à expiration. Le guide Supabase de Cloudflare demande la **connexion
directe** : le script de déploiement la déduit de l'URI du pooler rangée dans
`SUPABASE_DB_URL` (même mot de passe ; `db.<ref>.supabase.co`, en IPv6, que le réseau de
Cloudflare joint) et met Hyperdrive à jour. Les migrations, lancées depuis les machines de
GitHub (IPv4 seulement), gardent le pooler.

## 2026-10-01 — Phase 2 : collecte des données

### Le Worker transporte les pages, Postgres les lit

L'offre gratuite de Cloudflare accorde 10 ms de calcul par exécution du Worker. Lire une page
de 50 membres en JavaScript (`JSON.parse`, puis une requête par ligne) les consommerait vite.
Le Worker passe donc chaque page de Whop **telle quelle** à une fonction SQL
(`stayput.sync_page`, migration 0005), qui la lit, range chaque élément (membres, adhésions,
paiements, activité) et note où en est la liste. Une page = un appel à Whop + une requête SQL.
Les e-mails et numéros de téléphone que Whop renvoie ne sont jamais enregistrés, ni le contenu
des messages (seuls l'auteur, la date et le salon).

### Synchronisation par passes, reprise au curseur

Chaque liste de Whop est un « flux » (`sync_state`) : `members`, `payments`… ou une liste par
salon de discussion, forum ou cours (`messages:<salon>`), créée quand StayPut découvre le salon.
Un flux se lit par **passes** : du haut de la liste (le plus récent) jusqu'à ce qu'une passe
précédente a déjà lu, ou jusqu'au bout. Une passe peut s'étaler sur plusieurs exécutions : le
curseur de Whop est enregistré, et l'exécution suivante reprend à la page suivante.

- **Premier passage (backfill)** : 90 jours pour les paiements, messages et posts de forum ;
  la liste entière pour les membres et les adhésions (tous comptent, même anciens).
- **Cadence** : membres, adhésions, paiements, tickets support et messages toutes les heures ;
  relecture complète des membres et adhésions chaque jour (statuts, dates de renouvellement,
  dernière action) ; variantes (prix), salons, forums et cours chaque jour ; leçons terminées
  chaque jour (le webhook les apporte en temps réel).
- **Ordre des listes** : StayPut demande le tri du plus récent au plus ancien quand Whop le
  permet (membres, adhésions, paiements, messages). Whop ne documente pas l'ordre des posts de
  forum : StayPut suppose « épinglés d'abord, puis du plus récent », et relit tout chaque jour au
  cas où. Une page triée du plus ancien au plus récent n'arrête jamais une passe avant la fin :
  au pire StayPut lit trop, jamais trop peu.

### Budget : 40 appels à Whop par exécution, une exécution toutes les 10 minutes

L'offre gratuite limite une exécution à 50 sous-requêtes. StayPut s'accorde **40 appels à Whop
par exécution** (le reste pour la base), sans relance automatique (une relance compterait
double). Le cahier des charges demande une synchronisation horaire ; le cron tourne **toutes les
10 minutes** (`*/10 * * * *`) pour multiplier par six ce que l'offre gratuite permet (environ
240 appels par heure). Chaque créateur reste lu au plus une fois par heure : chaque exécution
prend les créateurs qui attendent depuis le plus longtemps, un seul traitement à la fois par
créateur (bail de 5 minutes en base). Un gros créateur lit son historique en plusieurs
exécutions. Avec Workers payant (5 $/mois, plus tard), la limite passe à 1 000 sous-requêtes.

- Whop répond **429** (trop d'appels) ou **401** (clé refusée) : l'exécution s'arrête, la
  suivante reprend.
- **403** (le créateur n'a pas accordé une permission) : le flux attend sa prochaine passe, et
  l'erreur est visible dans l'état de la synchronisation. **404** d'un salon supprimé : son flux
  disparaît.
- À l'ouverture du tableau de bord, une synchronisation part en arrière-plan (au plus toutes
  les 10 minutes) : la première ouverture lance le backfill. Le bouton « Synchroniser » lit ce
  qui est dû pendant la requête, au plus une fois par minute.

### Webhooks : réponse immédiate, rangement juste après

`POST /webhooks/whop` vérifie la signature, enregistre la livraison et répond 200 ; le
rangement se fait ensuite (`waitUntil`). Une livraison qui échoue (ou que le Worker n'a pas eu
le temps de ranger) est rejouée par le cron, 5 fois au plus, à partir d'une minute d'âge.
Les événements de chat (`chat.message.created`, `chat.reaction.created`) ont été ajoutés au
webhook de l'app du sandbox (par l'API) : c'est la **seule source des réactions**, que la liste
de Whop ne donne qu'un message à la fois (un appel par message, impossible dans le budget).

### Ce qui arrive dans le désordre

- Une activité (message, réaction…) d'un utilisateur que StayPut ne connaît pas encore comme
  membre attend 7 jours dans `pending_activity`, puis rejoint `activity_events` dès que le
  membre arrive (webhook `member.created` ou synchronisation).
- Un paiement reçu avant son adhésion ou son membre garde leurs identifiants Whop
  (`whop_membership_id`, `whop_member_id`) : le lien se fait à leur arrivée.

### Tickets support

Whop ne donne pas la date d'ouverture d'un ticket, seulement celle du dernier message et de la
résolution. Une ouverture est donc datée par le dernier message vu, et comptée une fois par
épisode (la première, puis une après chaque résolution) ; une résolution est datée par Whop.
Les tickets se relisent en entier toutes les heures (le seul moyen de voir une résolution).

### Statistiques par jour et par heure

`member_stats_daily` et `activity_hours` sont recalculées pour chaque créateur dont l'activité
a changé, à partir du plus ancien changement (marque `stats_dirty_since`, posée par chaque
nouvelle activité ; un verrou garantit qu'aucune activité écrite pendant le calcul n'est
oubliée).

### Limites connues

- Réactions : par webhook seulement (voir plus haut).
- Commentaires de forum : la liste des posts sans `parent_id` ne dit pas si elle inclut les
  commentaires ; à vérifier sur un vrai forum (celui du sandbox est vide).
- Le module Discord (optionnel, désactivé par défaut) est fait le 01/10/2026, avec Telegram :
  voir la section suivante.

### Membres fictifs du sandbox (script `seed-sandbox`)

Le cahier des charges demande de « générer dans le sandbox des membres fictifs ». L'API de Whop
ne crée pas d'utilisateurs (aucun point d'accès ; l'invitation répond 403, Phase 0), et un vrai
compte de test demande une inscription à la main, sans historique (impossible de fabriquer 60
jours d'activité passée chez Whop). Les 25 membres fictifs vivent donc **dans la base de
StayPut**, rattachés au compte « StayPut Test », écrits comme des pages de Whop par les mêmes
fonctions SQL (ils passent par les mêmes contrôles). Leurs identifiants commencent par `seed`
(jamais ceux de Whop) ; `remove` les retire avec leur activité. Limite : une action de la
Phase 4 sur l'un d'eux échouera chez Whop (il n'y existe pas) ; les actions se testeront sur de
vrais comptes de test, à créer à ce moment-là.

### Après le premier déploiement (migration 0006)

- Le webhook d'essai de Whop envoie des données inventées, dont l'entreprise
  `biz_xxxxxxxxxxxxxx` : rangé comme une vraie livraison, il l'avait créée. Ces entreprises
  fictives sont maintenant ignorées, et celle-ci supprimée.
- La synchronisation ne lit les listes de Whop que pour les entreprises dont l'équipe a ouvert
  StayPut au moins une fois (le backfill commence à la première visite, cahier des charges,
  Phase 2, point 2). Les webhooks d'une entreprise qui a installé l'app sont rangés avant cela.

### Les permissions se ré-approuvent, entreprise par entreprise

Les permissions ajoutées à l'app ne valent pour une entreprise qui l'a déjà installée qu'après
qu'elle les a **ré-approuvées** dans Whop (« New scopes don't carry over until you accept them
in Authorized apps », documentation Whop). Constaté le 01/10/2026 : 403 sur toutes les listes
(« App API key is not authorized for the member:basic:read scope ») jusqu'à l'approbation par le
fondateur, puis tout lu au premier « Synchroniser maintenant ». En conséquence :

- un flux refusé est réessayé dans l'heure (et non à sa cadence normale, un jour pour certains),
  et tout de suite à l'ouverture du tableau de bord ou sur « Synchroniser maintenant » ;
- l'écran dit où approuver (« Settings → Authorized apps ») quand Whop refuse une permission ;
- le workflow « Inspect » demande à Whop quelles permissions la clé de l'app possède vraiment
  sur le compte sandbox (`GET /permissions`).

Chaque nouvelle permission (Phase 4 : actions) demandera donc la même ré-approbation aux
créateurs déjà installés : à prévoir dans le message de mise à jour.

## 2026-10-01 — Discord et Telegram, sources d'activité optionnelles

Décision du fondateur : ajouter le module Discord du cahier des charges (Phase 2, point 5)
**et Telegram**, puisque les deux sont gratuits (API REST de Discord, Bot API de Telegram, aucun
abonnement). Chaque module s'allume quand ses secrets existent (`DISCORD_BOT_TOKEN` et
`DISCORD_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`) et reste invisible sinon.

### À qui appartient un message : Discord par Whop, Telegram par le membre

- `GET /users/{id}` avec la clé de l'app ne montre d'un membre que ce qui est **public sur
  Whop : le Discord principal et le compte X** (documentation du SDK, « other profiles only what
  is public »). Le Discord d'un membre vient donc de son profil Whop (relu chaque semaine, 10
  profils par entreprise et par exécution, délié s'il l'a délié sur Whop).
- Whop ne montre le Telegram de personne. Le membre relie le sien lui-même : bouton « Relier mon
  Telegram » dans la vue membre → lien `t.me/<bot>?start=<jeton>` signé pour lui et sa
  communauté (valable une heure) → Telegram dit au bot quel compte l'a ouvert. Un compte ne
  compte que pour un membre par communauté ; « Délier » le retire.
- Un message d'un compte inconnu attend 7 jours dans `pending_activity` sous le compte
  (`discord:<id>`, `telegram:<id>`), rangé chez le membre dès qu'il est relié.

### Discord : ajout du bot, salons, lecture

- Le créateur ajoute le bot depuis la page d'autorisation de Discord (`bot identify`, code
  grant) : Discord renvoie le serveur dans la réponse à l'échange du code, StayPut ne garde
  aucun jeton d'utilisateur (révoqué aussitôt). Le `state` est signé (entreprise, membre de
  l'équipe, 30 minutes). Adresse de retour à déclarer sur l'application Discord :
  `https://stayput.chezbenz18.workers.dev/auth/discord/callback`.
- Permissions du bot : voir les salons et lire l'historique (66560), rien d'autre ; l'intent
  « Message Content » n'est pas demandé, seul l'auteur et l'heure sont lus.
- À la première connexion, StayPut suit tous les salons textuels **que le bot peut lire**
  (permissions des rôles et des salons calculées comme Discord), le créateur décoche ensuite.
  Un salon supprimé (404) cesse d'être suivi ; un salon devenu illisible (403) est signalé.
- Lecture : 90 jours d'historique puis le nouveau, 100 messages par appel, **toutes les 3
  heures** (un serveur a beaucoup de salons ; les scores lisent l'activité du jour), dans le
  même budget de 40 appels que Whop, après Whop. Un 401 ou un 429 de Discord laisse Discord pour
  l'exécution suivante sans arrêter Whop.
- Limites : les fils (threads) et les salons forum de Discord ne sont pas lus ; à ajouter si
  les créateurs s'en servent. Piste d'économie si le budget se tend : lire `last_message_id`
  des salons en un appel par serveur et ne lire que les salons qui ont bougé.

### Telegram : groupes reliés par un lien signé

- Le créateur ouvre « Ajouter le bot à un groupe » (`t.me/<bot>?startgroup=<jeton>`, signé pour
  sa communauté, valable une heure) ; Telegram envoie `/start <jeton>` dans le groupe et le bot
  confirme dans le groupe (transparence : il dit que seuls l'auteur et l'heure comptent). Un
  lien expiré : le bot le dit et quitte le groupe.
- Le webhook de Telegram est déclaré par le Worker lui-même à la première demande de lien,
  avec l'adresse par laquelle il est joint (aucun réglage à garder à jour) ; le secret que
  Telegram répète dans chaque requête est dérivé du jeton du bot.
- Telegram ne laisse aucun bot lire le passé d'un groupe : l'activité compte à partir de
  l'arrivée du bot. Le **mode confidentialité** du bot doit être désactivé (@BotFather →
  /setprivacy → Disable) avant de l'ajouter aux groupes, sinon il ne voit que les commandes ;
  l'écran le signale.

### Vérification au déploiement (même jour, pendant la mise en route avec le fondateur)

Un module « allumé » prouve seulement que ses secrets existent. La dernière étape du
déploiement (`scripts/deploy/check-bots.ts`, une fois le Worker en ligne) demande donc à
Discord et à Telegram s'ils les **acceptent**, comme `check-whop.ts` le fait pour la clé Whop :

- **Discord** : `GET /applications/@me` avec le jeton du bot (l'appel que le Worker fait en
  premier) ; puis le « Client Secret » sur un **code inventé** : Discord vérifie le secret avant
  le code, il répond `invalid_client` (401) à un secret faux et `invalid_grant` (400) à un bon,
  sans qu'aucun jeton ne soit créé. Puis l'adresse de retour (`redirect_uris` de l'application,
  à l'identique), le bot public (sinon seul son propriétaire peut l'ajouter à un serveur) et
  l'installation sur un serveur (« Guild Install »).
- **Telegram** : `getMe` (jeton accepté, `can_read_all_group_messages` = mode confidentialité
  désactivé, `can_join_groups` = ajout aux groupes permis) et `getWebhookInfo` (pas encore
  déclaré, déclaré vers StayPut avec la dernière erreur de livraison, ou vers une autre
  adresse, dont seule l'origine est affichée).

Chaque problème est un **avertissement** avec la correction exacte (le menu à ouvrir), jamais
un échec : les modules sont optionnels et un déploiement qui corrige autre chose ne doit pas
attendre Discord ou Telegram. Le résultat s'affiche dans le résumé de l'exécution. Aucun
secret n'est affiché : les adresses de Telegram contiennent le jeton, aucune n'est répétée.

### Telegram : les canaux, et la langue du bot (même jour)

Le fondateur avait créé un **canal** pour son test, et demande que StayPut marche aussi avec un
canal. Ce que Telegram permet, vérifié dans l'API des bots :

- Dans un canal, seuls les administrateurs publient ; les réactions et les vues y sont
  **anonymes**. Aucun bot ne peut savoir quel membre a lu ou réagi.
- Les **commentaires** d'un canal vivent dans son **groupe de discussion** (Gérer → Discussion),
  écrits par des membres identifiés. Un canal compte donc **par ce groupe** : le créateur y
  ajoute le bot avec le même lien signé qu'un groupe ordinaire. Rien de plus à stocker ; la
  carte Telegram l'explique.
- Telegram **recopie chaque publication du canal** dans ce groupe (`is_automatic_forward`,
  `sender_chat` = le canal, `from` = un compte de remplacement). Elle n'est l'activité de
  personne : ignorée, comme tout message envoyé au nom d'un chat (administrateur anonyme,
  quelqu'un qui écrit en tant que sa propre chaîne), attribuable à aucun membre.
- Pas fait, pour plus tard si c'est utile : relier le canal lui-même (le bot administrateur
  reçoit les abonnements et désabonnements, `chat_member`), un signal de départ. Il faudrait
  relier le canal à la communauté et garder ces événements.

Essai du fondateur : ses messages dans le groupe de discussion ne comptaient pas. Il y écrivait
en **administrateur anonyme** (« Envoi anonyme… ») : Telegram les envoie au nom du groupe et ne
dit à personne, bot compris, qui les a écrits. Ignorés à raison ; la carte Telegram le dit
maintenant. Pour le diagnostic, le workflow Inspect demande aussi à Telegram ce qu'il voit de
chaque groupe relié (le bot y est-il encore, groupe devenu supergroupe, groupe de discussion
d'un canal, livraisons en attente ou en erreur), sans nom ni identifiant
(`scripts/ops/telegram-groups.ts`).

**Langue du bot.** Il répondait selon la langue que Telegram dit de l'utilisateur
(`language_code`) : chez le fondateur, Telegram en français, le bot a répondu en anglais. Le
lien signé porte maintenant la **langue de l'interface StayPut** (`?lang=` envoyé par la page,
`_fr_` dans le paramètre du lien, couvert par la signature) ; la langue de Telegram ne sert
plus que de repli. Les liens faits avant restent valables leur heure. Même chose pour le lien
d'un membre. Et la page déclare sa langue avant d'être dessinée : Chrome proposait de
« traduire depuis l'anglais » la page en français.

### « Synchroniser maintenant » relit aussi Discord (même jour)

Les salons Discord sont lus toutes les 3 heures (rien ne prévient StayPut d'un nouveau message
Discord, alors que Whop et Telegram envoient les leurs). Un créateur qui essaie (« j'écris dans
mon serveur, je regarde StayPut ») aurait attendu jusqu'à 3 heures. Le bouton relit maintenant
aussi les salons Discord non lus depuis 10 minutes (au plus une fois par minute, comme avant),
puis la page relit les sources. Le panneau s'appelle « Synchronisation des données », plus
« Données de Whop ».

### Correctif : les listes Postgres arrivent en texte en production (même jour)

Premier serveur Discord relié en production : « Sources d'activité » tombait en erreur. Le
Worker lit la base avec postgres.js **sans** lire les types au démarrage (`fetch_types: false`,
un aller-retour de moins par connexion) : une colonne tableau (`discord_guilds.channel_ids`,
`text[]`) arrive alors en texte (`{123,456}`), pas en liste. PGlite, dans les tests, rend une
vraie liste : le bug était invisible tant qu'aucun serveur n'était relié. Il en cachait un
second, silencieux : la fenêtre « Choisir les salons » aurait montré tous les salons décochés.

- Les deux lectures de `channel_ids` passent par `to_jsonb(channel_ids)` (jsonb est lu
  pareil partout) ; la règle est écrite dans `apps/worker/src/db.ts`.
- La base de test rend désormais chaque tableau en texte, comme la production
  (`test/helpers/db.ts`) : tout code qui lirait encore une colonne tableau échoue dans les
  tests. Les deux bugs y échouent sans le correctif et passent avec.

### Relier les comptes sans passer par Whop (même jour, demande du fondateur)

« On ne voit pas les membres si leur compte Whop n'est pas connecté à Discord ou Telegram. »
Jusqu'ici, un message ne comptait que pour le membre qui avait relié son Discord à son profil
Whop, ou son Telegram depuis StayPut. Les autres attendaient 7 jours, puis disparaissaient.
Désormais, un compte rejoint son membre de quatre façons (migration 0012) :

- **Par son nom, tout seul** : quand son pseudo est le pseudo Whop d'un membre, ou que son nom
  complet (deux mots au moins) est le nom Whop d'un membre, et qu'**un seul** membre correspond
  (« Chloé Dubois », « chloe dubois » et « CHLOE-DUBOIS » sont un seul nom). Deux « Thomas
  Durand », ou un prénom seul : StayPut ne choisit pas, il propose. Essayé à chaque nouveau nom,
  puis toutes les 10 minutes (un membre arrivé entre-temps, un pseudo Whop lu depuis).
- **Par le créateur, en un clic**, dans Sources → « Comptes Discord et Telegram » : chaque compte
  qui a écrit, avec ses messages en attente et jusqu'à 3 membres suggérés (même pseudo, même nom,
  même prénom), ou n'importe quel membre de la liste. « Pas un membre » le met de côté (un invité,
  un ami). Une erreur se corrige d'un clic (« Délier »).
- Par le profil Whop (Discord) et par le membre lui-même (Telegram), comme avant.
- Dès qu'une personne a décidé (le créateur a relié ou délié le compte, son propriétaire l'a
  délié), StayPut ne le relie plus par son nom.

Qui a relié quoi est gardé (`discord_link`, `telegram_link`). La lecture hebdomadaire des
profils Whop ne défait plus que ses propres liens, jamais ceux du créateur ou d'un nom. Si le
propriétaire d'un compte le déclare sur son profil Whop, Whop a raison et le compte le suit.

- **Rien n'est perdu** : l'activité d'un compte pas encore relié attend **30 jours** (7 pour un
  utilisateur Whop qui n'est pas encore membre). Le relier ramène tout son mois.
- **Ce que StayPut garde** : en plus de l'auteur et de la date, le nom affiché et le pseudo du
  compte (`platform_accounts`), pour que le créateur le reconnaisse. Jamais le contenu. Les noms
  d'un compte sans membre s'effacent après 30 jours sans message. Les comptes vus avant 0012
  n'ont pas de nom : StayPut le demande à Discord (`GET /users/{id}`) ou à Telegram
  (`getChatMember`, dans le groupe où il a écrit), 10 par affichage de la liste.
- Le pseudo Whop des membres est maintenant lu (`members.username`), pour comparer les pseudos.
- **Le compte du créateur** (migration 0013) : le propriétaire d'une communauté n'en est pas
  membre sur Whop, il n'apparaît donc pas dans la liste. Ses comptes, et ceux de son équipe, se
  mettent de côté avec « C'est moi / mon équipe » (l'activité de l'équipe ne compte pas dans
  les scores), à part de « Pas un membre » (un invité). Les comptes mis de côté sont listés, et
  « Remettre » corrige une erreur.
- **Limite** : un membre n'a qu'un compte par plateforme. Pour une très grande communauté, la
  liste des membres à choisir est celle déjà chargée par le tableau de bord.

### Voir ce que StayPut lit sur Discord et Telegram (même jour, demande du fondateur)

« Comment avoir un suivi de Discord et Telegram sur StayPut si rien n'est affiché ? » Les
messages comptaient (scores, activité des membres) mais ne se voyaient nulle part, et ceux de
l'équipe pas du tout. Sources montre maintenant, dès qu'un serveur ou un groupe est relié, une
carte **« Activité sur Discord et Telegram »** (migration 0014, `platform_activity`) :

- par plateforme, les messages des **30 derniers jours** (dans le fuseau du créateur), la date
  du dernier, **qui a écrit** (membres, équipe, invités, comptes à relier, chacun compté une
  fois) et **un graphique en barres par jour** ;
- les **membres les plus actifs** (l'équipe à part), et chaque **serveur et groupe** avec ses
  messages.

Les messages de l'équipe y apparaissent, jamais dans les scores. Un graphique par plateforme,
d'une seule couleur : Discord et Telegram sont deux bleus trop proches pour partager un
graphique (vérifié avec le validateur de palettes). Survoler une barre lit le jour ; les
chiffres sont aussi dans un tableau pour les lecteurs d'écran.

### L'activité en direct (même jour, demande du fondateur)

« Qu'on n'ait plus besoin de réactualiser la page pour voir les nouveaux messages. » La carte
d'activité se relit seule toutes les 30 secondes tant que l'onglet est visible, et tout de
suite quand on y revient (badge « En direct ») :

- **Telegram** envoie chaque message à StayPut au moment où il est écrit : il apparaît à la
  relecture suivante.
- **Discord** n'envoie rien. Tant que la page est ouverte, chaque relecture lit d'abord les
  salons Discord de l'entreprise s'ils n'ont pas été lus depuis une minute (10 appels au plus,
  migration 0015). Cette lecture prend le même verrou qu'une synchronisation (deux lectures ne
  lisent jamais un salon en même temps), mais ne touche pas à la date de la dernière
  synchronisation : les listes de Whop gardent leur rythme. Hors de la page, Discord reste lu
  toutes les 3 heures.
- Quand de nouveaux messages arrivent, la liste des comptes à relier et les compteurs des
  sources se relisent aussi. Relier un compte relit l'activité (ses messages changent de case).
- Un échec de relecture garde l'affichage : la suivante réessaie.
- **Plus rapide** (même soir, retour du fondateur : « plus ou moins performant ») : la carte se
  relit toutes les **10 secondes** et les salons Discord au plus toutes les **15 secondes**. Un
  message Telegram apparaît en 10 secondes au plus, un message Discord en 25 secondes au plus.
  Coût : environ 6 requêtes par minute et par onglet ouvert (le plan gratuit en permet 100 000
  par jour), et rien quand l'onglet est caché ; Discord tolère largement 4 lectures par minute
  et par salon. Un vrai temps réel (WebSocket, Durable Object) n'apporterait que quelques
  secondes, et Discord n'envoie de toute façon rien sans une connexion permanente à sa passerelle.

### Voir tous les membres de Discord et Telegram (migration 0017, même soir)

« Je veux qu'on puisse voir les membres » : jusqu'ici StayPut ne connaissait que les comptes qui
écrivent. Une carte **« Membres sur Discord et Telegram »** (onglet Sources d'activité) liste
maintenant toutes les personnes qu'il connaît sur le serveur et dans le groupe, avec ce que
chacune est pour la communauté (membre relié, équipe, pas un membre, pas encore relié), ses
messages sur 30 jours, depuis quand elle est là ou quand elle est partie ; recherche par nom
(accents ignorés) et filtre par plateforme. Elle se relit seule toutes les 30 secondes.

- **Discord** donne la liste complète d'un serveur, mais seulement à une application dont le
  **Server Members Intent** est activé (Developer Portal → Bot → Privileged Gateway Intents ;
  gratuit, sans vérification sous 100 serveurs). StayPut la lit comme un flux de
  synchronisation de plus (`discord_members:<serveur>`, 1 000 personnes par page) : toutes les
  6 heures, et chaque minute pendant que le créateur regarde Sources. Qui la lecture ne
  rencontre plus a quitté le serveur. Sans l'intent, Discord répond 403 : la carte l'explique
  avec le chemin exact, et chaque déploiement vérifie l'intent (résumé « Discord and
  Telegram »). Le nombre de membres d'un serveur, lui, vient sans intent
  (`approximate_member_count`).
- **Telegram** ne donne aucune liste des membres à un bot. StayPut connaît : ceux qui écrivent,
  ceux qui arrivent ou partent depuis que le bot est là (messages de service du groupe, et les
  mises à jour `chat_member` qu'un bot administrateur reçoit), et les administrateurs ; plus le
  nombre total de membres (`getChatMemberCount`), relu au plus toutes les 10 minutes. La carte
  dit « Membres dans le groupe : 34 · StayPut en connaît 3 », et pourquoi.
- **Où ils sont** : une table `platform_presence` (compte, serveur ou groupe, arrivée, départ).
  Les noms viennent de `note_account`, qui relie au passage une personne au membre Whop qui
  porte exactement son nom ou son pseudo. Rien de ce qui est écrit n'est lu ni gardé.
- **Effacement** : les noms d'un compte sans membre restent tant qu'il est sur le serveur ou
  dans le groupe, et partent 30 jours après son départ (avant : 30 jours sans message). Une
  personne silencieuse reste donc visible tant qu'elle est là.
- Déconnecter un serveur ou un groupe oublie qui StayPut y voyait.

### Interface : un vrai tableau de bord

- Trois sections à onglets dans la vue créateur : vue d'ensemble (chiffres, « À surveiller »,
  données de Whop, sources), membres (filtres et recherche), sources d'activité. Les données
  sont lues une fois pour les trois ; les sources se relisent quand le créateur revient sur
  la page (après avoir connecté Discord ou Telegram dans un autre onglet).
- « À surveiller » ne montre que des faits de Whop (paiement échoué, annulation programmée),
  jamais un score : le score de risque est la Phase 3.
- Police Inter servie par StayPut (la CSP n'autorise aucune autre origine ; seuls les fichiers
  latins sont chargés), icônes Lucide, jetons de couleur testés WCAG AA dans les deux thèmes.
- Ouvrir Discord ou Telegram depuis le cadre de Whop passe par `openExternalUrl` du SDK
  d'iframe de Whop, dont le protocole (postMessage) est reproduit en quelques lignes plutôt que
  d'ajouter `@whop/iframe` et sa dépendance zod ; si Whop ne répond pas, un lien simple est
  proposé.

## 2026-10-01 — Phase 3 : détection (score de risque)

### Qui calcule quoi

- Postgres rassemble les chiffres de chaque membre en **un seul document JSON compact**
  (`risk_features` : un tableau par membre, dates en millisecondes) ; les fonctions pures de
  `packages/core` (`computeRisk`) décident ; Postgres garde le résultat (`save_risk_scores`).
  Une lecture et une écriture JSON par lot : le plan gratuit donne 10 ms de CPU par invocation,
  1 500 membres en prennent environ 2.
- Le score courant vit dans `member_risk` (une ligne par membre) ; `risk_scores` garde **une
  ligne par membre et par jour** (le dernier calcul de la journée), purgée après 400 jours :
  c'est l'historique du graphique de la Phase 6.
- Recalcul **chaque heure** (cron `0 * * * *`) : les membres dont le score a plus de 50 minutes,
  les entreprises qui attendent depuis le plus longtemps d'abord, 1 500 membres par exécution
  au plus ; et **juste après une synchronisation** (500 au plus, le reste à l'heure suivante),
  pour que le premier tableau de bord ait déjà ses scores. Les membres de l'équipe et ceux qui
  sont partis n'ont pas de score.

### Les cinq sous-scores, tels que codés

- **Récence** : depuis la dernière activité (événements de StayPut ou dernière action vue par
  Whop, la plus récente), ou depuis l'arrivée pour un membre qui n'a jamais rien fait.
- **Fréquence** : les 7 derniers jours contre la moyenne hebdomadaire des 28 jours d'avant ;
  sans moyenne, 0 (le radar d'activation et la récence couvrent ces membres).
- **Progression** : depuis la dernière leçon terminée (ou mise à jour d'objectif, Phase 5), ou
  depuis l'arrivée ; 0 pour un créateur sans cours ni objectifs.
- **Paiement** : 1 pour un dernier paiement échoué non résolu (ou une adhésion `past_due`) ou
  une résiliation programmée ; 0,7 pour un paiement en attente avec lien de reprise
  (`requires_action`, `pending`… : la vérification 3D Secure) ; sinon 0.
- **Friction** : 1 pour une conversation de support dont le dernier mot est celui du membre
  depuis plus de 48 h ; 0,5 si les réactions des 14 derniers jours font moins de la moitié des
  14 jours d'avant (**au moins 2 réactions avant** : passer de 1 à 0 ne dit rien) ; sinon 0.
- Niveaux 40 / 70 réglables ; une résiliation programmée vaut 100 et son propre statut,
  « Départ programmé » ; un paiement échoué ou en retard place au moins en risque élevé (voir
  « Retouches après la revue du fondateur » plus bas).

### Les raisons

- Les deux raisons sont les facteurs qui pèsent le plus dans le score (poids × sous-score) ;
  une résiliation programmée est toujours dite en premier.
- Elles sont gardées **en codes avec leurs chiffres** (`{"code":"inactive","days":12}`) et
  rédigées à l'affichage dans la langue du créateur : un même score se lit en français et en
  anglais, et une tournure se corrige sans recalculer.
- Un facteur qui ajoute moins de 3 points au score n'est pas une raison, ni « 0 jour » (vu sur
  la liste du sandbox : « Aucune activité depuis 0 jour » pour un membre actif la veille).
- Le titre de la leçon vient de la dernière leçon terminée, que Whop donne avec l'interaction
  (le script des membres fictifs donne maintenant un titre à ses leçons). Tournure retenue :
  « Dernière leçon terminée : « 4. … », il y a 23 jours » plutôt que l'exemple du cahier des
  charges « A arrêté le cours à la leçon 4 », qui affirmait un abandon pour des membres encore
  actifs (vu sur la liste du sandbox).

### Radar d'activation, cohortes, leçons bloquantes

- **Radar** : arrivé il y a 72 heures à 7 jours, et rien depuis. L'action d'accueil est la
  Phase 4 ; en attendant, la vue d'ensemble les liste.
- **Cohortes** (une fois par semaine) : par mois d'arrivée, la part des membres partis dans les
  30, 60 et 90 jours, comptée **seulement parmi ceux arrivés assez tôt** pour l'horizon ; alerte
  à 1,5 fois la moyenne du créateur, avec 10 membres au moins dans la cohorte **et** à
  l'horizon (un taux sur 3 membres ne dit rien).
- **Leçons bloquantes** (une fois par semaine) : pour chaque leçon, les membres dont c'est la
  dernière leçon terminée et qui sont inactifs depuis 14 jours ou partis ; signalée au-delà de
  2 fois la moyenne du cours, avec 10 membres concernés au moins.
- Les analyses tournent quand elles sont dues (`company_sync.analyses_at`), dans le passage
  horaire ou après une synchronisation ; la date affichée vient de `stayput.analyses_at`, lisible
  par l'équipe seulement.

### Réglages

- Niche (les 7 préréglages du cahier des charges), 5 poids **ramenés à une somme de 1** (trois
  décimales, par la page comme par le Worker), seuil de récence de 1 à 90 jours, niveaux
  (moyen < élevé). Enregistrer rend tous les scores dus et lance le recalcul aussitôt, en
  arrière-plan ; la page relit les membres quelques secondes après.
- La niche se choisit dans **Réglages** pour l'instant ; l'onboarding de la Phase 6 la
  demandera à l'installation.

### Interface

- Onglets : vue d'ensemble, membres, **analyses**, sources d'activité, **réglages**.
- Vue d'ensemble : six chiffres (voir les retouches plus bas) ; « À surveiller » = départs
  programmés et risques élevés (un paiement échoué en fait toujours partie), du score le plus
  haut au plus bas, avec leurs raisons (avant les premiers scores, les faits de Whop comme en
  Phase 2) ; « Nouveaux membres qui n'ont pas commencé » ; « Le risque
  parmi vos membres » : une barre par niveau (part des membres notés), nom, icône, nombre et
  part écrits à côté, chaque ligne ouvre les membres de ce niveau.
- Membres : triés par score ; filtres sur le départ, élevé, moyen, faible, nouveaux inactifs,
  partis ; chaque ligne porte le niveau, le score et les raisons.
- Un niveau n'est **jamais dit par la couleur seule** : couleur, icône et nom. Faible = vert de
  la marque, moyen = ambre, élevé = nouveau ton orange (« serious »), départ = rouge. Les textes
  restent testés WCAG AA ; les barres ont leurs propres couleurs (des marques, pas du texte),
  vérifiées distinctes pour les daltoniens avec le validateur de palettes.

### Limites connues

- L'inactivité « 14 jours » des leçons bloquantes et la récence ne voient que l'activité que
  StayPut connaît (Whop, Discord, Telegram) : un membre qui ne fait que regarder des vidéos hors
  des leçons suivies paraît inactif.
- Pas encore d'historique du score à l'écran (Phase 6), ni d'action depuis la liste (Phase 4).

### Retouches après la revue du fondateur (même jour)

Le fondateur a fait le tour du tableau de bord du sandbox et relevé cinq incohérences qui
pouvaient faire perdre confiance dans le score :

1. **Paiement échoué ou en retard = risque élevé au minimum**, quelle que soit l'activité (une
   carte refusée coupe l'accès d'un membre très actif aussi). Avec les poids du cahier des
   charges, un paiement échoué seul ne valait que 15 points (Zoé Lambert, « Risque faible ·
   20 »). Le score est porté au seuil du niveau élevé (70 par défaut, plus s'il était déjà plus
   haut) et « Paiement échoué » est dit en premier, même si le créateur met le poids du paiement
   à zéro. Le paiement en attente de 3D Secure garde son sous-score de 0,7 sans règle.
2. **Leçon bloquante : au moins 3 membres décrochés**, en plus du double de la moyenne du cours
   et des 10 membres concernés (« 1 sur 23 » était signalé). La règle est réappliquée aux
   chiffres gardés à chaque lecture (`isBlockingLesson`), donc un changement de règle se voit
   tout de suite, sans attendre l'analyse de la semaine suivante.
3. **« Activité en baisse de 100 % » devient « Aucune activité cette semaine »** (et « Aucune
   réaction depuis 14 jours » pour les réactions). Les deux raisons ne se répètent plus ni ne se
   contredisent : inactif depuis 7 jours ou plus dit déjà « rien cette semaine » (la raison
   suivante prend la place) ; un membre passé dans la communauté il y a 3 jours sans rien y
   faire de la semaine n'est pas dit « inactif depuis 3 jours » (la récence compte les visites
   vues par Whop).
4. **« Membres » et « Adhésions actives » faisaient doublon** (26 et 26). « Membres » compte
   maintenant les membres dans la communauté **hors équipe** ; « Adhésions actives » est
   remplacé par **« Revenus mensuels »** : les adhésions récurrentes qui paient encore (actives,
   en retard ou en fin de période), hors équipe, ramenées au mois (une année compte pour un
   douzième, une semaine pour 52 douzièmes, un mois de 28 à 31 jours pour un mois ; les essais et
   les achats uniques n'en font pas partie), avec **la part menacée** (membres en risque élevé ou
   en départ programmé). Dans la devise qui rapporte le plus ; s'il y en a d'autres, la tuile le
   dit. C'est le premier pas vers l'audit de la Phase 6 (« Y $ de revenus mensuels menacés »).
5. **« Activité, 30 derniers jours » sans unité** devient **« Actions, 30 jours »** (précisé
   sous le chiffre) :
   messages (Whop, Discord, Telegram), réactions, posts et leçons terminées, hors équipe, les
   mêmes compteurs que la ligne « 30 derniers jours » de chaque membre (auparavant, tous les
   événements, tickets de support et passages de l'équipe compris).

Le Worker ne recalcule un score qu'une fois par heure et les analyses qu'une fois par semaine :
les actions `seed` et `report` du workflow « Seed sandbox » recalculent tout de suite les scores
et les analyses du sandbox avec les règles du code déployé.

## 2026-10-01 — Phase 4 : actions (en cours)

### Le moteur de garde-fous (`packages/core/src/actions.ts`)

Une seule fonction pure, `checkGuardrails`, par laquelle passe toute action de tout
déclencheur (SPEC 5.8), testée cas par cas. Dans l'ordre : l'interrupteur de toute l'app, celui
du créateur, la liste « ne jamais contacter » (aucune action, de quelque type que ce soit),
puis les plafonds propres à l'action, puis les messages.

- **Relance ou message de service.** Le cahier des charges plafonne « les messages de
  relance » (1 tous les 5 jours, 4 par mois). Une relance est ce que StayPut envoie de
  lui-même (message à l'heure d'or, accueil, suivi Alumni). Un message de service répond à un
  geste du membre ou de Whop : paiement à valider (3D Secure), paiement échoué, annulation
  programmée (questionnaire). Il n'est **jamais retenu** par les plafonds, puisque l'accès du
  membre est en jeu. Mais il compte dans son historique : aucune relance ne le suit dans les
  5 jours. Les deux respectent la liste « ne jamais contacter », les interrupteurs et les heures
  silencieuses.
- **Fenêtres glissantes.** « 4 messages par mois » : sur 30 jours glissants (un mois civil
  permettrait 4 messages le 31 puis 4 le 1er). « 14 jours offerts par trimestre » : sur
  90 jours glissants. Le plafond de codes promo du créateur aussi, sur 30 jours.
- **Heures silencieuses** dans le fuseau du créateur : Whop ne donne pas celui du membre. Un
  message tombant entre 22 h et 8 h part à 8 h. Une opération Whop sans message (relance de
  paiement) n'attend pas.
- **Heure d'or** : l'heure la plus fréquente de l'activité du membre sur 30 jours (lue dans
  `activity_events`, `activity_hours` couvrant 90 jours), **hors heures silencieuses** (un
  membre actif surtout à 23 h reçoit son message à sa meilleure heure permise, pas à 8 h). À
  égalité, l'heure la plus proche de l'heure par défaut du créateur (19 h) ; sans activité,
  l'heure par défaut.
- **Mode test** : l'action est calculée et passe tous les garde-fous, puis elle est marquée
  `simulated` (nouveau statut) avec le message exact qu'elle aurait envoyé. Rien ne part, et
  une action simulée ne comptera jamais comme sauvetage (Phase 6).

### Les déclencheurs (`supabase/migrations/0009_actions.sql`)

Ils lisent **l'état** que StayPut tient à jour (paiement à valider, paiement échoué, annulation
programmée, score passé en élevé, nouveau membre qui n'a pas commencé), plutôt que des
événements isolés : un webhook manqué ne fait rien perdre. Ils ne regardent que l'état
**récent** (paiements des 3 derniers jours, score passé en élevé depuis moins de 2 jours) :
installer StayPut n'agit jamais sur le mois dernier. Chaque action a une **clé d'unicité**
(`payment_retry:pay_…:1`) : elle n'est créée qu'une fois. L'équipe et les membres partis ne
sont jamais visés.

- Relance de paiement : à 24 h puis 72 h de l'échec, seulement si Whop peut la relancer et
  n'a pas prévu la sienne (décision du 30/09/2026). La seconde seulement après la première.
- Mode `manual` (par défaut) : l'action reste proposée jusqu'au clic du créateur. Mode `auto` :
  elle part après les garde-fous.
- **Revérification au moment d'envoyer** : un membre qui a payé entre-temps ne reçoit pas
  « ton paiement n'est pas passé » et sa relance est annulée ; un membre qui a retiré son
  annulation ne reçoit pas le questionnaire ; un interrupteur actionné entre-temps bloque.
- Envoi : notification Whop à travers l'expérience StayPut de la communauté (seuls ceux qui
  peuvent l'ouvrir la reçoivent). StayPut l'apprend quand un membre ouvre l'app ; tant qu'il
  ne la connaît pas, la notification attend. Une panne de Whop est réessayée une heure plus
  tard, 3 tentatives en tout ; un refus (permission manquante) est définitif et noté.
  `Idempotency-Key` = l'action : jamais deux envois.
- Le cron horaire planifie, passe les garde-fous et exécute (20 actions par passage, dans la
  limite des appels du plan gratuit de Cloudflare).

### Les messages (`packages/core/src/templates.ts`)

Modèles par défaut en français et en anglais pour chaque message, courts, chaleureux, jamais
culpabilisants, **au tutoiement** (le ton des communautés Whop ; le créateur les modifie). Une
partie entre `[[ ]]` n'apparaît que si toutes ses variables ont une valeur : un prénom inconnu
ne laisse jamais « Salut , ». L'emplacement d'une IA de rédaction existe, éteint.

### L'écran du créateur (onglet Actions, réglages)

- **Onglet Actions** : trois listes, _À valider_, _Programmées_, _Historique_, avec leur
  compte. Chaque action montre le membre, ce qui l'a déclenchée et **le message exact** qu'il
  recevra : l'aperçu est rendu par le même code que l'envoi, avec les modèles du créateur. On
  valide une action ou toutes d'un clic ; on annule ce qui n'est pas parti. L'historique dit ce
  qui s'est passé : envoyée, simulée (mode test), bloquée par un garde-fou avec la raison en
  clair, annulée et pourquoi (« le paiement est passé entre-temps »), échouée avec l'erreur.
- **Validée, elle passe tout de suite** les garde-fous, et ce qui est dû part aussitôt : pas
  besoin d'attendre le passage de l'heure. Ce qui a une heure à respecter (l'heure d'or d'un
  message de risque) attend son heure dans _Programmées_, mode test compris : le mode test
  simule l'envoi au moment où il aurait eu lieu.
- **Réglages** (onglet Réglages, sous le score) : mode manuel ou automatique, mode test, arrêt
  d'urgence, langue des messages, heures silencieuses, heure d'envoi par défaut, limites et
  textes des messages. Les limites ne peuvent être que **plus strictes** que celles du cahier
  des charges (1 relance tous les 5 jours, 4 messages sur 30 jours, 2 relances de paiement,
  14 jours offerts sur 90 jours) ; le plafond de codes promo est au choix du créateur (0 à 100),
  comme le prévoit la SPEC. Un champ de message vide garde le texte de StayPut, affiché en
  exemple ; une variable inconnue est refusée avant l'envoi au serveur.
- **Liste « ne jamais contacter »** : un interrupteur sur chaque membre de l'onglet Membres
  (pas l'équipe, pas les membres partis), `PUT /members/:id/contact`. Il vaut dès le passage
  suivant : une action déjà proposée pour ce membre est bloquée, avec la raison dans
  l'historique, plutôt qu'effacée en silence.

### Le fuseau du créateur (migration 0011, même jour)

Les heures silencieuses, l'heure d'or et l'heure par défaut sont celles du créateur. Mais
`companies.timezone` valait `UTC` depuis 0001, une valeur que personne n'avait choisie : chez
le fondateur, l'heure par défaut 19 h devenait 21 h à Paris.

- **Le navigateur du créateur la donne** à sa première visite du tableau de bord : la session
  dit si l'entreprise a déjà son fuseau (`timezoneSet`), et sinon la page envoie celui du
  navigateur (`POST /timezone`). Le premier entendu reste ; un autre navigateur, ailleurs, ne
  le change pas. Ensuite, seul le créateur le change, dans Réglages → Actions et garde-fous,
  avec un bouton « Utiliser celui de ce navigateur ». La liste propose d'abord, à la demande du
  fondateur, les États-Unis (New York, Chicago, Denver, Los Angeles), le Royaume-Uni et la
  France, puis tous les fuseaux par région.
- Le formulaire n'envoie le fuseau **que si le créateur l'a modifié** : celui du navigateur a
  pu arriver après la lecture du formulaire, il ne faut pas l'écraser par l'ancien.
- **Validé deux fois** : le Worker n'accepte qu'un nom IANA que son moteur connaît
  (`Europe/Paris`), gardé tel quel (les moteurs ne s'accordent pas tous sur les noms
  canoniques) ; Postgres vérifie qu'il le connaît aussi (`pg_timezone_names`). Un fuseau
  inconnu de l'un ou de l'autre ne passe pas : il casserait les calculs en SQL.
- Changer de fuseau **recompte l'activité** des 90 derniers jours dans le nouveau (les jours
  et les heures d'activité sont locaux).
- **Les heures silencieuses sont revérifiées au moment d'envoyer**, dans le fuseau et avec les
  heures du moment : une action programmée avant un changement de fuseau ou d'heures, ou un
  passage du cron en retard, ne fait jamais partir un message la nuit. Le message attend la fin
  des heures silencieuses ; ce n'est pas une tentative.

### La vue membre : questionnaire de départ, offres, paiements (migration 0016, même jour)

Dans l'espace StayPut de la communauté (la vue membre de Whop), le membre voit ce qui concerne
son propre abonnement, jamais un score (SPEC 5.3) :

- **Un paiement qui l'attend** (30 derniers jours) : une validation 3D Secure → « Valider mon
  paiement », vers le lien que Whop a donné ; un paiement échoué → « Mettre à jour mon moyen de
  paiement », vers la page de son abonnement chez Whop (`manage_url`, lue au moment d'afficher).
- **Son annulation programmée** : « Pourquoi nous quittez-vous ? », cinq réponses, un clic.
  Chaque réponse amène l'offre de la SPEC : pas le temps → une pause ; trop cher → un code
  promo à usage unique ; pas de résultats → l'aide du créateur ; objectif atteint → une
  invitation à recommander la communauté ; autre raison → des jours offerts. Le membre peut
  changer sa réponse tant qu'il n'a pas choisi. Un seul questionnaire par annulation ; une fois
  répondu, la notification qui l'aurait demandé ne part plus (sa place est réservée).
- **Son accord, jamais implicite** : accepter une offre ne retire son annulation que s'il coche
  « Je garde mon abonnement ». La case est obligatoire pour une pause (un abonnement qui se
  termine ne peut pas être suspendu), au choix pour les jours offerts et l'aide, absente pour le
  code promo et l'invitation.
- **L'offre acceptée est une action comme les autres** : elle passe par les garde-fous (un code
  déjà actif, le plafond de codes du mois, les jours offerts du trimestre, les arrêts) et par le
  mode du créateur. En automatique, elle s'applique dans la même requête et le membre voit le
  résultat (la date de reprise, son code) ; en manuel, il lit « Votre offre est en préparation »
  jusqu'à la validation. Une offre que les garde-fous bloqueraient n'est pas proposée : le
  membre laisse seulement sa raison.
- **Chez Whop** : l'accord → `PATCH /memberships/{id}` (`cancel_at_period_end: false`) ; la
  pause → `POST /memberships/{id}/pause` ; les jours offerts → `POST /memberships/{id}/extend` ;
  le code → `POST /promo_codes` (pourcentage et durée en mois du créateur, une utilisation, pour
  le produit du membre, valable 7 jours). Chaque appel a sa clé d'idempotence : une nouvelle
  tentative ne pause, ne prolonge et ne crée jamais deux fois. Le code (`STAY-` et 8 caractères
  sans 0/O ni 1/I/L, environ 40 bits) dérive de l'identifiant aléatoire de l'action : le même à
  chaque tentative. L'aide et l'invitation sont notées ; le créateur prend le relais (« À vous
  de jouer » dans l'historique).
- **En mode test, pas de questionnaire pour les membres** : promettre un code qui ne viendrait
  jamais serait pire que rien. Le membre « ne jamais contacter » ne le voit pas non plus. Le
  bouton de paiement reste : c'est la situation du membre lui-même, rien ne lui est envoyé.
- **L'équipe voit un aperçu** à la place : le questionnaire avec les offres du créateur, chaque
  réponse à essayer, rien d'enregistré ni d'appliqué ; un bandeau dit quand le mode test le
  cache aux membres.
- **Les réglages** (Réglages → Actions et garde-fous → « Offres de départ ») : la pause (7 à 90
  jours), la réduction (5 à 50 %) et la durée (1 à 12 mois) du code, les jours offerts (1 à 14)
  et le message du créateur au membre sans résultats (400 caractères ; vide, le texte de
  StayPut). Un avertissement dit quand une limite rend une offre impossible (plafond de codes à
  0, jours offerts au-delà de la limite du trimestre).
- **L'historique** montre pour chaque offre la raison du membre, l'offre, le code et sa fin, la
  reprise après une pause, son accord, avec le statut « Appliquée ».

### L'offre Alumni, première partie (migration 0018, même soir)

SPEC 5.9 : un ancien membre garde le contact gratuitement. StayPut crée l'offre pour le
créateur, depuis une carte **« Offre Alumni »** de l'onglet Actions, sur Whop et pas à pas :

1. un produit caché de la boutique (`POST /products`, `visibility: hidden`) ;
2. son prix gratuit, caché lui aussi (`POST /variants`, `one_time`, `initial_price: 0`), dont le
   **lien direct** est la porte d'entrée (l'invitation de Whop répond 403 à ce compte) ;
3. un espace StayPut (`POST /experiences` avec l'`app_id` de StayPut), par lequel passeront les
   nouvelles de J+7, J+30 et J+60 ;
4. rattaché au produit (`POST /experiences/{id}/attach`).

Chaque étape a sa clé d'idempotence et ce qui est fait est gardé : si Whop refuse une étape (une
permission pas encore accordée), la carte dit laquelle (`access_pass:create`, `plan:create`,
`experience:create` ou `experience:attach`), et un nouveau clic termine le reste sans recréer
ce qui existe. Une fois prête, la carte donne le **lien d'entrée** (à copier) et le texte du
**message automatique « User left »** de Whop, lien compris, avec le chemin pour l'activer :
c'est Whop qui l'envoie à chaque membre qui part, en message privé et par e-mail (aucune API ne
permet de l'activer à la place du créateur).

- **Le lien dans la vue membre** : sous le questionnaire de départ, « Gardez le contact,
  gratuitement » et le bouton « Rejoindre l'Alumni » (pas pour un membre qui a gardé son
  abonnement). L'aperçu de l'équipe le montre aussi.
- **Qui entre, qui part, qui revient** : un déclencheur sur les memberships (webhooks et
  synchronisation) tient `alumni_members` à jour. Un membre est **dans l'Alumni** quand il a un
  accès Alumni en cours et qu'il ne paie plus : plus d'abonnement payant en cours, ou seulement
  des abonnements annulés pour la fin de leur période. Un membre qui paie et prend le lien par
  curiosité n'y entre qu'à la fin de son abonnement. Son accès Alumni se termine : il est
  **parti**, et StayPut ne le relance plus jamais (SPEC 5.9). Il paie de nouveau : il est
  **revenu**, y compris s'il annule son annulation. S'il repart ensuite alors que son accès Alumni
  court toujours, il y est de nouveau, avec cette nouvelle date de départ.
- **La date de départ** (d'où partent J+7, J+30 et J+60) : la fin du dernier abonnement payant
  (la fin de la période pour une annulation programmée), jamais après le moment où StayPut l'a vu
  partir : un abonnement arrêté avant la fin de sa période (un remboursement) garde cette fin
  dans les données de Whop, et le premier message arriverait sinon trop tard.
- **Hors du score de risque** : un membre dans l'Alumni ne paie plus. Son score est effacé et il
  n'est plus calculé : ni message à l'heure d'or, ni message d'accueil (le radar d'activation
  part du score). Revenu dans une offre payante, il est de nouveau suivi.
- **Limite connue** : un membre de l'Alumni reste un membre de la communauté pour Whop ; il
  apparaît donc dans l'onglet Membres (adhésion « Accès à vie »).

### Reste à faire dans cette phase

La seconde partie de l'offre Alumni (les nouvelles de J+7, J+30 et J+60 avec un code de retour,
l'espace Alumni côté membre, le compte des retours), la démonstration de chaque déclencheur, et
les permissions d'écriture à ajouter dans Whop (`member:manage`, `payment:manage`, `promo_code:create`, `promo_code:basic:read`,
`notification:create`). À trancher au rapport de phase : un code promo valable 7 jours ne sert
qu'à un nouveau passage en caisse ; Whop permet aussi de le réserver aux abonnements en cours
(`existing_memberships_only`). Les défis de sauvetage et les binômes dépendent de la Phase 5
(espace membre).
