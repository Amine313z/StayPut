# Exploitation

Ce qu'il faut savoir faire une fois StayPut en service : surveiller, rejouer les envois de Whop,
changer une clé, sauvegarder, arrêter tout en urgence. Chaque procédure vaut pour le sandbox et
pour la production ; pour la production, les réglages GitHub portent le préfixe `PRODUCTION_`
(`docs/production.md`).

## Surveiller

- **Réglages › État**, dans la communauté de l'opérateur (`OPERATOR_COMPANY_ID`) : Whop (sandbox
  ou production), la base (à jour ou non), chaque tâche planifiée (en retard après deux périodes
  sans passage), les envois de Whop des dernières 24 heures et ceux en échec, les communautés
  (actives, accès refusé, désinstallées), les lectures refusées par Whop, les actions en échec de
  la semaine, le journal des erreurs (30 jours). Jamais le contenu d'un envoi ni une donnée de
  membre.
- **`/health`** : `{"status":"ok","whopEnv":…,"database":"ok"}`, sinon une réponse 503 qui dit
  pourquoi (`not_configured`, `outdated`, `unreachable`, `timeout`).
- **Actions → Inspect** (sandbox) : la base en nombres seulement, les permissions que Whop
  accorde, Telegram, le site et la démo dans Chrome, les captures. Sur la production, seulement
  le site et la démo : les journaux de ce dépôt public ne montrent aucune communauté cliente.

## Lire le journal d'audit

Chaque changement fait par l'équipe d'une communauté y laisse une ligne (`stayput.audit_log`) :
qui (son identifiant Whop), quoi (`action` : `badge.set`, `test_mode.off`, `actions.approve`,
`member.contact`, `member.delete`, `data.export`, `discord.connect`, `webhooks.replay`…), sur quoi
(`target` : des identifiants, des nombres, des réglages, jamais un nom ni un texte) et quand.
L'équipe le retrouve dans l'export de ses données (Réglages › Général › Vos données) ; l'opérateur
le lit dans le SQL Editor de Supabase :

```
select created_at, actor, action, target from stayput.audit_log
 where company_id = 'biz_…' order by created_at desc limit 100;
```

Une demande refusée (invalide, ou d'un compte hors de l'équipe) n'y laisse rien. Un membre
supprimé l'est aussi du journal : ses lignes gardent l'action, plus sur qui (`{"erased": true}`).
La suppression de toutes les données d'une communauté efface son journal avec le reste, comme la
politique de confidentialité le promet : seul le journal du Worker garde qui l'a demandée.

## Rejouer les envois de Whop

Un envoi de Whop (un paiement, un abonnement, un membre, un message…) est enregistré dès sa
réception, puis classé. S'il échoue au classement :

1. **De lui-même** : il est rejoué toutes les 10 minutes, 5 fois au plus.
2. **À la main**, depuis **Réglages › État → Envois de Whop** :
   1. lire l'erreur de l'envoi (type, communauté, essais, message) ;
   2. corriger la cause : le plus souvent un correctif à déployer (Actions → Deploy), parfois une
      permission à accorder dans Whop ;
   3. **Rejouer** (un envoi) ou **Rejouer tous les échecs** : ils sont classés aussitôt, même
      ceux que le rejeu automatique a abandonnés ; chaque rejeu est gardé dans le journal
      d'audit (`webhooks.replay`) ;
   4. vérifier que la liste des échecs s'est vidée.

Limites :

- Un envoi est gardé **30 jours** au plus : au-delà, il n'existe plus.
- Un envoi refusé à l'entrée (signature fausse après un changement de secret, Worker arrêté)
  n'a jamais été enregistré : StayPut ne peut pas le rejouer. La synchronisation relit chaque
  heure membres, abonnements et paiements, donc l'état revient de lui-même ; seule l'activité de
  ce moment-là (messages, leçons) peut manquer.

## Changer une clé

Règle commune : la nouvelle valeur va **directement** de la console du service au réglage GitHub
(jamais dans un message, un fichier ou un journal), puis **Actions → Deploy** (cible `sandbox` ou
`production`) la donne au Worker. Le déploiement vérifie ce qu'il peut (Whop répond-il à la clé,
Discord et Telegram acceptent-ils leurs jetons, `/health` répond-il `ok`) ; on retire l'ancienne
valeur seulement après.

