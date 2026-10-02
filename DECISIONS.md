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

### StayPut dans le cadre de Whop du sandbox (mode localhost, 1er octobre au soir)

Le fondateur veut voir StayPut **dans** Whop, sur le sandbox. Whop n'y affiche aucune app : ses
cadres passent par le relais de production (`https://dm4jquomz8hrsmrk6gb9.apps.whop.com`), qui ne
connaît pas les apps du sandbox, d'où « App Base URL not set » (la configuration de l'app est
bonne, relue chez Whop ; le guide du sandbox : « Don't use apps or messaging features in
sandbox »). Mais le **mode localhost** du cadre (bouton `</>` en haut à droite) charge l'app depuis
l'ordinateur de celui qui regarde, `http://localhost:3000`, avec son jeton Whop dans l'adresse
(`?whop-dev-user-token=…`) : c'est le fonctionnement du proxy de développement de Whop
(`@whop-apps/dev-proxy`, lu dans son code), qui garde ce jeton et le met dans l'en-tête
`x-whop-user-token` de chaque requête, comme le relais de production.

- **`whop-frame.mjs`** fait la même chose pour StayPut en ligne : un relais local, sans
  dépendance (Node 18 ou plus), qui garde le dernier jeton reçu et transmet chaque requête au
  Worker avec cet en-tête ; une redirection vers StayPut reste sur le relais (dans le cadre).
  Il n'écoute que `127.0.0.1` : le jeton ne quitte pas l'ordinateur. L'en-tête envoyé par le
  navigateur lui-même est toujours écarté.
- StayPut le sert lui-même (`/whop-frame.mjs`, depuis `apps/web/public`) : une seule commande
  PowerShell le télécharge et le lance (README).
- Côté StayPut, rien ne change : le jeton est vérifié comme celui du relais de Whop (clés du
  sandbox, audience = l'app), et l'accès demandé à Whop.
- **Confirmé par le fondateur le 2 octobre (vers 0 h 50)** : StayPut s'affiche en entier dans le
  cadre du sandbox. Le cadre donne bien un jeton signé par les clés du sandbox, que StayPut
  accepte. La première version du relais laissait certaines cartes sur « Pas de connexion » (le
  navigateur ne le joignait plus, sans erreur dans sa fenêtre) ; la seconde écoute aussi `::1`,
  garde les connexions inactives ouvertes longtemps, retente une lecture sur une connexion
  fermée et écrit chaque échec : tout s'affiche.
- Sous Windows, la commande existe pour l'Invite de commandes (`curl … && node …`) et pour
  PowerShell (`iwr …; node …`) : le fondateur a d'abord ouvert la première.

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

### L'offre Alumni, seconde partie : les nouvelles de J+7, J+30 et J+60 (migration 0019)

SPEC 5.9 : une fois dans l'Alumni, l'ancien membre reçoit, 7, 30 et 60 jours après son départ,
une notification Whop par l'**espace Alumni** (le seul qu'il voit encore) avec des nouvelles de
la communauté et un **code de retour**. Chaque relance est une action comme les autres : le mode
du créateur (à valider en mode manuel), les garde-fous, le mode test.

- **Quand** : chaque étape est préparée une fois par départ (la date de départ est dans sa clé :
  un membre revenu puis reparti recommence la série), envoyée à l'heure d'or. Une étape n'est
  préparée que tant qu'elle reste à distance de la suivante : J+7 jusqu'au 23ᵉ jour, J+30
  jusqu'au 53ᵉ, J+60 jusqu'au 85ᵉ. Un membre entré tard dans l'Alumni reçoit seulement l'étape
  en cours, jamais deux relances coup sur coup (l'espacement des relances les bloquerait).
- **Le code** : `STAY-` et 8 caractères, à usage unique, valable 7 jours, limité au produit que
  le membre a quitté, pas réservé aux nouveaux clients. La réduction et sa durée sont celles
  du code promo des offres de départ (réglage « Offres de départ »). Il est créé au moment de
  l'envoi, puis la notification part avec le code dans `{offer}` :
  « STAY-K7QM2XPA (-20 % pendant 3 mois, valable 7 jours) ».
- **Garde-fous** : comme un code promo, un seul code actif par membre, et le plafond mensuel de
  codes du créateur compte désormais aussi ces codes de retour. Plus l'espacement et le plafond
  des relances, les heures silencieuses et la liste « ne jamais contacter ».
- **Plus jamais relancé** : un membre revenu dans une offre payante, ou parti de l'Alumni, voit
  ses relances annulées au moment de partir (« Le membre est revenu dans une offre payante »).
- **Une panne entre le code et la notification** : le code déjà créé est gardé avec l'action, et
  la reprise, une heure plus tard, n'envoie que la notification, avec ce code-là (même
  réduction, même date de fin, même si le créateur a changé ses réglages entre-temps).
- **Côté ancien membre** : en ouvrant StayPut dans l'espace Alumni, il voit « Bienvenue dans
  l'Alumni », son code tant qu'il est valable (à copier) et le bouton **« Revenir dans la
  communauté »**, qui ouvre la page de paiement du prix qu'il avait. Ce lien est construit sur
  le modèle des liens de Whop (`https://whop.com/checkout/plan_…`, vu en sandbox) : si ce prix
  n'est plus en vente, c'est la page de Whop qui le dira (à vérifier en démonstration).
- **Côté créateur** : l'onglet Actions montre chaque relance avec le message exact, code compris
  (le code vient de l'action : l'aperçu montre celui qui partira), et l'étape (« 30 jours après
  son départ, dans l'Alumni »).
- **Correctif** : StayPut retenait comme espace de la communauté le dernier espace où un membre
  l'avait ouvert. Un ancien membre (ou l'équipe) ouvrant StayPut dans l'espace Alumni aurait
  envoyé toutes les notifications des membres payants vers un espace qu'ils ne voient pas.
  L'espace Alumni n'est plus jamais retenu (aucune offre Alumni n'existait encore en
  production : rien à réparer).
- **Le retour** : l'identifiant Whop du code est gardé (`promo_code_id`). Un paiement fait avec
  ce code sera compté comme un sauvetage direct quand l'argent sauvé sera calculé (Phase 6).

### La démonstration en mode test (arrêt de la phase 4)

Le 1er octobre au soir, sur le sandbox (mode test, mode manuel), chaque déclencheur a proposé son
action sur les membres fictifs : 3 paiements refusés (3 messages, et 1 nouvelle tentative, pour le
seul que Whop ne retente pas lui-même), 1 paiement en attente de 3D Secure (1 message), 3
annulations programmées (3 questionnaires), des scores devenus élevés (messages à l'heure d'or)
et 1 nouveau membre inactif (accueil). Le créateur les valide dans l'onglet Actions, et le passage
horaire suivant les simule (les messages attendent la fin des heures de silence).

- **Le script des membres fictifs** crée désormais un nouveau paiement à chaque passage pour
  chaque problème de paiement (son identifiant porte l'heure) : Whop ne change jamais la date de
  création d'un paiement, et un paiement déjà enregistré gardait la sienne, trop ancienne pour
  les déclencheurs (ils ne regardent que 3 jours). Il prépare aussi les actions aussitôt, sans
  attendre le passage horaire.
- **Le réel sur les membres fictifs est impossible** : ils n'existent que dans la base de
  StayPut (l'API de Whop ne crée pas d'utilisateurs), et Whop refuserait un message ou un
  prélèvement pour eux. L'essai réel se fera sur un vrai membre de test (un second compte Whop
  qui rejoint la communauté du sandbox), une fois les permissions d'écriture accordées.

### La page d'une carte s'ouvre dans StayPut (2 octobre, retour du fondateur)

« Ouvrir sa page » ouvrait la page publique d'une carte dans un nouvel onglet (Whop l'ouvre
ainsi, par `openExternalUrl`) : le fondateur s'y est retrouvé sans moyen de revenir. Le bouton
devient **« Voir la page »** et montre la vraie page dans une fenêtre de StayPut, côté équipe
(Espace membre → Témoignages) comme côté membre. La fenêtre (`ui/Dialog.tsx`) est le `<dialog>`
modal du navigateur : Échap, « Fermer » ou un clic à côté la referment, et le focus revient au
bouton.

