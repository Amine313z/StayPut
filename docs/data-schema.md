# Le schéma de données

Tout vit dans le schéma Postgres **`stayput`** (Supabase), créé par les migrations de
`supabase/migrations` dans l'ordre (`npm run db:migrate`, ou `supabase/install.sql` dans le SQL
Editor). Une migration appliquée n'est jamais modifiée : on en ajoute une. La dernière attendue
par le code est dans `apps/worker/src/schema-version.ts` ; `/health` dit `outdated` si la base est
en retard.

## Les règles qui valent pour toutes les tables

- **RLS sur chaque table.** Le tableau de bord lit sous le rôle `stayput_user` (`withUser`) :
  - **équipe** : les lignes des communautés dont l'utilisateur est de l'équipe
    (`is_company_admin`, accès vérifié auprès de Whop depuis moins d'un jour) ;
  - **membre** : en plus, ses propres lignes, pour la page du membre ;
  - **Worker seul** : aucune politique, donc rien pour `stayput_user`.
- `stayput_user` lit, et n'écrit que par des fonctions SQL (`security definer`) qui vérifient
  elles-mêmes qui écrit ; il n'a jamais de droit d'écriture direct sur une table.
- Rien n'est ouvert à l'API publique de Supabase (`anon`, `authenticated`, `service_role`).
- Chaque table qui a un `company_id` le relie à `companies` avec `on delete cascade` : supprimer
  une communauté supprime tout ce qui la concerne (deux exceptions, voir `error_log` et
  `webhook_events`).
- Les identifiants sont ceux de Whop, avec leur préfixe (`biz_…` une communauté, `user_…` une
  personne, `mber_…` un membre, `mem_…` un abonnement, `pay_…` un paiement), vérifiés par des
  contraintes.
- `apps/worker/test/schema.test.ts` vérifie ces règles à chaque test.

## Les communautés et leur équipe

| Table              | Contenu                                                                                                                                                                    | Accès       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `companies`        | une communauté Whop qui a ouvert StayPut : nom, niche, langue, fuseau, mode (`auto`/`manual`), statut, installation et désinstallation, accès retiré par Whop, démo ou non | équipe      |
| `company_settings` | ses réglages : poids et seuils du score, garde-fous, heures silencieuses, mode test (`dry_run`), offres, règles éteintes, options (rapport du lundi, badge…)               | équipe      |
| `company_admins`   | qui de l'équipe a ouvert StayPut, et quand son accès a été vérifié auprès de Whop                                                                                          | Worker seul |
| `company_sync`     | où en est la synchronisation de la communauté (bail, dernier passage, statistiques à refaire)                                                                              | Worker seul |
| `sync_state`       | l'avancement de chaque flux synchronisé (membres, paiements, salons Discord…) : curseur, passe complète, dernière erreur                                                   | équipe      |
| `audit_log`        | ce que l'équipe a fait (réglages, approbations, export, suppression, rejeu…), par qui                                                                                      | équipe      |
| `app_settings`     | une seule ligne : l'arrêt général de StayPut, et le déploiement que la base sert (`sandbox` ou `production`, migration 0043)                                               | Worker seul |

## Ce que StayPut lit chez Whop

| Table              | Contenu                                                                                                                                                         | Accès          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `members`          | un membre : nom affiché, pseudo, date d'arrivée, statut, « ne pas contacter », comptes Discord et Telegram liés ; jamais d'e-mail ni de téléphone               | équipe, membre |
| `memberships`      | ses abonnements : offre, prix, période, statut, fin de période, annulation programmée, pause                                                                    | équipe, membre |
| `payments`         | ses paiements : montant, statut, motif d'échec, nouvelle tentative possible, lien de récupération                                                               | équipe         |
| `plans`            | les offres de la communauté (prix, période)                                                                                                                     | équipe         |
| `activity_events`  | l'activité détaillée d'un membre (message, réaction, leçon, connexion…), gardée 12 mois                                                                         | équipe         |
| `pending_activity` | une activité reçue avant que son auteur soit connu comme membre ; rattachée ensuite, ou effacée                                                                 | Worker seul    |
| `webhook_events`   | les envois de Whop, tels que reçus, le temps d'être traités (rejeu, puis suppression) ; `company_id` sans clé étrangère : un envoi peut précéder l'installation | Worker seul    |

## Discord et Telegram

| Table               | Contenu                                                                         | Accès  |
| ------------------- | ------------------------------------------------------------------------------- | ------ |
| `discord_guilds`    | un serveur Discord connecté : salons suivis, noms des salons, nombre de membres | équipe |
| `telegram_chats`    | un groupe Telegram connecté : titre, dernier message, nombre de membres         | équipe |
| `telegram_topics`   | les sujets d'un groupe à sujets                                                 | équipe |
| `platform_accounts` | un compte Discord ou Telegram vu dans la communauté, lié ou non à un membre     | équipe |
| `platform_presence` | qui est sur le serveur ou dans le groupe, depuis quand, et quand il l'a quitté  | équipe |

## Ce que StayPut en calcule

| Table                  | Contenu                                                                                                   | Accès  |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| `member_stats_daily`   | les compteurs par jour et par membre (messages, réactions, leçons, messages du forum, actions de StayPut) | équipe |
| `activity_hours`       | les heures où chaque membre est d'habitude actif (l'heure d'envoi des messages)                           | équipe |
| `member_risk`          | le score de risque actuel de chaque membre (0 à 100), son niveau, ses sous-scores et ses raisons          | équipe |
| `risk_scores`          | l'historique quotidien des scores, gardé 400 jours                                                        | équipe |
| `cohort_stats`         | la rétention de chaque cohorte (mois d'arrivée) à 30, 60 et 90 jours, et ses alertes                      | équipe |
| `lesson_dropoff_stats` | les leçons de cours où les membres décrochent                                                             | équipe |
| `benchmarks`           | les rétentions anonymes par niche (5 communautés au moins), sans aucune communauté nommée                 | équipe |

## Les actions et ce qu'elles rapportent

| Table            | Contenu                                                                                                                                               | Accès          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `actions`        | chaque action de StayPut vers un membre : type, déclencheur, contenu, statut (proposée, programmée, envoyée, simulée, bloquée…), heure, résultat      | équipe         |
| `exit_surveys`   | le questionnaire de départ : la raison donnée, l'offre proposée, la réponse du membre et son accord pour garder l'abonnement                          | équipe, membre |
| `creator_offers` | une offre faite par l'équipe à un membre depuis sa fiche, et ce qu'il en a fait                                                                       | équipe         |
| `saves`          | un sauvetage : le membre, l'action qui l'a fait, son type (paiement récupéré, annulation retirée, retour), direct ou influencé, le montant, la preuve | équipe         |
| `weekly_reports` | le rapport du lundi de chaque semaine, tel qu'il a été fait, et son envoi (date, essais, erreur)                                                      | équipe         |

## L'offre Alumni

| Table            | Contenu                                                                                        | Accès  |
| ---------------- | ---------------------------------------------------------------------------------------------- | ------ |
| `alumni_offers`  | l'offre gratuite « Alumni » de la communauté : produit, variante, expérience, lien             | équipe |
| `alumni_members` | un ancien membre entré dans l'Alumni : départ, entrée, sortie, retour, codes de retour envoyés | équipe |

## L'espace membre (éteint en V1, `MEMBER_SPACE_ENABLED`)

`goals`, `results`, `milestones`, `proofs`, `badges` (le catalogue), `member_badges`,
`buddy_pairs`, `rescue_challenges`, `rescue_challenge_participants` : objectifs, résultats et
preuves, badges, binômes et défis de relance (Phase 5). Les tables existent et restent vides tant
que l'espace membre est éteint ; équipe et membre (le sien) y ont accès.

## Exploitation et conformité

| Table               | Contenu                                                                                                                                              | Accès       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `erased_people`     | l'empreinte (SHA-256) d'une personne dont les données ont été effacées, pour ne pas la recréer à la synchronisation suivante ; jamais qui elle était | équipe      |
| `error_log`         | chaque erreur une fois par endroit, communauté et message nettoyé, avec son nombre et ses dates ; gardée 30 jours ; `company_id` sans clé étrangère  | Worker seul |
| `job_runs`          | le dernier passage de chaque tâche planifiée, son dernier succès et son dernier échec                                                                | Worker seul |
| `billing`           | prévue dès la Phase 1 pour la facturation de StayPut par communauté ; vide, en attente de la phase 7                                                 | équipe      |
| `schema_migrations` | les migrations appliquées (`scripts/migrate.ts`)                                                                                                     | Worker seul |

## Les fonctions SQL

Le Worker ne fait presque pas de SQL à la main : la logique qui touche plusieurs tables vit dans
des fonctions du schéma (environ 180), chacune dans la migration qui l'a créée ou remplacée en
dernier. Les principales :

- **ingestion** : `process_webhook_event`, `ingest_page`, `upsert_member`, `upsert_membership`,
  `upsert_payment`, `record_activity`, `record_telegram_message` ;
- **détection** : `risk_features`, `save_risk_scores`, `analysis_features`, `save_analyses` ;
- **actions** : `plan_actions`, `apply_schedule`, `due_actions`, `finish_action`,
  `approve_actions`, `answer_exit_survey`, `decide_exit_offer` ;
- **valeur** : `attribution_facts`, `record_saves`, `weekly_reports_due`, `refresh_benchmarks` ;
- **données des personnes** : `forget_member`, `delete_company_data`,
  `delete_uninstalled_companies`, `purge_old_activity`, `purge_webhook_events` ;
- **exploitation** : `log_error`, `record_job_run`, `operator_status`, `replay_failed_webhooks`.

L'export d'une communauté (Réglages › Général) lit chaque table qui la concerne, sauf celles
que `apps/worker/src/data.ts` exclut avec leur raison (les tables du Worker seul, l'historique
technique) ; un test vérifie qu'aucune table n'est oubliée.
