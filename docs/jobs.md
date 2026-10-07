# Les tâches planifiées

Le Worker a **un seul déclencheur**, toutes les 5 minutes (`*/5 * * * *`, `triggers.crons` de
`apps/worker/wrangler.toml`) : l'offre gratuite de Cloudflare en permet 5 par compte, et le compte
fait tourner deux Workers, celui du sandbox et celui de la production. Chaque passage lit son heure
prévue (UTC) et lance le groupe de tâches qu'elle désigne (`groupAt`, `apps/worker/src/cron.ts`),
seul dans son exécution, avec ses propres 50 sous-requêtes :

| Minute du passage (UTC)      | Groupe                                   |
| ---------------------------- | ---------------------------------------- |
| `:00`                        | les tâches horaires                      |
| `:05`, `:15`, `:25`, … `:55` | la synchronisation (six fois par heure)  |
| le lundi à `7:30`            | les tâches hebdomadaires                 |
| `:10`, `:20`, `:30`, … `:50` | rien : le passage s'arrête avant la base |

Le travail horaire reste pile à l'heure : une action part à la prochaine heure d'or du membre à
partir de l'heure du passage (`nextLocalHour`), si bien qu'un passage à `:05` repousserait d'un
jour celles prévues dans l'heure.

Les tâches d'un groupe passent l'une après l'autre ; une tâche en échec n'arrête pas les
suivantes, et le passage suivant du groupe la reprend. Chaque passage est noté dans `job_runs`
(dernière exécution, dernier succès, dernier échec, durée) et chaque échec dans le journal des
erreurs : les deux se lisent dans **Réglages › État** (`docs/operations.md`), qui dit une tâche
« en retard » après deux périodes sans passage. Le déploiement relit chez Cloudflare le
déclencheur enregistré, et s'arrête s'il manque (`scripts/deploy/check-crons.ts`).

Les tâches ne lisent jamais l'horloge elles-mêmes : elles reçoivent l'heure prévue du passage,
ce qui les rend testables.

## La synchronisation, toutes les 10 minutes (`sync`, à `:05`, `:15`, … `:55`)

| Tâche             | Ce qu'elle fait                                                                                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replay-webhooks` | rejoue les envois de Whop en échec, ou laissés inachevés (5 essais au plus)                                                                                                                                                                                                         |
| `sync`            | une tranche de la synchronisation avec Whop (membres, abonnements, paiements, offres, chats, forums, cours) et Discord (membres, messages des salons choisis) : les communautés qui attendent le plus, dans le budget d'appels ; Telegram, lui, envoie ses messages au fil de l'eau |
| `stats`           | les compteurs par jour (`member_stats_daily`) et les heures d'activité (`activity_hours`) des membres dont l'activité a changé                                                                                                                                                      |

## Chaque heure (`hourly`, à `:00`)

| Tâche            | Ce qu'elle fait                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `risk`           | le score de risque de chaque membre (et son historique quotidien, gardé 400 jours) ; les analyses de la semaine (cohortes, leçons) quand une semaine a passé                                                       |
| `actions`        | planifie les actions de chaque communauté, les passe aux garde-fous, puis envoie celles dont l'heure est venue (simulées en mode test)                                                                             |
| `saves`          | attribue les sauvetages : paiements récupérés, annulations retirées, retours avec un code, chacun à l'action qui l'a fait                                                                                          |
| `weekly-reports` | le rapport du lundi de chaque communauté où il est lundi passé 8 h, à son équipe par une notification Whop (fait une fois, réessayé 3 fois au plus)                                                                |
| `data-upkeep`    | supprime les envois de Whop traités, constate les communautés dont Whop a retiré l'accès (désinstallées après un jour de refus) et efface celles désinstallées depuis 30 jours ; vide le vieux journal des erreurs |

## Chaque lundi à 7 h 30 UTC (`weekly`)

| Tâche                | Ce qu'elle fait                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `benchmarks`         | les rétentions anonymes par niche, à partir des communautés qui partagent les leurs (5 au moins) |
| `activity-retention` | supprime l'activité détaillée de plus de 12 mois ; ses compteurs par jour restent                |

## Ajouter une tâche

1. L'écrire dans `apps/worker/src/jobs.ts` (un `CronJob` : un nom, une fonction qui reçoit le
   contexte et l'heure prévue).
2. L'ajouter à la liste du bon groupe dans `SCHEDULE`. Un nouveau rythme est un nouveau groupe
   (`JobGroup`, `groupAt`, `EVERY_MINUTES`), jamais un second déclencheur : un test vérifie que
   chaque groupe passe à son rythme, seul dans ses passages.
3. Elle apparaît d'elle-même dans Réglages › État.
