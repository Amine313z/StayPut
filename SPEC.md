# MISSION — Construire StayPut, l'app de rétention pour les créateurs Whop

Tu es le développeur principal de StayPut. Ce document est ton cahier des charges complet. Lis-le entièrement avant d'écrire la moindre ligne de code. Travaille étape par étape, dans l'ordre des phases ci-dessous, et **arrête-toi à la fin de chaque phase** pour me présenter un résumé de ce qui est fait, ce qui a été testé, et ce dont tu as besoin de ma part avant de continuer.

---

## 0. Règles de travail (à respecter pendant tout le projet)

1. **Vérifie avant de coder.** La documentation Whop évolue vite. Avant d'utiliser un endpoint, un webhook ou une permission, vérifie son nom exact, ses paramètres et ses permissions dans la doc officielle : commence par `https://docs.whop.com/llms.txt`, puis les index `https://docs.whop.com/_llms/for-developers.md` et la page `https://docs.whop.com/api-reference/stability`. N'invente jamais un nom d'endpoint ou de permission. Si quelque chose n'existe pas, dis-le-moi et propose une alternative.
2. **Budget 0 €.** Tout doit tourner sur des offres gratuites : Cloudflare Workers (+ Cron Triggers), Cloudflare Pages, Supabase (Postgres), Tesseract.js côté navigateur. Pas d'IA payante, pas de service payant. Si une fonctionnalité exige un service payant, signale-le avant de l'implémenter. N'utilise pas l'offre Hobby de Vercel (usage non commercial).
3. **Secrets.** Aucun secret dans le code ni dans Git. En local : fichier `.dev.vars` (Wrangler) et `.env.local` (frontend), tous deux dans `.gitignore`. En production : `wrangler secret put`. Fournis un `.dev.vars.example` et un `.env.example` avec des valeurs factices. N'affiche jamais le contenu d'un secret dans le terminal ou dans tes messages.
4. **Sandbox d'abord.** Chaque fonctionnalité est développée et testée contre le sandbox Whop (`https://sandbox-api.whop.com/api/v1`) avant la production (`https://api.whop.com/api/v1`). La base URL se choisit par variable d'environnement `WHOP_ENV=sandbox|production`.
5. **Langue.** Code, noms de variables, commentaires et commits en anglais. Interface en anglais par défaut, avec le français comme seconde langue (i18n dès le départ, aucun texte en dur dans les composants). Tes messages vers moi en français.
6. **Qualité.** TypeScript strict partout. Tests unitaires pour toute la logique métier (score, attribution, garde-fous, facturation). Commits petits et descriptifs. README à jour à chaque phase.
7. **Multi-créateurs.** StayPut est installé par de nombreux créateurs. Chaque table métier porte un `company_id` et aucune requête ne doit jamais pouvoir lire les données d'un autre créateur (Row Level Security Supabase activée + filtre systématique côté serveur).
8. **Sécurité des actions.** Aucune action qui touche l'argent ou la membership d'un membre (pause, jours offerts, code promo, relance de paiement) ne part sans passer par le moteur de garde-fous (section 5.8) et sans être journalisée.

---

## 1. Ce qu'est StayPut (contexte produit)

StayPut prédit quel membre d'une communauté Whop va partir, agit automatiquement pour le garder, fait progresser les membres vers leurs objectifs, et prouve au créateur combien d'argent il a sauvé.

Quatre piliers forment une boucle :

1. **Détecter** : score de risque par membre, radar des 7 premiers jours, alertes de cohortes, détecteur de leçon bloquante.
2. **Agir** : relance des paiements échoués, lien 3D Secure, rattrapage après annulation programmée (pause, jours offerts, code promo), messages personnalisés à l'heure d'or, reconquête des anciens membres, binômes, défis de sauvetage.
3. **Engager** : espace membre avec objectifs, résultats, preuves (OCR), badges, jours mérités, cartes témoignage avec QR et lien d'affiliation.
4. **Prouver** : argent sauvé attribué à chaque action, prédiction de revenu à 90 jours, simulateur « et si », benchmarks anonymes, rapport du lundi, badge public « Rétention vérifiée ».

Chaque action et chaque résultat du membre réinjectent de la donnée dans le score.

---

## 2. Stack technique imposée

