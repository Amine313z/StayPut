# StayPut

L'app de rétention pour les créateurs Whop : elle prédit quel membre va partir, agit pour le
garder, fait progresser les membres vers leurs objectifs et prouve au créateur combien d'argent
il a sauvé.

- **Cahier des charges** : [`SPEC.md`](./SPEC.md). Le travail avance phase par phase, avec un
  arrêt et une validation à la fin de chacune.
- **Phase 0 — vérification de l'API Whop** : [`docs/whop-api-verification.md`](./docs/whop-api-verification.md).

## État

| Phase | Statut |
| --- | --- |
| 0. Vérification de l'API Whop | Rapport fait ; il reste l'essai de l'invitation Alumni dans le sandbox |
| 1. Fondations | À faire après validation de la Phase 0 |

## Stack prévue (`SPEC.md`, section 2)

Cloudflare Workers (Hono) et Cron Triggers pour l'API, les webhooks et les tâches ; React +
Vite sur Cloudflare Pages pour la vue créateur et la vue membre ; Supabase (Postgres, RLS) ;
`@whop/sdk` ; Vitest et Playwright. Budget : 0 €.

## Outils de la Phase 0

```bash
# Essai de « Invite to a Membership » dans le sandbox Whop (clé de compte sandbox requise)
WHOP_SANDBOX_API_KEY=... node scripts/sandbox/check-invite.mjs you+test@example.com --cleanup
```

Aucun secret dans le dépôt : les clés se rangent dans `.dev.vars` / `.env.local` (ignorés par
Git) en local, et dans les secrets de Cloudflare en production.
