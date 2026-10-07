# Les variables d'environnement

Aucune valeur secrète dans le code ni dans un fichier du dépôt. Trois endroits seulement :

1. **GitHub** (Settings → Secrets and variables → Actions, et l'environnement `production stayput off`) : ce
   que les workflows Deploy et Inspect lisent. Les secrets y sont masqués dans les journaux.
2. **Le Worker Cloudflare** : ses `vars` (dans `apps/worker/wrangler.toml`, publiques) et ses
   secrets, envoyés par le workflow Deploy à chaque déploiement (`wrangler deploy
--secrets-file`, un fichier temporaire effacé aussitôt).
3. **En local** : `apps/worker/.dev.vars` et `.env`, ignorés par Git (modèles :
   `apps/worker/.dev.vars.example`, `.env.example`).

## Le Worker

| Nom                     | Type    | Rôle                                                                                                                                            | Si absent                                                              |
| ----------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `WHOP_ENV`              | var     | `sandbox` ou `production` : quelle API de Whop, quelles clés publiques pour le jeton de l'iframe                                                | `sandbox`                                                              |
| `WHOP_APP_ID`           | var     | l'app Whop (`app_…`) : l'audience du jeton de l'iframe, le client OAuth                                                                         | toute requête du tableau de bord est refusée                           |
| `OPERATOR_COMPANY_ID`   | var     | la communauté de l'opérateur (`biz_…`) : seule son équipe voit Réglages › État                                                                  | la page d'état n'existe pour personne                                  |
| `MEMBER_SPACE_ENABLED`  | var     | `true` allume l'espace membre (Phase 5), éteint en V1                                                                                           | éteint                                                                 |
| `WHOP_API_KEY`          | secret  | la clé API de l'app (`apik_…`) : lire et agir chez Whop, vérifier l'accès de l'équipe ; signe aussi la session « Sign in with Whop » du sandbox | rien ne se lit chez Whop ; le tableau de bord répond « non configuré » |
| `WHOP_WEBHOOK_SECRET`   | secret  | le secret du webhook (`ws_…`) : vérifie la signature des envois de Whop                                                                         | les envois sont refusés                                                |
| `DISCORD_BOT_TOKEN`     | secret  | le jeton du bot Discord de StayPut                                                                                                              | module Discord éteint                                                  |
| `DISCORD_CLIENT_SECRET` | secret  | le « Client Secret » de l'application Discord : ajouter le bot à un serveur                                                                     | Discord lisible, mais pas connectable                                  |
| `TELEGRAM_BOT_TOKEN`    | secret  | le jeton du bot Telegram ; le secret du webhook Telegram en est dérivé                                                                          | module Telegram éteint                                                 |
| `HYPERDRIVE`            | liaison | la connexion à la base, par Hyperdrive ; écrite dans `wrangler.toml` au déploiement seulement                                                   | `/health` répond 503, `database: not_configured`                       |

En local seulement (`ENVIRONMENT=development`) : `DEV_USER_ID` et `DEV_ACCESS_LEVEL` font agir
chaque requête comme cet utilisateur, hors de l'iframe de Whop. Jamais dans un Worker déployé.

L'interface (`apps/web`) lit une variable à la construction : `VITE_MEMBER_SPACE_ENABLED`
(l'espace membre, comme ci-dessus).

## GitHub : le sandbox (réglages du dépôt)

| Nom                                                             | Type     | Utilisé par                                                                                     |
| --------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`                                          | secret   | Deploy : publier le Worker, créer Hyperdrive (droits « Edit Cloudflare Workers » et Hyperdrive) |
| `CLOUDFLARE_ACCOUNT_ID`                                         | secret   | Deploy                                                                                          |
| `SUPABASE_DB_URL`                                               | secret   | Deploy (migrations, Hyperdrive) ; Inspect (lecture des comptes, jamais de donnée personnelle)   |
| `WHOP_API_KEY`, `WHOP_WEBHOOK_SECRET`                           | secret   | Deploy (envoyés au Worker) ; Inspect (la clé : les permissions que Whop accorde)                |
| `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_SECRET`                    | secret   | Deploy, sandbox et production (une seule application Discord)                                   |
| `TELEGRAM_BOT_TOKEN`                                            | secret   | Deploy ; Inspect (l'état des groupes)                                                           |
| `WHOP_ENV`, `WHOP_APP_ID`, `OPERATOR_COMPANY_ID`, `STAYPUT_URL` | variable | facultatives : remplacent les valeurs de `wrangler.toml` et l'adresse du Worker                 |

## GitHub : la production

Les mêmes noms préfixés **`PRODUCTION_`**, rangés dans l'environnement GitHub `production` :
`PRODUCTION_SUPABASE_DB_URL`, `PRODUCTION_WHOP_API_KEY`, `PRODUCTION_WHOP_WEBHOOK_SECRET`,
`PRODUCTION_TELEGRAM_BOT_TOKEN` (facultatif, un second bot), `PRODUCTION_WHOP_APP_ID`,
`PRODUCTION_OPERATOR_COMPANY_ID`, `PRODUCTION_STAYPUT_URL` (facultatif). Un réglage obligatoire
manquant arrête le déploiement : il n'est jamais remplacé par celui du sandbox. `WHOP_ENV` y vaut
toujours `production`. Cloudflare et Discord restent ceux du dépôt. Détails :
`docs/production.md`.

## Les scripts en ligne de commande

| Nom                          | Rôle                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`               | `npm run db:migrate` et les scripts du sandbox : l'URI « Session pooler » de Supabase (dans `.env`)                                 |
| `STAYPUT_TARGET`             | `sandbox` ou `production` : posé par Deploy ; la base est réservée à ce déploiement (`docs/data-schema.md`)                         |
| `STAYPUT_URL`, `CHROME_PATH` | les scripts de navigateur (`scripts/ops/look.mjs`, `store.mjs`) : l'adresse visitée, le Chrome à lancer                             |
| `WHOP_SANDBOX_API_KEY`       | la clé du **compte** sandbox, pour les scripts lancés à la main dans `scripts/sandbox/` ; jamais dans un workflow ni dans le Worker |
