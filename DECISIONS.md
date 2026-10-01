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