| Clé                              | Où la changer                                                                                                       | Réglage GitHub                                           | Ensuite                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clé API de l'app Whop (`apik_…`) | Whop → Developer → StayPut → clé API : en créer une                                                                 | `WHOP_API_KEY` / `PRODUCTION_WHOP_API_KEY`               | Deploy (il demande à Whop s'il accepte la clé), puis supprimer l'ancienne dans Whop. Dans le sandbox, les sessions « Sign in with Whop » prennent fin : se reconnecter.                                         |
| Secret du webhook Whop (`ws_…`)  | Whop → Developer → StayPut → Webhooks : régénérer le secret, ou recréer le webhook (même adresse, mêmes événements) | `WHOP_WEBHOOK_SECRET` / `PRODUCTION_WHOP_WEBHOOK_SECRET` | Deploy aussitôt : entre-temps, Whop signe avec le nouveau secret et ses envois sont refusés (voir les limites du rejeu). Supprimer l'ancien webhook s'il a été recréé.                                          |
| Mot de passe de la base          | Supabase → Project Settings → Database → Reset database password ; recopier l'URI « Session pooler »                | `SUPABASE_DB_URL` / `PRODUCTION_SUPABASE_DB_URL`         | Deploy aussitôt : il redonne la connexion à Hyperdrive (Cloudflare la vérifie). Entre le changement et la fin du déploiement, le Worker ne joint plus la base (quelques minutes).                               |
| Jeton du bot Telegram            | @BotFather → `/revoke` → le bot                                                                                     | `TELEGRAM_BOT_TOKEN` / `PRODUCTION_TELEGRAM_BOT_TOKEN`   | Deploy, puis ouvrir une fois **Intégrations › Telegram** dans une communauté : le Worker redonne à Telegram l'adresse et le nouveau secret (dérivé du jeton). Telegram garde 24 heures les messages non livrés. |
| Jeton du bot Discord             | Discord Developer Portal → l'application → Bot → Reset Token                                                        | `DISCORD_BOT_TOKEN` (partagé)                            | Deploy **sandbox et production** : la même application sert les deux.                                                                                                                                           |
| Secret client Discord            | Discord Developer Portal → l'application → OAuth2 → Reset Secret                                                    | `DISCORD_CLIENT_SECRET` (partagé)                        | Deploy sandbox et production.                                                                                                                                                                                   |
| Jeton Cloudflare                 | Cloudflare → My Profile → API Tokens → le jeton → Roll                                                              | `CLOUDFLARE_API_TOKEN` (partagé)                         | Rien à redéployer : seuls les workflows s'en servent. Un Deploy le vérifie.                                                                                                                                     |

Après une fuite (un secret vu là où il ne devait pas être) : changer la clé tout de suite, puis
regarder dans Réglages › État et dans le journal d'audit (plus haut) ce qui s'est passé depuis.

## Sauvegarder la base

- Supabase garde ses propres sauvegardes selon le plan du projet : les voir dans **Database →
  Backups** (le plan gratuit en garde peu ou pas : à vérifier avant d'ouvrir au public).
- Une copie à la main, depuis une machine de confiance avec les outils Postgres :

  ```
  pg_dump "<URI Session pooler>" --schema=stayput --format=custom --file=stayput-AAAA-MM-JJ.dump
  ```

  Le fichier contient des données de membres : le chiffrer, le garder hors du dépôt, l'effacer
  quand il ne sert plus.

- Restaurer dans un **nouveau** projet Supabase : y appliquer d'abord les migrations
  (`npm run db:migrate`, qui crée aussi les rôles), puis
  `pg_restore --data-only --schema=stayput -d "<URI>" stayput-AAAA-MM-JJ.dump`. Le nouveau projet
  n'est réservé à aucun déploiement tant que Deploy ne l'a pas migré (`docs/data-schema.md`).

## Arrêter tout en urgence

- **Une communauté** : son équipe active le mode test (Réglages › Automatisations) : StayPut
  calcule tout et n'envoie plus rien.
- **Tout StayPut** : l'arrêt général (`stayput.app_settings.kill_switch = true`, dans le SQL
  Editor de Supabase) : plus aucune action ne part, pour aucune communauté, jusqu'à ce qu'il soit
  remis à `false`. Les lectures et les calculs continuent.
- **Un mauvais déploiement** : revenir à la version précédente du Worker (Cloudflare → Workers &
  Pages → `stayput` ou `stayput-app` → Deployments → Rollback), ou annuler le commit fautif
  (`git revert`) puis Deploy. Une migration appliquée ne se défait pas : la suivante corrige.
