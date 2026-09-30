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

Par GitHub Actions, sans rien installer : **Actions → Deploy → Run workflow**
([`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)). Le workflow vérifie le code,
applique les migrations manquantes, crée la connexion Hyperdrive au premier passage (cache
désactivé), construit l'interface, publie le Worker avec ses secrets, puis vérifie `/health`.

Tout se range dans **Settings → Secrets and variables → Actions** du dépôt, jamais dans le code :

| Nom                     | Type     | Contenu                                                          | Requis            |
| ----------------------- | -------- | ---------------------------------------------------------------- | ----------------- |
| `CLOUDFLARE_API_TOKEN`  | secret   | jeton « Edit Cloudflare Workers » + permission Hyperdrive : Edit | oui               |
| `CLOUDFLARE_ACCOUNT_ID` | secret   | identifiant du compte Cloudflare                                 | oui               |
| `SUPABASE_DB_URL`       | secret   | URI « Session pooler » de Supabase, mot de passe compris         | oui               |
| `WHOP_API_KEY`          | secret   | clé API de l'app Whop                                            | pour l'API Whop   |
| `WHOP_WEBHOOK_SECRET`   | secret   | secret `ws_…` du webhook                                         | pour les webhooks |
| `WHOP_APP_ID`           | variable | identifiant de l'app (`app_…`)                                   | pour la connexion |
| `WHOP_ENV`              | variable | `sandbox` (par défaut) ou `production`                           | non               |

À déclarer ensuite dans Whop (tableau de bord développeur → l'app) : l'URL de base
`https://stayput.<sous-domaine>.workers.dev`, le chemin de la vue tableau de bord
`/dashboard/[companyId]`, celui de la vue expérience `/experiences/[experienceId]`, et le webhook
`https://stayput.<sous-domaine>.workers.dev/webhooks/whop`.

Sans GitHub Actions : `supabase/install.sql` dans le SQL Editor de Supabase, puis depuis
`apps/worker` `npx wrangler hyperdrive create stayput-db --connection-string="…" --caching-disabled`
(recopier l'`id` dans un bloc `[[hyperdrive]]` de `wrangler.toml`), `npx wrangler secret put …`
et `npm run deploy` à la racine. `.dev.vars` et `.env` sont ignorés par Git.

## Outils de la Phase 0

```bash
# Essai de « Invite to a Membership » dans le sandbox Whop. La clé de compte sandbox vient de la
# variable d'environnement WHOP_SANDBOX_API_KEY ; NODE_USE_ENV_PROXY=1 derrière un proxy
# (sessions cloud). Résultat du 30/09/2026 : docs/whop-api-verification.md, section 11.
NODE_USE_ENV_PROXY=1 node scripts/sandbox/check-invite.mjs you+test@example.com --cleanup
```
