# Les tâches planifiées

Le Worker a trois déclencheurs (`triggers.crons` de `apps/worker/wrangler.toml`, heures UTC),
chacun avec sa liste de tâches (`SCHEDULE`, `apps/worker/src/cron.ts`). Les tâches d'un
déclencheur passent l'une après l'autre ; une tâche en échec n'arrête pas les suivantes, et
l'exécution suivante la reprend. Chaque passage est noté dans `job_runs` (dernière exécution,
dernier succès, dernier échec, durée) et chaque échec dans le journal des erreurs : les deux se
lisent dans **Réglages › État** (`docs/operations.md`), qui dit une tâche « en retard » après deux
périodes sans passage.

Les tâches ne lisent jamais l'horloge elles-mêmes : elles reçoivent l'heure prévue du passage,
ce qui les rend testables.

## Toutes les 10 minutes (`*/10 * * * *`)

| Tâche             | Ce qu'elle fait                                                                                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replay-webhooks` | rejoue les envois de Whop en échec, ou laissés inachevés (5 essais au plus)                                                                                                                                                                                                         |
| `sync`            | une tranche de la synchronisation avec Whop (membres, abonnements, paiements, offres, chats, forums, cours) et Discord (membres, messages des salons choisis) : les communautés qui attendent le plus, dans le budget d'appels ; Telegram, lui, envoie ses messages au fil de l'eau |
| `stats`           | les compteurs par jour (`member_stats_daily`) et les heures d'activité (`activity_hours`) des membres dont l'activité a changé                                                                                                                                                      |

## Chaque heure (`0 * * * *`)

| Tâche            | Ce qu'elle fait                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `risk`           | le score de risque de chaque membre (et son historique quotidien, gardé 400 jours) ; les analyses de la semaine (cohortes, leçons) quand une semaine a passé                                                       |
| `actions`        | planifie les actions de chaque communauté, les passe aux garde-fous, puis envoie celles dont l'heure est venue (simulées en mode test)                                                                             |
| `saves`          | attribue les sauvetages : paiements récupérés, annulations retirées, retours avec un code, chacun à l'action qui l'a fait                                                                                          |
| `weekly-reports` | le rapport du lundi de chaque communauté où il est lundi passé 8 h, à son équipe par une notification Whop (fait une fois, réessayé 3 fois au plus)                                                                |
| `data-upkeep`    | supprime les envois de Whop traités, constate les communautés dont Whop a retiré l'accès (désinstallées après un jour de refus) et efface celles désinstallées depuis 30 jours ; vide le vieux journal des erreurs |

## Chaque lundi à 7 h 30 UTC (`30 7 * * 1`)

| Tâche                | Ce qu'elle fait                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `benchmarks`         | les rétentions anonymes par niche, à partir des communautés qui partagent les leurs (5 au moins) |
| `activity-retention` | supprime l'activité détaillée de plus de 12 mois ; ses compteurs par jour restent                |

## Ajouter une tâche

1. L'écrire dans `apps/worker/src/jobs.ts` (un `CronJob` : un nom, une fonction qui reçoit le
   contexte et l'heure prévue).
2. L'ajouter à la liste du bon déclencheur dans `SCHEDULE` ; un nouveau déclencheur va aussi dans
   `triggers.crons` de `wrangler.toml` et dans `EVERY_MINUTES` (un test vérifie l'accord).
3. Elle apparaît d'elle-même dans Réglages › État.
