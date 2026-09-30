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

| Phase                         | Statut                                       |
| ----------------------------- | -------------------------------------------- |
| 0. Vérification de l'API Whop | Validée le 30/09/2026                        |
| 1. Fondations                 | Faite (30/09/2026), en attente de validation |
| 2. Collecte des données       | À faire après validation de la Phase 1       |

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

Première mise en ligne (à faire une fois, commandes depuis `apps/worker`) :

1. **Base** : Supabase → SQL Editor → coller tout [`supabase/install.sql`](./supabase/install.sql)
   → Run (ou `npm run db:migrate`). À refaire après chaque nouvelle migration : seules les
   migrations manquantes s'appliquent.
2. **Hyperdrive** (connexion du Worker à la base, cache désactivé) :
   `npx wrangler hyperdrive create stayput-db --connection-string="<URI de connexion Supabase>" --caching-disabled`,
   puis recopier l'`id` affiché dans le bloc `[[hyperdrive]]` de `apps/worker/wrangler.toml`.
3. **Secrets** : `npx wrangler secret put WHOP_API_KEY`, puis
   `npx wrangler secret put WHOP_WEBHOOK_SECRET`. `WHOP_APP_ID` et `WHOP_ENV` sont dans
   `wrangler.toml` (`[vars]`).
4. **Mise en ligne** : `npm run deploy` (depuis la racine), qui construit l'interface puis publie
   le Worker. `https://<nom>.<sous-domaine>.workers.dev/health` doit répondre
   `"status":"ok"`.

Wrangler s'authentifie avec `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID` (variables
d'environnement), ou `npx wrangler login`. Aucun secret dans le dépôt : `.dev.vars` et `.env`
sont ignorés par Git.

À déclarer ensuite dans Whop (tableau de bord développeur → l'app) : l'URL de base, le chemin de
la vue tableau de bord `/dashboard/[companyId]`, celui de la vue expérience
`/experiences/[experienceId]`, et le webhook `https://<domaine>/webhooks/whop`.

## Outils de la Phase 0

```bash
# Essai de « Invite to a Membership » dans le sandbox Whop. La clé de compte sandbox vient de la
# variable d'environnement WHOP_SANDBOX_API_KEY ; NODE_USE_ENV_PROXY=1 derrière un proxy
# (sessions cloud). Résultat du 30/09/2026 : docs/whop-api-verification.md, section 11.
NODE_USE_ENV_PROXY=1 node scripts/sandbox/check-invite.mjs you+test@example.com --cleanup
```
