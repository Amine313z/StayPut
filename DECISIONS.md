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

### Correctif du 2 octobre : relier les comptes Discord et Telegram

- Le fondateur ne trouvait plus comment relier les comptes Discord et Telegram aux membres. Rien
  n'était cassé côté serveur : depuis le découpage d'Intégrations en onglets (Whop, Discord,
  Telegram, Activité), la liste « À relier » n'existait plus qu'en bas de l'onglet Activité,
  après le graphique et la liste de toutes les personnes (une quarantaine dans la démo). Les
  onglets Discord et Telegram disaient pourtant « reliez les autres ci-dessous », sans rien en
  dessous.
- Chaque onglet a maintenant sa liste juste sous sa carte : « Comptes Discord » sous le serveur,
  « Comptes Telegram » sous les groupes, chacun avec ses seuls comptes (relier, « C'est moi /
  mon équipe », « Pas un membre », délier). Dans Activité, la liste des deux plateformes passe
  avant la liste des personnes : ce qui est à faire avant ce qui est à lire.
- Dans la démo, « auteurs récents non reliés » suit la liste, comme sur le serveur
  (`stayput.unlinked_authors` compte les comptes dont des messages attendent) : il baisse quand
  on relie ou qu'on écarte quelqu'un. Il disait 3 quand la liste en montrait 2.

## 2026-10-03 — Refonte du design, v4 : étape 1 (jetons, polices, montants, langue)

Le fondateur a envoyé une quatrième version du brief (« Complete redesign prompt (v4) ») avec la
consigne « exécute étape par étape ». Dix étapes, un arrêt et une capture après chacune : 1.
jetons, polices, format des montants, langue ; 2. cohérence des données de la démo ; 3. tableau
de bord façon « solde Whop » et animations ; 4. Intégrations ; 5. Membres ; 6. Guide, visite et
prise en main ; 7. Automatisations ; 8. Analyses ; 9. Réglages ; 10. MOTION.md et liste finale.

### Ce qui ne change pas

- La pile réelle reste celle du SPEC (React + Vite, Worker Cloudflare, graphiques SVG de
  StayPut) : le brief cite à nouveau Next.js, Frosted UI et Recharts comme pile « existante »,
  les raisons des versions précédentes tiennent. « Framer Motion » est la bibliothèque déjà
  utilisée, sous son nouveau nom `motion`.

### Les montants comme Whop les écrit

- Toujours le symbole et les centimes : « $247.00 », « $1,284.50 » ; en français « 247,00 $ »
  (le symbole seul, jamais « $US »). Les nombres de membres et de messages restent sans
  décimales. Seul l'axe d'un graphique raccourcit un montant (« $1.2K »). C'est la fonction
  `currency` du traducteur (`packages/i18n`), qui perd son option « sans centimes ».
- Le montant héros n'est plus dans le dégradé : Satoshi 700, 48 px, blanc plein. Le dégradé
  signature ne reste que sur le bouton principal et le ruban du logo. Montants secondaires en
  Satoshi 600, 28 px ; montants des listes en Satoshi 500, 14 px.
- Les étiquettes passent en minuscules, Geist 500, 12 px, blanc-500 (`.label-text`, plus de
  capitales ni d'espacement des lettres).

### Une seule police pour tous les chiffres

- Satoshi pour chaque nombre de l'app : la classe `.num` (Satoshi et chiffres tabulaires) pour
  tout nombre isolé, les classes `.metric*` pour les montants ; les axes et infobulles des
  graphiques, l'anneau de risque, les montants des listes et le compteur « 2/4 » y passent dès
  cette étape. Les dates dans une phrase (« Renouvelle le 25 oct. ») restent du texte, en Geist.
- La preuve se fait dans un vrai navigateur sur le site en ligne : le job « look » d'Inspect lit
  la police réellement utilisée par chaque montant, chiffre, axe, étiquette et lien du menu,
  vérifie que Satoshi (500, 600, 700) et Geist (400, 500) sont chargées, que les montants ont
  leurs centimes et que la démo s'ouvre en anglais, et échoue sinon.

### La langue

- L'anglais partout par défaut ; le français seulement dans Réglages › Général, listé en second.
- Le choix est retenu **pour l'app de cette communauté seulement** (`stayput.locale.<biz_…>` dans
  le navigateur) : `/demo` s'ouvre toujours en anglais, même après un choix du français ailleurs,
  et un choix fait dans la démo n'est pas gardé. Conséquence : un choix fait avant cette version
  (une clé commune à tout le navigateur) est oublié une fois ; il suffit de rechoisir dans
  Réglages.
- La langue des messages aux membres est déjà l'anglais par défaut côté base
  (`companies.locale`). L'étiquette « EN / FR » sur l'aperçu des modèles viendra avec la page
  Automatisations (étape 7).
- Le mot « thème » disparaît des Réglages (« Votre langue, comment StayPut note vos membres et
  agit »).

### Autres jetons

- Logo de l'en-tête en 32 px.
- Animations : 120 ms (micro), 200 ms (survol), 300 ms (standard), 450 ms (page), un ressort
  (raideur 380, amortissement 32) pour les tiroirs et les interrupteurs seulement ; un chiffre
  compte depuis 0 en 900 ms la première fois puis va d'une valeur à l'autre en 600 ms ; l'anneau
  de risque se remplit en 700 ms. Le reste du système d'animation (§14) vient avec le tableau de
  bord, à l'étape 3.

## 2026-10-03 — v4 : le solde façon Whop et le tri « Needs attention »

Ordre du fondateur, dans cet ordre et un arrêt après chacun : 1. le solde au style Whop (§8) et
le tri « Needs attention » ; 2. le bug Activity ; 3. le Guide (§10, §11) ; 4. la page Membres
(§9.3). Ceci est le 1.

### Le solde

- En haut du tableau de bord, comme le « Total balance » de Whop : l'étiquette « Revenue saved ·
  This month » (Geist 500, 13 px), le montant (Satoshi 700, 48 px, blanc), dessous l'écart
  « +$98.00 vs last month », turquoise en avance, blanc-500 sinon (jamais rouge). Les revenus et
  les membres à risque à sa droite sur un écran large, sous la courbe sur un écran étroit. 7D,
  30D, 90D en petites pilules en haut à droite.
- La courbe sous le solde, sans boîte : 220 px, une ligne turquoise lisse de 2 px, un fond
  turquoise de 22 % à rien, une ligne de base pointillée, ni grille ni axe, la date seulement au
  survol, un point de 6 px qui pulse sur aujourd'hui. Les membres à risque en tirets fins
  blanc-500, à masquer depuis la légende. Au survol : un trait, un point sur chaque ligne et une
  infobulle courte (la date, « Saved », « At risk »).

### Un seul chiffre (§13)

- La courbe montre **le solde du mois** : les montants sauvés additionnés depuis le 1er de
  chaque mois. Elle finit donc aujourd'hui exactement sur le grand chiffre, et repart de zéro le
  1er, comme un solde Whop après un versement. Le total de la période choisie est dans la phrase
  lue aux lecteurs d'écran.
- L'écart compare le mois en cours aux **mêmes jours** du mois dernier (du 1er à la date du
  jour) : jamais un début de mois contre un mois entier. Le 1er, un jour contre un jour ; un mois
  plus court s'arrête à son dernier jour (31 mars contre 28 février).
- « Membres sauvés » (le bandeau des 30 jours) : les membres derrière les sauvetages
  **directs**, dans la devise de la courbe, sur **les mêmes 30 jours calendaires** qu'elle,
  chacun une fois. Leurs abonnements font le total des 30 derniers jours de la courbe, dit dans
  l'infobulle (« What their plans paid: $543.00 in 30 days. »). Avant, le Worker comptait aussi
  les renouvellements « influencés » et 30 × 24 h glissantes : deux chiffres qui pouvaient
  diverger.
- Le Worker envoie l'historique **depuis le 1er du mois d'il y a 89 jours** (90 à 120 jours) :
  sans cela, le premier mois de la vue 90 jours commençait en son milieu et son solde était faux.
- Des tests échouent si ces chiffres divergent : la démo (grand chiffre = fin de la courbe,
  membres sauvés × prix de leur abonnement = total des 30 jours, un sauvetage = l'abonnement d'un
  membre) et le Worker (un renouvellement influencé et un sauvetage d'il y a 30 jours calendaires
  ne comptent pas ; les jours du mois de la courbe font le grand chiffre).

### La démo

- Chaque sauvetage est celui d'un vrai membre de la démo, au prix de son abonnement (49 $, 149 $
  pour un VIP, 470 $ l'an une fois), jamais deux fois le même membre en 30 jours. Les trois du fil
  d'activité (Clara Faure, Anaïs Robin, Arthur Lemoine) en font partie, et le dernier paiement
  d'un membre sauvé est celui du sauvetage. Le 3 octobre : $247.00 ce mois-ci, +$98.00 face aux
  mêmes jours de septembre, 7 membres sauvés pour $543.00 en 30 jours.