- **La vraie page, pas une copie** : un cadre (`iframe`) charge `/v/<id>` depuis l'adresse où
  StayPut est affiché (le cadre de Whop, ou le relais), car la politique du tableau de bord
  n'autorise que les cadres de sa propre origine ; le lien à partager garde l'adresse publique.
  Le cadre est `sandbox` : aucun script (la page n'en a pas), seul le lien « Rejoindre » peut
  s'ouvrir, dans un nouvel onglet. La page le marque `target="_blank"` : les pages de Whop
  refusent de s'afficher dans une autre page.
- **Le thème suit StayPut** : la page suit `prefers-color-scheme`, et le cadre hérite du
  `color-scheme` du tableau de bord.
- « Ouvrir dans un nouvel onglet » reste proposé sous la page, et dit où il mène.
- **Sur téléphone**, la page publique resserre ses marges sous 480 px (pour un visiteur comme dans
  la fenêtre) : le résultat tient sur une ligne.
- **Le QR code à scanner passe de 180 à 220 pixels au moins** (225 pour l'adresse actuelle,
  5 pixels par module). Essai avec deux décodeurs indépendants (ZXing, celui de beaucoup de
  téléphones Android, et OpenCV) sur des photos simulées (inclinaison, flou, bruit, reflet, moiré
  d'écran) : à la distance où 180 px passaient 52 fois sur 72, 225 px passent 69 fois sur 72 ;
  de près, les deux passent toujours.
- Les tests de l'interface ne chargent pas la page des cadres (`navigation.disableChildFrameNavigation`
  de happy-dom) : c'est le Worker qui la sert, et elle est testée de son côté.

### Reste à faire dans cette phase

Les permissions d'écriture à ajouter dans Whop :
`member:manage`, `payment:manage`, `promo_code:create`, `notification:create` pour les actions,
et `access_pass:create`, `plan:create`, `experience:create`, `experience:attach` pour créer
l'offre Alumni. À trancher au rapport de phase : un code promo valable 7 jours ne sert qu'à un
nouveau passage en caisse ; Whop permet aussi de le réserver aux abonnements en cours
(`existing_memberships_only`). Les défis de sauvetage et les binômes dépendent de la Phase 5
(espace membre).

## 2026-10-01 — Phase 5 : espace membre (arrêt le 02/10/2026)

### Objectif, résultats, jalons et premiers badges (migration 0020)

- **Un objectif en cours par membre** (index unique partiel). En fixer un nouveau met fin au
  précédent (« abandonné ») ; un objectif atteint le reste. Les résultats d'un objectif
  abandonné restent en base, l'espace ne les montre plus.
- **Deux façons de noter un résultat**, choisies avec l'objectif : `total`, où le membre en est
  (un poids, un chiffre d'affaires mensuel) ; `add`, ce qu'il a fait depuis la dernière fois
  (deux clients de plus, une séance), avec un bouton « Ajouter 1 » ; un nombre négatif corrige
  une erreur. La valeur atteinte est gardée sur l'objectif (`current_value`), verrouillée pendant
  l'enregistrement : deux saisies au même instant s'additionnent, aucune ne se perd.
- **La progression** est la part du chemin parcouru du départ à la cible, de 0 à 100 %, dans les
  deux sens (perdre 7 kg compte comme gagner 3 000 €), arrondie vers le bas : un jalon n'est
  jamais annoncé avant d'être atteint. La base la calcule (`goal_progress`) et packages/core la
  calcule à l'identique, en centimes (`goalProgress`) ; un test compare les deux sur 305 cas.
- **Jalons à 25, 50, 75 et 100 %** : atteints, ils le restent, même si la valeur redescend (un
  trader qui perd une semaine). À 100 %, l'objectif est atteint et ne prend plus de résultat :
  l'espace félicite le membre et l'invite à en fixer un nouveau.
- **Badges**, une fois pour toutes par membre : « Premier résultat », un par jalon, et « 7 jours
  d'affilée » = sept jours de suite (fuseau du créateur) où le membre a ouvert son espace ou noté
  un objectif ou un résultat. « Première preuve » viendra avec les captures (étape 2), « Mentor »
  et « Sauveteur » avec les binômes et les défis de sauvetage. Un badge pas encore obtenu
  s'affiche avec la façon de l'obtenir : jamais de score, seulement la prochaine étape (SPEC 5.3).
- **L'activité** (SPEC Phase 5, point 10) : chaque ouverture de l'espace compte une fois par jour
  (`stayput_open`, fuseau du créateur : l'ouvrir dix fois reste une journée active), chaque
  objectif et chaque résultat une fois (`goal_update`). Ils comptent dans le score (récence,
  fréquence, progression). L'ouverture par quelqu'un que StayPut ne connaît pas encore attend son
  adhésion, comme ses autres activités. L'équipe ne compte jamais. La raison du score « Aucune
  leçon depuis X jours » devient « Aucune leçon ni résultat depuis X jours ».
- **Les messages** : les variables `{goal}` et `{progress}` des modèles, prévues en Phase 4, ont
  maintenant une valeur : le titre de l'objectif en cours et la progression (« 40 % »).
- **Les objectifs proposés** : trois par niche, écrits par StayPut en français et en anglais (le
  membre les voit dans sa langue ; les montants sont en € en français et en $ en anglais, le
  membre change l'unité). Le créateur peut écrire les siens, jusqu'à six, dans ses mots (une
  seule langue), dans Réglages → « Objectifs proposés aux membres », ou revenir à ceux de
  StayPut. Changer de niche change les objectifs de StayPut proposés. Le membre peut toujours
  créer le sien (type d'objectif, façon de noter, unité).
- **La date cible** va de la veille (l'« aujourd'hui » du membre, où qu'il soit) à cinq ans.
- **Les nombres** se tapent comme on les écrit : « 3 000,5 » ou « 3,000.5 ». Avec deux
  séparateurs, le dernier commence les décimales ; une virgule seule aussi, sauf en anglais
  entre groupes de trois chiffres (« 3,000 »).
- **L'aperçu de l'équipe** : dans la vue membre, l'équipe essaie l'espace dans son navigateur,
  comme un membre (choisir, noter, voir les jalons et badges, même calcul que la base) ; rien
  n'est enregistré et l'ouverture ne compte pas. C'est ce qui permet de le voir dans le sandbox
  sans second compte.
- **Un membre que StayPut n'a pas encore lu** (une adhésion toute neuve, avant le passage de la
  synchronisation) voit « Votre espace se prépare » plutôt qu'un formulaire qui échouerait.
- À trancher : un ancien membre entré dans l'Alumni voit aussi l'espace de progression (son
  objectif peut lui donner envie de revenir) ; ses ouvertures ne comptent dans aucun score
  (les membres de l'Alumni n'en ont pas).

### Les preuves par capture (migration 0021)

- **Le parcours** : sous la saisie d'un résultat, « Joindre une capture ». Le navigateur du
  membre lit la capture avec Tesseract.js, propose les nombres qu'il y trouve (le plus proche de
  là où en est le membre est présélectionné pour un objectif « où j'en suis ») ; le membre touche
  le sien ou le tape, puis note. Seuls l'empreinte SHA-256 de l'image et les nombres lus
  (trente au plus, jamais le texte de la capture, qui peut contenir des noms) partent au
  serveur ; **l'image ne quitte jamais l'appareil**, et StayPut ne propose pas de la garder
  (`image_stored` reste faux) : la carte témoignage et la page publique n'en ont pas besoin.
- **Justifié ou déclaré** : un résultat est « justifié » quand le nombre noté figure parmi ceux
  lus sur la capture, au centime près (le Worker le vérifie, la base ne reçoit la preuve que dans
  ce cas) ; sinon il compte quand même, comme « déclaré », et l'écran le dit avant l'envoi
  (« Ce nombre n'est pas sur la capture »). C'est un niveau de confiance, pas une preuve
  infalsifiable : le navigateur du membre fait la lecture. L'empreinte permet de vérifier plus
  tard une capture que le membre montrerait.
- **Une capture appuie un seul résultat** dans une communauté (index unique sur l'empreinte) :
  la même image une seconde fois laisse le résultat « déclaré », et l'écran le dit.
- **Badge « Première preuve »** au premier résultat justifié ; les résultats justifiés portent
  « Appuyé par une capture » dans la liste.
- **Les nombres d'une capture** : montants, nombres et pourcentages, dans l'ordre où ils
  apparaissent, chacun une fois ; les dates (01/10/2026, 2026-10-01) et les heures (23:45) ne
  sont pas des résultats et sont écartées ; un nombre qui se lit de deux façons (« 3,250 » :
  3 250 en anglais, 3,25 en français) donne les deux, le membre touche le bon. Un signe moins
  dans un mot (« COVID-19 ») n'en est pas un.
- **Tesseract, servi par StayPut** : le moteur (le worker, trois cœurs WebAssembly selon ce que
  le navigateur sait faire, ~3,9 Mo chacun, et le modèle anglais « best_int », 2,9 Mo, qui lit
  les chiffres quelle que soit la langue autour) est copié dans le site au moment de la
  construction (`apps/web/src/ocr-files.ts`, versions vérifiées), sous un dossier qui porte sa
  version (cache d'un an) : jamais de CDN, les pages n'autorisent que leur propre origine. Il ne
  se charge que quand un membre choisit une capture (le navigateur le garde ensuite).
- **La politique de sécurité du site** autorise désormais `'wasm-unsafe-eval'` : WebAssembly
  seulement, pas l'`eval` de JavaScript. Vérifié dans Chromium (Playwright) sur le site construit
  servi avec ces en-têtes : une capture de tableau de bord (« Chiffre d'affaires 3 250,00 € »,
  « Ventes 12 », « Panier moyen 270,83 € », date et heure) est lue en un peu plus d'une seconde,
  les nombres proposés sont 3 250, 12 et 270,83, et la page n'a aucune erreur. Sans cette
  autorisation, le cœur WebAssembly est refusé et le worker ne répond plus jamais : la lecture
  abandonne donc après deux minutes, ou dès que le worker signale une erreur, et le membre peut
  taper son résultat.
- **L'essai de l'équipe** lit aussi les captures (dans le navigateur, rien n'est envoyé) et
  applique les mêmes règles : justifié, déclaré, une capture par résultat.

### Les jours mérités (migration 0022)

- **Éteints par défaut** : le créateur les allume dans Réglages → « Jours mérités » (le
  commutateur est `company_settings.options.earned_days`, prévu dès 0001), avec ses nombres :
  3 jours à 50 % et 7 jours à 100 % par défaut (SPEC), de 0 à 14 chacun (0 : rien à ce jalon).
- **Une fois par membre et par jalon** : la première fois qu'il atteint 50 % (puis 100 %) d'un
  objectif pendant que les jours mérités sont allumés. Sans cette règle, un objectif rendu facile
  exprès (de 0 à 1) se répéterait pour des jours sans fin ; le plafond trimestriel des garde-fous
  le limiterait, mais un membre de bonne foi n'en a pas besoin davantage.
- **Une action comme les autres** : un `extend_offer` (le même que les jours offerts du
  questionnaire de départ) avec le déclencheur `milestone`, sur l'adhésion que le membre paie
  (active, en essai ou dont l'annulation est programmée) ; sans adhésion vivante, rien. Les
  garde-fous le comptent avec les autres jours offerts (14 par membre et par trimestre au plus),
  le mode test le simule, le mode manuel attend la validation du créateur, « ne jamais
  contacter » le bloque. En mode automatique, il part dès le résultat noté : le membre voit
  « Cadeau : 3 jours offerts ajoutés à votre accès ! ». L'onglet Actions le montre avec son
  jalon (« 50 % d'un objectif atteints ») et ses jours.
- **Le membre voit** les jours offerts à venir sous sa barre (« 3 jours offerts à 50 % · 7 jours
  offerts à 100 % ») : une raison de plus d'avancer. Il voit ensuite ceux qu'il a reçus (jamais
  ceux simulés en mode test, ni ceux en attente du créateur : un cadeau annoncé puis refusé
  décevrait).
- **L'essai de l'équipe** montre les jours mérités comme un membre les recevrait en mode
  automatique.

### Les annonces des jalons (migration 0023)

- **Le créateur choisit où** (Réglages → « Annonces des jalons », rien par défaut) parmi les
  endroits où StayPut peut publier maintenant : les chats Whop de la communauté (lus avec
  `chat:read` ; y publier demande en plus `chat:message:create`, à ajouter avec les autres
  permissions), les salons des serveurs Discord reliés où le bot peut écrire (Voir le salon et
  Envoyer des messages, calculés comme Discord : rôles, puis exceptions du salon), les groupes
  Telegram reliés. Le serveur refuse un endroit qui n'est pas dans cette liste. Le bot Discord
  n'a pas demandé « Envoyer des messages » à son installation : il écrit là où @everyone (ou son
  rôle) le peut, ce qui est le cas des salons ouverts de la plupart des serveurs.
- **Le membre décide** : après un jalon (ou l'objectif atteint), la fête lui propose « Le
  partager avec la communauté ? » avec le texte exact, dans la langue de la communauté. Seuls
  son prénom, le titre de son objectif et le jalon sont publiés, jamais ses chiffres (un revenu
  ne regarde que lui). Une fois par objectif et par jalon.
- **Une action comme les autres** (`milestone_announcement`, déclencheur `member_request`) :
  arrêts, « ne jamais contacter », mode test (simulée, le membre lit que la communauté est en
  mode test), mode manuel (elle attend la validation du créateur, le membre le lit). Pas
  d'heures de silence : ce n'est pas un message au membre. Le créateur la voit dans l'onglet
  Actions avec son texte et l'endroit.
- **Sur Discord, personne n'est mentionné** (`allowed_mentions` vide), et un `nonce` empêche une
  double publication si la réponse de Discord se perd ; sur Whop, la clé d'idempotence habituelle.
  Une panne (5xx, 429, réseau) est retentée comme les autres actions ; un refus (permission
  absente) est définitif et visible dans l'onglet Actions.
- **La tâche horaire** sait désormais publier sur Discord et Telegram (une action validée en mode
  manuel part au passage suivant).
- **L'essai de l'équipe** montre la proposition de partage avec le texte, et dit qu'en essai rien
  n'est publié.

### Les cartes témoignage et leur page publique (migration 0024)

- **La carte est dessinée dans le navigateur du membre** (canvas, 1080 × 1350 : le portrait que
  les réseaux montrent en entier), à partir d'un de ses résultats : l'objectif, le chemin
  (« 0 € → 3 250 € »), la part de l'objectif et la cible, le niveau de preuve, la date, son nom
  s'il l'a coché (décoché par défaut), un QR code vers sa page publique, et « et rejoindre
  {communauté} » s'il a un lien d'affiliation. Ses couleurs sont les siennes, quel que soit le
  thème de la page. Le QR code (`qrcode-generator` 2.0.4, licence MIT, sans dépendance, correction
  M) a des modules en pixels entiers et une marge blanche de 4 modules : un lecteur indépendant
  (jsQR) le décode en taille réelle et réduit à 35 %, avec l'adresse de production.
- **Le chemin n'est jamais coupé** (correctif du 2 octobre) : avec une unité en mots, la carte
  d'essai affichait « 0 séances → 6… ». Le chemin prend la plus grande taille qui tient sur une
  ligne (de 88 à 56 px) ; au-delà, il passe sur deux lignes, coupées après la flèche, aussi
  grandes que la place au-dessus du QR code le permet (36 px au moins). Vérifié dans Chromium
  avec « séances », « heures de pratique » et la pire mise en page (communauté sur deux lignes,
  objectif sur trois, chemin sur deux) : rien ne touche le QR code.
- **Téléchargement en PNG** par une adresse `data:` (la politique de sécurité du site les
  autorise déjà pour les images). Dans le cadre de Whop, un téléchargement peut être bloqué : la
  carte s'affiche en image, que le membre enregistre d'un appui long ou d'un clic droit (c'est
  écrit dessous). Le lien de la page se copie ou se sélectionne.
- **La page publique `/v/:proofId`** est du HTML rendu par le Worker, sans script, dans la langue
  de la communauté : le résultat, son niveau de preuve, sa date, une note qui explique les
  niveaux, et le bouton « Rejoindre » vers le lien d'affiliation. Sa politique de sécurité
  n'autorise que son propre style (son empreinte SHA-256 ; la largeur de la barre est une classe,
  pas un style en ligne) ; `noindex`. Une preuve jamais publiée, retirée, ou d'une communauté qui
  a désinstallé StayPut donne une page « Cette page n'existe pas » (404), dans la langue du
  navigateur.
- **Ce que la page montre est figé** quand le membre crée la carte (`proofs.public_display`) : un
  nom ou un titre changé ensuite ne modifie pas une page que d'autres ont vue. Refaire la carte du
  même résultat la met à jour, à la même adresse. La date est le jour du résultat dans le fuseau
  de la communauté, pour que la carte et la page disent la même.
- **Une preuve par résultat** (index unique de 0024) : celle de la capture (« appuyé par une
  capture »), ou une preuve « déclarée » que la carte crée, en une seule instruction (deux
  demandes au même moment font une seule preuve). Une carte ne fait jamais passer un résultat
  déclaré pour appuyé.
- **Retirer la page** vide ce qu'elle montre : son QR code ne mène plus à rien. L'image déjà
  téléchargée reste chez le membre ; seul le membre peut retirer sa page.
- **Le lien d'affiliation (SPEC 5.6)** : l'API permet de lire celui d'un membre déjà affilié
  (`GET /users/{id}` pour son nom d'utilisateur, `GET /affiliates?account_id=…&query=…` pour
  trouver l'affilié dont l'utilisateur est le membre, puis `GET /affiliates/{id}/overrides` :
  le `product_direct_link` d'une commission par variante), avec la permission
  `affiliate:basic:read`. Elle permet aussi de créer un affilié (`POST /affiliates`), mais un lien
  n'existe qu'avec une commission (« override ») : c'est une décision d'argent du créateur,
  StayPut ne crée donc rien. Sans lien lu, le membre colle le sien. Seules les adresses whop.com
  (et ses sous-domaines, `sandbox.whop.com` compris) sont acceptées : une page publique n'envoie
  jamais ailleurs. StayPut lit le lien à l'ouverture du formulaire de la carte (jamais pour
  l'équipe), et le montre aussi au membre qui accepte l'invitation « départ vers affiliation »
  (Phase 4) ; sans lien, ce membre lit toujours qu'il recevra les détails.
- **L'essai de l'équipe** dessine la carte comme celle d'un membre (« Votre nom » à la place du
  nom, sans nom de communauté) ; rien n'est publié, il n'y a pas de page à ouvrir.

### Les binômes (migration 0025)

- **Éteints par défaut** : le créateur les allume dans Réglages → « Binômes », qui montre aussi
  les binômes en cours, les nouveaux en attente, les vétérans disponibles et les mentors.
- **Qui est associé** : chaque nouveau membre (arrivé il y a moins de 7 jours) reçoit un vétéran :
  un membre depuis plus de 30 jours dont le risque est faible, du même type d'objectif quand il y
  en a un (« Autre » ne compte pas), puis le moins pris (3 binômes en cours au plus), le plus
  engagé (score le plus bas), le plus ancien. Les nouveaux que le radar d'activation signale
  passent en premier. Ni l'équipe, ni la liste « ne jamais contacter », ni un membre qui a refusé.
- **Interprétation de la SPEC** : la Phase 5 (point 8) parle de tout nouveau membre ; le tableau
  des déclencheurs de la Phase 4 rattache le binôme au radar d'activation. J'ai suivi la Phase 5,
  avec la priorité au radar : avec le radar seul, aucun nouveau n'aurait d'objectif (en fixer un
  est une activité), et la règle « même type d'objectif » ne servirait jamais.
- **La présentation** : deux actions, `buddy_intro` au nouveau et `mentor_intro` au vétéran
  (déclencheur `buddy_pair`), des relances comme les autres : heure d'or, garde-fous (espacement
  et plafonds), mode test (simulées), mode manuel (validées par le créateur). Modèles FR et EN
  modifiables, avec la variable `{buddy_name}` (le prénom de l'autre). Un vétéran n'est associé
  qu'une fois tous les 5 jours : l'espacement des garde-fous bloquerait sinon sa deuxième
  présentation.
- **Le binôme existe dès l'association** : chacun le voit dans son espace (le nom de l'autre,
  depuis quand il est membre, le type d'objectif s'il est le même), même quand la présentation
  attend le créateur ou est simulée en mode test.
- **La fin** : l'un des deux part, refuse (« Pas de binôme pour moi »), ou passe sur la liste
  « ne jamais contacter » : le binôme s'arrête, ses présentations pas encore parties sont
  annulées, et un nouveau qui a encore moins de 7 jours reçoit un autre vétéran (jamais le même
  deux fois). Éteindre les binômes arrête les nouvelles associations ; celles en cours vont à
  leur terme.
- **Le badge Mentor** : 30 jours après l'association, si le nouveau est toujours là, le vétéran
  le gagne (une fois). L'espace d'un vétéran le montre « à obtenir » tant qu'il accueille
  quelqu'un.
- **Vie privée** : chacun ne voit de l'autre que son nom, depuis quand il est membre et le type
  d'objectif s'il est le même ; jamais un score ni des chiffres.
- **Ce qui manque** : l'API ne permet pas à une app d'ouvrir une conversation privée entre deux
  membres (Phase 0 : messages privés « INCERTAIN », non utilisés). La présentation leur dit de se
  saluer dans la communauté.
- **L'essai de l'équipe** n'a pas de binôme : ils se font entre membres réels.

### Les défis de sauvetage (migration 0026)

- **Éteints par défaut** : le créateur les allume dans Réglages → « Défis de sauvetage », qui
  montre les défis ouverts, les membres revenus en 30 jours et les sauveteurs.
- **Le défi** : un membre inactif depuis 14 jours (dans la communauté depuis 14 jours au moins)
  devient un défi que les membres voient dans leur espace : « Aidez un membre qui a décroché :
  répondez à son dernier message ». Sans son nom : seulement l'endroit (Discord, Telegram, le
  chat Whop), le nom du serveur ou du groupe, depuis quand il s'est tu, et un lien vers son
  dernier message quand la plateforme en donne un (un message Discord ; un message d'un
  supergroupe Telegram, que ses membres peuvent ouvrir). Le chat Whop ne donne pas de lien vers
  un message : le défi dit seulement « Dans le chat Whop ».
- **Seulement un membre qu'on peut aider** : il faut que StayPut connaisse son dernier message
  (90 jours au plus) ; sinon il n'y a rien à quoi répondre. Jamais l'équipe, ni la liste « ne
  jamais contacter ».
- **Mesure** : 10 défis ouverts au plus par communauté, les membres qui ont décroché le plus
  récemment d'abord (les plus faciles à faire revenir) ; un défi dure 14 jours ; une fois par mois
  au plus pour un même membre. Un membre voit 5 défis au plus, ceux que personne n'a encore pris
  d'abord, jamais le sien.
- **Le badge Sauveteur** : un membre « s'en occupe » ; si le membre décroché revient (n'importe
  quelle activité après la création du défi), ceux qui s'en occupaient avant son retour gagnent
  le badge (une fois). StayPut ne peut pas vérifier qu'ils ont vraiment répondu : il note qui a
  pris le défi avant le retour.
- **Vie privée** : StayPut ne dit jamais de qui il s'agit. Le lien mène au message là où il a
  été écrit, dans un endroit que les membres voient déjà ; c'est le prix de « répondez à son
  dernier message », et c'est pourquoi les défis restent éteints tant que le créateur ne les
  allume pas.
- **L'essai de l'équipe** n'a pas de défi : ils portent sur des membres réels.

### Le nom de la communauté (correctif)

Le parcours du membre fictif a montré que StayPut ne connaissait pas le nom des communautés :
`companies.name` n'était jamais rempli, et `{creator_name}` restait vide dans les messages
(« Content de t'avoir dans . »), les cartes et leurs pages. StayPut le lit désormais chez Whop
(`GET /accounts/{id}`, son `title`, avec `company:basic:read`) à chaque synchronisation lancée
depuis le tableau de bord, et dès qu'il manque. Les modèles par défaut mettent aussi
`{creator_name}` dans une partie facultative : sans nom, la phrase reste juste (« Content de
t'avoir. »).

**2 octobre** : le menu du tableau de bord affichait encore `biz_2whAzkbCRpcGqQ` au lieu du nom.
`GET /accounts/{id}` répond **403** à la clé de l'app (la clé de compte du sandbox, elle, y a
droit : d'où l'essai trompeur) ; `GET /companies/{id}` répond 200 avec le `title`
(« StayPut Test »), avec la permission `company:basic:read` déjà accordée. StayPut lit donc
`/companies/{id}`. Inspect le vérifie avec la clé de l'app (`scripts/ops/whop-permissions.ts`),
et le faux Whop des tests répond 403 sur `/accounts/…`, comme en ligne.

### Le parcours d'un membre fictif (arrêt de la phase 5)

Le 2 octobre, sur le sandbox, le workflow « Seed sandbox » (action `journey`) a fait faire tout le
chemin à Léa Moreau, une des membres fictives, par les fonctions mêmes du Worker : un objectif
(0 € → 3 000 € de chiffre d'affaires mensuel), trois résultats (800 €, 1 650 € appuyés par une
capture, 2 400 €), les jalons de 25, 50 et 75 % et cinq badges, puis la carte témoignage du
résultat appuyé, dont la page publique est en ligne. La carte a été dessinée par le code de
l'application dans Chromium ; son QR code, décodé par un lecteur indépendant, mène à cette page.

- **La capture d'écran** d'un membre fictif ne passe pas par un navigateur : le parcours donne ce
  que le navigateur envoie (l'empreinte de l'image et les nombres lus). La lecture elle-même a été
  vérifiée dans un vrai navigateur, sous la politique de sécurité du site (étape 2).
- **Le parcours a trouvé un défaut** : le nom de la communauté manquait partout (voir le
  correctif ci-dessus).

### L'espace membre réuni dans le tableau de bord (2 octobre, demande du fondateur)

Le fondateur n'avait l'espace membre que « par petits morceaux » : le tableau de bord dans le
cadre de Whop, l'espace membre par un autre lien (la vue expérience), une carte témoignage reçue
en image, sa page par un lien. Un onglet **Espace membre** du tableau de bord réunit tout, pour
l'équipe :

- **Les chiffres sur 30 jours** : objectifs en cours (et atteints depuis le début), résultats
  notés et ceux qu'une capture appuie, membres actifs dans leur espace (ouverture, objectif ou
  résultat : un membre qui note un résultat a utilisé son espace), badges gagnés, cartes en ligne.
  Lus en tant que créateur, sous RLS, comme le reste du tableau de bord.
- **Les cartes témoignage en ligne** (les 6 plus récentes, et combien en tout) : dessinées dans le
  navigateur comme le membre les a partagées, QR code compris, avec « Ouvrir sa page » et
  « Copier le lien ». Ce sont déjà des pages publiques : l'équipe n'y voit rien de plus que ce que
  le membre a montré. Elle ne peut pas les retirer : seul le membre le peut.
- **L'entraide** : binômes et défis de sauvetage, allumés ou non, en cours, avec le lien vers
  leurs réglages (qui restent dans Réglages, où le fondateur les connaît).
- **L'espace des membres à essayer** : le questionnaire de départ avec les offres du créateur,
  puis l'objectif, les résultats, la carte et les badges, exactement comme la vue membre les
  montre à l'équipe (rien n'est enregistré ni envoyé). Les mêmes composants, servis par
  `/api/creator/:companyId/preview/retention` et `…/preview/space` : plus besoin de connaître
  l'expérience de StayPut dans la communauté pour les voir.

### La structure du tableau de bord : un menu de rubriques, des onglets en haut (2 octobre)

Demande du fondateur : un menu de rubriques dans StayPut (Tableau de bord, Espace membre, Membres,
Actions, Analyses, Sources d'activité, Réglages), et dans chaque rubrique plusieurs onglets en
haut, avec des mots anglais que tout créateur comprend ; garder le choix de la langue et du thème.

- **Le menu** est une colonne à gauche de StayPut, juste à droite du menu de Whop, qu'elle
  prolonge (lu ainsi : « à droite », c'est-à-dire dans le cadre de StayPut). Il porte en tête la
  communauté et « Vue de l'équipe », et en bas « Se déconnecter » hors de Whop. Sur un téléphone,
  il devient une rangée à faire défiler, au-dessus de la rubrique. La langue et le thème restent
  dans la barre du haut, comme avant.
- **Les mots anglais** (le français suit) : Dashboard, Member space, Members, **Automations**
  (plutôt qu'« Actions », trop vague : ce que StayPut fait de lui-même, validé ou non),
  **Analytics** (le mot des outils de créateurs), **Integrations** (plutôt que « Activity
  sources » : on y connecte Discord et Telegram), Settings.
- **Les onglets**, une seule chose chacun : Dashboard (Overview, Needs attention, New members),
  Member space (Overview, Testimonials, Member view), Members (All members, Never contact :
  nouvel onglet, la liste « ne jamais contacter » réunie), Automations (To approve, Scheduled,
  History, Alumni offer), Analytics (Cohorts, Lessons), Integrations (Whop, Discord, Telegram,
  Activity), Settings (Risk score, Automations, Member space). La vue d'ensemble garde les cinq
  premiers membres à surveiller et nouveaux membres, avec « Tout voir » vers leur onglet.
- **Les nombres** sur les onglets quand l'écran les connaît : membres (tous, ne jamais
  contacter), actions (à valider, programmées, historique).
- **Les adresses** : une par onglet (`/dashboard/<communauté>/<rubrique>/<onglet>`), la page
  d'accueil d'une rubrique est son premier onglet ; une adresse inconnue y mène, et
  `/actions?view=history` mène à l'onglet Historique. Le retour après l'ajout du bot Discord
  ouvre Intégrations → Discord.
- **La mise en page** suit la place laissée à côté du menu (requêtes de conteneur de Tailwind) et
  non la largeur de la fenêtre : dans le cadre de Whop (environ 1 300 px), les six chiffres du
  tableau de bord passent sur deux lignes de trois au lieu d'être serrés sur une. La page est
  plus large (1 280 px au plus au lieu de 1 152).

### Reste à faire dans cette phase

- Les permissions à ajouter dans Whop, avec celles de la phase 4 : `chat:read` et
  `chat:message:create` (annonces dans un chat Whop), `affiliate:basic:read` (lien d'affiliation
  sur les cartes).
- Un vrai membre de test (un second compte Whop dans la communauté du sandbox), pour les
  parcours qu'un membre fictif ne peut pas faire : ouvrir l'espace dans Whop, lire une vraie
  capture, recevoir les notifications.

## 2026-10-02 — Refonte du design, étape 1 : fondations et tableau de bord

La demande du fondateur (2 octobre) : faire de StayPut un produit haut de gamme, animé, sans rien
retirer des fonctions ni des données ; appliquer les huit correctifs obligatoires ; avancer page
par page (Tableau de bord → Membres → Intégrations → Automatisations → Analyses → Espace membre →
Réglages), avec un arrêt et une validation après chacune. Cette étape livre les fondations et le
tableau de bord.

### Les choix techniques

- **React + Vite restent** (SPEC §2), servis par le Worker sur la même origine : c'est ce qui
  permet au jeton Whop de l'iframe d'arriver à l'API. Passer à Next.js ou à Cloudflare Pages ne
  changerait rien à l'écran et casserait une architecture validée.
- **Pas de Frosted UI comme base** : il n'en existe qu'une version d'essai (`0.0.1-canary.161`)
  et son style n'est pas celui de la marque. Nos propres composants reprennent ce qui fait le
  confort de Whop : fenêtres natives (`<dialog>`), clavier, anneaux de focus menthe.
- **Ajouts** : `motion` (l'ex-Framer Motion, licence MIT) et les polices Space Grotesk et Inter,
  servies par StayPut lui-même (la politique de sécurité n'autorise aucune autre origine).
  Recharts arrivera avec les Analyses, chargé à la demande. Budget : 0 €.

### Couleurs, polices, animation

- Les couleurs sont prises sur le logo officiel ; le thème sombre est celui par défaut, le clair
  garde la même hiérarchie. Un test calcule les contrastes (WCAG AA) de chaque paire texte/fond
  dans les deux thèmes ; les couleurs des niveaux de risque sont vérifiées pour les daltoniens.
- Les jetons sont décrits dans `docs/design-tokens.md`, l'animation dans `MOTION.md` : une seule
  courbe, 150 / 250 / 400 ms, aucun rebond sur une donnée ; quand l'appareil demande moins de
  mouvement, seuls les fondus restent et les chiffres s'affichent tout de suite.
- Dans les tests, les animations se terminent aussitôt (`test/setup.ts`) : on vérifie ce que les
  écrans disent, pas comment ils bougent.

### L'argent sauvé (SPEC 6.4)

- `packages/core/src/attribution.ts` applique les règles du cahier des charges dans l'ordre :
  **direct** (paiement échoué rattrapé dans les 14 jours, annulation retirée dans les 7 jours
  après une offre gardée, pause qui reprend, retour avec le code de StayPut) puis **influencé**
  (renouvellement après un message, le membre ayant été actif dans les 14 jours). Un paiement ne
  compte qu'une fois ; seules les actions vraiment envoyées comptent (rien en mode test).
- Une tâche horaire (`countSaves`) enregistre les sauvetages ; migration 0027
  (`attribution_facts`, `record_saves`).

### Écrire, Pause, Offre depuis le tableau de bord (correctif 2)

- **Écrire** part en un clic ; **Pause** et **Offre** demandent une confirmation qui montre ce que
  le membre recevra exactement (les conditions réglées dans Réglages › Automatisations).
- Tout passe par les garde-fous, comme les actions de StayPut : un message du créateur par membre
  et par jour, une seule offre ouverte par membre (7 jours pour l'accepter dans son espace), rien
  pour un membre « ne jamais contacter », pas de Pause ni d'Offre sans abonnement payant.
- Table `creator_offers` et routes `/members/message`, `/members/:id/offer`,
  `/retention/creator-offer` (migration 0027).

### Le nom et le logo de la communauté (correctif 4)

- Lus chez Whop (`/companies/{id}`, que la clé de l'app a le droit de lire). Le logo est servi
  par StayPut (`/api/creator/:id/logo`) car la page n'affiche que des images de sa propre adresse :
  seulement une adresse https donnée par Whop, une image de 1 Mo au plus, gardée un jour par le
  navigateur. Sans logo : les initiales de la communauté sur le menthe de la marque.
- L'identifiant `biz_…` n'apparaît plus dans l'en-tête ; il ira dans Réglages › Développeur.

### Le cadre

- Un menu latéral qui se replie sur ses icônes (le choix est gardé sur l'appareil), la rubrique
  ouverte marquée d'une barre menthe qui glisse ; en haut, la communauté (nom et logo), la
  recherche d'un membre (accents ignorés), la langue (EN / FR, immédiate), le thème et l'aide.
- Sur un téléphone, une barre en bas : Tableau de bord, Membres, Automatisations, Analyses, et
  « Plus » pour le reste.
- Les rubriques suivent l'ordre du brief (Membres en deuxième). Une rubrique sans second onglet
  n'affiche plus de rangée d'onglets. Chaque page arrive en fondu en montant de 8 px ; le cadre ne
  bouge jamais.

### La page d'accueil

- **L'argent d'abord** (correctif 1) : revenus sauvés ce mois-ci (le plus grand, avec la lueur
  menthe), revenus à risque, membres à risque, rétention à 30 jours. Chaque chiffre compte jusqu'à
  sa valeur et s'éclaire quand il change (menthe s'il s'améliore, rouge s'il empire).
- **L'action du jour** (correctif 2) : une seule, un seul bouton. « En jeu » est ce que paient ces
  membres, jamais une promesse de ce qui sera sauvé. Le message part au nom du créateur, à la
  meilleure heure du membre, dans les garde-fous.
- **À surveiller** : les départs et les risques élevés, avec la raison principale, la date de
  départ ou de renouvellement, ce que paie le membre, et Écrire / Pause / Offre sur place.
- **Activité en direct** : relue toutes les 30 secondes ; une nouvelle ligne glisse du haut avec
  un éclat menthe.
- **Le risque** : une barre par niveau (chaque niveau mène à ses membres) et la tendance des
  membres à risque sur 30 jours.
- **Les chiffres secondaires** (correctif 3) : membres et nouveaux de la semaine, revenu mensuel,
  « Activité des membres (30 j) » et, à part, « Actions de StayPut (30 j) ».
- Le mode test est dit en haut de la page et sur la carte de l'action du jour.

### Le mode démo

- `/demo` ouvre le même tableau de bord sur une communauté imaginaire, « Atlas Trading Club » :
  56 membres aux noms réalistes, des mois d'historique, 3 annulations programmées, 2 paiements
  échoués, des sauvetages, un fil d'activité qui bouge. Tout est calculé dans le navigateur à
  partir des membres, comme le Worker calcule les vrais chiffres : rien n'est réel, rien n'est
  envoyé, aucun appel ne part vers StayPut. La même communauté à chaque visite (captures
  identiques) ; ce que l'on y fait (écrire, offrir) la change jusqu'au rechargement.
- Chaque écran de la démo le dit (« Données de démo ») et offre « Quitter la démo », qui ramène
  au tableau de bord d'où l'on vient. On y entre par l'aide : « Explorer avec des données de
  démo ». Elle est ouverte à tous : pratique pour les captures de l'App Store et pour montrer
  StayPut, sans risque puisqu'elle ne contient rien de vrai.
- Les autres rubriques n'ont pas encore leurs données de démo et le disent ; chacune les recevra
  à son étape.

### Limites connues

- Le JavaScript de la page pèse 263 Ko compressés : à alléger en chargeant les rubriques à la
  demande, prévu avec les pages suivantes.
- Les autres pages gardent leur ancien style jusqu'à leur étape.
- La recherche du haut cherche parmi les membres que le tableau de bord a lus.

## 2026-10-02 — Refonte du design, révision : le nouveau brief

Le fondateur a remplacé le premier brief par un brief complet (« StayPut — Full UI redesign
prompt ») : moins de couleurs, une page d'accueil plus légère, l'espace membre hors de la V1,
l'anglais par défaut avec la langue seulement dans les Réglages. Ordre de travail : jetons →
composants → Tableau de bord → Membres → Intégrations → Automatisations → Analyses → Réglages →
Prise en main et Guide, avec un arrêt après chaque page. Cette révision livre les jetons, les
composants et le **Tableau de bord**, pour valider d'abord les couleurs et la typographie.

### Ce qui ne change pas, et pourquoi

- **React + Vite restent** (le brief cite Next.js, Frosted UI et Cloudflare Pages comme pile
  « existante ») : la pile réelle est celle du SPEC §2, validée et en ligne ; les raisons de
  l'étape 1 tiennent toujours (même origine pour le jeton de l'iframe, Frosted UI seulement en
  version d'essai).
- **Pas de Recharts** : mesuré pour ce seul graphique en aires, 109 Ko compressés (372 Ko
  minifiés, avec Redux, Immer et d3), quand toute la page en pèse 265. Et son moteur anime chaque
  point en JavaScript avec ses propres courbes, à l'inverse de la règle du brief (transform et
  opacity seulement, une seule courbe). Le graphique est dessiné par StayPut en SVG (quelques Ko) :
  courbe lissée qui ne dépasse jamais ses points, dégradé menthe qui s'efface, réticule et
  infobulle, flèches du clavier, phrase et tableau pour les lecteurs d'écran.

### Périmètre : l'espace membre hors de la V1

- Tout le code reste, éteint par `MEMBER_SPACE_ENABLED = "false"` (Worker, `wrangler.toml`) et
  `VITE_MEMBER_SPACE_ENABLED` (au build du site, absent donc éteint). Éteint : ni rubrique ni
  onglet de réglages, ses routes répondent 404, les binômes et les défis de sauvetage ne sont plus
  planifiés, la page publique d'une carte dit qu'elle n'existe plus.
- Reste, car c'est le pilier « Agir » : le questionnaire de départ et l'offre de sa raison
  (pause, jours offerts, code promo, aide, et l'invitation à recommander la communauté quand le
  membre a atteint son objectif), le paiement à régler, l'Alumni et le lien Telegram. Le lien
  d'affiliation de cette invitation a sa propre route, `/retention/affiliate`, pour ne pas
  dépendre de l'espace membre (trouvé en relisant les tests).
- Sans espace membre, la vue membre s'intitule « Votre abonnement » et dit simplement quand rien
  n'attend le membre.

### Navigation et langue

- Six rubriques, dans l'ordre du brief : Tableau de bord · Membres · Automatisations · Analyses ·
  Intégrations · Réglages. Le bouton **Guide** est dans la barre du haut.
- **Anglais par défaut, jamais deviné** depuis le navigateur. La langue ne se change qu'à un
  endroit : Réglages › Général (English / Français), tout de suite, chiffres, dates et montants
  compris. Le thème y est aussi : la barre du haut ne garde que la communauté, la recherche et le
  Guide. L'identifiant `biz_…` n'apparaît que dans Réglages › Général › Développeur.
- **La vue membre parle la langue des messages de la communauté** (`companies.locale`, réglée
  dans Automatisations) : le membre n'a pas choisi la langue de StayPut et le brief interdit de
  deviner celle de son navigateur ; c'est aussi la langue de ce que StayPut lui écrit.

### Discipline des couleurs et de la typographie

- Un seul accent : le menthe sur le presque-noir. Plus d'ambre : les tons « avertissement » et
  « sérieux » sont devenus de l'argent. Les niveaux de risque n'ont plus de couleur : l'anneau
  menthe et le nom du niveau les disent.
- Le rouge seulement pour l'urgent (départ dans les 48 heures, paiement échoué non rattrapé,
  erreur d'automatisation, suppression), en point ou en petit badge, dit aussi en mots aux
  lecteurs d'écran. Les revenus à risque sont en argent.
- Cartes : `bg-elevated` à 60 %, bordure menthe à 12 %, rayon de 12 px. Le mode test est une
  fine ligne bordée de menthe, texte discret.
- Space Grotesk 600 seulement ; chiffres héros de 40 px, le **revenu sauvé** à 48 px et seul dans
  le dégradé argent → menthe du logo (le brief veut le revenu à risque en argent : le dégradé
  reste au chiffre à mettre en avant). Titres de page 24 px, étiquettes 12 px en capitales.
- Deux tailles de texte par carte au plus : l'explication passe derrière un « i » (`InfoTip`).
  Un seul bouton menthe par écran ; pendant une action, une roue remplace le texte du bouton sans
  en changer la taille.

### La page d'accueil : cinq choses seulement

1. **Trois chiffres** qui comptent jusqu'à leur valeur : revenus sauvés ce mois-ci (avec sa
   lueur), revenus à risque, membres à risque.
2. **L'action prioritaire du jour** : une phrase, ce qui est en jeu (ce que paient ces membres,
   jamais une promesse), le seul bouton menthe de la page.
3. **Le graphique** revenus sauvés / revenus à risque sur 7, 30 ou 90 jours. « Sauvés » est
   l'argent que StayPut a récupéré lui-même (sauvetages directs), **additionné** depuis le début
   de la période ; « À risque » est, chaque jour, ce que payaient par mois les membres en départ
   ou à risque élevé ce jour-là, dans la devise principale de la communauté. Un jour sans score
   n'a pas de chiffre (pas un faux zéro) ; aujourd'hui reprend le chiffre en direct du haut de
   la page.
4. **À surveiller** : les 5 membres les plus urgents, dans cet ordre : départ dans les
   48 heures ou paiement échoué (point rouge), puis les départs, puis les scores les plus hauts,
   puis la fin la plus proche. Anneau du score, raison (le paiement échoué d'abord), date de
   départ ou de renouvellement, ce que paie le membre, Écrire / Pause / Offre.
5. **Les actions de StayPut (30 j)** : messages envoyés, paiements relancés, pauses proposées
   (une réponse au questionnaire dont l'offre était une pause, ou une Pause du créateur), membres
   sauvés (distincts).

Quittent l'accueil : la rétention et l'activité des membres (vers Analyses), le fil en direct, la
répartition du risque, les nouveaux membres inactifs (ce sera un filtre de Membres), les chiffres
de la communauté et la synchronisation (Intégrations › Whop).

### « Pour bien démarrer »

- Au-dessus des chiffres tant qu'elle n'est pas finie, puis elle disparaît. Quatre étapes, chacune
  mène à son écran : **Connecter Discord** (un serveur connecté), **Activer votre première
  automatisation** (le mode automatique, ou une action validée ou faite à la main par le
  créateur), **Passer en revue vos membres à risque** (la page Membres ouverte une fois),
  **Régler les garde-fous** (Réglages › Automatisations enregistrés une fois).
- Migration **0028** : deux dates dans `company_settings` (`guardrails_saved_at`,
  `at_risk_reviewed_at`), posées une seule fois par `getting_started_done` ; la route
  `POST /getting-started/reviewed`. Gardées sur le serveur, pour être les mêmes sur tous les
  appareils de l'équipe.

### La démo

- 90 jours d'historique : un paiement sauvé tous les 3 à 6 jours (surtout des abonnements
  mensuels, parfois un VIP, une fois un abonnement annuel), environ 15 à 20 % du revenu mensuel
  sauvé : crédible, pas miraculeux. Les revenus à risque descendent de 1 180 $ à 641 $ en trois
  mois, avec le bruit d'une vraie communauté. Le chiffre du mois est celui du calendrier : il est
  petit en début de mois, comme pour une vraie communauté.
- « Pour bien démarrer » à moitié faite (Discord et une automatisation) : elle se coche quand on
  ouvre Membres et qu'on enregistre les garde-fous.

### Reste à faire (pages suivantes)

- Membres (tableau, filtres collants, tiroir du membre), Intégrations (tableaux de bord Discord et
  Telegram), Automatisations (règles, modèles), Analyses (rétention, raisons de départ, prévision
  à 90 jours), Réglages (le reste des onglets), Prise en main en 4 étapes et Guide à 5 sujets avec
  vidéos ; les réponses au questionnaire de départ dans la démo (pour Analyses).
- Le JavaScript pèse toujours 265 Ko compressés : le découpage par rubrique est prévu avec les
  pages suivantes.

### Correctif du 2 octobre : « Un obstacle » sur les pages de la démo

- Le fondateur a vu « Un obstacle » sur toutes les pages : c'était le panneau d'erreur de la démo,
  qui n'avait de données que pour le tableau de bord, Membres et une partie des Intégrations et des
  Réglages. 8 pages sur 16 s'arrêtaient sur « Cette page n'a pas encore de données de démo ».
- Chaque page a maintenant ses données, tirées des mêmes 56 membres (`apps/web/src/demo/pages.ts`) :
  6 actions à approuver, 3 programmées et 11 passées (dont une arrêtée par un garde-fou), les
  cohortes par mois d'arrivée (juillet signalé), deux leçons bloquantes, l'activité Discord et
  Telegram sur 30 jours, les personnes et les comptes à relier, le score de risque de la niche
  trading, l'offre Alumni et les salons Discord. Approuver, annuler, relier un compte, enregistrer
  : tout marche jusqu'au rechargement de la page.
- L'action du jour de la démo suit maintenant ces actions, comme le vrai calcul : « Approuver
  6 actions » d'abord (mode manuel), puis le membre à haut risque que personne n'a joint.
- Le test qui ouvre chaque page de la démo a trouvé un vrai bogue : après « Approuver », le bouton
  de l'action suivante restait bloqué sur « fait ». Chaque nouvelle action du jour est maintenant
  une nouvelle carte.
- Le panneau d'erreur s'appelle « Cette page n'a pas pu s'ouvrir » (plus « Un obstacle »), en
  argent et non en rouge ; une donnée de démo manquante s'affiche en état vide calme, jamais en
  erreur.

## 2026-10-02 — Refonte du design, v3 : noir · turquoise · blanc

Le fondateur a envoyé une troisième version du brief (« v3 : black · turquoise · white ») avec
la consigne « exécute étape par étape pour ne rien oublier ». Ordre : jetons et logo →
composants → **Tableau de bord**, puis arrêt pour valider couleurs, typographie, mise en page et
animation, avant Membres → Intégrations → Automatisations → Analyses → Réglages → Prise en main
et Guide. Cette étape livre les jetons, le logo, les composants, le cadre et le Tableau de bord.

### Ce qui ne change pas

- React + Vite et le graphique SVG dessiné par StayPut (pas de Next.js, pas de Recharts) : les
  raisons de la révision précédente tiennent toujours.

### La palette exacte, un seul thème

- Les douze couleurs du brief, exactement (`apps/web/src/styles.css`). La palette de Tailwind
  est coupée (`--color-*: initial`) : une couleur absente n'existe pas. Le test des contrastes
  vérifie chaque valeur, que chaque couleur écrite dans le code en fait partie (transparence
  permise) et que chaque paire texte / fond atteint WCAG AA.
- **Thème sombre seul** (« the only theme in V1 ») : le thème clair, son réglage et son script
  de démarrage sont retirés.
- Le dégradé signature blanc → turquoise clair sur le chiffre héros, le bouton principal (texte
  noir) et le ruban du logo, nulle part ailleurs. Le turquoise plein seulement sur des éléments
  fins (lignes, anneaux, bordures de 1 px, texte).
- Décor : une lueur radiale de 700 px derrière le bloc héros (un dégradé, pas un flou), une
  traînée diagonale turquoise à 6 %, et le logo à 3 % en bas à droite du Tableau de bord. Ce
  filigrane est posé après le dernier bloc : fixé au coin de l'écran, il passait derrière la
  courbe du graphique et ressemblait à un défaut des données.
- Rouge : un point ou un petit badge à 70 %, seulement pour l'urgent.

### Les polices : Satoshi et Geist

- **Geist** (Vercel, licence OFL), installée par npm.
- **Satoshi** (Indian Type Foundry, licence ITF FFL 2.0, Fontshare) : la licence permet de
  l'utiliser dans notre app, mais interdit de redistribuer les fichiers, notamment par un dépôt,
  et celui de StayPut est public. Elle est donc téléchargée chez Fontshare à chaque déploiement
  (`scripts/deploy/satoshi.ts`, étape « Fetch the Satoshi font from Fontshare » avant le build),
  jamais commitée (`apps/web/public/fonts/` est ignoré par Git), jamais convertie ni découpée.
  L'empreinte SHA-256 du paquet relu est notée (`SATOSHI_SHA256`) : si Fontshare change le
  paquet, le déploiement continue et le signale. Si le téléchargement échoue, le site part sans
  Satoshi (Geist prend sa place) et le contrôle « look » d'Inspect échoue pour le dire.
- Le proxy de la session de travail bloque fontshare.com : la licence et le contenu du paquet ont
  été lus par le workflow Inspect (étape « Read Fontshare's Satoshi package »).
- Space Grotesk et Inter sont retirés (le brief les interdit).

### Le logo

- Le ruban du « S » recoloré blanc → turquoise clair, forme et lumière gardées, sur un carré noir
  pur ; les traînées des coins en turquoise. Exports 64 / 128 / 256 px, favicon 32 px,
  apple-touch-icon.

### Les composants

- Faits : MetricHero et SecondaryMetric, AreaChart, RiskRing, la ligne de membre
  (`MemberListRow`), Drawer, ActionButton (primaire en dégradé, fantôme), Toast, EmptyState,
  Skeleton, GettingStartedPill, LabelTip (l'infobulle portée par le libellé lui-même), UrgentDot.
- Avec leurs pages : RiskBadge (Membres), RuleCard (Automatisations), Heatmap (Analyses),
  GuidePanel et OnboardingStep (Prise en main et Guide).
- Retirés : l'icône « i » (`InfoTip`), MetricCard, ChecklistCard, le choix du thème.

### Le cadre

- Barre du haut sur toute la largeur : le logo de 40 px, le nom et le logo de la communauté lus
  chez Whop, la recherche d'un membre (⌘K ou Ctrl K, depuis n'importe où), le Guide.
- Menu de 220 px, 64 px replié (une infobulle par icône) ; la rubrique ouverte porte une barre
  turquoise de 2 px qui glisse d'une rubrique à l'autre, et son icône est turquoise.
- Mode test actif : une fine barre bordée de turquoise, « Mode test activé : StayPut calcule tout
  mais n'envoie rien. » et « Désactiver » (avec confirmation). La route `POST /test-mode/off`
  ne change que ce réglage ; la session dit désormais si le mode test est actif.

### Le Tableau de bord

- Exactement les cinq blocs du brief : la pastille « Getting started » sous le titre (repliée dès
  2 étapes sur 4, disparue à 4 sur 4) ; un seul bloc héros sans cases intérieures (sauvé ce
  mois-ci en 56 px dans le dégradé, avec sa lueur ; à risque et membres à risque en 32 px blanc ;
  le graphique 7 / 30 / 90 jours dans le même bloc) ; l'action prioritaire du jour ; « Needs
  attention », les 5 membres les plus urgents ; la bande « StayPut actions (30d) ».
- Plus aucune phrase sous les chiffres : une infobulle de deux lignes au plus sur le libellé.
  « Guardrails » devient « limits » (« limites ») partout où le créateur le lit.

### L'action du jour ne dit jamais « rien d'urgent » à tort (migration 0029)

- Les candidates : approuver les actions préparées (mode manuel), relancer les paiements échoués,
  proposer une pause aux membres qui partent, écrire aux membres à haut risque que personne n'a
  contactés. La plus grosse somme en jeu l'emporte ; à égalité, ce qui est déjà préparé ou le
  plus sûr passe d'abord. La somme est le montant des paiements échoués ou ce que paient ces
  membres par mois, jamais une promesse. Un clic vise 25 membres au plus.
- S'il ne reste rien à faire en un clic mais qu'un paiement échoué ou un départ demeure : « 3
  membres ont toujours un paiement échoué : 347 $ en jeu » et « Voir qui ». « Rien d'urgent »
  seulement quand rien n'est en jeu.
- Migration **0029** : `payments_to_retry` (le dernier paiement de chaque membre, échoué,
  relançable, sans relance prévue par Whop, moins de deux relances de StayPut, aucune due dans
  l'heure) et `retry_failed_payments` (avance les relances prévues, ajoute les manquantes,
  approuvées par le créateur). Chaque relance passe par les garde-fous et le journal comme toute
  action (règle 8 du SPEC) : deux par paiement au plus, les arrêts, la liste « ne jamais
  contacter ».
- Routes : `POST /payments/retry`, `POST /members/offers` (une pause ou une offre à 25 membres
  au plus, chacune par `create_creator_offer`), `POST /test-mode/off`.

### La démo

- 36 membres (39 avec ceux qui sont partis, le brief en demande 25 à 40), des courbes réelles :
  un sauvetage tous les 5 à 9 jours, parfois un VIP, une fois un abonnement annuel.
- L'action du jour s'y enchaîne comme le vrai calcul : approuver 6 actions (384 $), relancer
  3 paiements (347 $), proposer une pause (237 $), écrire à Théo (49 $), puis « 3 membres ont
  toujours un paiement échoué ».

### Vérifier les polices et le graphique en ligne

- Le brief demande de vérifier dans le navigateur que les polices se chargent. Le job « look »
  d'Inspect ouvre la démo en ligne dans Chrome (bureau et téléphone), vérifie Satoshi et Geist,
  compte les jours du graphique et ses courbes dessinées, et échoue sinon
  (`scripts/ops/look.mjs`). Ses captures sont gardées sur la branche `screenshots` du dépôt.

### Limites connues

- Le filtre « Paiement échoué » de Membres viendra avec la page Membres : en attendant, « Voir
  qui » ouvre le filtre « risque élevé ».
- Les autres pages gardent l'ancienne mise en page dans les nouvelles couleurs jusqu'à leur tour ;
  le Guide est encore du texte.