| Couche | Choix |
| --- | --- |
| Backend (API, webhooks, jobs) | Cloudflare Workers en TypeScript, framework Hono |
| Jobs planifiés | Cloudflare Cron Triggers (horaire + hebdomadaire) |
| Base de données | Supabase Postgres, RLS activée, migrations SQL versionnées dans `/supabase/migrations` |
| Frontend | React + Vite + TypeScript, déployé sur Cloudflare Pages |
| SDK Whop | `@whop/sdk` (vérifier la version et l'initialisation dans la doc : `new Whop({ appID, apiKey, webhookKey })`) |
| OCR | Tesseract.js exécuté dans le navigateur du membre (l'image ne quitte jamais l'appareil) |
| Cartes témoignage | Génération dans le navigateur (canvas) + librairie QR open source |
| Graphiques | Librairie open source légère (ex. Recharts) |
| Tests | Vitest (unitaires), Playwright (quelques parcours e2e) |

Structure du dépôt (monorepo) :

```
/apps/worker        -> Worker Cloudflare (API, webhooks, cron)
/apps/web           -> Frontend React (vue créateur + vue membre)
/packages/core      -> logique métier pure et testée (score, attribution, garde-fous, prédiction)
/packages/whop      -> client Whop typé (wrappers autour du SDK + appels REST non couverts)
/packages/i18n      -> traductions EN / FR
/supabase/migrations
/scripts            -> seed sandbox, backfill, outils
/docs               -> documentation technique, rapport de vérification API
```

---

## 3. Modèle de données (à créer en Phase 1)

Crée au minimum ces tables (adapte les types, ajoute index et clés étrangères). Toutes portent `company_id` sauf mention contraire.

- `companies` : id Whop (`biz_…`), nom, niche, langue, plan StayPut, mode (`auto` | `manual`), fuseau horaire, date d'installation, statut (actif / désinstallé), paramètres JSON.
- `company_settings` : poids du score, seuils, garde-fous, plafonds de réduction, heures silencieuses, modèles de messages actifs, options (binômes, jours mérités, badge public, benchmarks opt-in).
- `members` : id Whop du membre et de l'utilisateur, nom affiché, date d'arrivée, cohorte (mois d'arrivée), identifiant Discord lié (si disponible), liste « ne jamais contacter ».
- `memberships` : id, member, produit / variant, prix, devise, période de facturation, statut, `cancel_at_period_end`, fin de période, pause en cours.
- `payments` : id, membership, montant, statut, date, raison d'échec, `recovery_url` 3D Secure si présente.
- `activity_events` : member, type (`message`, `reaction`, `lesson_completed`, `forum_post`, `support_ticket_opened`, `support_ticket_resolved`, `stayput_open`, `goal_update`, `discord_message`), horodatage, métadonnées. Table volumineuse : index sur `(company_id, member_id, occurred_at)`.
- `member_stats_daily` : agrégats par membre et par jour (messages, réactions, leçons, actions StayPut), pour calculer vite les fréquences.
- `activity_hours` : histogramme des heures d'activité par membre (24 cases), pour l'heure d'or.
- `risk_scores` : member, score 0-100, niveau, sous-scores détaillés, raisons principales (texte court), date de calcul. Garder l'historique (une ligne par calcul horaire, purge après 90 jours sauf un point par jour).
- `actions` : type, member, statut (`proposed`, `approved`, `scheduled`, `sent`, `failed`, `cancelled`, `blocked_by_guardrail`), déclencheur, contenu, `send_at`, résultat, journal d'erreurs.
- `saves` : membre sauvé, action à l'origine, type de sauvetage, montant sauvé, catégorie (`direct` | `influenced`), preuve (ids des événements Whop), date.
- `goals`, `results`, `proofs` (niveau `declared` | `justified` | `connected`, données OCR extraites, hash de l'image, jamais l'image elle-même sauf si le membre l'accepte explicitement), `milestones`, `badges`, `member_badges`.
- `buddy_pairs` : nouveau membre, vétéran, date, statut.
- `rescue_challenges` : défis de sauvetage, participants, membres réengagés.
- `exit_surveys` : membre, raison choisie, commentaire, offre proposée, résultat.
- `alumni_members` : ancien membre, membership Alumni, mode d'entrée (`invitation` | `lien`), date d'invitation, date d'entrée, statut (`invité`, `entré`, `parti`, `revenu`), date de départ de l'Alumni, codes promo envoyés (voir 5.9).
- `cohort_stats`, `lesson_dropoff_stats` : résultats des analyses.
- `benchmarks` : agrégats anonymes par niche (jamais de données identifiables), avec nombre d'entreprises contributrices.
- `webhook_events` : id du webhook (`webhook-id`), type, payload, statut de traitement, tentatives, erreur. Sert à l'idempotence et au rejeu.
- `billing` : plan StayPut du créateur, compteur de membres, montant Performance calculé par mois, statut de facturation.
- `audit_log` : toute action sensible (qui, quoi, quand, pourquoi).

---

## 4. Phases de travail (dans cet ordre)

### Phase 0 — Vérification de l'API Whop (avant tout code)

1. Lis la documentation Whop (point de départ `https://docs.whop.com/llms.txt`).
2. Produis `/docs/whop-api-verification.md` : un tableau listant, pour chaque besoin de la section 5, l'endpoint ou le webhook exact, la surface (Current ou Legacy), les permissions requises, et un statut `OK` / `NON TROUVÉ` / `INCERTAIN`.
3. Points à trancher explicitement dans ce rapport :
   - Comment une app appelle l'API **au nom d'une entreprise qui l'a installée** (clé API d'app + identifiant d'entreprise, OAuth grant, en-têtes nécessaires).
   - Comment l'app authentifie l'utilisateur qui ouvre la vue créateur ou la vue membre (jeton utilisateur transmis par Whop dans l'iframe, vérification côté serveur), et comment vérifier qu'il est bien admin de l'entreprise (Check User Access).
   - Le nom exact des « app views » (vue tableau de bord créateur, vue expérience membre) et leurs chemins.
   - Les webhooks d'app disponibles : `payment.failed`, `payment.succeeded`, Payment Requires Action (avec `recovery_url`), `membership.activated`, `membership.deactivated`, Membership Cancel at Period End Changed, Membership Trial Ending Soon, `member.created`, `member.updated`, `course_lesson_interaction.completed`, et un éventuel événement d'installation / désinstallation de l'app.
   - Endpoints d'action : pause, resume, cancel, extend (jours gratuits), update (`cancel_at_period_end`), Retry Payment, Promo Codes (création), Send Notification (avec `user_ids`), Messages (création dans un canal), création de DM si elle existe.
   - Endpoints de lecture : List Members, List Memberships, List Payments, List Messages, Reactions, Forums / Forum posts, Course Lesson Interactions, Courses / Lessons, Support Channels, Stats, People, Retrieve User (pour le Discord lié), Affiliates.
   - Les permissions exactes à demander (utilise « List the Permission Catalog ») : donne-moi la liste finale, je les déclarerai dans le tableau de bord.
   - Si les notifications Whop atteignent un **ancien** membre (membership désactivée). Si non, propose une alternative à 0 € pour la reconquête et signale-la.
   - Les options de monétisation d'app (abonnement mensuel, prix par membre…) et s'il est possible de débiter un créateur d'un montant variable chaque mois (Create Payment avec moyen de paiement enregistré, ou facture). Réponds oui / non / incertain.
4. **Arrête-toi** et envoie-moi le rapport. Je valide avant la Phase 1.

### Phase 1 — Fondations

1. Initialise le monorepo, TypeScript strict, ESLint, Prettier, Vitest, scripts npm.
2. Crée le Worker Hono avec les routes de base : `GET /health`, `POST /webhooks/whop`, `/api/creator/*`, `/api/member/*`, `/badge/:companyId.svg`, `/v/:proofId` (page publique de vérification d'une preuve).
3. Crée le frontend React avec deux entrées : **vue créateur** (tableau de bord) et **vue membre** (espace de progression), routage, i18n EN/FR, thème clair/sombre, design sobre et mobile d'abord.
4. Authentification : vérifie le jeton utilisateur Whop à chaque requête API ; la vue créateur exige que l'utilisateur soit admin de l'entreprise ; la vue membre exige un accès valide à l'expérience.
5. Écris les migrations Supabase de la section 3, active la RLS, crée les rôles.
6. Client Whop typé dans `/packages/whop` : gestion de la base URL sandbox/production, pagination automatique, gestion des erreurs, **respect des limites de débit** (retry avec backoff exponentiel sur 429 et 5xx), version d'API épinglée par en-tête `Api-Version-Date` quand l'endpoint est sur la surface Current.
7. Déploiement : `wrangler.toml` pour le Worker, configuration Cloudflare Pages, commandes de déploiement documentées dans le README.
8. **Arrête-toi** : donne-moi les URLs à déclarer dans Whop (URL de base de l'app, chemins des vues, URL du webhook) et la liste des secrets à créer.

### Phase 2 — Collecte des données

1. **Webhook d'app** (`POST /webhooks/whop`) :
   - Vérifie la signature (en-têtes `webhook-id`, `webhook-timestamp`, `webhook-signature`, via le SDK et `WHOP_WEBHOOK_SECRET`). Rejette toute requête invalide.
   - Idempotence : si `webhook-id` existe déjà dans `webhook_events`, réponds 200 sans retraiter.
   - Réponds 200 immédiatement et traite en arrière-plan (`ctx.waitUntil`). En cas d'échec, marque l'événement pour rejeu au prochain cron.
   - Route chaque type d'événement vers son handler et met à jour `members`, `memberships`, `payments`, `activity_events`.
2. **Installation d'un créateur** : à la première ouverture de la vue créateur (ou à l'événement d'installation s'il existe), crée la ligne `companies`, lance l'onboarding (section 5.1) et le **backfill** : 90 derniers jours de memberships, paiements, messages, réactions, interactions de leçons, tickets support.
3. **Synchronisation horaire** (cron) pour chaque créateur actif : nouveaux messages, réactions, posts de forum et tickets support depuis le dernier curseur enregistré. Découpe le travail par créateur pour rester sous les limites du Worker ; si un créateur a beaucoup de données, reprends au curseur au cron suivant.
4. Mets à jour `member_stats_daily` et `activity_hours` après chaque synchronisation.
5. **Module Discord (optionnel, désactivé par défaut)** : si le créateur l'active et ajoute le bot, le cron lit l'historique des messages des salons choisis par l'API REST Discord (sans passerelle permanente), relie l'auteur Discord au membre Whop via le Discord lié au profil, et crée des `activity_events` de type `discord_message`. Seules les métadonnées (auteur, date) sont stockées, jamais le contenu.
6. Script `/scripts/seed-sandbox.ts` qui génère dans le sandbox des membres fictifs avec des profils variés (actif, en déclin, inactif, paiement échoué, annulation programmée) pour tester tout le reste.
7. **Arrête-toi** : montre-moi les données collectées sur le sandbox.

### Phase 3 — Détection (score de risque)

Implémente toute cette logique dans `/packages/core`, en fonctions pures testées.

**Score de risque (0-100), recalculé chaque heure pour chaque membre actif.** Cinq sous-scores entre 0 et 1 :

| Sous-score | Calcul par défaut |
| --- | --- |
| Récence (R) | `min(1, jours_depuis_derniere_activite / seuil_recence)` ; seuil par défaut 14 jours |
| Fréquence (F) | `clamp(1 - activite_7_derniers_jours / moyenne_hebdo_28_jours_precedents, 0, 1)` ; si la moyenne est 0, F = 0 et le membre relève du radar d'activation ou de la récence |
| Progression (P) | `min(1, jours_depuis_derniere_lecon_ou_mise_a_jour_objectif / 21)` ; 0 si le créateur n'a ni cours ni objectifs |
| Paiement (Pay) | 1 si paiement échoué non résolu ou `cancel_at_period_end = true` ; 0,7 si 3D Secure en attente ; sinon 0 |
| Friction (Fr) | 1 si ticket support ouvert depuis plus de 48 h ; 0,5 si les réactions ont baissé de plus de 50 % sur 14 jours ; sinon 0 |

`score = 100 × (wR×R + wF×F + wP×P + wPay×Pay + wFr×Fr)`

Poids par défaut : R 0,30 · F 0,25 · P 0,20 · Pay 0,15 · Fr 0,10. Les poids sont modifiables par le créateur (leur somme est toujours ramenée à 1).

Préréglages par niche (appliqués à l'onboarding, modifiables) :

| Niche | R | F | P | Pay | Fr | Seuil récence |
| --- | --- | --- | --- | --- | --- | --- |
| Trading | 0,35 | 0,30 | 0,10 | 0,15 | 0,10 | 7 jours |
| Fitness | 0,25 | 0,20 | 0,30 | 0,15 | 0,10 | 10 jours |
| Business en ligne | 0,30 | 0,20 | 0,25 | 0,15 | 0,10 | 14 jours |
| Coaching | 0,25 | 0,20 | 0,25 | 0,15 | 0,15 | 14 jours |
| E-commerce | 0,30 | 0,20 | 0,25 | 0,15 | 0,10 | 14 jours |
| Développement personnel | 0,25 | 0,25 | 0,25 | 0,15 | 0,10 | 14 jours |
| Autre | valeurs par défaut | | | | | 14 jours |

Niveaux : 0-39 **faible**, 40-69 **moyen**, 70-100 **élevé**. Règle prioritaire : si `cancel_at_period_end = true`, le membre passe au statut spécial **« départ programmé »** (score 100) quel que soit le calcul.

Pour chaque score, enregistre les 2 raisons principales en langage clair (« Aucun message depuis 12 jours », « A arrêté le cours à la leçon 4 »), affichées au créateur.

**Radar d'activation (7 premiers jours)** : tout membre arrivé depuis moins de 7 jours et sans aucune activité 72 h après son arrivée déclenche une alerte « nouveau membre inactif » et l'action d'accueil (Phase 4).

**Alertes de cohortes** : chaque semaine, calcule par mois d'arrivée le taux de départ à 30, 60 et 90 jours. Alerte si une cohorte part au moins 1,5 fois plus que la moyenne du créateur (minimum 10 membres dans la cohorte).

**Détecteur de leçon bloquante** : pour chaque leçon, calcule la part des membres dont c'est la dernière leçon terminée et qui sont inactifs depuis 14 jours ou partis. Signale les leçons dont ce taux dépasse 2 fois la moyenne des leçons du cours (minimum 10 membres concernés).

**Tests obligatoires** : cas limites (nouveau membre, membre sans cours, poids modifiés, données manquantes, départ programmé).

**Arrête-toi** : montre-moi la liste des membres du sandbox triés par score, avec leurs raisons.

### Phase 4 — Actions

Chaque action suit ce cycle : création (`proposed`) → validation (automatique en mode `auto`, par clic du créateur en mode `manual`) → passage par les garde-fous → planification (`scheduled`, avec `send_at`) → exécution par le cron → résultat journalisé. Le cron horaire exécute les actions dont `send_at` est passé.

| Déclencheur | Action |
| --- | --- |
| Webhook `payment.failed` | Retry Payment après 24 h, puis 72 h (maximum 2 tentatives), **uniquement si Whop n'a pas déjà prévu de nouvelle tentative** (`next_payment_attempt_at` vide) et si le paiement est `retryable` (décision du 30/09/2026), + notification au membre l'invitant à mettre à jour son moyen de paiement |
| Webhook Payment Requires Action | Notification immédiate au membre avec le `recovery_url` (lien de validation 3D Secure) |
| `cancel_at_period_end` passe à `true` | Notification au membre avec un questionnaire de départ en 1 clic (raisons : trop cher, pas le temps, pas de résultats, objectif atteint, autre) dans la vue membre ; puis offre selon la raison : **pas le temps** → pause proposée (endpoint pause) ; **trop cher** → code promo à usage unique créé pour ce membre (Whop ne lie pas un code à un membre : code unique aléatoire, `stock` 1, un par client, valable 7 jours, limité au produit du créateur ; décision du 30/09/2026) ; **pas de résultats** → message du créateur + proposition d'accompagnement ; **objectif atteint** → invitation à devenir affilié (voir 5.6) ; **autre** → jours offerts (extend). Si le membre accepte, l'app applique l'action (pause / code / extend) et, si nécessaire, remet `cancel_at_period_end` à `false` **uniquement avec l'accord explicite du membre** |
| Score qui passe en niveau élevé | Message personnalisé programmé à l'heure d'or du membre |
| Radar d'activation | Message d'accueil + création d'un binôme (voir 5.5) |
| Webhook `membership.deactivated` | **Offre Alumni** (voir 5.9) : invitation unique de l'ancien membre dans l'offre gratuite « Alumni » par « Invite to a Membership » (Whop envoie l'e-mail d'invitation) ; si l'invitation est impossible, lien d'accès à l'Alumni affiché dans le questionnaire de départ et sur la page de confirmation. Une fois dans l'Alumni : notifications Whop ciblées à J+7, J+30 et J+60 après le départ, avec les nouveautés de la communauté et un code promo de retour |
| Membre inactif depuis 14 jours dans une communauté avec défis activés | Création d'un défi de sauvetage visible par les membres actifs |

**Heure d'or** : pour chaque membre, l'heure la plus fréquente de son activité sur 30 jours (`activity_hours`), dans le fuseau du créateur ; à défaut, l'heure par défaut du créateur (19 h). Arrondi à l'heure (le cron est horaire).

**Messages** : modèles avec variables, sans IA : `{first_name}`, `{days_inactive}`, `{last_lesson}`, `{goal}`, `{progress}`, `{creator_name}`, `{offer}`. Fournis un jeu de modèles par défaut en EN et FR pour chaque type d'action (ton chaleureux, court, jamais culpabilisant), modifiables par le créateur. Prévois l'emplacement pour brancher plus tard une IA de rédaction, désactivée.

**Garde-fous (moteur central, testé)** :

- Maximum 1 message de relance tous les 5 jours par membre, et 4 messages par mois par membre.
- Maximum 2 tentatives de relance de paiement par paiement échoué.
- Un seul code promo actif par membre ; plafond mensuel de réductions accordées par créateur (valeur par défaut : 10 codes par mois, modifiable).
- Jours offerts plafonnés à 14 jours par membre et par trimestre.
- Heures silencieuses : aucun message entre 22 h et 8 h (heure du membre si connue, sinon du créateur).
- Liste « ne jamais contacter » respectée partout.
- Mode test (`dry_run`) : tout est calculé et journalisé, rien n'est envoyé.
- Interrupteur d'arrêt global par créateur et global pour toute l'app.
- Toute action bloquée est enregistrée avec le statut `blocked_by_guardrail` et la raison.

**Arrête-toi** : démontre chaque déclencheur sur le sandbox en mode `dry_run`, puis en réel sur les membres fictifs.

### Phase 5 — Espace membre (engager)

1. **Objectif** : à la première ouverture, le membre choisit un objectif parmi ceux proposés par le créateur (ou en crée un), avec une valeur cible, une unité et une date.
2. **Résultats** : saisie manuelle rapide ; chaque saisie crée un `activity_event` de type `goal_update`.
3. **Preuves (OCR)** : le membre charge une capture ; Tesseract.js lit le texte dans son navigateur ; l'app propose le nombre détecté ; le membre confirme. Niveaux : `declared` (saisie seule), `justified` (capture lue par OCR, seul le hash de l'image et les valeurs extraites sont envoyés au serveur), `connected` (source externe, prévu pour plus tard).
4. **Jalons et badges** : jalons à 25 %, 50 %, 75 %, 100 % de l'objectif + badges d'assiduité (7 jours d'affilée, premier résultat, première preuve). Célébration à l'écran et annonce optionnelle dans le chat de la communauté (si le créateur l'active et si le membre l'accepte).
5. **Jours mérités** : si le créateur l'active, un jalon atteint déclenche des jours gratuits (extend) selon sa configuration (par défaut 3 jours à 50 %, 7 jours à 100 %), soumis aux garde-fous.
6. **Carte témoignage** : générée dans le navigateur (résultat, niveau de preuve, nom affiché si le membre l'accepte, QR vers `/v/:proofId`, lien d'affiliation du membre si disponible). Téléchargeable en PNG.
7. **Page publique `/v/:proofId`** : affiche le résultat, le niveau de preuve et la date, sans aucune donnée personnelle au-delà de ce que le membre a accepté.
8. **Binômes** : un nouveau membre (moins de 7 jours) est associé à un vétéran (membre depuis plus de 30 jours, score faible, objectif de même catégorie si possible, maximum 3 binômes actifs par vétéran). Les deux reçoivent une présentation (canal selon Phase 0). Le vétéran gagne un badge « Mentor » si son binôme est toujours là après 30 jours.
9. **Défis de sauvetage** : liste anonymisée de défis visibles des membres actifs (« Aide un membre qui a décroché : réponds à son dernier message ») ; un membre réengagé après intervention rapporte un badge au participant.
10. Chaque ouverture de l'espace membre crée un `activity_event` `stayput_open` (c'est notre donnée d'activité quand Whop n'en fournit pas).

**Arrête-toi** : parcours complet d'un membre fictif, de l'objectif à la carte témoignage.

### Phase 6 — Tableau de bord créateur (prouver)

1. **Onboarding en 3 minutes** : choix de la niche (applique les préréglages), mode auto ou manuel, activation des options, proposition de créer l'offre **Alumni** (refusable ou personnalisable, voir 5.9), puis **audit instantané** affiché dès la fin du backfill : « X membres à risque, Y $ de revenus mensuels menacés ».
2. **Écran d'accueil** : trois chiffres (argent sauvé ce mois, membres à risque, taux de rétention 30 jours) et **une seule action prioritaire du jour** (celle qui protège le plus de revenu).
3. **Liste des membres** : triée par risque, filtres par niveau, raisons en clair, historique du score (graphique), actions passées, bouton d'action rapide.
4. **Argent sauvé (attribution, à coder dans `/packages/core` avec tests)** :
   - **Direct** : paiement échoué puis `payment.succeeded` sur la même membership dans les 14 jours suivant une action StayPut → montant du paiement.
   - **Direct** : `cancel_at_period_end` repasse à `false` dans les 7 jours suivant une offre StayPut acceptée, **et** le renouvellement suivant est payé → montant du renouvellement.
   - **Direct** : membre en pause via StayPut qui reprend et paie → montant du premier paiement après reprise.
   - **Direct** : ancien membre qui revient avec un code promo StayPut → montant du premier paiement.
   - **Influencé** : membre à risque élevé qui a reçu un message, redevient actif dans les 14 jours et renouvelle → montant du renouvellement, affiché séparément.
   - Chaque sauvetage affiche sa preuve (événements Whop liés, action d'origine). Un même paiement ne compte qu'une fois.
5. **Prédiction de revenu à 90 jours** : pour chaque membre actif, probabilité de rester par mois selon son niveau de risque (valeurs de départ : faible 0,95 · moyen 0,80 · élevé 0,50), puis recalibrées avec l'historique réel du créateur dès 60 jours de données. Deux courbes : « sans action » et « si vous agissez » (taux de sauvetage observé du créateur, 30 % par défaut, appliqué aux membres à risque).
6. **Simulateur « et si »** : curseur « part des membres à risque contactés » → revenu projeté supplémentaire.
7. **Cohortes** et **leçons bloquantes** : tableaux et alertes issus de la Phase 3.
8. **Synthèse des raisons de départ** : regroupement des réponses au questionnaire de départ, par semaine.
9. **Rapport du lundi** : cron hebdomadaire (lundi 8 h, fuseau du créateur) ; notification à l'équipe du créateur (Send Notification vers l'équipe du compte) avec membres sauvés, perdus, argent sauvé, et la priorité de la semaine.
10. **Benchmarks anonymes** : uniquement pour les créateurs ayant accepté (opt-in) ; agrégats par niche (rétention 30 / 60 / 90 jours) affichés seulement si au moins 5 entreprises contribuent ; aucune donnée identifiable.
11. **Badge « Rétention vérifiée »** : si le créateur l'active, `/badge/:companyId.svg` affiche sa rétention réelle à 90 jours, avec lien de vérification.
12. **Paramètres** : poids du score, seuils, mode, modèles de messages, garde-fous, options, liste « ne jamais contacter », gestion de l'équipe, export des données, suppression des données.
13. **Alumni** : nombre d'anciens membres dans l'Alumni, taux de retour, argent récupéré (voir 5.9).

**Arrête-toi** : démonstration complète du tableau de bord sur le sandbox.

### Phase 7 — Facturation de StayPut

1. Plans : **Free** (0 $, jusqu'à 100 membres, détection + alertes + audit, pas d'actions automatiques), **Pro** (29 $/mois, 100 à 2 000 membres, tout le système), **Scale** (99 $/mois, plus de 2 000 membres, tout + multi-communautés, benchmarks avancés, marque blanche du badge et des cartes).
2. Implémente la facturation avec le mécanisme de monétisation d'app validé en Phase 0. Contrôle des limites : au-delà du plafond de membres, prévenir le créateur et proposer le plan supérieur, sans couper brutalement les fonctions en cours.
3. **Plan Performance** (0 $ fixe + 10 % des sauvetages **directs** du mois) : implémente-le derrière un feature flag désactivé. Calcul mensuel, relevé détaillé consultable par le créateur (chaque sauvetage avec sa preuve). L'encaissement réel ne sera activé qu'après validation de Whop.
4. Offre Founder : un code interne donne l'accès Pro gratuit à vie aux 20 premiers créateurs que je désignerai.

### Phase 8 — Conformité et robustesse

1. Page politique de confidentialité et CGU (brouillons que je ferai relire), accessibles depuis l'app.
2. Données minimales : pas de contenu des messages stocké (seulement type, auteur, date), pas d'image de preuve stockée sans accord explicite.
3. Droits : export des données d'un membre ou d'un créateur, suppression sur demande, suppression automatique des données d'un créateur 30 jours après désinstallation.
4. Rétention des données : `activity_events` détaillés conservés 12 mois, puis agrégés.
5. Journalisation des erreurs, page d'état interne, rejeu des webhooks en échec.
6. Tests e2e Playwright des parcours clés : installation, audit, action automatique, espace membre, attribution d'un sauvetage.

### Phase 9 — Mise en production et lancement

1. Checklist de passage sandbox → production (variables, secrets, URLs, webhooks, permissions).
2. Déploiement production.
3. Préparation de la fiche App Store : titre, sous-titre, description courte et longue en anglais (mots-clés : churn, retention, member risk, failed payments, win-back), liste des fonctionnalités, 5 captures d'écran à produire depuis l'app avec des données fictives, icône.
4. Documentation technique finale dans `/docs` : architecture, schéma de données, jobs, variables d'environnement, procédure de rotation des clés, procédure de rejeu des webhooks.

---

## 5. Précisions fonctionnelles transverses

5.1 **Onboarding** : voir Phase 6, point 1. Il doit être terminé en moins de 3 minutes et fonctionner sans aucun réglage manuel.

5.2 **Modes** : `auto` (les actions partent seules après garde-fous) et `manual` (le créateur valide chaque action depuis une file d'attente, un clic par action ou « tout valider »).

5.3 **Vue membre** : ne doit jamais donner l'impression d'une surveillance. Aucun score de risque visible par le membre. Vocabulaire orienté progression.

5.4 **Performances** : le tableau de bord créateur doit s'afficher en moins de 2 secondes pour 10 000 membres (pagination, agrégats précalculés).

5.5 **Canaux de communication** : utilise les canaux confirmés en Phase 0, par ordre de préférence : notification Whop ciblée, message dans un canal de la communauté (pour les annonces publiques uniquement), autre canal validé. Une notification Whop n'atteint que les utilisateurs qui ont accès à l'expérience visée, et cette expérience doit appartenir à StayPut (vérifié en Phase 0) : un ancien membre n'est donc plus joignable par ce canal. Pour les anciens membres, le canal est l'**offre Alumni** (5.9) : une fois entrés, ils ont accès à l'expérience Alumni de StayPut et reçoivent ses notifications ciblées. Pas d'e-mail envoyé par StayPut.

5.6 **Affiliation** : si l'API permet de récupérer ou créer le lien d'affiliation d'un membre, utilise-le dans les cartes témoignage et l'invitation « départ vers affiliation » ; sinon, laisse le membre coller son lien et signale-le-moi.

5.7 **Accessibilité** : contrastes suffisants, navigation clavier, textes alternatifs.

5.8 **Garde-fous** : voir Phase 4. Toute nouvelle action ajoutée plus tard doit obligatoirement passer par ce moteur.

5.9 **Offre Alumni (décision du 30/09/2026)** : la reconquête des anciens membres passe par une offre gratuite dans la communauté du créateur.

- **Création** : pendant l'onboarding, StayPut propose de créer automatiquement une offre gratuite nommée « Alumni » (produit + variant gratuit, `initial_price` 0, caché de la boutique) qui donne accès à une seule expérience : un espace StayPut d'actualités et d'offres de retour. Le créateur peut refuser ou la personnaliser (nom, texte, visuel). Endpoints : Create Product, Create Variant, Create Experience (`app_id` de StayPut) puis Attach Experience (voir `docs/whop-api-verification.md`).
- **Invitation automatique** : au webhook `membership.deactivated`, StayPut invite l'ancien membre dans l'Alumni avec « Invite to a Membership » ; Whop envoie l'e-mail d'invitation. L'endpoint est expérimental (réservé aux comptes activés par Whop) : à vérifier dans le sandbox. Repli : le lien d'accès à l'Alumni (lien direct du variant) est affiché dans le questionnaire de départ et sur la page de confirmation.
- **Séquence de reconquête** : une fois dans l'Alumni, notifications Whop ciblées à J+7, J+30 et J+60 après le départ, avec les nouveautés de la communauté et un code promo de retour : code unique, usage unique, valable 7 jours, limité au produit du créateur, non réservé aux nouveaux clients.
- **Garde-fous** : une seule invitation par ancien membre ; les messages respectent les heures silencieuses et la liste « ne jamais contacter » ; un ancien membre qui quitte l'Alumni n'est plus jamais relancé.
- **Attribution** : un ancien membre qui revient avec le code promo compte comme sauvetage direct (montant du premier paiement).
- **Tableau de bord** : nombre d'anciens membres dans l'Alumni, taux de retour, argent récupéré.

---

## 6. Ce que j'attends de toi à chaque arrêt de phase

- Ce qui est fait (liste courte).
- Ce qui est testé et comment (commandes à lancer).
- Ce qui est incertain ou non conforme au cahier des charges, et pourquoi.
- Ce que je dois faire ou te fournir avant la phase suivante (précis : où cliquer, quoi copier, dans quel fichier le mettre).

Commence par la Phase 0.