- Le total à risque de la démo bouge par paliers, comme dans une vraie communauté : un membre
  entre dans le risque ou en sort quelques fois par semaine, au prix de son abonnement (de
  1 225,17 $ il y a trois mois à 731,17 $ aujourd'hui), au lieu d'un bruit jour par jour qui
  faisait zigzaguer la ligne.

### Le tri « Needs attention »

- Dans cet ordre : 1. départ dans les 7 jours ; 2. paiement échoué non récupéré ; 3. score de
  risque décroissant ; 4. revenu mensuel décroissant (un abonnement annuel compte pour un
  douzième). Un membre à 100 qui part dans 6 jours passe toujours avant un paiement échoué à 79.
  Le point rouge reste réservé au départ dans les 48 heures et au paiement échoué.

### Animations (§14)

- Trois jetons de plus : `fill` 400 ms (le fond, une fois la ligne tracée), `morph` 500 ms (une
  autre période : la courbe se transforme au lieu d'être redessinée ; chaque période est lue aux
  mêmes 90 points d'une courbe monotone, donc les tracés se correspondent point à point), `pulse`
  1,2 s (le point d'aujourd'hui, toutes les 2,4 s). Le trait et l'infobulle suivent le pointeur
  avec 80 ms de lissage ; la lueur du solde suit la souris de 20 px au plus (ordinateur
  seulement, jamais si l'appareil demande moins d'animations).
- Un chiffre ne pulse plus au chargement (le comptage est son arrivée) : la lumière turquoise
  quand il s'améliore, une baisse de 200 ms quand il se dégrade.

### Ménage

- L'ancien graphique (`AreaChart`, avec axe et grille) n'est plus utilisé : retiré. Le style
  commun des graphiques (`ui/charts/theme.ts`) passe aux valeurs v4 et `BalanceChart` le lit.
- Le signe fait partie du montant (« +$98.00 », en Satoshi) : un lecteur d'écran le lisait à
  part.

### Incertain

- La chute de la courbe le 1er du mois (le solde repart de zéro) : c'est ainsi que Whop dessine
  un solde après un versement, et c'est ce qui fait finir la courbe sur le grand chiffre. Si le
  fondateur préfère une courbe qui ne fait que monter sur la période choisie, le grand chiffre
  devra alors suivre la période (« sur 30 jours ») plutôt que « ce mois-ci ».

## 2026-10-03 — Le bug Activity : jamais « Loading… » plus de 5 secondes

Ordre du fondateur n° 2 (brief v4 §9.6 : chaque bloc de données se termine en moins de
5 secondes sur ses données, un état vide ou une erreur avec « Retry »).

### La cause

- **Côté navigateur.** Chaque bloc relisait ses données en annulant la lecture encore en cours
  (`useApi`). Or l'onglet Activity relance ses blocs souvent : le bloc en direct toutes les
  10 secondes, et chaque nouveau message relance « comptes à relier » et « membres » ; le bloc en
  direct lançait aussi une lecture toutes les 10 secondes même si la précédente n'était pas finie,
  donc des réponses dans le désordre et de fausses « nouveautés ». Dès qu'une lecture prenait plus
  de temps que l'intervalle, aucune n'aboutissait : « Loading… » pour toujours. Un test le
  reproduit (`apps/web/test/loading.test.tsx`, il échouait sur l'ancien code).
- **Côté Worker.** Trois routes attendaient Discord ou Telegram avant de répondre : les noms
  manquants (`/accounts`, jusqu'à 10 appels), les nombres de membres des serveurs et groupes
  (`/people`), les nouveaux messages Discord (`/platform-activity/refresh`, jusqu'à 10 appels).
  Un service lent suffisait à suspendre la réponse : le test Worker ajouté expirait au bout de
  30 secondes sur l'ancien code.
- **Mesuré en production** (Inspect, lu comme l'équipe le lit, durées et nombres seulement) : les
  trois requêtes SQL de l'onglet répondent en 0,26 à 0,28 s, trajet réseau compris ; 0 nom à
  demander, 2 comptages. La base n'est pas en cause.

### La correction

- `useApi` : une seule lecture à la fois ; une relecture demandée pendant une lecture part juste
  après, sans l'annuler. Après 5 secondes sans réponse : « This is taking longer than usual. »
  (FR « Cela prend plus de temps que d'habitude. ») avec « Retry », et la réponse s'affiche quand
  même si elle arrive ensuite. Un appel muet est abandonné au bout de 20 secondes (« StayPut did
  not answer in time »). Une relecture qui échoue laisse affiché ce qui l'était. Le bloc en
  direct de l'onglet Activity utilise désormais le même mécanisme.
- Le panneau de synchronisation (Intégrations › Whop), qui affichait aussi « Loading… » sans
  limite avant son premier état, suit la même règle.
- Worker : Discord et Telegram sont attendus 2,5 secondes au plus (`waitAtMost`, sur une connexion
  à la base à part) ; au-delà, la route répond avec ce que la base contient et le reste se termine
  après la réponse : la lecture suivante le montre.
- Le bouton s'appelle « Retry » en anglais, comme dans le brief (« Réessayer » en français).

### Ce qui n'est pas fait ici

- La fusion de l'onglet Activity dans chaque onglet de plateforme et la reconstruction des
  Intégrations en tableaux de bord (§9.6) : c'est l'étape « Intégrations » du brief, pas encore
  demandée.

## 2026-10-03 — La démo : Discord et Telegram comptés à partir des membres

Le fondateur, sur une capture d'Intégrations › Activity de la démo : « corrige et passe au 3 ».
Trois chiffres ne tenaient pas : « Live » mais « Last message 1 hour ago » (l'heure était figée à
l'ouverture de la démo), « 39 members » sur Discord pour une communauté de 36 membres dont 7
n'ont rien écrit, 1 506 messages là où la page Membres en compte 511 sur les mêmes 30 jours. Ils
étaient écrits à la main.

- Un seul modèle : un compte par personne et par plateforme (`demo/pages.ts`). La plupart des
  membres sont sur le serveur Discord, un tiers aussi dans le groupe Telegram ; leurs messages
  y sont une part des leurs (le reste sur Whop) ; ceux qui n'ont rien écrit y sont, silencieux.
  S'y ajoutent l'équipe (mise de côté), un invité, et les 4 comptes à relier dont les messages
  attendent leur membre. Tuiles, jours, serveurs et groupes, membres les plus actifs, liste de
  tout le monde, comptes à relier et compteurs des sources en sont tous tirés, comme le serveur
  les compte. Relier un compte donne ses messages au membre (page Membres comprise).
- En direct : ce que les membres font pendant que la démo est ouverte (une ligne toutes les 25 à
  45 secondes) est compté là où ça s'est passé, avant chaque réponse de la démo : le fil, la
  tuile et la barre du jour de la plateforme, le dernier message, les chiffres du membre.
- La liste « Tied » se replie au-delà de 6 comptes, comme « Set aside » : les comptes à relier
  restent en tête.
- Des tests échouent si les tuiles ne sont plus la somme des comptes, si un membre a plus de
  messages sur Discord et Telegram que dans ses propres chiffres, ou si le direct ne compte pas
  un message partout.

## 2026-10-03 — Le Guide, la visite et l'accueil (brief v4 §10 et §11)

Troisième point de la liste du fondateur. Les textes sont ceux du §11, mot pour mot (anglais
officiel, français dans la langue française).

### Le Guide

- Le bouton « Guide » de la barre du haut ouvre un panneau de 420 px à droite, qui arrive sur le
  ressort des tiroirs (raideur 380, amortissement 32 ; tous les tiroirs l'ont désormais, comme le
  dit le §14). Cinq cartes validées, chacune avec sa petite animation en boucle (4 à 4,5 s puis
  1 s de pause, transform et opacité seulement, en pause hors de l'écran, immobile si l'appareil
  demande moins de mouvement) et « Show me ». Puis « What do you want to do? » et ses quatre
  raccourcis, puis « Replay the tour ». Plus de carte « mode test » : le mode test garde sa fine
  barre en haut de chaque écran.
- « Show me » ouvre la page et éclaire l'endroit (page assombrie, halo turquoise, le titre de la
  carte et « Got it ») : qui va partir → « Needs attention » ; les garder → le choix
  Automatique / Manuel (Réglages › Automatisations) ; l'argent gardé → le montant du mois ; le
  contrôle → les limites ; Discord et Telegram → l'invitation à connecter (ou les onglets des
  plateformes quand l'une l'est déjà).
- Les raccourcis mènent à l'écran qui le fait, sans bloquer la page : « See who is about to
  leave » → Membres filtrés sur « Leaving » ; « Turn on payment retries » → le champ « Retries per
  failed payment » (un halo s'allume 2 s et le curseur s'y place) ; « Connect Discord or
  Telegram » → Intégrations ; « Set my limits » → les limites. Quand la page Automatisations aura
  ses règles (étape 7), les relances de paiement y pointeront.
- Depuis un vrai tableau de bord, « Explore with demo data » reste tout en bas, sur une ligne :
  c'est le seul chemin vers la démo depuis l'application.

### La visite (5 étapes)

- Le montant du mois → l'action du jour → l'anneau de risque du premier membre → Automatisations
  → Intégrations (sur téléphone, « More », où se trouve Intégrations). Page assombrie à 70 %,
  halo turquoise de 2 px, Next / Back / Skip (et les flèches, Échap). Le halo et la bulle
  glissent d'un endroit à l'autre en 400 ms ; un clic sur la page assombrie ne fait rien (rien ne
  s'arrête par erreur). « $0.00 » du premier texte est écrit dans la devise de la communauté.
- Un endroit absent (une page qui charge) est attendu 5 secondes ; s'il ne vient pas, la bulle
  reste au milieu de la page assombrie : ce qu'elle dit reste vrai.

### L'accueil (premier lancement, 4 étapes)

- Bienvenue → Discord ou Telegram (facultatif, chaque connexion en un clic, « Connected » une
  fois fait) → Automatique ou manuel (enregistré sur « Next ») → le premier audit : les membres
  à risque et les revenus qu'ils menacent, les chiffres mêmes du tableau de bord, qui comptent
  depuis 0. Il se termine sur la visite ou le tableau de bord.
- Il s'ouvre seul la première fois qu'une communauté ouvre StayPut, quel que soit l'appareil ou
  la personne de l'équipe, puis plus jamais une fois parcouru ou fermé (« Skip », Échap).
  Migration **0030** : `company_settings.welcomed_at`, enregistré par `getting_started_done`
  comme les étapes de « Getting started » (la première fois seulement). Conséquence : il
  s'ouvrira une fois dans la communauté du fondateur après ce déploiement.
- Routes : `POST /getting-started/welcomed` ; `POST /mode` (le mode seul, comme « Turn off » ne
  change que le mode test : les limites ne comptent pas comme réglées).
- La démo ne l'ouvre jamais seule (elle s'ouvre sur son tableau de bord) ; `/demo?welcome`
  l'ouvre, pour le voir et pour les captures.

### Intégrations sans Discord ni Telegram

- L'onglet Whop (l'entrée des Intégrations) et l'onglet Activity montrent l'état vide du §11 :
  « StayPut only sees what happens on Whop. », la phrase, les trois bénéfices, « Connect
  Discord » (le seul bouton principal de la page) et « Connect Telegram », chacun directement vers
  l'ajout du bot.
- La phrase de confidentialité est désormais la même partout (Intégrations, Guide, accueil) :
  « StayPut never reads what members write: only who wrote and when. » C'est exact : le bot ne
  garde que l'auteur (son nom, pour reconnaître le membre) et l'heure, jamais le texte.

### Une seule formulation

- Les deux modes se décrivent partout comme la carte 2 : « StayPut acts on its own, within your
  limits. » / « StayPut asks you first: you approve each action. » (avant : « guardrails »,
  « Actions tab »).

### Corrigé en passant

- Démo : « Disconnect » sur un groupe Telegram le laissait affiché « retiré » au lieu de le
  retirer, comme le fait le Worker ; le bouton revenait sans fin.

### À valider

- **Trois lignes par carte** : à 420 px, les textes validés font 3, 4, 3, 4 et 6 lignes en anglais
  (4, 5, 4, 4, 6 en français), plus « 2-minute setup. » et la phrase de confidentialité sous la
  carte 5. Les textes sont gardés mot pour mot ; pour tenir en trois lignes il faudrait les
  raccourcir.
- La taille du halo de la visite change pendant ses 400 ms (un seul élément fixe, hors de toute
  mise en page) : c'est la seule animation qui n'est pas que transform et opacité.

## 2026-10-03 — La page Membres : un tableau compact et le tiroir du membre (brief v4 §9.3)

### Le tableau

- Une ligne par membre (deux sur téléphone, l'état et le montant sous le nom) : avatar et nom,
  anneau de risque, état en un mot (Leaving · Payment failed · Inactive · Active ; Team et Gone
  pour l'équipe et ceux qui sont partis), MRR (« $49.00/mo », « Free »), dernière activité
  (« 3 weeks ago », « Never »), prochain renouvellement (« Oct 15 », « Ends Oct 20 » pour un
  départ). Les colonnes apparaissent selon la place (requêtes de conteneur) : jamais de défilement
  horizontal.
- Chaque colonne se trie. Le premier clic trie dans le sens le plus parlant (risque, MRR,
  activité : du plus grand ; nom, état, renouvellement : du premier), le second inverse. Ce
  qu'une colonne ne peut pas dire (pas de score, pas d'abonnement) va toujours à la fin ; à
  égalité, l'ordre du Worker (le plus à risque d'abord). L'adresse garde le filtre (`filter`), la
  recherche (`q`), le tri (`sort`, `dir`) et le membre ouvert (`member`).
- Les états viennent d'un seul endroit (`apps/web/src/members.ts`) : parti > équipe > départ
  programmé > paiement échoué non rattrapé > inactif (rien depuis 14 jours, le seuil par défaut
  du score ; un nouveau qui n'a encore rien fait ne devient « inactif » qu'au bout de 3 jours) >
  actif. Le point rouge : paiement non rattrapé ou départ dans les 48 heures, jamais l'équipe ni
  un membre parti. Le mot reste blanc (§6).
- Les puces (All, Leaving, High, Medium, Low, New inactive, Gone), chacune avec son nombre,
  restent collées sous la barre du haut avec la recherche ; la pastille glisse vers la puce
  choisie et la liste se fond en 200 ms. « Leaving » compte aussi une résiliation programmée
  avant le premier score (les faits de Whop, comme « Needs attention ») ; High, Medium, Low et New
  inactive ne gardent que les membres encore là.
- « Do not contact » : une cloche barrée dans sa colonne, seulement quand c'est actif ; la phrase
  qui l'explique n'est que dans le tiroir. L'onglet « Do not contact » montre la même table,
  filtrée ; un membre retiré de la liste s'en replie.
- Le titre « Members » n'est plus répété dans une carte (§9.1) : la page est la rubrique.

### Le tiroir

- Un clic sur une ligne (Entrée sur le nom, ou ⌘K) ouvre le tiroir à droite : l'anneau et le
  niveau, l'état, ce que le membre paie, la date de départ ; « Why » (les raisons du score) ; les
  actions rapides (Message, Pause, Offer, les mêmes que sur le tableau de bord) ; le score sur
  30 jours (courbe de 0 à 100, jours du calendrier de la communauté) ; l'abonnement (depuis
  quand, puis les précédents) ; les 12 derniers paiements (point rouge sur le dernier s'il a
  échoué) ; l'activité sur 30 jours par plateforme (Whop, puis Discord et Telegram une fois
  connectés ; « Account not tied yet » quand StayPut ne connaît pas le compte du membre) ;
  l'interrupteur « Do not contact » et sa phrase.
- Nouvelle route en lecture seule `GET /api/creator/:companyId/members/:memberId`
  (`readMemberDetail`, sous RLS comme le reste ; 400 pour un identifiant mal formé, 404 pour un
  membre d'une autre communauté). **Pas de migration.**
- **Écart avec l'ordre du brief** (« reasons, score sparkline, subscription and payment history,
  activity by platform, quick actions, toggle ») : les actions rapides viennent juste après les
  raisons. On ouvre un membre pour agir, et l'historique (jusqu'à 12 paiements) les pousserait
  hors de l'écran. L'interrupteur reste en dernier.
- Un membre sur la liste « Do not contact » n'a plus d'actions rapides (le Worker les refuse de
  toute façon) ; l'équipe et les membres partis n'ont ni raisons, ni actions, ni interrupteur.
- Les sections entrent l'une après l'autre ; derrière un tiroir, la page est assombrie à 50 %
  (§14 ; 70 % reste pour les fenêtres).

### Le mouvement (§14)

- Les dix premières lignes apparaissent à 30 ms d'écart ; au survol, une ligne monte de 2 px sur
  black-700 (200 ms) ; une ligne arrivée après coup a un liseré turquoise à gauche (600 ms) ; une
  ligne qui part se replie (250 ms). Les anneaux se dessinent en 700 ms, à 40 ms d'écart.
- « Needs attention » suit désormais les mêmes règles de liste : liseré turquoise de 600 ms (au
  lieu d'une lueur de 1,2 s) ; une ligne qui part s'efface en 250 ms, puis les suivantes
  remontent en 250 ms.
- Jamais `AnimatePresence mode="popLayout"` : pour épingler l'élément qui sort, Motion injecte
  une balise `<style>`, que la politique de sécurité de la page (`style-src 'self'`) refuse
  (erreur dans la console, élément non épinglé). Le premier Inspect l'a relevé sur le fondu des
  filtres ; le fondu superpose désormais l'ancienne et la nouvelle liste dans la même case d'une
  grille. Seul un vrai navigateur le montre (happy-dom ne donne aucune taille aux éléments) :
  `test/csp.test.ts` interdit ce mode dans les sources.

### Une seule formulation (§12)

- « Never contact » devient partout « Do not contact » / « Ne pas contacter », et la phrase de
  l'interrupteur dit « within your limits » (« dans vos limites ») au lieu de « guardrails ». Le
  filtre « New, inactive » devient « New inactive », « Left » devient « Gone » (« Partis »).

### Corrigé en passant

- Un abonnement terminé (« Expired », « Canceled ») ne dit plus « renews on » mais « ended on ».
- ⌘K ouvre directement le tiroir du membre trouvé (avant : la liste filtrée sur son nom) ;
  Entrée sans résultat cherche les mots dans Membres.
- Un membre sans nom a l'icône de personne dans le tableau, pas les initiales de « Member
  without a name ».

### Incertain

- Sur téléphone, la barre collante (puces + recherche) prend deux lignes, environ 130 px.
- L'en-tête des colonnes n'est pas collant : seules les puces et la recherche le sont.

## 2026-10-03 — Correctifs v4.1, bloc 1 : le projecteur de la visite et de « Show me »

Le fondateur a envoyé sept blocs de correctifs, à faire un par un, chacun suivi d'un arrêt avec
une capture. Le bloc 1 refait la lumière de la visite et de « Show me ».

### Un seul composant, des cibles exactes

- `Spotlight` (`components/guide/Spotlight.tsx`) sert à la visite et à « Show me ».
- Chaque endroit porte `data-tour="…"` sur l'élément exact, jamais sur un conteneur plus large :
  - `hero-amount` : le libellé, le montant et l'écart, pas la courbe ;
  - `priority-action` ;
  - `risk-ring` : l'anneau du premier membre de « Needs attention » ;
  - `rule-payment-retry` ;
  - `connect-discord`.
- « Show me » utilise aussi `attention-row` (la première ligne) et `limits` (le groupe des
  plafonds de Réglages › Automatisations, au lieu de toute la ligne, trop haute pour que
  l'infobulle tienne à côté).
- Tant qu'un endroit n'est pas là, la lumière attend 1,5 s avant de prendre sa solution de repli
  (les onglets de la page, la liste). Une page qui lit ses données montre ses onglets avant son
  contenu : sans ce délai, la lumière se posait sur les onglets de la page précédente.

### Mesurer au bon moment

- L'endroit est d'abord amené au milieu de la fenêtre, par un défilement doux.
- On attend la fin du défilement : aucun événement pendant 120 ms, 1,5 s au plus.
- On attend ensuite que sa boîte ne bouge plus pendant 150 ms : ses animations d'entrée, le
  compteur.
- Seulement alors, on mesure.
- La lumière suit ensuite la page :
  - le défilement et la taille de la fenêtre ;
  - un `ResizeObserver` sur l'endroit et sur la page ;
  - un relevé toutes les 300 ms pour ce qu'aucun événement ne signale.

### La découpe et l'infobulle

- La page est assombrie à 72 % (`#050607`). Un masque SVG y fait une vraie découpe : 8 px de
  marge, coins de 12 px, un halo turquoise-300 de 2 px avec une lueur douce. L'endroit reste
  entièrement visible.
- L'infobulle :
  - 320 px au plus ;
  - posée sur le premier côté qui a la place, dans l'ordre droite > bas > gauche > haut ;
  - sans toucher l'endroit, ni l'endroit suivant de la visite quand il est à l'écran ;
  - une flèche de 12 px pointe vers l'endroit ;
  - pour un endroit du menu latéral, toujours à droite du menu ;
  - invisible tant qu'elle n'est pas placée, mais déjà lisible par un lecteur d'écran : elle
    ne saute jamais d'une place à l'autre.
- Son contenu :
  - « x of 5 » (visite seulement), le titre, la phrase d'explication, les boutons ;
  - « Show me » reprend la phrase de l'étape de la visite qui montre le même endroit, sinon la
    légende de la carte du Guide, avec « Got it » : jamais un titre seul.
- Entre deux étapes :
  - la découpe et le halo glissent (position et taille, 400 ms,
    `cubic-bezier(0.22,1,0.36,1)`) ;
  - l'infobulle entre en fondu, avec un glissement de 6 px.
- Clavier :
  - Next / Back / Skip / Done, et les flèches ← → ;
  - Échap ferme ;
  - Tab reste dans l'infobulle.

### La visite change de page, puis revient

- Les étapes 4 et 5 ouvrent Automatisations, puis Intégrations › Discord.
- Skip, Échap et Done ramènent la page et la position de défilement d'avant la visite. Commencée
  sur le tableau de bord, Done y ramène.
- La page peut encore lire ses données au retour : le défilement est donc réappliqué à chaque
  image, pendant 1,5 s au plus.

### Automatisations s'ouvre sur ses règles (décision)

- L'étape 4 doit éclairer la règle de relance des paiements, sur la page Automatisations. Or
  cette page n'avait pas de règles : sa première page était la file « À valider ».
- J'ai donc avancé une première version de l'onglet **Règles**, prévu au bloc 7. Il montre cinq
  cartes en lecture seule, telles que le moteur les applique (`prepare_actions`) :
  - la relance des paiements, éteinte quand les limites ne permettent aucune relance ;
  - la demande de mise à jour de la carte ;
  - le questionnaire de départ ;
  - le message de suivi ;
  - le message de bienvenue.
- Chaque carte dit : Quand / Si / Alors, et On / Off.
- En tête : le mode (manuel ou automatique) et un lien « Mode et limites » vers les réglages.
- Viendront avec le bloc 7 : allumer ou éteindre une règle, les aperçus de messages, le panneau
  des limites.
- La file passe à `/actions/queue`. Les anciens liens `?view=queue` (ou `?view=history`…)
  ouvrent leur onglet. Le lien « Review » du tableau de bord y mène.
- Les onglets : Règles · À valider · Programmées · Historique · Offre Alumni. Le bloc 7 fera
  d'Historique et d'Alumni des filtres de la file.

### Démo

- Dans la démo, le bouton « Ajouter à Discord » est désactivé (« Désactivé dans la démo ») :
  la visite l'éclaire sans rien ouvrir.
- Les autres liens et envois de la démo relèvent du bloc 5.

### Tests

- `apps/web/e2e/spotlight.e2e.ts` (Playwright, Chrome) déroule la visite puis chaque
  « Show me » :
  - en anglais et en français, à 1280×720 et à 1024×768 ;
  - pour chaque endroit, une fois la lumière posée : l'endroit est entièrement dans la
    découpe et à l'écran, et l'infobulle est dans la fenêtre sans toucher ni l'endroit ni le
    suivant ;
  - la visite finit sur la page et au défilement de départ.
- Où il tourne :
  - en local : `npm run e2e`, après `npm run build` ;
  - en CI, après le build ;
  - dans Inspect, sur le site en ligne : job `spotlight`, avec les polices chargées comme chez
    les créateurs.
- `test/guide.test.ts` couvre le placement :
  - l'ordre des côtés ;
  - éviter l'endroit suivant ;
  - le menu latéral ;
  - rester dans la fenêtre ;
  - la découpe.
- `test/app.test.tsx` couvre :
  - la visite sur ses pages et ses flèches ;
  - le retour au point de départ ;
  - « Show me » jamais réduit à un titre ;
  - l'onglet Règles et l'ancien lien vers la file.
- Inspect (`look.mjs`) vérifie la même géométrie sur le site en ligne, à 1440×900. Il garde une
  capture par étape de la visite et par « Show me ».

### Incertain

- happy-dom ne donne aucune taille aux éléments. Dans les tests unitaires, la lumière ne trouve
  donc jamais sa place et l'infobulle reste au milieu : seule la suite Playwright vérifie la
  géométrie.
- Sur un téléphone (390 px), l'infobulle ne tient pas toujours à côté d'un grand endroit. Elle
  se met alors du côté qui a le plus de place, dans la fenêtre. Inspect y vérifie seulement que
  l'endroit est entier dans la découpe.

## 2026-10-03 — Correctifs v4.1, bloc 2 : la courbe de l'argent sauvé

### Ce que le fondateur a vu

- La courbe « Saved » retombait à 0,00 $ le 1er de chaque mois : en 30 jours, de 445,00 $ (le
  30 septembre) à 0,00 $ (le 1er octobre) ; en 90 jours, des dents de scie. On aurait dit une
  perte.
- La courbe lissée semblait passer sous la ligne de base avant de remonter.
- Le 1er octobre affichait 0,00 $ alors qu'une sauvegarde de 49,00 $ avait eu lieu ce jour-là.

### Ce qui change

- **La courbe additionne la période affichée** (7, 30 ou 90 jours) :
  - elle part de 0,00 $ au début du premier jour et ne descend jamais ;
  - chaque point est la fin de son jour, donc une sauvegarde du jour J fait monter la courbe
    pendant le jour J ;
  - le dernier point est le total sauvé sur la période.
- **Le montant du haut reste « Revenue saved · This month ».** Un trait vertical discret,
  marqué « Oct 1 », montre où commence le mois : ce que la courbe gagne après lui, c'est ce
  montant. Le trait n'apparaît que si le 1er du mois est dans la période (le 31, il est 30 jours
  en arrière, donc pas en 30 jours).
- **L'infobulle donne, pour le jour survolé :**
  - « Saved in period » (le cumul depuis le début de la période) ;
  - « Saved this month » (le cumul du mois jusqu'à ce jour) ; pour un jour d'un mois précédent,
    « Saved in September » ;
  - « At risk ».
  - Chaque série tracée a sa petite marque, la valeur passe en premier. Pendant le survol,
    l'étiquette du trait s'efface : la date est déjà sous la courbe.
- **La courbe** : toujours la courbe monotone (Fritsch–Carlson), mais lue en 631 points et
  tracée en segments droits. 630 est un multiple de 7, 30 et 90 : la fin de chaque jour tombe
  sur un point. Avant, 90 points ne tombaient pas sur les jours, et un second lissage faisait
  monter la courbe un peu avant le jour d'une sauvegarde. Elle reste plate entre deux jours
  égaux et ne passe jamais sous la ligne de base. Le passage d'une période à l'autre reste
  animé, chemin pour chemin.
- La ligne pointillée « à risque » part de la veille de la période quand ce jour a un score.

### Les jours sont ceux de la communauté

- **Le Worker** comptait déjà chaque sauvegarde dans le jour de son fuseau
  (`saved_at at time zone`).
- **Bug trouvé par les nouveaux tests.** Le montant du mois comparait la devise des
  sauvegardes telle quelle (`usd`, en minuscules comme Whop l'écrit) à celle des abonnements, mise
  en capitales (`USD`). En production, « Revenue saved · This month » serait donc resté à 0,00 $
  alors que la courbe montrait les sauvegardes.
  - Corrigé : la devise est comparée en capitales.
  - La borne « jusqu'à maintenant » est inclusive, comme sur la courbe.
  - Pas de migration.
- **La démo** comptait les jours avec le fuseau du navigateur, et sa communauté disait
  « Europe/Paris ». Désormais :
  - la communauté de la démo prend le fuseau du visiteur, comme une vraie communauté prend celui
    du créateur à sa première ouverture ;
  - le graphique, le mois du montant du haut et les membres sauvés sont calculés dans ce fuseau
    à chaque lecture ;
  - changer le fuseau dans Réglages › Automatisations les replace aussitôt.
- **`@stayput/core` `calendar.ts`** : `zonedDay` (le jour d'un moment dans un fuseau, comme
  Postgres), `addDays`, `monthStart`.
- **Les dates de ces jours s'écrivent sans fuseau**, avec les nouvelles fonctions du traducteur
  `calendarDate`, `calendarDay` et `calendarMonth` : un `2026-10-01` reste « Oct 1, 2026 » /
  « 1 oct. 2026 » pour tout lecteur.
- **Les durées relatives comptent les jours au calendrier** : 41 heures avant ce soir, c'est
  « hier », plus « il y a 2 jours ». Un jour affiché « il y a 2 jours » ne doit pas tomber à la
  date d'hier sur la courbe.

### Tests

- `core/test/calendar.test.ts` : 00:30 et 23:30 locales à Paris, New York, Tokyo et Calcutta,
  les changements d'heure, un fuseau inconnu.
- `worker/test/dashboard-sql.test.ts` : à Paris et à New York, des sauvegardes à 00:30 et à
  23:30 locales tombent sur leur jour, et le mois du montant du haut vaut la somme de ses jours.
  Ces tests échouent sans la correction de la devise.
- `web/test/demo.test.ts` : la démo dans plusieurs fuseaux (00:30 à Paris, 23:30 à New York),
  et le changement de fuseau dans les réglages.
- `web/test/balance.test.ts` : pour 7, 30 et 90 jours, la courbe ne descend jamais et finit sur
  la somme des sauvegardes de la période.
- `web/test/charts.test.ts` : le tracé lui-même ne descend jamais, ne passe pas sous la ligne de
  base et reste plat entre deux jours égaux.
- `web/test/app.test.tsx` : le tableau, l'infobulle et le trait du mois, en anglais et en
  français.
- `i18n` : les dates de calendrier et les durées relatives.
- Inspect (`look.mjs`) vérifie sur le site en ligne :
  - que la courbe des 30 jours ne descend jamais ;
  - que le trait porte la date du 1er du mois ;
  - que le mois finit sur le montant du haut.
  - Il garde aussi une capture du 1er du mois survolé, et des périodes 7 et 90 jours.

### Incertain

- Je n'ai pas retrouvé l'écran qui datait du 1er octobre la sauvegarde de 49,00 $. Dans la
  démo, c'est celle d'Arthur Lemoine, 41 heures avant l'ouverture de la page : à partir de 17 h
  environ, elle tombe le 2 octobre. Les jours viennent désormais d'un seul fuseau partout. Un
  « il y a 2 jours » qui voulait dire « hier » ne peut plus faire croire à un décalage.

## 2026-10-03 — Correctifs v4.1, bloc 3 : la page Membres et le tiroir du membre

### Ce que le fondateur a vu

- Le tiroir d'un membre dépassait de l'écran : 419 px de large, mais commencé environ 130 px
  trop à droite (« Ends Oct 9 », « Pause » et « Offer » coupés).
- La recherche perdait des lettres tapées, et « Hugo » montrait encore les 39 membres.

### Le tiroir

- **Il est ancré au bord droit de la fenêtre** : `position: fixed`, `right: 0`, largeur
  `min(420px, 100vw)`. Avant, il était placé par les marges automatiques du `<dialog>` modal
  (`ms-auto`), ce qui dépend du navigateur.
- La page garde la place de sa barre de défilement, qu'elle défile ou non
  (`scrollbar-gutter: stable`) : rien ne bouge quand elle se bloque.
- **Tant qu'un tiroir ou une fenêtre est ouvert, la page derrière ne défile plus** :
  - `ui/scrollLock.ts` pose `<html data-scroll-lock>`, et `styles.css` le traduit en
    `overflow: hidden` ;
  - pas de `style` écrit à la main, que la politique de sécurité refuserait ;
  - si plusieurs sont ouverts, la page reste bloquée jusqu'à la fermeture du dernier.
- **Pas reproduit ici.** Chrome sans écran n'a pas montré le décalage :
  - avec ou sans barres de défilement visibles ;
  - sur les 39 membres ;
  - en anglais à 1024 px et en français à 1440 px.
  - Le tiroir est donc placé explicitement, et les tests mesurent sa place dans un vrai
    navigateur.

### La recherche

- **Le bug.** Le champ affichait l'adresse (`?q=`), et React Router met l'adresse à jour dans
  une transition. Une touche tapée avant que la précédente n'y soit arrivée se perdait, et la
  liste suivait l'adresse, pas le champ. Le nouveau test de navigateur, lancé sur l'ancienne
  version, tape « hugo » et lit « hgo ».
- **Désormais :**
  - le champ garde lui-même ce qui est tapé, et la liste se filtre sur le champ, aussitôt ;
  - l'adresse suit 250 ms après la dernière touche (`q`, remplacée, jamais empilée dans
    l'historique) ;
  - quand l'adresse change autrement (Retour, un lien, « Clear search and filters »), le champ
    la suit, sauf s'il a le focus : on ne réécrit jamais ce que le créateur est en train de
    taper.
- **Ce qui est cherché** (`matchesSearch`, `src/members.ts`) :
  - le nom et le nom d'utilisateur Whop, sans tenir compte des majuscules ni des accents ;
  - chaque mot tapé doit s'y trouver, dans n'importe quel ordre (« bernard hugo ») ;
  - « @hugo » cherche aussi le nom d'utilisateur.
  - La recherche de la barre du haut (⌘K) suit la même règle.
- **Écart avec le brief : pas de recherche par e-mail.** StayPut ne garde jamais l'e-mail des
  membres (migration 0005 : « Emails and phone numbers that Whop returns are never stored »).
  La recherche porte donc sur le nom et le nom d'utilisateur Whop :
  - `members.username`, lu par la synchronisation depuis la migration 0012 ;
  - désormais renvoyé par `GET /members` (`MemberRow.username`) ;
  - **pas de migration**.
- La démo donne un nom d'utilisateur à chaque membre, sous quatre formes : `hugo.bernard`,
  `hugobernard`, `hugo_bernard`, `hbernard`.

### Aucun résultat

- Le message dit les mots cherchés : « No member matches “zzz”. » / « Aucun membre ne
  correspond à « zzz ». ».
- Un bouton discret « Clear search and filters » / « Effacer la recherche et les filtres » vide
  le champ et revient au filtre « All ».
- Avec un filtre seul (rien de tapé), le message d'avant reste, avec le même bouton.

### « Needs attention »

- **Au repos**, une ligne ne montre qu'un chevron « › ».
- **Survolée ou avec le focus clavier**, les actions Message, Pause et Offer prennent sa place :
  - en icônes, chacune avec son infobulle (`ui/IconTip.tsx`, 120 ms) ;
  - leur place est gardée, rien ne bouge ;
  - les lecteurs d'écran entendent le nom complet (« Message Hugo Bernard »).
- **Toute la ligne ouvre le membre**, dans son tiroir de Membres : le nom est un lien qui
  couvre la ligne, sous les actions.
- **Sur un écran tactile**, qui ne survole rien, les actions restent visibles et le chevron
  disparaît.
- Un membre sur « Do not contact » a une cloche barrée, avec son infobulle. Une offre déjà
  envoyée devient une coche.
- La version large des actions, dans le tiroir du membre, ne change pas.

### Tests

- `web/test/members.test.ts`, sur les membres de la démo :
  - « hugo », « HUGO », « Hugó », « hugo » entouré d'espaces, « Hugo Bernard » et
    « bernard hugo » ne trouvent que Hugo Bernard ;
  - « theo » trouve Théo Fontaine, « INES » Inès Haddad ;
  - « zzz » ne trouve personne, et rien de tapé montre tout le monde ;
  - le nom d'utilisateur se trouve avec ou sans @.
- `web/test/app.test.tsx` :
  - la recherche par nom d'utilisateur ;
  - le message sans résultat ;
  - le bouton qui vide le champ et remet le filtre « All » ;
  - la ligne de « Needs attention » : lien vers le membre, chevron, infobulles.
- `apps/web/e2e/members.e2e.ts` (Playwright, Chrome) :
  - la recherche tapée touche par touche (« hugo », « HUGO », « Hugó ») garde chaque lettre et
    ne montre que Hugo Bernard ; l'adresse suit ;
  - le tiroir à 1024 et 1440 px fait 420 px, entièrement dans la fenêtre, sans élément coupé ;
    la page est bloquée derrière, puis débloquée à la fermeture ;
  - une ligne de « Needs attention » : actions invisibles au repos, visibles au survol, et la
    ligne ouvre le membre.
  - Ces tests tournent en CI et sur le site en ligne : le job `spotlight` d'Inspect devient
    `browser`, puisqu'il ne teste plus seulement le projecteur.
- Les tests de navigateur et `look.mjs` montrent désormais de vraies barres de défilement, comme
  sous Windows. Chrome sans écran les cache par défaut, ce qui masquerait justement ce genre de
  décalage.
- Inspect (`look.mjs`) ajoute trois captures, avec leurs mesures :
  - la recherche « hugo » ;
  - le tiroir à 1440 px, bords mesurés ;
  - la ligne de « Needs attention » au repos et survolée.

### Incertain

- Le décalage du tiroir n'a pas été reproduit ici (voir « Le tiroir ») : à vérifier sur l'écran
  du fondateur.
- La recherche ne trouve pas par e-mail (voir « La recherche »).

## 2026-10-03 — Correctifs v4.1, bloc 4 : une seule histoire dans la démo

### La traînée diagonale retirée

- Le fondateur a demandé de retirer la fine ligne turquoise en diagonale du fond de page. Les
  briefs v3 et v4 la demandaient (« one very subtle diagonal light streak »).
- Elle est retirée de `styles.css` (`body::before`) et de `docs/design-tokens.md`. Restent la
  lumière derrière le montant du haut et le logo à 3 % en bas du Tableau de bord.

### Chaque date vient du paiement (règle 1)

- **Toutes les dates d'un membre viennent du jour où il a rejoint** : son offre se renouvelle
  ce jour-là de chaque période. Le générateur n'a plus de date de départ libre (`leaves`).
  - Un départ programmé tombe à la fin de la période payée.
  - Hugo Bernard a payé le 29 septembre (au mois) : il part le 29 octobre.
  - Kevin Nguyen a payé son année le 13 mai : il part le 13 mai 2027.
  - Margaux Picard (payé le 8 septembre) part le 8 octobre : il reste un départ dans la
    semaine, en tête de « Needs attention ».
- **Un renouvellement échoué a échoué le jour où il était dû** :
  - Sarah Cohen il y a 95 minutes, comme le dit le fil d'activité ;
  - Elena Novak le 30 septembre.
  - Leur ligne ne dit plus « Renews on Oct 26 » mais « Unpaid since Oct 3 ». La règle vaut
    aussi pour les vraies données : un paiement échoué n'affiche jamais un renouvellement à
    venir.
- **Une date d'une autre année garde son année** (`day(date, now)` du traducteur) : « Ends May
  13, 2027 ».
- Les paiements du tiroir suivent la même période. Un paiement sauvé par StayPut prend la place
  du paiement de sa période.

### Les membres partis (règles 2 et 8)

- Un membre parti dit « ended on » (ou « ends on » si la date est à venir), jamais « renews ».
  `membershipLine` le garantit aussi pour les vraies données, même si l'abonnement n'est pas
  encore marqué terminé.
- **Paul Henry** était listé sans abonnement mais avec un score. Il est désormais parti : un
  mois payé, terminé le 24 septembre. Il n'apparaît que dans « Gone » (qui compte 4 membres).
  Aucun membre n'a plus de score sans abonnement.
- Dans la démo, je n'ai trouvé aucun membre parti qui affichait « Renews on ». La règle est
  maintenant écrite et testée.

### La pause (règle 3)

- **Nouvel état « Paused »** (« En pause »), entre « Inactive » et « Active » :
  - sur Membres : « Paused · resumes Nov 2 » ;
  - dans le tiroir : « Paused · $149.00 per month · resumes on Nov 2, 2026 ».
- Juliette Caron a été mise en pause à son renouvellement, il y a 5 heures, pour 30 jours. Sa
  facturation reprend le 2 novembre.
- **Vraies données** : `MemberRow.membership.pausedUntil` vient de deux sources.
  - Le statut `paused` de Whop (colonnes `paused` / `pause_resumes_at` de 0001, que la
    synchronisation ne remplit pas encore).
  - Ou la dernière pause appliquée par StayPut (`resumes_at` du résultat de l'action) tant
    qu'elle court.
  - Pas de migration.

### « Score turned high » (règle 4)

- Une action déclenchée par « Score turned high » ne vise qu'un membre dont le score était
  élevé (≥ 70) le jour où elle a été créée.
- Lou Marchand (moyen, 62) reçoit maintenant un message du créateur (« You, from the
  dashboard »). Tom Barbier aussi : deux messages du créateur à deux jours d'écart, le second
  bloqué par l'espacement des messages.
- Victor Leclerc est passé en élevé il y a deux jours. Le message de StayPut l'a fait revenir :
  sa courbe monte à 74 ce jour-là, puis redescend à 55.

### Ce qu'il en est sorti : la preuve de valeur (règles 5 et 6)

- **Chaque action de l'historique qui a atteint le membre dit ce qu'il en est sorti**, à la
  place de « Sent » :
  - « Recovered $49.00 » : l'argent sauvé grâce à elle (`stayput.saves.action_id`) ;
  - « Still failing » : le paiement échoue toujours ;
  - « Paused until Nov 2 » ;
  - « Came back » : le membre a fait quelque chose après ;
  - « No reply yet » ;
  - « Left » : le membre est parti depuis. C'est un ajout du bloc, car « No reply yet » serait
    faux pour un membre parti.
  - Ce qui a été bloqué, annulé ou simulé garde son statut.
- **Une seule règle** pour le Worker et la démo : `actionOutcome` (`@stayput/core`,
  `outcomes.ts`).
  - Le Worker lit les faits en SQL pour l'historique : la sauvegarde liée à l'action, le
    dernier paiement, l'activité après l'envoi, le départ après l'envoi.
  - Pas de migration.
- **Dans la démo, chaque sauvegarde est une action de l'historique**, avant que l'argent
  n'arrive :
  - une relance de paiement (Clara Faure : relancée il y a 47 minutes, payée 4 minutes après) ;
  - une demande de mise à jour de la carte ;
  - une pause de 30 jours ;
  - des jours offerts.
  - L'historique compte 31 éléments, jusqu'en juin.
  - La relance d'Elena Novak, il y a 2 heures, a échoué de nouveau (« Still failing ») ; le
    fil le dit aussi.
- Le bandeau « StayPut actions (30d) » du Tableau de bord compte désormais l'historique des 30
  derniers jours, comme le Worker : 8 messages, 4 relances, 1 pause, 7 membres sauvés. Il
  affichait des nombres fixes (43 actions, 31 messages), sans lien avec l'historique.

### Les compteurs bougent ensemble (règle 7)

- Valider une action la retire tout de suite de la liste. Le bouton « Approve all (5) » et
  l'onglet « To approve (5) » changent dans la même image.
- `withMoves` applique les derniers gestes du créateur en attendant la réponse du Worker. Les
  nombres des onglets sont posés avant que l'écran ne se dessine (`useLayoutEffect`) ; avant,
  l'onglet suivait une image plus tard, après la relecture.
- Un test le vérifie à chaque changement du DOM. Il échoue avec l'ancien code.

### Les messages comptés (règle 9)

- Sur Intégrations › Activité, chaque plateforme dit maintenant la part de ses messages écrite
  par les membres : « 367 by members ». Ce nombre est exactement la somme de leurs tiroirs.
- Le reste vient de l'équipe, des invités et des comptes pas encore reliés.
- Pour chaque membre, Whop, Discord et Telegram additionnent ses 30 jours.
- **Vraies données : migration 0031** (`0031_platform_messages_by.sql`). Elle remplace
  `stayput.platform_activity` par la même fonction, qui ajoute `messagesBy` (membres, équipe,
  invités, à relier). Rien d'autre ne change.

### Corrigé en passant

- Le compte Telegram de Kevin Nguyen avait le même identifiant (`6120000002`) que le compte
  « Alex » à relier. React prévenait d'une clé en double sur Intégrations, et relier l'un
  pouvait toucher l'autre. Les comptes des membres ont désormais leur propre plage
  d'identifiants, et un test vérifie qu'aucun identifiant ne revient deux fois.

### Tests

- `core/test/outcomes.test.ts` : la règle des résultats, cas par cas.
- `worker/test/action-outcomes-sql.test.ts`, en SQL (PGlite), lu comme l'équipe :
  « Recovered », « Still failing », « Paused », « Came back », « No reply yet », « Left ».
- `worker/test/app.test.ts` : la pause acceptée dans l'espace membre ; son résultat et
  `pausedUntil` sur la ligne du membre.
- `worker/test/accounts-sql.test.ts` : `messagesBy`.
- `web/test/demo.test.ts` : un test par règle (1 à 9), le 3 octobre à 16 h à Paris.
- `web/test/app.test.tsx`, dans l'interface :
  - Juliette en pause dans le tableau et le tiroir ; Paul Henry parti, « ended on » ;
  - les badges de l'historique ;
  - l'onglet et « Approve all » qui bougent ensemble ;
  - « Unpaid since » dans « Needs attention » ;
  - « by members » sur l'Activité.
- `i18n` : la date courte garde son année quand ce n'est pas celle d'aujourd'hui.
- Inspect (`look.mjs`) sur le site en ligne vérifie toutes ces lignes : Juliette, Hugo, Kevin,
  Sarah, Paul, les badges, les compteurs 6 → 5, « by members ». Il ajoute trois captures :
  `actions-history-1440.png`, `members-drawer-paused-1440.png`, `actions-queue-approved.png`.

### Incertain

- La pause des vraies données dépend du statut `paused` que Whop renvoie après `POST
/memberships/{id}/pause`. Je ne l'ai pas vu dans le sandbox. En attendant la synchronisation,
  la date vient de l'action de StayPut.
- Un membre qui part et dont le paiement a échoué affiche sa date de départ plutôt que la date
  impayée (la raison dit déjà « Payment failed »).

## 2026-10-04 — Correctifs v4.1, bloc 5 : rien ne sort de la démo

### Ce qui est grisé : le choix du fondateur

- Le bloc dit « every external link or send action in /demo is disabled ». Dans la démo, les
  actions (Message, Pause, Offre, Relancer, Approuver) ne sortent déjà jamais du navigateur :
  `demo/api.ts` y répond et ne change que la communauté imaginaire.
- Question posée au fondateur le 4 octobre, réponse : **griser seulement ce qui sort de
  StayPut**. Les actions simulées restent cliquables : la visite guidée et les compteurs 6 → 5
  du bloc 4 marchent toujours dans la démo, et le bandeau dit déjà « nothing you do is sent ».
- En échange, un test dans un vrai navigateur prouve que rien ne sort (voir Tests).

### Un seul mécanisme

- `apps/web/src/demoMode.tsx` : `DemoMode` (posé par `CreatorView` quand c'est `/demo`) et
  `useDemo()`.
- `ExternalButton` (`ui/ExternalLink.tsx`), le seul bouton de l'app qui ouvre une page hors de
  StayPut, en dépend. Dans la démo, avec ou sans lien :
  - c'est un `<button aria-disabled="true">`, jamais un lien ; il n'ouvre rien ;
  - sa bulle « Disabled in the demo » (« Désactivé dans la démo ») apparaît au survol et au
    focus (`IconTip`, qui accepte maintenant un `id` pour `aria-describedby`) ;
  - touché sur un téléphone (pas de survol), il prend le focus : la bulle s'affiche aussi.
- Hors de la démo, rien ne change. Un `ExternalButton` sans lien n'affiche plus rien : chaque
  carte décide si elle le montre.
- `Button` grise aussi tout bouton `aria-disabled` (même aspect que `disabled`, sans l'effet
  d'appui).

### Le lien Alumni (point 1)

- La démo montre `https://whop.com/your-community/alumni` avec un badge « Example ». C'était
  `https://whop.com/atlas-trading-club/atlas-alumni/`, qui ressemblait à une vraie communauté.
- « Open » est grisé avec la bulle. « Copy » reste actif : il copie l'exemple.
- Le message « User left » de Whop porte l'exemple lui aussi.

### Les autres boutons (point 2)

- Discord : le bouton grisé que la démo avait déjà (bulle native `title`) passe par
  `ExternalButton`, avec la même bulle que les autres. Il garde `data-tour="connect-discord"`
  pour la visite guidée.
- Telegram : « Add another group » n'apparaissait pas du tout dans la démo (pas de lien). Il
  apparaît maintenant, grisé, comme celui de Discord.
- Le portail développeur Discord et les liens de l'espace membre passent par `ExternalButton` :
  ils seraient grisés aussi dans la démo s'ils y apparaissaient.
- « Connect Discord / Telegram » de l'invitation à connecter mène à l'onglet de la plateforme,
  dans StayPut : il reste actif.

### Tests

- `apps/web/test/app.test.tsx`, « the demo leads nowhere outside StayPut » :
  - le lien Alumni d'exemple, « Example », « Open » grisé et décrit, en anglais et en
    français ;
  - les boutons Discord et Telegram grisés ;
  - chaque page de la démo, le Guide et un tiroir de membre : aucun lien vers un autre site ou
    un nouvel onglet ;
  - hors de la démo, « Open » reste un vrai lien.
- `apps/web/e2e/demo-safety.e2e.ts`, dans Chrome, en local, en CI et sur le site en ligne
  (Inspect, job `browser`) :
  - chaque page de la démo n'appelle aucun autre site, ni l'API de StayPut (`/api/`) ;
  - aucun lien n'en sort ;
  - chaque bouton grisé montre sa bulle au survol et n'ouvre ni page ni onglet au clic.
- Inspect (`look.mjs`) vérifie le lien d'exemple et les trois bulles, et ajoute trois
  captures : `demo-alumni-1440.png`, `demo-discord-1440.png`, `demo-telegram-1440.png`.

## 2026-10-04 — Le prix de StayPut : payé sur Whop, rien dans l'app

- Décision du fondateur, le 4 octobre : StayPut s'installe dans la communauté du créateur et lui
  appartient. Le créateur paie le fondateur sur Whop : 29 $, 99 $ ou 500 $ (accès complet).
- StayPut ne prend aucun paiement : ni bouton de paiement, ni facture, ni prélèvement dans
  l'app. L'achat dans l'app de Whop (`inAppPurchase`), évoqué le même jour, est écarté.
- À préciser en Phase 7 (le fondateur veut voir les prix en dernier) :
  - ce que donne chaque prix ;
  - si les 500 $ sont payés une fois ou chaque mois ;
  - si le plan gratuit, le plan Performance et l'offre Founder de `SPEC.md` restent.
- Si les trois prix ne donnent pas les mêmes fonctions, StayPut lit sur Whop celui que le
  créateur a payé, pour ouvrir les bonnes. Il ne fait que le lire.

## 2026-10-04 — Correctifs v4.1, bloc 6 : les mots

- Le fondateur a validé le bloc 5 et demandé d'enchaîner toutes les étapes, les prix (Phase 7)
  en dernier : un court rapport après chaque étape, sans attendre, sauf décision à prendre.
- **Quand un message part** : « Sends at the hour they’re usually online » (« Part à l’heure
  où le membre est habituellement en ligne ») et « Sends in 2 hours » (« Envoyé dans 2
  heures », les mots du fondateur). « Leaves as soon as you approve it » devient « Sends as soon
  as you approve it » ; le français garde « Part dès votre validation ».
- **« Skip » à côté de « Approve »** (« Ignorer »), confirmé par « Yes, skip it ». Dans
  l'historique, la note devient « Skipped by you » (« Ignorée par vous ») ; le statut reste
  « Cancelled », qui couvre aussi les annulations de StayPut (abonnement terminé…).
- **Plus de « golden hour » à l'écran** : « Golden-hour message » devient « Check-in message »
  (« Message de suivi », le nom de la règle), et l'aide de l'heure par défaut dit « When
  StayPut does not know yet when a member is usually online ». Le code garde le nom interne.
- **L'anglais cite avec “ ”**, jamais « » (10 phrases corrigées, dont “It’s me / my team” et
  “User left”). Le français garde ses guillemets.
- **Langue des messages** : English d'abord, puis French.
- **Le Guide** s'intitule « How StayPut works » (« Comment marche StayPut ») ; le bouton du haut
  reste « Guide ».
- Le français reste partout où il s'applique, visite guidée comprise (inchangé).
- **Tests** : `packages/i18n/test/i18n.test.ts` refuse « » en anglais et « golden » / « heure
  d’or » à l'écran, et vérifie les nouveaux mots ; `apps/web/test/app.test.tsx` vérifie
  « Skip », « Sends at… », « Sends in 2 hours », l'ordre des langues et le titre du Guide en
  anglais et en français ; Inspect (`look.mjs`) vérifie « Skip » à côté de chaque « Approve »,
  aucune page de la démo avec « golden » ou « », et English d'abord.

## 2026-10-04 — Correctifs v4.1, bloc 7a : les Automatisations

Le bloc 7 reprend ce qui manque du design v4. Il se fait en trois étapes : 7a les
Automatisations (§9.4), 7b les graphiques d'Analyses (§9.5), 7c les tableaux de bord Discord et
Telegram (§9.6).

### Deux onglets : Règles et File d'attente

- La rubrique a deux onglets : **Règles** et **File d'attente** (« Queue »).
- À valider, Programmées, Historique et l'offre Alumni deviennent des **filtres** de la file,
  dans une rangée de pastilles (comme les filtres de Membres), plus des onglets.
- Les adresses : `/actions/queue`, `/actions/queue/scheduled`, `/actions/queue/history`,
  `/actions/queue/alumni`. Les anciennes (`/actions/history`, `?view=history`…) ouvrent leur
  filtre. Le lien « Review » du tableau de bord mène toujours à `/actions/queue`.
- L'onglet File d'attente compte ce qui attend votre validation ; chaque filtre compte ce qu'il
  contient.
- Passer d'un filtre à l'autre ne rejoue pas l'entrée de la page : seule la liste change
  (fondu). La rubrique anime donc par onglet, plus par adresse.

### Une règle s'allume ou s'éteint (migration 0032)

- Chaque carte a son interrupteur. Le choix est enregistré côté serveur :
  `company_settings.rules_off` (les règles éteintes) et `stayput.set_rule`.
- Une règle éteinte ne prévoit plus rien : `plan_actions` la saute. Ce qu'elle a prévu avant
  reste dans la file, où vous le validez ou l'ignorez.
- Les cinq règles : relance des paiements, demande de mise à jour de la carte (et la
  confirmation 3D Secure), questionnaire de départ, message de suivi, message de bienvenue.
- Route : `PUT /api/creator/:companyId/rules/:rule` avec `{ on }`, réservée à l'équipe. La démo
  répond de la même façon, dans le navigateur.
- L'enregistrement des réglages (Réglages › Automatisations) ne touche jamais aux règles.
- Si vos limites n'autorisent aucune relance, la règle reste allumée et sa ligne « Alors » le
  dit : « Rien pour l'instant : vos limites n'autorisent aucune relance ».

### Le reste de la page Règles

- **Le mode** se choisit sur la page (Manuel / Automatique), par la même route que l'accueil.
  Un message confirme le changement.
- **« Vos limites »** (le mot « garde-fous » disparaît de l'écran) : messages par membre tous
  les 5 jours et par mois, heures de silence, réductions par mois, membres à ne jamais contacter
  (lien vers Membres › Ne pas contacter). Le panneau se lit ici ; on le modifie dans Réglages ›
  Automatisations, où StayPut garde ses propres plafonds.
- **L'aperçu du message**, replié par défaut, sur chaque règle qui écrit au membre : le texte
  du créateur s'il l'a modifié, celui de StayPut sinon, dans la langue des membres, avec
  l'étiquette EN ou FR. Il s'adresse à « Alex » et signe du nom de la communauté. La relance
  des paiements n'écrit rien : pas d'aperçu.
- **Toutes les règles éteintes** : la page dit « Aucune règle n'est active » et propose les
  trois qui ramènent le plus d'argent (relances, carte, questionnaire), avec un seul bouton
  principal « Activer ces 3 règles », et « Voir les 5 règles ».

### La file d'attente

- Chaque ligne : le membre, l'action, l'aperçu du message, l'heure d'envoi.
- Un seul bouton principal pour la page : « Approve all (6) ». Sur chaque ligne, « Approve »
  et « Skip » sont des boutons fantômes, jamais pleins.
- La carte qui entourait la liste disparaît : la liste est séparée par de fins traits.

### Tests

- Worker : une règle éteinte ne prévoit rien (`actions.test.ts`) ; la route, réservée à
  l'équipe, refuse une règle inconnue ou un corps sans `on` (`app.test.ts`).
- Web (`app.test.tsx`) : les cinq cartes et leurs interrupteurs, l'aperçu EN, le mode, les
  limites, deux onglets ; un interrupteur qui change tout de suite et revient si le serveur
  échoue ; le mode ; l'état vide et ses trois règles ; les filtres, le bouton principal unique,
  « Approve » fantôme ; les anciennes adresses ; un interrupteur de la démo, sans appel réseau.
- Navigateur : `demo-safety.e2e.ts` parcourt les nouvelles adresses.
- Inspect (`look.mjs`) vérifie tout cela sur le site en ligne et ajoute trois captures :
  `automations-rules-1440.png`, `automations-empty-1440.png`, `automations-queue-1440.png`.
- La migration 0032 s'applique au déploiement.

## 2026-10-04 — Correctifs v4.1, bloc 7b : les graphiques d'Analyses

### Trois onglets

- **Vue d'ensemble** (nouveau, `/insights`), **Cohortes** (`/insights/cohorts`, avant à
  `/insights`) et **Leçons**.
- La vue d'ensemble se lit à l'ouverture. Cohortes et Leçons restent les analyses de la semaine.

### La prévision à 90 jours (SPEC 6.5 et 6.6)

- Deux courbes : le revenu mensuel attendu chaque jour « si vous agissez » (turquoise) et « si
  vous ne faites rien » (pointillés). L'écart entre les deux est légèrement rempli.
- En grand : ce qu'agir garde sur 90 jours. À côté : le total de chaque courbe sur 90 jours.
- **Le curseur « Et si vous contactez »** : la part des membres à risque contactés, de 0 à
  100 %. Le gain suit, au centime près.
- **Le calcul**, dans `@stayput/core` (`forecastRevenue`, testé) :
  - chaque mois, un membre reste avec une probabilité selon son risque. Les valeurs de départ
    sont celles de SPEC 6.5 : faible 95 %, moyen 80 %, élevé 50 % ;
  - **un départ programmé compte comme un risque élevé (50 %)**, faute de valeur dans SPEC :
    son score (100) est dans la zone élevée, et l'historique réel le corrige ;
  - agir sauve une part des membres à risque contactés (30 % au départ). **Un membre sauvé reste
    ensuite comme un membre à risque faible** : c'est la lecture la plus simple à expliquer.
- **Les chiffres de la communauté remplacent ceux de StayPut** (SPEC : « dès 60 jours de
  données ») :
  - probabilités : les membres de chaque niveau il y a 30 et 60 jours (`risk_scores`), et ceux
    encore là un mois plus tard. Il faut 60 jours d'historique et 10 membres à ce niveau ;
  - taux de sauvetage : les membres à risque que StayPut a contactés entre 90 et 14 jours (le
    temps qu'une action produise son effet), et ceux qu'il a sauvés (sauvetage direct). Il faut
    10 membres contactés.
- Sous le graphique, une phrase dit sur quoi reposent les chiffres : ceux de StayPut, ceux de
  la communauté, ou un peu des deux.
- Les revenus partent des mêmes chiffres que le tableau de bord : membres payants, devise
  principale, équipe exclue.
- **L'échelle ne part pas de zéro** : sinon les deux courbes se confondent. Des valeurs rondes
  discrètes à gauche le disent.

### Pourquoi les membres partent (SPEC 6.8)

- Un donut des réponses au questionnaire de départ sur 90 jours.
- **Une seule couleur d'accent** (cahier v4 §6) : la raison principale en turquoise, les autres
  en blancs dégradés, séparées par un fin espace.
- La légende donne chaque raison, son nombre et sa part : la couleur seule ne porte jamais
  l'information.
- Le regroupement « par semaine » de SPEC 6.8 ira dans le rapport du lundi (fin de Phase 6).

### L'activité des membres sur 30 jours

- Une barre par jour (messages, réactions, publications, leçons ; équipe exclue).
- L'infobulle donne aussi le nombre de membres actifs ce jour-là.
- Le total est celui du tableau de bord (« Member activity (30d) »).

### Cohortes et leçons

- **Courbes de rétention par mois d'arrivée**, au-dessus du tableau. Le mois signalé est en
  turquoise ; celui que le pointeur survole (sur le graphique ou sur sa ligne du tableau) prend
  sa place. La moyenne est en pointillés.
- Dans le tableau, le mois signalé a un **liseré turquoise à gauche**, son taux en turquoise :
  plus d'icône d'alerte ni de rouge.
- **Leçons** : une barre par leçon (les 8 premières) avec un trait à la moyenne du cours ; les
  leçons bloquantes en turquoise, les autres en gris ; le tableau dessous.

### Démo

- La démo répond à la vue d'ensemble avec ses propres chiffres :
  - revenus par niveau, ceux du tableau de bord ;
  - raisons de départ tirées des offres que montrent la file et l'Historique ;
  - activité jour par jour, qui retombe sur le total de la page Membres ;
  - chiffres de départ de StayPut, car la démo n'a que 8 semaines d'historique.
- Correction de cohérence : l'activité d'un membre de la démo est proportionnée à son
  ancienneté. Pauline, arrivée ce matin, avait 64 actions « sur 30 jours » ; elle en a
  maintenant une.

### Tests

- `packages/core/test/forecast.test.ts` : la prévision, le curseur, les totaux, et les
  chiffres de la communauté (60 jours, 10 membres).
- `apps/worker/test/analytics-sql.test.ts` : revenus par niveau, probabilités mesurées, taux
  de sauvetage, raisons, activité, nouvelle communauté, réservé à l'équipe. La route est testée
  dans `app.test.ts`.
- `apps/web/test/app.test.tsx` : prévision et curseur, donut, barres, états vides, onglets ;
  cohortes avec liseré et courbe ; barres des leçons.
- `apps/web/test/demo.test.ts` : la démo cohérente (activité, revenus, raisons).
- Inspect (`look.mjs`) vérifie tout cela en ligne, avec trois captures :
  `analytics-overview-1440.png`, `analytics-cohorts-1440.png`, `analytics-lessons-1440.png`.

## 2026-10-04 — Correctifs v4.1, bloc 7c : Discord et Telegram, un tableau de bord chacun

### Ce qui change

- **Intégrations › Discord** et **› Telegram** sont chacun un tableau de bord, dès qu'un serveur
  ou un groupe est connecté (cahier v4 §9.6). Avant la connexion, l'onglet garde la carte qui
  explique comment ajouter le bot.
- **L'onglet Activité disparaît** : son contenu est dans chaque onglet. L'ancienne adresse
  `/sources/activity` mène à Discord, ou à Telegram quand seul un groupe est connecté.
- Le même ordre pour les deux :
  1. la connexion (point turquoise qui pulse en direct, dernière lecture, « Reconnect ») et
     trois chiffres : membres actifs sur 7 jours, devenus silencieux, messages sur 30 jours ;
  2. les messages jour par jour, dessinés comme la balance (§8) : tous les messages, et en
     pointillés ceux des membres à risque aujourd'hui. Un clic sur un jour montre ses salons
     et qui a écrit ce jour-là ;
  3. une carte de chaleur jour × heure, du noir au turquoise clair, dans le fuseau de la
     communauté. Un clic sur une heure liste qui a écrit à cette heure-là sur 30 jours ;
  4. les salons Discord, ou les groupes et leurs sujets Telegram, en barres triables (messages,
     membres, nom) ; au survol, les 3 membres les plus actifs ;
  5. les plus actifs et les devenus silencieux, sur 7, 14 ou 30 jours, avec leur anneau de
     risque et leurs actions au survol ;
  6. les signaux et l'aperçu de la répartition des scores ;
  7. qui est qui (les comptes à relier, tout le monde sur la plateforme) et les réglages du bot.

### Les chiffres (migration 0033)

- `platform_dashboard`, `platform_day` et `platform_slot` lisent `activity_events` sous
  l'identité du créateur (`is_company_admin`). Ce sont des lectures seules.
- **Actif** : un membre qui a écrit sur la plateforme ces 7 derniers jours. **Devenu
  silencieux** : un membre qui y a écrit sur 90 jours, mais pas sur la période choisie.
- Les messages comptent tout le monde : membres, équipe, invités, comptes pas encore reliés.
  L'infobulle du chiffre dit la part des membres.
- Les listes montrent 10 membres ; « + N de plus » dit le reste.
- **Noms des salons Discord** : relus une fois par jour au plus (`note_discord_channels`), et
  à chaque choix de salons. Un salon dont StayPut ne connaît pas encore le nom le dit.
- **Sujets Telegram** (`telegram_topics`) : un groupe à sujets compte ses messages par sujet,
  et « General » pour ce qui est hors sujet. Le nom d'un sujet vient de sa création ou de sa
  modification ; un sujet créé avant l'arrivée du bot le dit.

### Les signaux

- Trois signaux par plateforme, **éteints par défaut** :
  - **Silence** : a écrit les 4 semaines d'avant, rien cette semaine (+10 points proposés) ;
  - **Écrit moins** : écrit encore, mais moins de la moitié de sa moyenne par semaine des 4
    semaines d'avant, à partir de 2 messages par semaine (+5) ;
  - **A quitté** le serveur ou le groupe ces 30 derniers jours (+20). Partir dit plus que se
    taire : un membre parti ne compte que pour ce signal.
- Chaque signal allumé **ajoute ses points** au score des 5 facteurs (0 à 30, par pas de 5 ;
  plafond 100). Les règles d'avant gardent la priorité : départ programmé → 100, paiement
  échoué → au moins « risque élevé ».
- Les raisons du score rangent les signaux avec les facteurs, par points. « Silence » ne
  s'affiche pas quand « Inactif » le dit déjà.
- **L'aperçu est exact sans demander au serveur** : chaque score enregistre de quoi il est fait
  (`member_risk.signals` : le score des facteurs, les signaux vrais par plateforme, la règle).
  Le navigateur recalcule la répartition avec les réglages en cours et dit combien de membres
  changent de niveau (« High risk: 6 → 8 »).
- Enregistrer rend tous les scores dus : ils sont recalculés dans l'heure (dans la démo, tout
  de suite).

### Le test de connexion

- « Start the test » : le créateur écrit un message dans un salon ou un groupe que StayPut lit.
  Pendant le test, la page relit ce qui arrive toutes les 3 secondes (10 sinon).
- Le message s'affiche avec son heure seulement, jamais son texte. Au bout de 2 minutes sans
  message, la page dit quoi vérifier.
- Dans la démo, rien n'est écrit : le message est simulé au bout de 2,5 secondes, et la page le
  dit.

### La phrase de confidentialité

- Le cahier proposait « StayPut never reads what members write: only who wrote and when. » et
  demandait de l'ajuster si le bot fait autrement.
- StayPut garde aussi **où** (le salon, le groupe, le sujet) : c'est ce qui permet le bloc des
  salons. La phrase devient donc « …only who wrote, where and when. » (« …seulement qui a
  écrit, où et quand. »).
- Une seule clé (`sources.privacy`) pour les intégrations, le guide et l'accueil : la même
  phrase partout. Les textes du bot Telegram disent la même chose.

### Corrigé en passant

- **Tout le monde sur Discord / dans votre groupe Telegram** : la liste gardait 500 personnes
  en tout. Un grand serveur pouvait cacher tout le groupe Telegram, et le total était celui des
  deux. `platform_people` (remplacée dans 0033) garde **500 personnes par plateforme** et donne
  le total de chacune (`totals`).
- **Téléphone** : les tableaux des graphiques destinés aux lecteurs d'écran élargissaient la
  page (970 px pour un écran de 390). Un tableau n'est jamais plus étroit que son contenu :
  `ChartTable` le cache dans un conteneur, pour les 6 graphiques.
- **Une lecture qui échoue** : les blocs qui partagent la même lecture (chiffres, jours,
  heures, salons, membres, signaux) affichent un seul message d'erreur avec « Retry », sans
  cartes vides ni chiffres en attente.
- Les textes « reliez les autres ci-dessous » disent maintenant « dans “Qui est qui” », le bloc
  qui les contient.

### Démo

- Un journal message par message (graine fixe) donne tous les chiffres : jours, heures, salons,
  sujets, listes et la tuile en direct. Les tests vérifient que tout s'additionne.
- Deux départs (Yanis de Discord il y a 5 jours, Omar du groupe Telegram il y a 3 jours) et des
  membres silencieux près du seuil, pour que les signaux changent des niveaux.
- Enregistrer des signaux recalcule les scores, les niveaux et les totaux de la démo. Leurs
  raisons viennent après un départ programmé ou un paiement échoué, et avant les autres.

### Tests

- `packages/core/test/risk.test.ts` : signaux, points, règles, raisons, répartition.
- `apps/worker/test/platform-dashboard-sql.test.ts` : chiffres, jours, heures, salons, sujets,
  listes, signaux enregistrés et score refait. `accounts-sql.test.ts` : 500 personnes par
  plateforme et leurs totaux.
- `apps/web/test/app.test.tsx` : le tableau de bord entier, un jour choisi, une heure choisie,
  l'aperçu puis l'enregistrement des signaux, le test de connexion, « Retry » sous 5 secondes,
  la redirection de l'ancien onglet, les comptes à relier dans chaque onglet.
- `apps/web/test/demo.test.ts` : la démo s'additionne, et l'aperçu donne exactement les
  niveaux qu'on obtient en enregistrant.
- Inspect (`look.mjs`) vérifie les deux tableaux de bord en ligne (aucun bloc en attente après
  5 secondes, un jour et une heure choisis, l'aperçu qui bouge, rien de plus large qu'un
  téléphone) avec les captures `integrations-discord.png`, `integrations-telegram.png`,
  `integrations-discord-day.png`, `integrations-discord-hour.png`,
  `integrations-discord-signals.png` et `integrations-discord-390.png`.

### Incertain

- Les seuils des signaux (4 semaines, moitié de la moyenne, 2 messages par semaine, 30 jours)
  et les points proposés sont des choix de StayPut, à ajuster avec de vraies communautés.
- Les sujets Telegram ne sont vus que si le bot est dans un groupe à sujets. Les noms des
  sujets créés avant son arrivée restent inconnus jusqu'à leur prochaine modification.

## 2026-10-04 — Une réduction posée sur l'abonnement, un code Alumni pour les anciens clients

Deux défauts trouvés en vérifiant les offres (rapport du 04/10), corrigés après le bloc 7 comme
prévu.

### La réduction d'un membre va sur son abonnement

- **Le défaut** : un membre qui trouvait l'abonnement trop cher recevait un code valable 7 jours
  « pour son prochain paiement ». Or un abonné ne repasse jamais par un paiement où taper un
  code : son abonnement se renouvelle tout seul. Le code ne servait à rien.
- **Maintenant**, quand le membre accepte la réduction :
  1. StayPut crée un code unique, à usage unique, **réservé aux abonnements existants**
     (`existing_memberships_only`, l'option de Whop prévue pour « retenir un membre qui
     annule ») : personne ne peut s'en servir à un paiement ;
  2. il le pose sur l'abonnement (`POST /memberships/{id}/apply_promo_code`) : la réduction
     s'applique toute seule aux prochains paiements, pendant les mois prévus ;
  3. puis il retire l'annulation programmée.
- **L'ordre compte** : la réduction d'abord, l'annulation ensuite. Si Whop refuse la réduction,
  l'annulation reste en place : un membre ne reste jamais au plein tarif après avoir accepté de
  rester pour une réduction.
- **L'accord du membre** : une réduction n'a de sens que sur un abonnement qui continue. Dans le
  questionnaire de départ, elle demande donc la case « Je garde mon abonnement », comme la pause.
  L'offre du créateur depuis le tableau de bord fait de même : l'accepter, c'est rester
  (migration 0034, `decide_creator_offer`).
- **« Gardé » seulement s'il y avait une annulation** : StayPut ne retire une annulation (et ne
  compte un « abonnement gardé ») que si elle existait. Une pause ou une réduction pour un membre
  qui ne partait pas ne compte plus comme une annulation reprise : la pause compte comme une
  pause reprise.
- Le membre lit « C'est fait : 20 % de réduction sur vos 3 prochains paiements » ; le créateur,
  dans l'Historique, « Appliquée à l'abonnement ». Les offres d'avant gardent leur code affiché.

### Le code de retour Alumni est réservé aux anciens clients

- Il était déjà unique, à usage unique et valable 7 jours ; il est maintenant aussi réservé aux
  clients qui ont quitté la communauté (`churned_users_only`). Partagé, il ne donne rien à
  personne d'autre.

### Démo

- L'exemple de Sabrina (« trop cher », code non utilisé, partie quand même) racontait l'ancien
  comportement. Sabrina garde son « Left » avec un message du créateur. L'exemple de réduction est
  maintenant Laura : elle a pris la réduction et gardé son abonnement il y a 6 jours, et elle est
  revenue depuis (« Came back »).

### Tests

- `apps/worker/test/actions.test.ts` : l'ordre des appels (code réservé aux abonnements
  existants, réduction, annulation retirée) ; un refus de Whop laisse l'annulation ; pas de
  « gardé » sans annulation ; le code Alumni réservé aux anciens clients (aussi dans
  `alumni-followups.test.ts`).
- `apps/worker/test/creator-actions-sql.test.ts` : l'offre de réduction du créateur, acceptée,
  garde l'abonnement (échoue avant 0034).
- `apps/web/test/app.test.tsx` : la case d'accord, le message « C'est fait », l'Historique.

### Incertain

- `apply_promo_code` est documenté dans l'OpenAPI de Whop mais absent du SDK 2.0.0 ; je ne l'ai
  pas encore essayé dans la sandbox. Il demande une permission de gestion des abonnements, que
  l'app a déjà pour la pause et l'annulation : à confirmer au premier essai réel.
- Whop pourrait refuser de poser une réduction sur un abonnement dont l'annulation est
  programmée. Dans ce cas, l'action échoue proprement (rien n'est changé) et il faudra inverser
  l'ordre en gardant la garantie du plein tarif.

## 2026-10-04 — Phase 6.1 : la niche et les anciens membres dans l'accueil

### Ce qui change

- **Étape 1 (Bienvenue)** : « Votre communauté parle de » et les 7 niches. Le choix est
  facultatif ; « Commencer » applique ses préréglages (poids du score et seuil d'inactivité,
  `NICHE_PRESETS`), les seuils de risque restent ceux de la communauté. Rien n'est écrit si la
  niche est déjà la bonne. Un échec est dit et l'étape reste, comme pour le mode.
- **Étape 4 (Audit)** : sous les chiffres, « Anciens membres ». Sans offre Alumni : une phrase et
  « Créer l'offre Alumni » (gratuite, cachée de la boutique, voir 5.9) ; une permission manquante
  est nommée. Une fois l'offre prête (ou si elle l'était déjà) : le message automatique « User
  left » de Whop, prêt à copier avec le lien Alumni, et où le coller.
- Le brief v4 §10 fixe 4 étapes : la niche et l'Alumni entrent dans les étapes existantes au
  lieu d'en ajouter deux. Tout reste refusable : Passer ferme l'accueil sans rien changer.

### Pas dans l'accueil

- « Activation des options » (jours gagnés, binômes, défis, annonces) : ce sont des fonctions de
  l'espace membre, éteint en V1 (`MEMBER_SPACE_ENABLED`). Elles restent dans les Réglages.

### Tests

- `apps/web/test/app.test.tsx` : la niche choisie écrit ses préréglages en gardant les seuils ;
  l'offre Alumni créée depuis l'audit donne le texte « User left » avec son lien.

## 2026-10-04 — Phase 6.9 : le rapport du lundi

### Ce qui part, et quand

- Chaque lundi à partir de 8 h **dans le fuseau de la communauté**, une notification Whop à toute
  son équipe (`POST /notifications` avec `account_id`, comme le prévoit Whop pour les apps de
  tableau de bord). Le job tourne chaque heure (`weekly-reports`, après le calcul des
  sauvetages) : à 8 h là-bas pour un fuseau entier, à 8 h 30 pour un fuseau à la demi-heure.
- La semaine rapportée va du lundi 0 h au lundi 0 h, là-bas : celle qui vient de finir.
- Contenu : membres sauvés (sauvetages directs, chaque membre une fois), argent sauvé (direct, et
  l'influencé à part), membres perdus (abonnement terminé dans la semaine, comme la rétention du
  tableau de bord), première raison de départ, et la priorité de la semaine, celle que le tableau
  de bord donne ce lundi matin. Jamais un nom de membre : la notification s'affiche sur l'écran
  verrouillé d'un téléphone.
- Langue : celle de la communauté (`companies.locale`, la langue des messages).

### Une fois, et gardé

- Chaque rapport est fait une fois et gardé tel quel (`weekly_reports`, migration 0035) : une
  nouvelle tentative renvoie le même texte, même si un sauvetage de la semaine a été compté entre
  temps. Clé d'idempotence Whop par communauté et par semaine.
- Si Whop refuse, StayPut réessaie les heures suivantes, 3 fois au plus, puis le rapport reste
  « Non envoyé : Whop l'a refusé » dans l'app. Un rapport raté le lundi ne part pas le mardi.
- Pas de rapport pour la communauté de démo, ni pour une communauté installée le lundi même.

### Dans l'app

- Analytique › **Rapports** : l'interrupteur « L'envoyer à mon équipe » (activé par défaut,
  `company_settings.options.weekly_report`), la date du prochain, puis les 12 dernières semaines
  telles qu'envoyées. C'est aussi la synthèse des raisons de départ par semaine (SPEC 6.8).
- Démo : 6 semaines tirées de son histoire (ses sauvetages, ses départs, ses réponses au
  questionnaire) ; la priorité du dernier rapport est celle du tableau de bord.

### Tests

- `packages/core/test/weekly.test.ts` : la semaine dans le fuseau (Paris, New York, Tokyo,
  changement d'heure), le prochain envoi, le texte EN/FR, une semaine calme, aucun nom.
- `apps/worker/test/reports-sql.test.ts` : dû le lundi à 8 h là-bas seulement, jamais deux fois,
  ni démo ni désactivé ni installé le jour même ; les chiffres de la semaine (sauvetages, départs,
  réponses, bornes à 23 h 30 / 0 h 30) ; l'envoi une fois ; le refus réessayé avec le même
  rapport, puis abandonné après 3 refus ; lu sous RLS par l'équipe seulement.
- `apps/web/test/app.test.tsx` et `demo.test.ts` : la page, l'interrupteur, l'état vide en
  français, la démo cohérente avec ses propres chiffres.

### Incertain

- L'envoi à l'équipe par `account_id` est documenté par Whop mais pas encore essayé dans la
  sandbox : le premier lundi le dira (la page affichera « Envoyé » ou « Non envoyé »).
- Pas de `rest_path` : le chemin de la vue tableau de bord de l'app n'a pas `[restPath]`, donc
  toucher la notification ouvre l'accueil de StayPut.

## 2026-10-05 — Phase 6.10 : les benchmarks anonymes

### Ce qui est comparé

- La rétention à 30, 60 et 90 jours des membres arrivés ces 6 derniers mois (les analyses de la
  semaine, `cohort_stats`), regroupés : une communauté compte pour un chiffre, quelle que soit sa
  taille. Il lui faut au moins 10 membres assez anciens à chaque horizon pour compter.
- La valeur d'une niche est la moyenne des communautés qui partagent. Elle n'apparaît qu'à partir
  de **5 communautés** : la règle RLS de `stayput.benchmarks` (0002) la cache en dessous, et la
  table ne garde ni nom ni identifiant, seulement niche, mois, chiffre et nombre de contributeurs.

### Qui voit quoi

- **Opt-in** (`company_settings.options.benchmarks_opt_in`, désactivé par défaut) : on voit le
  chiffre de sa niche seulement si l'on partage le sien. Sa propre rétention s'affiche toujours.
- Recalcul chaque lundi à 07 h 30 UTC (le cron hebdomadaire, jusque-là vide) pour le mois en
  cours ; une communauté qui arrête de partager sort des chiffres au calcul suivant. Les mois
  passés restent comme ils ont été calculés.

### Dans l'app

- Analytique › Vue d'ensemble, en bas : « Les communautés comme la vôtre », l'interrupteur
  « Partager mes chiffres anonymement », les trois horizons en deux barres (vous, la niche) avec
  l'écart en points, et un tableau pour les lecteurs d'écran.
- Démo : elle partage ; les chiffres de sa niche sont fictifs comme le reste, les siens viennent de
  ses cohortes. Les départs à 90 jours de la démo passent de 19 % à 22 % pour que la rétention
  baisse bien de 60 à 90 jours.

### Tests

- `apps/worker/test/benchmarks-sql.test.ts` : 4 communautés ne suffisent pas, la 5e fait
  apparaître la moyenne (chaque communauté pèse pareil) ; ni celle qui ne partage pas, ni la démo,
  ni une petite (8 membres), ni des arrivées de plus de 6 mois ; une communauté qui ne partage pas
  ne voit rien de sa niche ; arrêter de partager la retire au calcul suivant ; rien ne nomme une
  communauté.
- `apps/web/test/app.test.tsx` et `demo.test.ts` : l'interrupteur, les écarts, « pas encore
  assez » en français, la démo cohérente.

## 2026-10-05 — Phase 6.11 : le badge « Rétention vérifiée »

### Le chiffre

- La part des membres arrivés ces **12 derniers mois** encore là **90 jours** après leur arrivée,
  tirée des analyses de la semaine (`cohort_stats`, `left_by_90` / `eligible_90`), donc mise à
  jour chaque lundi. Il faut au moins **10 membres** arrivés depuis plus de 90 jours ; en dessous,
  le badge n'apparaît nulle part et Réglages dit combien il en manque.
- Le créateur ne peut pas le modifier : StayPut le lit des abonnements Whop.

### Public, sur demande

- Désactivé par défaut (`company_settings.options.public_badge`, présent depuis 0001 ; 0037
  ajoute `save_badge_setting`). Une fois activé :
  - `/badge/<id>.svg` : l'image (« Verified retention | 92% at 90 days », ou en français selon la
    langue de la communauté), en cache une heure ;
  - `/verify/<id>` : la page de vérification, en HTML simple sans script (le style de la page de
    preuve publique), qui dit le chiffre, ce qu'il compte, combien de membres et la date.
- Désactivé, communauté de démo, désinstallée ou sans chiffre : les deux adresses répondent 404,
  sans dire pourquoi.

### Dans l'app

- Réglages › Général : « Badge « Rétention vérifiée » », l'interrupteur, le badge tel qu'il
  s'affiche (le même dessin que le Worker, `retentionBadgeSvg` dans packages/core), le code HTML
  à coller sur la page de vente avec « Copier le code », et « Ouvrir la page de vérification »
  (grisé dans la démo, comme tout lien sortant).
- La version « marque blanche » du badge (SPEC Phase 7, plan Scale) viendra avec les plans.

### Tests

- `packages/core/test/badge.test.ts` : les mots EN/FR, le dessin (titre pour les lecteurs
  d'écran, aucun script ni lien).
- `apps/worker/test/badge-sql.test.ts` : 12 mois, 10 membres au moins, public seulement activé,
  jamais la démo ni une communauté désinstallée, lu sous RLS par l'équipe.
- `apps/worker/test/app.test.ts` : l'image et la page de vérification apparaissent quand on
  l'active, disparaissent quand on le désactive.
- `apps/web/test/app.test.tsx` et `demo.test.ts` : la carte, le code à coller, le message
  d'attente en français, la démo.

## 2026-10-05 — Phase 6.12 : l'équipe, l'export et la suppression des données

### L'équipe

- Réglages › Général › « Équipe » : les administrateurs que Whop liste parmi les membres de la
  communauté, et pour chacun s'il a ouvert StayPut et quand pour la dernière fois
  (`company_admins.verified_at`). 0038 ajoute `team_access(company)`, qui ne répond qu'à un
  membre de l'équipe.
- On n'ajoute ni ne retire personne dans StayPut : c'est Whop qui décide qui fait partie de
  l'équipe (chaque ouverture est vérifiée auprès de Whop). La carte le dit.
- Sur téléphone, « A ouvert StayPut il y a… » passe sous le nom pour que le nom reste entier.

### L'export

- « Exporter mes données (JSON) » : un fichier `stayput-<id>-<jour>.json` avec la communauté,
  l'équipe et **toutes les tables qui ont un `company_id`**, lues sous RLS comme le membre de
  l'équipe (donc seulement les lignes de sa communauté). 100 000 lignes au plus par table ; au-delà,
  la table le dit (`truncated`).
- Quatre tables restent dehors, chacune avec sa raison dans `apps/worker/src/data.ts`
  (`NOT_EXPORTED`) : `company_admins` (déjà dans `team`), `company_sync` (la tenue de compte du
  Worker), `pending_activity` (messages qui attendent quelques minutes leur membre) et
  `webhook_events` (les envois bruts de Whop, gardés quelques jours). Une nouvelle table avec un
  `company_id` doit aller dans l'une des deux listes : `data-sql.test.ts` échoue sinon.
- Aucune table ne garde de secret (vérifié dans les migrations) : rien à masquer dans l'export.
- La démo exporte aussi (un fichier de ses données fictives) : ce n'est ni un lien sortant ni une
  action qui détruit.

### La suppression

- « Supprimer toutes les données » ouvre une fenêtre qui dit ce qui part et demande de retaper le
  nom de la communauté. La requête répète l'identifiant de la communauté
  (`{ confirm: <id> }`) : un appel égaré ne supprime rien.
- `delete_company_data(company)` (0038, réservée au Worker, jamais à `stayput_user`) supprime la
  communauté — tout le reste suit par `on delete cascade` — et ses `webhook_events`. Le Worker
  écrit dans ses journaux qui l'a demandé.
- Si StayPut reste installé, il repart des données de Whop à la prochaine ouverture ou
  synchronisation ; pour arrêter pour de bon, il faut le désinstaller depuis Whop. La fenêtre le
  dit. La suppression automatique 30 jours après la désinstallation vient avec la Phase 8.
- Grisé dans la démo, avec « Désactivé dans la démo ».

### Tests

- `apps/worker/test/data-sql.test.ts` : chaque table avec un `company_id` est exportée ou a sa
  raison ; l'export ne contient que les lignes de la communauté et rien pour l'équipe d'une autre ;
  l'équipe et qui a ouvert StayPut ; la suppression vide toutes les tables d'une communauté et ne
  touche pas à l'autre.
- `apps/worker/test/app.test.ts` : l'équipe, l'export en pièce jointe, la suppression refusée
  sans le bon identifiant ou à qui n'est pas de l'équipe, acceptée sinon.
- `apps/web/test/app.test.tsx` : la liste de l'équipe, le fichier téléchargé, le bouton
  « Tout supprimer » actif seulement une fois le nom retapé.

### Incertain

- Dans le cadre (iframe) de Whop, le téléchargement d'un fichier peut être bloqué par le bac à
  sable du cadre. À essayer sur le sandbox ; sinon, ouvrir l'export dans un nouvel onglet.

## 2026-10-05 — Phase 6.13 : les chiffres de l'Alumni

### Les trois chiffres

- **Dans l'Alumni** : les anciens membres qui y sont aujourd'hui et ne paient pas encore
  (`alumni_members.status = 'entered'`).
- **Taux de retour** : sur tous les anciens membres entrés un jour dans l'Alumni (encore dedans,
  partis de l'Alumni ou revenus), la part qui paie à nouveau. `alumniReturnRate` dans
  packages/core ; aucun taux tant que personne n'est entré (« Pas encore »).
- **Argent récupéré** : ce que les anciens membres revenus ont payé **depuis leur première entrée
  dans l'Alumni** (paiements réussis, montant positif ; remboursés ou contestés exclus, comme en
  6.4). Dans la devise principale ; les autres devises sont signalées par l'API, pas additionnées.
- Ce n'est pas la même chose que « Sauvé » (6.4) : « Sauvé » ne compte un retour que s'il passe
  par un code de retour StayPut, et seulement son premier paiement. L'Alumni compte tous les
  retours et tout ce qu'ils ont payé depuis : c'est le chiffre que la SPEC demande pour la page
  Alumni, et la page dit exactement ce qu'il compte (info-bulle sur chaque chiffre).

### Où

- 0039 remplace `alumni_view` (même signature, mêmes droits) pour ajouter l'argent, par devise.
- Automatisations › File d'attente › Alumni : les trois chiffres en haut, puis une ligne « 12
  anciens membres sont entrés dans l'Alumni. Revenus : 2 · partis de l'Alumni : 1. », puis le
  lien et le message « User left » comme avant.
- Démo : 9 dans l'Alumni, 1 parti, 2 revenus (17 %), et 147,00 $ : les deux revenus ont repris
  l'abonnement mensuel (49 $), l'un il y a cinq semaines (deux paiements), l'autre il y a douze
  jours (un paiement). `demo.test.ts` vérifie que ces chiffres se tiennent.

### Tests

- `packages/core/test/alumni.test.ts` : le taux, et pas de taux sans entrée.
- `apps/worker/test/alumni-money-sql.test.ts` : seuls les revenus comptent, seulement depuis leur
  entrée, jamais un remboursement ; une autre devise est signalée à part ; rien pour qui n'est
  pas de l'équipe.
- `apps/web/test/app.test.tsx` : les trois chiffres, leurs info-bulles, « Pas encore » en
  français avant toute entrée.

### Démo : un seul identifiant

- La démo appelle son API sous `demo`, mais montre partout ailleurs le même identifiant de forme
  Whop, `biz_AtlasTradingClub` : Réglages › Développeur, le fichier exporté et les adresses du
  badge (avant, Développeur disait « demo » et le badge `biz_AtlasTradingClub`). `DEMO_WHOP_ID`
  dans apps/web/src/api.ts ; `demo.test.ts` et `app.test.tsx` le vérifient.

### Inspect : la preuve du tableau de bord sur le sandbox

- `scripts/ops/inspect.ts` lit aussi, pour chaque communauté, ce que la Phase 6 a produit : la
  niche, l'accueil terminé, le rapport du lundi, le partage des benchmarks, le badge, l'équipe,
  les sauvetages par type (nombre et somme), les réponses au questionnaire par raison, les 4
  derniers rapports du lundi (envoi, essais, erreur), les benchmarks de sa niche (nombre de
  communautés) et l'argent de l'Alumni. Des comptes et des sommes seulement, rien de personnel ;
  essayé sur un PostgreSQL 16 local avant de tourner en production.
- `scripts/ops/look.mjs` photographie aussi chaque page de Réglages, la liste « Ne pas
  contacter » et les chiffres de l'Alumni.

## 2026-10-05 — Correctif : la page de vérification du badge

- `/verify/<id>` n'était pas dans `run_worker_first` (wrangler.toml) : en production, Cloudflare y
  servait l'application React (sa page « introuvable ») au lieu de la page de vérification du
  Worker. Les tests appelaient le Worker directement et ne pouvaient pas le voir.
- Corrigé, et `apps/worker/test/routing.test.ts` vérifie désormais que **chaque route du Worker**
  est dans `run_worker_first` (il échouait sur `/verify` avant le correctif). Inspect demande
  aussi `/verify/…` et `/badge/….svg` d'une communauté qui n'existe pas : 404 du Worker, pas la
  page de l'application.

## 2026-10-05 — Arrêt de la Phase 6 : le tableau de bord, point par point

### Les 13 points de la SPEC, où ils sont

| #   | Point                         | Où dans l'app                                                                                                                                                                                             |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Onboarding en 3 minutes       | L'accueil en 4 étapes à la première ouverture (niche, Alumni, « User left »)                                                                                                                              |
| 2   | Écran d'accueil               | Tableau de bord : l'argent sauvé, à risque, membres à risque, l'action du jour                                                                                                                            |
| 3   | Liste des membres             | Membres : tri par risque, filtres, raisons, historique, actions, fiche                                                                                                                                    |
| 4   | Argent sauvé (attribution)    | Tableau de bord ; File d'attente › Historique : chaque action et ce qu'elle a donné (« Récupéré 49,00 $ »). Les identifiants Whop de la preuve sont gardés (`saves.proof`) et dans l'export, pas affichés |
| 5   | Prédiction à 90 jours         | Analyses › Vue d'ensemble : deux courbes                                                                                                                                                                  |
| 6   | Simulateur « et si »          | Analyses › Vue d'ensemble : le curseur                                                                                                                                                                    |
| 7   | Cohortes et leçons bloquantes | Analyses › Cohortes, Leçons                                                                                                                                                                               |
| 8   | Raisons de départ             | Analyses › Vue d'ensemble (90 jours) et chaque rapport du lundi (la semaine)                                                                                                                              |
| 9   | Rapport du lundi              | Notification à l'équipe, lundi 8 h ; Analyses › Rapports                                                                                                                                                  |
| 10  | Benchmarks anonymes           | Analyses › Vue d'ensemble, en bas (sur accord, 5 communautés au moins)                                                                                                                                    |
| 11  | Badge « Rétention vérifiée »  | Réglages › Général ; `/badge/<id>.svg` et `/verify/<id>`                                                                                                                                                  |
| 12  | Paramètres                    | Réglages (Général, Score de risque, Automatisations) ; Membres › Ne pas contacter                                                                                                                         |
| 13  | Alumni                        | Automatisations › File d'attente › Alumni : les trois chiffres                                                                                                                                            |

Tous sont dans la démo en ligne (`/demo`), photographiés à chaque Inspect.

### Le sandbox, lu par Inspect le 5 octobre à 01 h 27 UTC

- « StayPut Test » : 26 membres (25 notés : 3 départs programmés, 10 risque élevé, 9 moyen,
  3 faible), 157 paiements, 1 646 événements d'activité, Discord et Telegram connectés ; mode
  test et mode manuel, heure de Paris ; 8 cohortes et 12 leçons analysées.
- **Badge** : 22 membres comptés, assez pour un chiffre dès que le badge est activé (éteint).
- **Benchmarks** : non partagés, et une seule communauté : rien à montrer, comme prévu.
- **Rapport du lundi** : le premier est dû ce lundi à 8 h (Paris). L'envoi demande la permission
  `notification:create`, pas encore accordée : Whop devrait le refuser (403), et le rapport reste
  lisible dans Analyses › Rapports. Vérifié à 8 h 25 (voir plus bas, s'il y a lieu).
- **Sauvetages** : aucun. Les membres fictifs n'existent que dans StayPut : ils ne paient pas, et
  rien ne peut être « sauvé » pour eux. Un vrai sauvetage demandera un vrai membre de test (un
  second compte Whop), comme à l'arrêt de la Phase 4.
- **Alumni** : pas d'offre, les 4 permissions de création ne sont pas accordées.
- **Accueil** : jamais terminé sur le sandbox (`welcomed_at` vide) ; il s'ouvrira à la prochaine
  ouverture de StayPut.

### Ce qui reste au fondateur pour la démonstration complète

1. Ouvrir StayPut dans le sandbox de Whop (la communauté « StayPut Test ») : l'accueil s'ouvre,
   puis parcourir les six rubriques.
2. Accorder les 8 permissions d'écriture dans le tableau de bord développeur de Whop (actions :
   `member:manage`, `payment:manage`, `promo_code:create`, `notification:create` ; Alumni :
   `access_pass:create`, `plan:create`, `experience:create`, `experience:attach`), puis approuver
   à nouveau l'app (Whop → Paramètres → Applications autorisées).
3. Au choix : activer le badge et le partage des benchmarks dans Réglages.

## 2026-10-05 — Phase 8.2 et 8.3 : données minimales et droits des personnes

### Ce que Whop envoie

- **Trouvé en préparant la politique de confidentialité** : les envois bruts de Whop
  (`webhook_events.payload`) étaient gardés tels quels et sans limite de durée. Ils contiennent
  l'e-mail du membre (`user.email`, `customer_email`), son téléphone, et pour un message de chat
  son texte (`content`). Contraire à la SPEC 8.2 (« pas de contenu des messages stocké »), à
  l'en-tête de 0005 (« les e-mails ne sont jamais stockés ») et à ce que disait 151e (« gardés
  quelques jours »). Sur le sandbox, aucun envoi n'était stocké (« Webhook deliveries : none »).
- 0040 : un déclencheur retire ces champs de chaque envoi avant qu'il soit gardé (e-mails,
  téléphones, adresses, texte des messages, pièces jointes), à toute profondeur ; les envois
  déjà gardés sont nettoyés de la même façon. Ce que StayPut lit (ids, nom, dates, montants)
  reste : le traitement est inchangé (testé sur un membre, un paiement et un message).
- Un envoi traité ou ignoré part après **7 jours** (le temps de vérifier un doute), tout envoi
  après **30 jours** au plus (les rejeux abandonnent après 5 essais) : chaque heure.

### Les données d'un membre (fiche du membre › « Ses données »)

- **Exporter (JSON)** : tout ce que StayPut garde sur ce membre, lu sous RLS comme le membre de
  l'équipe : chaque table qui pointe vers un membre (`MEMBER_TABLES` dans
  apps/worker/src/data.ts ; un test échoue si une nouvelle table manque), plus ses abonnements
  et paiements lus avant lui (par ses ids Whop) et ses comptes Discord et Telegram.
