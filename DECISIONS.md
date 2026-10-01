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
- Le module Discord (optionnel, désactivé par défaut) n'est pas fait : il attend que le
  fondateur décide de l'activer.

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