- **Supprimer ses données** : après confirmation, tout ce qui le concerne est supprimé
  (`forget_member`), et StayPut ne le reprend **plus jamais** dans cette communauté : ni par Whop
  (synchronisation, envois), ni par Discord ou Telegram. Pour cela StayPut garde l'**empreinte**
  (SHA-256) de ses ids (`erased_people`), jamais les ids ; des déclencheurs écartent toute ligne
  qui le concerne. L'historique des actions de l'équipe (`audit_log`) reste, sans dire sur qui.
- Grisé dans la démo, l'export y marche (les données fictives du membre).

### Désinstallation, puis suppression au bout de 30 jours

- Whop n'envoie aucun événement de désinstallation (Phase 0). StayPut la déduit : quand la
  lecture des membres d'une communauté est refusée (403), il demande à Whop ce que l'app peut
  encore y faire (`GET /permissions`, au plus toutes les 6 heures). Rien d'accordé pendant
  **un jour** : la communauté est « désinstallée », depuis le premier refus. Une réponse 401 (la
  clé elle-même refusée) concerne tout le monde : personne n'est marqué. Rouvrir StayPut, ou un
  accès rendu, annule tout.
- **30 jours** après, tout est supprimé (comme « Supprimer toutes les données »), jamais la démo.
- À confirmer en vrai : ce que Whop répond exactement après une désinstallation (Phase 0 l'avait
  laissé « à confirmer en sandbox ») ; il faudrait désinstaller l'app du sandbox pour le voir.

## 2026-10-05 — Phase 8.4 : l'activité détaillée gardée 12 mois

- Chaque lundi, les événements d'activité de plus de 12 mois sont supprimés (0041) ; leurs
  comptes par jour (`member_stats_daily`) restent.
- Le recalcul des comptes d'un jour (`refresh_activity_stats`) ne remonte plus avant le premier
  jour dont tous les événements sont encore gardés : sinon un recalcul demandé de loin aurait
  effacé les comptes des jours aux événements supprimés. Testé : purge puis recalcul, les comptes
  anciens ne bougent pas.
- Conséquence : les leçons bloquantes ne regardent plus que les 12 derniers mois de leçons.

## 2026-10-05 — Phase 8.1 : politique de confidentialité, conditions d'utilisation, accord de traitement

- **Trois pages publiques servies par le Worker** : `/privacy`, `/terms`, `/dpa`, en anglais et en
  français (`?lang=fr`, sinon la langue du navigateur, sinon l'anglais), en HTML simple sans
  script, comme la page de vérification du badge (une politique de sécurité qui n'autorise que
  leur propre style). Ajoutées à `run_worker_first` (le test de routage l'impose).
- **Dans l'app** : Réglages › Général › « Documents légaux » ouvre chaque page dans une fenêtre
  qui se ferme, comme la page d'une carte : on les lit sans quitter Whop. Côté membre, un lien
  discret « Confidentialité » en bas de sa page, dans la langue de la communauté. Dans la démo,
  rien n'est grisé : ce ne sont pas des liens externes.
- **Ce que disent les textes** : StayPut est sous-traitant pour les données des membres (le
  créateur est responsable du traitement) et responsable pour les comptes des équipes ; ce qui
  est traité, d'où, pourquoi ; jamais d'e-mail, de téléphone ni de texte de message ; les durées
  telles que la base les applique (12 mois d'activité détaillée, 7 jours puis 30 jours au plus
  pour les envois de Whop, suppression 30 jours après la désinstallation ; un test vérifie que
  les pages disent ces durées) ; les droits et comment les exercer ; les sous-traitants (Whop,
  Cloudflare, Supabase, Discord et Telegram s'ils sont connectés) ; notification d'une violation
  sous 48 heures (DPA).
- **Brouillons** : chaque page le dit en tête. **À compléter par le fondateur** avant le
  lancement, dans `apps/worker/src/legal.ts` (`OPERATOR`) : la raison sociale de l'éditeur, son
  adresse, l'e-mail de contact, le droit applicable et les tribunaux. Tant qu'ils manquent, les
  pages les montrent entre crochets (« [raison sociale de l'éditeur : à compléter] »). Les
  textes sont à faire relire (SPEC 8.1) ; ils ne valent pas avis juridique.
- **Permissions** : l'app du sandbox demande `member:email:read` et `member:phone:read` depuis
  la Phase 2, mais StayPut ne lit ni ne garde aucun e-mail ni téléphone. L'app de production ne
  les demandera pas (checklist de la Phase 9) ; le rapport des permissions d'Inspect les range
  désormais à part, « Not needed (SPEC 8.2) ».
- Pour la fiche de l'App Store (Phase 9) : les adresses publiques à donner à Whop sont
  `https://<domaine de StayPut>/privacy` et `/terms`.

## 2026-10-05 — Phase 8.5 : journal des erreurs, page d'état interne, rejeu des webhooks

- **Journal des erreurs** (0042, `error_log`) : chaque erreur une seule fois par endroit,
  communauté et message, avec son nombre et ses dates. Sources : chaque tâche planifiée en échec
  (`job:<nom>`), toute requête qui échoue sans réponse prévue (`request`), le travail en
  arrière-plan (`background:<quoi>`). Le message est **nettoyé avant d'être gardé**
  (`scrubErrorMessage`, packages/core) : e-mails, identifiants Whop d'une personne (`user_`,
  `mber_`, `mem_`), numéros longs (téléphones, comptes Discord et Telegram), clés (`apik_`, `ws_`…),
  jetons, et la partie « ? » des adresses. Gardé 30 jours après sa dernière occurrence, supprimé
  avec la communauté. Pas dans l'export des données : ce sont les erreurs de StayPut, pas les
  données de la communauté (`NOT_EXPORTED`, avec sa raison).
- **Suivi des tâches** (`job_runs`) : chaque passage de chaque tâche planifiée (durée, dernier
  succès, dernier échec et son message). Une tâche est « en retard » après deux de ses périodes
  sans passage (Cloudflare l'a sautée, ou le Worker s'est arrêté).
- **Page d'état** : Réglages › État, visible seulement pour l'équipe de la communauté de
  l'opérateur (`OPERATOR_COMPANY_ID` : « StayPut Test » dans le sandbox, dans wrangler.toml ; en
  production, la variable de dépôt du même nom, comme `WHOP_APP_ID`). Pour toute autre
  communauté, ses routes n'existent pas (404), et un membre qui n'est pas de l'équipe est refusé
  (403). Elle montre : Whop (sandbox ou production), la base (à jour ou non) et son schéma ; les
  tâches ; les envois de Whop des dernières 24 heures et ceux en échec (type, communauté, essais,
  erreur ; jamais leur contenu) ; les communautés (actives, accès refusé, désinstallées) ; les
  lectures refusées ; les actions en échec de la semaine ; le journal des erreurs.
- **Rejeu** : « Rejouer » (un envoi) et « Rejouer tous les échecs » retraitent aussitôt un envoi
  en échec, même un de ceux que le rejeu automatique (toutes les 10 minutes, 5 essais) a
  abandonnés. Qui l'a fait est gardé (`audit_log`, action `webhooks.replay`). La procédure :
  corriger la cause (le plus souvent, déployer un correctif), puis rejouer. Un envoi en échec est
  gardé 30 jours au plus (0040) ; au-delà il est perdu, mais la synchronisation relit de toute
  façon les membres, abonnements et paiements chaque heure.
- **Pages légales dans l'app** : la capture d'Inspect montrait la page claire dans la fenêtre
  sombre, avec un double cadre. Ouverte depuis StayPut (`?view=app`), elle prend ses couleurs
  sombres et perd son cadre ; la page publique suit toujours la préférence du navigateur.

## 2026-10-05 — Phase 8.6 : les parcours clés, de bout en bout

- **Dans un vrai navigateur** (`apps/web/e2e/journeys.e2e.ts`, Playwright, Chrome), à chaque
  envoi sur GitHub (CI, sur la version construite) et à chaque Inspect (sur le site déployé) :
  1. **Installation** : l'accueil en 4 étapes (le sujet de la communauté, Discord/Telegram, le
     mode automatique, le premier audit), puis le tableau de bord ; Automatisations affiche bien le
     mode choisi.
  2. **Audit** : le filtre « High » de Membres montre autant de lignes qu'il en compte, chacune
     notée 70 ou plus, et la fiche du premier dit pourquoi.
  3. **Une action** : proposée dans la file, approuvée, elle passe dans « Scheduled ».
  4. **La page du membre** : la raison de son départ, l'offre qui y répond (20 % pendant 3 mois),
     son accord pour garder l'abonnement, puis ce qui en résulte ; jamais de score de risque.
     Les réponses du serveur y sont données par le test, à la forme de celles du Worker.
  5. **Un sauvetage attribué** : « Recovered $49.00 » dans l'historique, et le montant du mois sur
     le tableau de bord.
     Les parcours du créateur tournent sur la démo (répondue dans le navigateur) : c'est la seule
     partie du site déployé ouverte sans compte Whop.
- **Côté Worker** (`apps/worker/test/journey.test.ts`, sur une vraie base Postgres en mémoire,
  dans `npm run check`) : le même parcours avec le code de production, de bout en bout. Les
  envois de Whop classés (un membre, son abonnement, un paiement refusé) → le calcul du risque
  (Bo à risque, à cause du paiement) → en mode automatique, l'avis et la nouvelle tentative
  planifiés sans approbation puis envoyés par Whop → Whop envoie le paiement réussi → le
  sauvetage de 49 $ attribué à l'action, une seule fois, et affiché sur le tableau de bord.

## 2026-10-05 — Le premier rapport du lundi, dans le sandbox

- Fait à 8 h 00 (Paris) pour la semaine du 28/09 et **accepté par Whop** (`POST /notifications`,
  `account_id` = la communauté) : envoyé à 06:00:18 UTC, aucun essai raté, aucune erreur. Pourtant
  `GET /permissions` dit toujours `notification:create` non accordée : le 403 attendu à l'arrêt de
  la Phase 6 n'est pas venu.
- Incertain : qu'elle soit vraiment arrivée. Whop a répondu sans erreur, rien de plus : à voir
  dans la cloche de Whop (sandbox) de « StayPut Test ». Si elle n'y est pas, Whop accepte sans
  livrer, et « Envoyé » dans Analyses › Rapports dirait plus que ce qui est sûr.

## 2026-10-05 — Phase 9.1 et 9.2 : la production, un second déploiement

- La production est un **second Worker**, `stayput-app`
  (`https://stayput-app.chezbenz18.workers.dev`), à côté du sandbox `stayput` qui reste pour les
  essais : sa propre base Supabase, sa propre connexion Hyperdrive (`stayput-db-production`), sa
  propre app Whop. Le workflow Deploy a un choix `target` (`sandbox` par défaut, ou
  `production`) ; Inspect aussi, mais sur la production il ne regarde que ce que voit un
  navigateur : le dépôt est public, ses journaux aussi, et aucune communauté cliente ne doit y
  apparaître. L'état de la production se lit dans StayPut, Réglages › État.
- **Les réglages de la production portent le préfixe `PRODUCTION_`**
  (`PRODUCTION_SUPABASE_DB_URL`, `PRODUCTION_WHOP_API_KEY`, `PRODUCTION_WHOP_WEBHOOK_SECRET`,
  `PRODUCTION_TELEGRAM_BOT_TOKEN`, `PRODUCTION_WHOP_APP_ID`, `PRODUCTION_OPERATOR_COMPANY_ID`)
  plutôt que les mêmes noms dans un environnement GitHub. Un secret d'environnement remplace
  celui du dépôt, mais un secret oublié laisse passer celui du dépôt, donc celui du sandbox, sans
  rien dire : la production aurait écrit dans la base du sandbox. Avec un nom à elle, un réglage
  manquant arrête le déploiement, qui le nomme. L'environnement GitHub « production » sert à les
  ranger et à exiger ton accord avant chaque déploiement de production. `WHOP_ENV` n'est plus à
  régler : la cible le fixe. Pour l'opérateur, ceci remplace « la variable de dépôt du même nom »
  de la Phase 8.5.
- En production, la clé et le secret du webhook de Whop, l'app et la communauté de l'opérateur
  sont obligatoires (le sandbox peut tourner sans) ; un identifiant collé sous une autre forme
  (une adresse à la place du `biz_…`) est refusé.
- **Une base, un déploiement** (migration 0043, `scripts/deploy/claim.ts`) : le premier
  déploiement qui migre une base l'inscrit dans `stayput.app_settings.deployment_target` ;
  l'autre est ensuite refusé avant toute migration, sans rien modifier.
- **Telegram** : un bot n'a qu'une adresse de webhook, que le Worker règle lui-même ; partagé, il
  passerait d'un Worker à l'autre. Sans `PRODUCTION_TELEGRAM_BOT_TOKEN`, Telegram reste donc
  éteint en production : il faut un second bot. Discord, sans webhook, sert les deux (une
  redirection OAuth de plus).
- La checklist complète : `docs/production.md`.

### Testé

- `apps/worker/test/deploy.test.ts` : les réglages `PRODUCTION_…` exigés et nommés tels qu'ils
  sont rangés, les identifiants mal collés refusés, la cible et l'environnement de Whop qui
  doivent s'accorder, une connexion Hyperdrive par déploiement.
- `apps/worker/test/claim.test.ts` (Postgres en mémoire) : la base réservée par le premier
  déploiement, refusée à l'autre et restée au premier ; rien à réserver avant 0043 ; seuls
  `sandbox` et `production` existent.

### Incertain

- Le déploiement de production n'a pas encore tourné : il attend la base, l'app Whop et les
  réglages (`docs/production.md`, étapes 1 à 3).

## 2026-10-05 — Phase 9.3 : la fiche App Store

- `docs/app-store.md` : le nom, un sous-titre, la description courte (`description` chez Whop,
  dans les listes et la recherche) et la longue (`app_store_description`, sur la page de l'app),
  en anglais avec les mots-clés churn, retention, member risk, failed payments, win-back ; la
  liste des fonctionnalités ; l'icône (`docs/brand-logo-1024.png`) ; les liens légaux. Les textes
  ne promettent que ce que StayPut fait aujourd'hui (rien sur l'espace membre, éteint en V1). Le
  prix attend la phase 7.
- **Les 5 captures** (1920 × 1080) sont faites par `scripts/ops/store.mjs` à chaque Inspect, sur
  la démo déployée, donc avec les polices de StayPut (Satoshi ne vit que sur le site déployé) :
  le tableau de bord, les membres classés par risque, la file d'approbation, les paiements
  refusés relancés et récupérés, l'offre Alumni. Moins d'animation demandé : chaque chiffre est à
  sa valeur finale. Le bandeau de la démo, son badge et la pastille « Getting started » sont
  masqués (`data-demo-notice`, `data-demo-badge`, `data-getting-started`) : ils ne font pas partie
  du produit acheté. Les données restent celles, inventées, de la démo. Copie gardée dans
  `docs/app-store/`.
- **Correctif** : une capture montrait « In the Alumni 8.996 ». Un nombre de personnes qui compte
  jusqu'à sa valeur passait par des décimales (le format des nombres en garde trois) ; arrêté au
  vol, il les montrait. Les compteurs animés de l'Alumni et des tableaux Discord et Telegram
  arrondissent maintenant chaque étape, comme ceux du tableau de bord.
- Whop ne publie pas les dimensions attendues des captures : 1920 × 1080 (16:9) par défaut ; la
  fenêtre et l'échelle se changent en tête du script.
- La politique de sécurité du site (`style-src 'self'`) refuse le style qui masque le bandeau de
  la démo : le premier Inspect n'a fait aucune capture. Le navigateur des captures, lui seul,
  l'ignore (`bypassCSP`) ; le site garde sa politique. Vérifié en local avec la même politique
  (refusé sans, cinq captures avec).

## 2026-10-05 — Phase 9.4 : la documentation technique finale

- Dans `/docs`, en français : `architecture.md` (le Worker, la base, une requête, les webhooks, les
  actions, Discord et Telegram, la démo, la sécurité), `data-schema.md` (chaque table, ce qu'elle
  garde, qui la lit, combien de temps ; les règles communes ; les fonctions SQL principales),
  `jobs.md` (les trois déclencheurs et leurs tâches), `environment.md` (chaque variable du
  Worker, de GitHub et des scripts), `operations.md` (surveiller, rejouer les envois de Whop,
  changer chaque clé, sauvegarder, arrêter tout en urgence). Le README y renvoie et son état des
  phases est à jour.
- **Correctif trouvé en écrivant la rotation des clés** : après un changement du mot de passe de
  la base, le déploiement ne redonnait pas la connexion à Hyperdrive. Il ne la mettait à jour que
  si l'hôte, le port, l'utilisateur ou la base changeaient, et Cloudflare ne montre jamais le mot
  de passe gardé : le Worker serait resté sur l'ancien, sans accès à la base. Chaque déploiement
  redonne maintenant la connexion à Hyperdrive, qui la vérifie avant de l'accepter.
- Incertain : les sauvegardes que Supabase garde sur le plan gratuit (le site de Supabase n'est
  pas joignable d'ici) ; `docs/operations.md` dit où le voir et comment faire une copie à la main.

## 2026-10-06 — Sécurité : le journal de l'équipe (`audit_log`)

- **Trouvé pendant l'audit de sécurité** : le SPEC (§3) veut dans `audit_log` « toute action
  sensible (qui, quoi, quand, pourquoi) », mais seul le rejeu des envois de Whop y écrivait.
  Exporter les données de tous les membres, couper le mode test, approuver des actions, donner une
  remise ou effacer un membre ne laissait aucune trace.
- Chaque route de la vue créateur qui change quelque chose porte maintenant le middleware
  `audited('<action>')` (`app.ts`), placé après `requireCreator` : une réponse 2xx écrit la ligne
  (qui, quoi, quand, et sur quoi : `target`, que la route renseigne avec des identifiants, des
  nombres et des réglages ; jamais un nom, le texte d'un message, ni l'identifiant Discord ou
  Telegram d'une personne, qui survivrait à son effacement). Une demande refusée n'écrit rien. Les
  deux exports (la communauté, un membre) aussi, bien qu'ils ne changent rien : ils font sortir les
  données. Et la connexion d'un serveur Discord (le retour de Discord, hors de l'API).
- Une ligne qui ne peut pas s'écrire ne fait pas échouer la demande : le changement est déjà fait,
  le dire raté tromperait. L'erreur va au journal des erreurs (`audit:<action>`).
- Effacer un membre : la ligne dit qu'un membre a été effacé, par qui et quand, jamais lequel ; ses
  lignes d'avant gardent l'action, plus sur qui (`forget_member`, 0040).
- Sans ligne : la suppression de toutes les données (le journal part avec le reste, comme la
  politique de confidentialité le promet ; le journal du Worker garde qui l'a demandée), les
  relectures (synchronisation, activité en direct), la pastille « Getting started » et le fuseau
  du navigateur. `routing.test.ts` échoue sur toute autre route de la vue créateur qui change
  quelque chose sans ligne.
- Les workflows CI, Deploy et Seed reçoivent un jeton GitHub en lecture seule
  (`permissions: contents: read`), comme Inspect, dont seule la tâche des captures écrit (la branche
  `screenshots`).

### Testé

- `app.test.ts` : les lignes écrites (badge, mode test, « ne pas contacter », export) avec leur
  auteur et leur heure, aucune pour un refus (400, 403, 404) ; l'effacement d'un membre ; une ligne
  impossible à écrire ; la connexion d'un serveur Discord.
- `routing.test.ts` : chaque route qui change quelque chose a sa ligne, ou sa raison de ne pas en
  avoir ; vérifié qu'il échoue quand une route perd son marqueur.

## 2026-10-06 — Sécurité : la taille des envois, et le Worker attaqué depuis l'extérieur

- **Trouvé pendant l'audit** : les deux webhooks ne refusaient un envoi trop gros que d'après son
  en-tête `Content-Length`. Envoyé par morceaux (sans longueur annoncée), il était lu en entier en
  mémoire avant d'être mesuré : une seule requête de quelques dizaines de Mo pouvait épuiser la
  mémoire du Worker (128 Mo), et faire échouer les autres requêtes qu'il servait au même moment.
- Le corps se lit maintenant morceau par morceau, et la lecture s'arrête à la limite
  (`readCapped`, `apps/worker/src/http.ts`) : 256 Ko pour Whop, 64 Ko pour Telegram (qui reçoit
  toujours « ok, ignoré », pour ne pas le renvoyer). Toute l'API (`/api/*`) a sa limite, 64 Ko
  (`bodyLimit` de Hono), avant même de savoir qui appelle : ce que le tableau de bord envoie de plus
  gros (les réglages des actions, avec chaque message écrit dans les deux langues) reste sous
  25 Ko. Le logo d'une communauté, lu chez Whop, s'arrête aussi à 1 Mo, quoi que dise sa longueur.
- **`scripts/ops/probe.ts`**, dans Inspect (sandbox et production) : ce qu'aucun navigateur de
  créateur ou de membre n'envoie, chaque fois refusé comme il le faut — pas de jeton, un jeton sans
  signature (`alg: none`), signé par une autre clé ou par un secret partagé (HS256), un cookie de
  session forgé ; les webhooks de Whop non signés, mal signés, ou bien signés mais rejoués 10
  minutes plus tard ; celui de Telegram sans son secret ; les corps trop gros, avec ou sans leur
  longueur ; un autre site (CORS) ; les en-têtes de sécurité ; les fichiers jamais servis (`.env`,
  `.git/config`, `wrangler.toml`…) ; `/health` sans rien de secret. Une ligne par contrôle, son
  verdict et le code de statut : jamais un corps, un jeton ni un secret, les journaux de ce dépôt
  public étant publics. Rien n'est écrit : tout est refusé avant d'être gardé.
- Pour information seulement (pas un échec) : qui peut afficher le site dans un cadre
  (`frame-ancestors`), HTTPS imposé (`Strict-Transport-Security`), et la limite de débit, absente
  sur `workers.dev` (une règle Cloudflare la donnera sur le domaine de la production).

### Testé

- `http.test.ts` : la limite exacte passe, un octet de plus non ; une longueur annoncée trop grande
  refusée sans lecture ; les octets comptés, pas les caractères ; un caractère coupé entre deux
  morceaux bien relu.
- `app.test.ts` : un corps sans longueur au-delà de la limite, refusé (413) sur l'API avant
  l'identification, sur le webhook de Whop et pour le logo, après quelques morceaux lus seulement ;
  Telegram répond « too large » ; les plus gros réglages légitimes passent.
- `probe.ts` essayé sur le Worker servi en local : les 31 contrôles qui ne demandent ni la base ni
  le site statique passent.

## 2026-10-06 — Tests fonctionnels : la boucle de l'argent sur de faux membres

- **`scripts/seed/scenarios.ts`** : une communauté à part (`biz_ScenarioRun1`, mode automatique,
  mode test coupé) et ses 25 faux membres (le générateur du sandbox, avec ses propres
  identifiants `scen…` : ceux de Whop sont uniques dans toute la base, et les faux membres du
  sandbox ont déjà les `seed…`), puis les **vraies tâches horaires du Worker** (`SCHEDULE` de
  `cron.ts`), heure après heure, face à un Whop qui ne fait que noter ce qu'on lui demande. 21
  contrôles : chaque membre noté ; un avis à chaque membre au paiement refusé, la nouvelle
  tentative de celui que Whop laisse à StayPut (une seule) ; l'avis 3-D Secure avec son lien ; le
  questionnaire de départ à chaque annulation programmée ; la relance de chaque inactif gardée
  pour son heure ; rien pour un membre sur la liste « ne pas contacter » (sa relance est bloquée
  par le garde-fou) ; la bienvenue au nouveau venu inactif ; une relance par membre et par 5 jours
  au plus ; puis Whop répond (deux paiements payés, une offre acceptée et l'annulation retirée) :
  2 × 49 $ récupérés, comptés une fois, sur le tableau de bord et dans le rapport du lundi, et le
  renouvellement après l'annulation retirée compté lui aussi.
- Deux exécutions du même scénario : `scenarios.test.ts` en CI (base en mémoire), et
  `seed-sandbox.ts scenarios` (workflow « Seed sandbox ») sur la base du sandbox elle-même, dans
  **une transaction annulée à la fin** : rien ne reste, rien ne part chez Whop. Dans cette
  transaction seulement, les autres communautés sont mises de côté comme communautés de démo (que
  toutes les tâches ignorent) ; une lecture sous RLS (le tableau de bord) se fait dans un
  savepoint défait après elle, pour que son rôle ne survive pas.
- Essayé avant le sandbox sur un PostgreSQL 16 local, avec les 43 migrations et la communauté de
  test et ses 25 faux membres : 21 contrôles sur 21, et les mêmes nombres de lignes avant et après
  (la transaction n'a rien laissé). Cet essai a trouvé une erreur du script lui-même (une
  communauté « désinstallée » doit avoir sa date), corrigée avant tout passage sur le sandbox.
- Ce que ce scénario ne prouve pas : la réponse du vrai Whop (le sandbox de Whop refuse les
  envois des apps et ne connaît pas ces faux membres). Ce sera l'essai avec les comptes de test du
  fondateur (carte 4000 0000 0000 0341 : le renouvellement refusé, puis la carte mise à jour).

## 2026-10-07 — Vers le Whop officiel : l'app relue à chaque déploiement, la page Discover

- **Pourquoi.** Dans le sandbox, le cadre de Whop affiche « App Base URL not set » : son relais
  de production ne connaît pas les apps du sandbox. En production, ce même écran voudrait dire une
  Base URL absente ou mal tapée dans les réglages de l'app sur whop.com. Le fondateur : « sur Whop
  officiel, pas droit à l'erreur ». Une valeur mal tapée ne doit donc jamais passer inaperçue.
- **Ce que Whop montre** (relu le 07/10/2026 sur l'app du sandbox) : `GET /apps/{id}` répond
  **sans clé**, avec les chemins (`experience_path`, `dashboard_path`, `discover_path`), le statut,
  l'`origin` (l'adresse de l'app chez Whop, que son cadre charge) et les permissions demandées. La
  `base_url` reste `null` pour qui n'est pas développeur du compte de l'app ; avec la clé de
  compte du sandbox, elle apparaît. Le proxy de cette session refuse `*.apps.whop.com` : le passage
  par le relais se vérifie depuis GitHub.
- **`scripts/deploy/check-app.ts`**, deux étapes du déploiement :
  - `settings`, avant toute modification : les trois chemins doivent être ceux de
    `WHOP_VIEW_PATHS` (`packages/core/src/whop-views.ts`, la constante qu'un test confronte aussi
    au routeur de l'app) ; l'app doit demander les 21 permissions dont StayPut a besoin, et ni
    `member:email:read` ni `member:phone:read`. Celles de l'offre Alumni restent facultatives (une
    note) ; une permission que StayPut n'utilise pas est un avertissement.
  - `reach`, une fois le Worker en ligne : la Base URL comparée quand Whop la montre, et en
    production `/health` demandé à travers l'`origin`. « App Base URL not set » arrête le
    déploiement en disant quoi taper, un StayPut de l'autre environnement aussi ; toute autre
    réponse (une connexion demandée, par exemple) n'est qu'un avertissement, faute de pouvoir
    conclure. Trois essais à 5 secondes d'écart : Whop peut mettre un moment à suivre ses réglages.
  - En production, un écart arrête le déploiement. Sur le sandbox, il est seulement signalé : son
    app n'a pas de chemin Discover, demande encore l'e-mail et le téléphone, et le sandbox
    n'affiche aucune app.
  - Inspect fait les deux relectures : un réglage changé plus tard sur whop.com s'y voit.
- **Les listes de permissions** passent de `scripts/ops/whop-permissions.ts` à
  `packages/whop/src/permissions.ts` : le script d'Inspect lance sa lecture dès qu'on l'importe, le
  contrôle du déploiement ne pouvait pas les lui emprunter.
- **L'environnement GitHub de la production s'appelle « production stayput off »** (le nom que le
  fondateur lui a donné, gardé à sa demande) : Deploy et Inspect le lisent pour la cible
  `production`. Le premier déploiement de production lisait `production`, que GitHub a créé vide :
  les cinq réglages `PRODUCTION_…` manquaient, et le déploiement s'est arrêté à sa première
  vérification, avant toute modification.
- **La page Discover** (`/discover`, `apps/web/src/views/Discover.tsx`) : ce qu'un créateur voit
  de StayPut dans l'App Store de Whop avant de l'installer, avec les textes validés de la fiche
  (`docs/app-store.md`) : détecter, agir, prouver ; le mode test au départ, les deux modes, les
  garde-fous ; ni e-mail ni téléphone, 12 mois d'activité, suppression 30 jours après la
  désinstallation. Statique : aucun appel à l'API, aucun lien qui sort du cadre (la démo est une
  page de StayPut, les textes légaux s'ouvrent dans une fenêtre). Le bouton d'installation est
  celui de Whop, autour de la page.

- **La démo, une seule horloge** (trouvé en lançant toute la suite) : `createWorld(now)` datait
  tout de `now`, mais lisait l'heure réelle pour les fenêtres de 5 jours (qui a déjà reçu un
  message) et pour ce que le visiteur fait. Le test du 02/10 a donc échoué le 07/10 : Sarah Cohen,
  prévenue de son paiement refusé dans la journée de la démo, ne comptait plus comme prévenue. La
  démo a maintenant son horloge (`now`, puis le temps qui passe depuis sa création), passée aux
  pages (`DemoPagesInput.clock`). Pour un visiteur rien ne change (sa démo commence à l'heure
  réelle) ; un test lu 40 jours plus tard voit exactement la même démo.

### Testé

- `deploy.test.ts` (15 cas) : une app réglée comme il faut passe ; un chemin mal tapé ou vide
  arrête la production en disant où le corriger, et n'est que signalé sur le sandbox ; une
  permission nécessaire absente, l'e-mail ou le téléphone demandés ; l'offre Alumni facultative ;
  la Base URL comparée à une barre oblique près ; les réponses du relais (StayPut, l'autre
  environnement, « App Base URL not set », autre chose, rien) ; l'app relue sans la clé quand Whop
  la refuse ; une app absente distinguée de Whop injoignable.
- `demo.test.ts` : la même démo vue au jour de `now` et 40 jours plus tard (échoue sans la
  correction, comme le test des actions du jour).
- `app.test.tsx` : chaque chemin de `WHOP_VIEW_PATHS`, rempli comme Whop le fait, mène à la bonne
  page ; la page Discover s'affiche sans aucun appel, sa démo reste dans le cadre, ses textes
  légaux s'ouvrent dans une fenêtre ; en français aussi.
- Contre le vrai Whop (sandbox) : deux chemins justes, Discover vide (une note), les 21
  permissions demandées, l'e-mail et le téléphone signalés, sortie 0. Avec `WHOP_ENV=production`
  et l'identifiant de l'app du sandbox : « Whop (production) has no app … », sortie 1.

### Incertain

- La réponse du relais de production à `/health` n'a pas pu être lue d'ici (proxy). Le premier
  déploiement de production dira si Whop la transmet sans session ; sinon ce n'est qu'un
  avertissement, et l'affichage se vérifie à l'œil en ouvrant StayPut dans la communauté, l'app
  encore cachée (`docs/production.md`, étape 5).

## 2026-10-07 — Premier déploiement de production : un seul déclencheur par Worker

### Ce qui s'est passé

Le premier déploiement de production (run 37669919711) a tout fait : migrations 0001 → 0043, base
réservée à la production, Hyperdrive `stayput-db-production`, Worker `stayput-app`, `/health` ok,
et **`/health` ok à travers le relais de Whop** (`hz7d7jwf1wfrbos5s6ur.apps.whop.com`) : le point
« Incertain » de l'entrée précédente est levé, Whop transmet la réponse sans session. Mais
Cloudflare a refusé ses trois déclencheurs : « This account has reached the Workers Free limit of
5 cron triggers per account » (code 10072). Le sandbox en tenait déjà trois, et 3 + 3 dépasse 5.
Le run est pourtant resté vert : `wrangler deploy … | tee` rend le code de `tee`, sans
`pipefail`. Sans déclencheur, la production n'aurait rien synchronisé, rien noté, rien envoyé.

### Un déclencheur toutes les 5 minutes, et son heure choisit le travail

La limite était connue (« 5 crons par compte », Phase 1), pas son partage entre deux Workers.
Chaque Worker n'a plus qu'**un** déclencheur, `*/5 * * * *` : le compte en tient deux, il en
reste trois. `groupAt` (`apps/worker/src/cron.ts`) lit l'heure prévue du passage :

- `:00` → les tâches horaires. Elles restent pile à l'heure : `nextLocalHour` cherche la
  prochaine heure d'or **à partir** de l'heure du passage (arrondie au-dessus), donc un passage à
  `:05` repousserait d'un jour une action due dans l'heure.
- `:05`, `:15`, … `:55` → la synchronisation : six passages par heure comme avant, donc le même
  budget (40 appels à Whop par passage, environ 240 par heure).
- lundi `7:30` → les tâches hebdomadaires, à la même heure qu'avant.
- les autres passages ne font rien et s'arrêtent avant d'ouvrir la base.

Chaque groupe a son exécution, donc ses 50 sous-requêtes, comme avec trois déclencheurs. Écartés :
réunir le travail horaire et la synchronisation dans le même passage (les deux budgets se
seraient partagé 50 sous-requêtes) ; décaler l'horaire à `:05` (l'heure d'or) ; retirer des
déclencheurs au sandbox (il doit tourner comme la production) ; Workers payant (5 $/mois),
qui reste la voie quand la limite de CPU (10 ms) ou de sous-requêtes gênera, au choix du fondateur.

### Le déploiement ne laisse plus passer un refus de Cloudflare

- `set -o pipefail` sur la publication : une erreur de wrangler arrête le déploiement (un `trap`
  retire quand même le fichier des secrets du Worker).
- `scripts/deploy/check-crons.ts`, juste après : relit chez Cloudflare les déclencheurs du Worker
  publié (`GET …/workers/scripts/{nom}/schedules`) et s'arrête s'ils ne sont pas ceux de
  `wrangler.toml`, en rappelant la limite. Il compte aussi les déclencheurs de tout le compte, en
  nombre seulement (les journaux sont publics : aucun autre Worker n'y est nommé), et avertit à
  5 sur 5. Il tourne aussi après une publication en échec, pour dire pourquoi.
- `prepare.ts` masque l'identifiant de compte Cloudflare nettoyé (`::add-mask::`) : GitHub ne
  masque que le secret tel qu'il est rangé, et l'identifiant extrait apparaissait en clair dans
  les journaux publics des étapes suivantes. Les journaux des runs passés le montrent encore :
  les effacer est au choix du fondateur.

### Ordre de remise en route

Le sandbox d'abord (il passe de 3 déclencheurs à 1 et libère la place), puis la production.
Fait le soir même : sandbox (run 37672711550), « Cloudflare runs stayput on */5 * * * * », 1
déclencheur sur le compte ; production (run 37673301225), « Cloudflare runs stayput-app on
*/5 * * * * », 2 sur 5, `/health` ok directement et par le relais de Whop, la redirection Discord
de production déclarée, l'identifiant de compte masqué (`***`) dans les journaux.

### Testé

- `runtime.test.ts` : `wrangler.toml` déclare le seul déclencheur ; chaque minute de l'heure a
  son groupe (et le lundi 7:30) ; sur deux semaines de passages, chaque groupe revient exactement
  à son rythme (`EVERY_MINUTES`, celui de la page d'état), un seul groupe par passage.
- `deploy.test.ts` : le nom du Worker (production : `stayput-app`), les déclencheurs de
  `wrangler.toml`, la lecture chez Cloudflare avec le jeton, une erreur de Cloudflare dite telle
  quelle, le compte de tout le compte, et le cas du 07/10 (aucun déclencheur, la limite rappelée).

## 2026-10-08 — Installée sur le Whop officiel ; New York par défaut ; la promesse du mode test

### L'installation dans « StayPut Community »

Le lien `https://whop.com/apps/<app_…>/install` répondait « This AccessPass was not found » :
l'app pointait vers un produit supprimé (`prod_GfpyTV98LoDAu` : introuvable par l'API, quand
les produits masqués et archivés de la communauté y répondent). Rien ne permet de rattacher une
app à un autre produit (aucun champ dans `PATCH /apps/{id}`). Le fondateur a créé un produit dans
l'onglet **Produits** de l'app (gratuit, masqué), puis le lien d'installation a fonctionné :
permissions approuvées, StayPut affiché dans le tableau de bord de Whop. L'API donne toujours
l'ancien `product_id` : la page d'installation prend donc un produit de l'app, pas ce champ.
L'app est passée de « masquée » à « non répertoriée » (accessible par lien direct seulement), avec
une description, comme la bêta le demandera. `docs/production.md` (étape 5) dit la marche.

### L'heure de New York pour toute nouvelle communauté

Choix du fondateur : une nouvelle communauté démarre à l'heure de New York (migration 0044, la
valeur par défaut de `companies.timezone`, qui était UTC), et l'app ne reprend plus le fuseau du
navigateur à la première visite (la route `POST /timezone`, son appel et le bouton « fuseau de ce
navigateur » des réglages sont retirés). L'équipe choisit un autre fuseau dans Settings, New York
en tête de la liste. La démo est aussi à l'heure de New York. Les communautés existantes gardent le
leur. Rappelé au fondateur : un créateur de Los Angeles doit changer le sien, sinon ses heures
calmes et son heure d'or tombent 3 heures trop tôt.

### Le mode test n'est pas activé au départ

La fiche App Store et `docs/production.md` promettaient « une nouvelle communauté démarre en mode
test » ; le code ne l'a jamais fait (`dry_run` faux par défaut depuis 0001). Décision : garder le
code, corriger les textes. Une nouvelle communauté démarre en mode **manuel** : rien ne part sans
l'accord de l'équipe, et ce qu'elle approuve part vraiment. Le mode test par-dessus aurait simulé
le premier envoi qu'un créateur approuve, qui aurait cru à une panne.

### Testé

- `app.test.ts` (Worker) : une nouvelle communauté lit `America/New_York`, la route du navigateur
  n'existe plus (404), un enregistrement sans fuseau le garde, avec un fuseau il change.
- `app.test.tsx` (web) : aucun fuseau envoyé à l'ouverture, aucun bouton de navigateur dans les
  réglages, le fuseau changé à la main part avec l'enregistrement.

## 2026-10-08 — « Message » : le créateur écrit lui-même

### Pourquoi

« Message » sur un membre envoyait le texte de StayPut (`creator_message`), compté comme une
relance : une tous les 5 jours, à l'heure d'or du membre. Le fondateur cliquait et voyait « En
file », sans pouvoir écrire ni envoyer. Il veut écrire lui-même et que ça parte.

### Ce qui change

- « Message » sur un membre (sa fiche, la liste, « Needs attention ») ouvre une fenêtre : un
  titre (proposé : « A message for you », 80 caractères au plus) et le texte du créateur (300 au
  plus, les limites des modèles), puis « Send ».
- Nouveau type d'action `creator_note` (migration 0045, `create_creator_note`) : approuvé par le
  clic, `send_at` = maintenant, `message_kind` 'service'. Aucun plafond de relance ne le retient
  (c'est le créateur qui écrit) ; il compte dans l'historique du membre, donc aucune relance de
  StayPut ne tombe juste après. Restent : les arrêts, « ne jamais contacter », les heures calmes
  (il part à leur fin, et la réponse le dit), le mode test (simulé). Trois par membre et par
  24 heures au plus, contre un double envoi ou une erreur.
- Envoyé mot pour mot en notification Whop, avec la photo du créateur (`icon_user_id`). Le
  journal de l'équipe garde qui a écrit à qui, jamais les mots.
- L'envoi groupé de la page d'accueil (« Message 3 high-risk members… ») garde le texte de
  StayPut et ses plafonds : c'est StayPut qui écrit.
- Compté comme « atteindre un membre à risque » pour les sauvetages et les analyses, comme
  `creator_message`.

### Testé

- `app.test.ts` (Worker) : titre ou texte vide ou trop long refusés ; un membre n'écrit à
  personne ; envoyé mot pour mot, au seul membre, avec la photo du créateur ; un second le même
  jour part aussi ; pendant les heures calmes, la réponse donne l'heure de départ ; un quatrième
  refusé ; « ne jamais contacter » refusé ; un membre inconnu, 404.
- `app.test.tsx` (web) : la fenêtre, le titre proposé, « Send » inactif sans texte, le compteur,
  « Sent to … », l'heure de départ dans les heures calmes, le refus du quatrième dit en clair.

## 2026-10-08 — « Message » dit ce que Whop en a fait, jamais « envoyé » avant

### Pourquoi

Premier essai en production : le fondateur écrit à un membre, voit « Sent to … », et rien
n'arrive. StayPut n'avait encore aucun espace dans la communauté (son `experience_id`, appris
quand quelqu'un ouvre StayPut côté membre) : l'action attendait, retentée toutes les heures. La
réponse donnait l'heure de départ calculée, pas ce qui s'était passé. Whop, lui, ne livre une
notification d'app qu'aux utilisateurs de son espace (`user_ids` « provided they are in the
targeted experience »), et laisse tomber les autres sans rien dire.

### Ce qui change

- Sans espace connu, « Message » est refusé (409 `no_space`) et rien n'est créé ; le créateur lit
  que Whop ne peut rien livrer à ses membres tant que StayPut n'a pas d'espace dans sa
  communauté. En mode test, il est simulé comme avant (rien ne part de toute façon).
- Envoyé maintenant, le message part dans la requête même (`prepareActions` puis
  `executeAction`, comme une offre acceptée par un membre), et la réponse relit l'action :
  `sent` (Whop l'a pris), `scheduled` (heures calmes, avec l'heure), `simulated`, `retrying`
  (Whop ne l'a pas pris, nouvel essai dans une heure) ou `failed` avec sa raison.
- Avant d'envoyer un message du créateur, StayPut demande à Whop si le membre a accès à son
  espace (`checkAccess`) : sinon, échec final `no_access`, aucune notification, et le créateur
  le lit. Sans réponse de Whop à cette question, le message part comme les autres.
- Les messages automatiques ne changent pas. Qu'une communauté sans espace StayPut ne reçoive
  aucun message reste à signaler ailleurs qu'ici (dans le tableau de bord), avant la bêta.

### Testé

- `app.test.ts` (Worker) : sans espace, 409 `no_space` et aucune action ; en mode test, simulé ;
  un membre sans accès, `failed` / `no_access` et aucune notification ; Whop en panne,
  `retrying` avec le nouvel essai une heure plus tard ; le cas nominal dit `sent`, les heures
  calmes `scheduled`.
- `app.test.tsx` (web) : « Sent to … » seulement sur `sent` ; « Not sent to … yet » et le
  prochain essai ; le membre sans accès ; le refus sans espace, la fenêtre reste ouverte.

## 2026-10-08 — Nouvelle app de production ; StayPut plus rapide à s'ouvrir

### L'app de production refaite

La première app de production (`app_LRq2G68rpP3FpW`) restait liée à son produit de fiche
supprimé (`prod_GfpyTV98LoDAu`, 404) : la galerie de l'App Store ne se chargeait plus
(« Failed to load app gallery ») et l'API n'a aucun champ pour changer ce lien (`UpdateApp`
n'a pas de `product_id`). Le fondateur a créé `app_GimcEN4Jfpn4Ma` (même hébergement, mêmes 25
permissions, même webhook) ; seuls `PRODUCTION_WHOP_APP_ID`, `PRODUCTION_WHOP_API_KEY` et
`PRODUCTION_WHOP_WEBHOOK_SECRET` ont changé, aucun code. Les données ne bougent pas : elles
sont rattachées à la communauté, pas à l'app. Le produit de fiche de la nouvelle app
(`prod_6S7xpEfw0hPwc`, « StayPut ») apparaît dans la liste Produits de la communauté : ne
jamais le supprimer ni l'archiver.

### Pourquoi c'était lent, et ce qui change

L'écran d'accueil attendait : la session (vérification Whop + base), puis seulement les
membres, les sources, la synchronisation et les chiffres, chacun avec sa propre vérification
Whop ; les chiffres faisaient 11 lectures de la base l'une après l'autre ; le premier fichier
JavaScript (333 Ko compressés) contenait toutes les pages.

- **Smart Placement** (`wrangler.toml`, `[placement] mode = "smart"`) : Cloudflare fait tourner
  le Worker là où il répond le plus vite, près de la base plutôt que près de l'appelant (le
  relais de Whop compris). Disponible sur l'offre gratuite ; il lui faut un trafic régulier
  pour décider. `/health` dit maintenant dans quel centre le Worker a tourné (`colo`) et le
  temps de la sonde de la base (`databaseMs`), et le déploiement l'affiche à travers le relais
  de Whop : de quoi trancher sur des chiffres (et, au besoin, fixer une région).
- **Les lectures du tableau de bord en 3 vagues simultanées** au lieu de 11 en file
  (`dashboard.ts`) : postgres.js envoie à la suite les requêtes lancées ensemble sur la
  connexion de la transaction. `/health` fait désormais sa sonde de la même façon (deux
  requêtes à la fois dans une transaction, à travers Hyperdrive) : chaque déploiement, celui du
  sandbox d'abord, vérifie que ce chemin fonctionne avant la production.
- **Une seule question à Whop par écran** : les appels simultanés d'un écran partagent la
  vérification d'accès en cours (avant : une chacun tant que la réponse n'était pas en cache).
- **Les premières lectures partent avant que React dessine** (`prefetch.ts`, appelé par
  `main.tsx`) : session, membres, sources, synchronisation et, sur l'accueil, les chiffres,
  tous en même temps ; l'écran prend la réponse au lieu de redemander. Une réponse en échec
  (première visite : la communauté est écrite par la session) est redemandée par l'écran.
- **Chaque page sauf l'accueil se charge à sa première ouverture** (`App.tsx`, `lazy` du
  routeur) : 253 Ko au premier chargement au lieu de 333 (espace membre, analyses,
  automatisations, réglages, sources à part).

### Testé

- Worker : 4 appels simultanés d'un écran, une seule vérification Whop (le test échoue sans
  le correctif) ; `/health` avec `colo` et `databaseMs` ; le message du relais avec le centre
  et le temps ; la région de la base lue dans l'adresse du pooler ; tous les tests du tableau
  de bord inchangés avec les vagues.
- Web : les lectures en avance prises par leur écran, jamais redemandées ; redemandées après un
  échec ou après 10 secondes ; rien hors d'un tableau de bord ; les pages chargées à la demande.

## 2026-10-08 — Le tableau de bord sans le logo StayPut, son titre centré

Demande du fondateur : « suprime les logo a cette page et le titre centre le mieux avec un
meilleur dessign » (la page Dashboard).

- **Plus de « S » en haut à gauche** (`CreatorShell.tsx`) : le cadre de Whop dit déjà StayPut ;
  la barre commence par la communauté (son logo et son nom, le lien vers l'accueil). Le
  squelette de chargement suit (un carré gris à la place du « S »).
- **Plus de « S » dans les états vides** (`EmptyState.tsx`) : une icône seulement quand elle dit
  quelque chose. « Rien ne demande ton attention » montre une coche turquoise (tout va bien),
  pas la marque.
- **« Dashboard » centré** (`SectionLayout.tsx`, classe `title-home`) : Satoshi 700, 30 px,
  interlettrage serré, un court trait turquoise dessous ; la pastille « Pour commencer » est
  centrée sous lui. Les autres sections gardent leur titre à gauche, au-dessus de leurs onglets.
- Le « S » reste là où il présente StayPut à quelqu'un qui ne le connaît pas : l'accueil hors
  de Whop, la page de découverte, le guide.

## 2026-10-08 — Le Worker tourne à côté de la base (placement ciblé)

Mesure : `/health` (une transaction à travers Hyperdrive) prenait **486 ms** depuis le centre
de Seattle, où le Worker tournait encore après le passage à Smart Placement. Smart Placement ne
déplace un Worker qu'après avoir vu un trafic régulier de plusieurs endroits : une communauté en
test n'en envoie jamais assez. Chaque écran du tableau de bord fait plusieurs allers-retours avec
la base pour une seule attente du navigateur : c'est là que partait le temps.

- **Le déploiement fixe la région** (`scripts/deploy/hyperdrive.ts`, `withPlacement`) : la
  région AWS de la base est lue dans l'adresse de son pooler Supabase
  (`aws-0-<région>.pooler.supabase.com`) et écrite dans le `wrangler.toml` déployé
  (`mode = "targeted"`, `region = "aws:<région>"`), pour le sandbox comme pour la production,
  chacun avec sa base. Une adresse qui ne dit pas sa région garde Smart Placement.
- Le fichier commité garde `mode = "smart"` (développement local, adresse inconnue).
- Le déploiement affiche l'en-tête `cf-placement` de `/health` (où Cloudflare a fait tourner le
  Worker) à côté du temps de la sonde : la preuve se lit dans chaque déploiement.
- **Mesuré sur le sandbox** : `cf-placement: remote-FRA`, sonde **58 ms** au lieu de 494 ms
  (requête entrée à Los Angeles). Le champ `colo` de `/health` dit donc où la requête est
  entrée, pas où le Worker a tourné : le message du déploiement le dit ainsi.
- **Mesuré en production** : `cf-placement: remote-LHR` (la base de production est à Londres),
  sonde **83 ms** au lieu de 486–513 ms, par le relais de Whop comme en direct.
