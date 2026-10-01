# Vérification de l'API Whop — Phase 0

Rapport du 30 septembre 2026, avant toute ligne de code (`SPEC.md`, Phase 0). Deuxième version :
la première avait été écrite sans accès à la documentation ; celle-ci la confronte à la
documentation officielle.

## 0. Sources et statuts

1. **La documentation officielle** (`docs.whop.com`), lue le 30/09/2026, y compris la
   spécification OpenAPI incluse dans chaque page de la référence : elle donne la méthode, le
   chemin et les **permissions exigées** (`security`) de chaque point d'accès. Version d'API de
   la documentation : `2026-09-29`.
2. **Le SDK officiel `@whop/sdk` 2.0.0** (npm, 24/09/2026) : 391 opérations, le catalogue des
   272 permissions (`PermissionAction`) et la liste des événements de webhook.
3. **Le SDK Python officiel `whop-sdk` 2.0.0** (PyPI), pour le seul détail que le SDK
   TypeScript ne contient plus : la vérification du jeton de l'iframe.

**Essai dans le sandbox le 30/09/2026** : produit et variant gratuits créés, invitation refusée
(sections 8 et 11).

**Statuts.** `OK` : confirmé par la documentation (ou par la spécification OpenAPI). `INCERTAIN`
: la documentation ne tranche pas, ou il faut l'essayer en sandbox. `NON TROUVÉ` : n'existe ni
dans la documentation ni dans le SDK.

## 1. Écarts avec `SPEC.md`, et décisions prises

| Sujet                                       | `SPEC.md` (version initiale)                        | Réalité vérifiée                                                                                                                                                                   | Suite                                                                                                                                             |
| ------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK                                         | `new Whop({ appID, apiKey, webhookKey })`           | Ancien SDK (≤ 0.0.42). La 2.0.0 : `new WhopClient({ token, apiVersionDate, environment })`, et la vérification des webhooks est une fonction à part, `unwrapWebhook`               | On suit la 2.0.0.                                                                                                                                 |
| Vocabulaire                                 | « company », « plan »                               | L'API courante dit **account** (identifiants toujours `biz_…`) et, dans la documentation du 29/09, **variant** au lieu de plan (`/variants` ; le SDK 2.0.0 expose encore `/plans`) | Le client `packages/whop` isole ces noms ; `/variants` fonctionne en sandbox (section 11) : StayPut l'utilise.                                    |
| Installation / désinstallation              | Événement « s'il existe »                           | **Aucun événement**                                                                                                                                                                | Installation détectée à la première ouverture de la vue créateur ; désinstallation déduite des refus de l'API (section 5).                        |
| Code promo « pour ce membre »               | Lié au membre                                       | Un code ne se lie pas à un membre                                                                                                                                                  | **Décision du 30/09** : code unique, usage unique, valable 7 jours, limité au produit du créateur (`SPEC.md`, Phase 4).                           |
| Relance des paiements échoués               | StayPut relance à 24 h puis 72 h                    | Whop relance déjà : `next_payment_attempt_at`, `retryable`                                                                                                                         | **Décision du 30/09** : relance seulement si Whop n'a rien prévu (`SPEC.md`, Phase 4).                                                            |
| Reconquête par notification                 | Notification Whop                                   | **Impossible** : une notification n'atteint que les utilisateurs qui ont accès à l'expérience visée, et l'expérience doit appartenir à l'app                                       | **Décision du 30/09 : offre Alumni** (`SPEC.md`, 5.9) ; vérification en section 8.                                                                |
| Entrée dans l'Alumni                        | Invitation automatique (« Invite to a Membership ») | **`403` en sandbox** : point d'accès expérimental, ouvert compte par compte selon la documentation (le compte du créateur qui invite)                                              | Repli déjà prévu par la décision du 30/09 : **lien d'accès**, porté à chaque départ par le message automatique « User left » de Whop (section 8). |
| Permissions des actions sur les memberships | —                                                   | Pause, reprise, jours offerts exigent **`member:manage`** (ma première version supposait `membership:update`)                                                                      | Corrigé en section 6.                                                                                                                             |

## 2. Appeler l'API au nom d'une entreprise qui a installé l'app

| Point                 | Réponse                                                                                                                                                                                                                                                                                      | Statut |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Identifiant           | **Clé API d'app** en `Authorization: Bearer <clé>` : elle « authentifie l'app sur chaque compte qui l'a installée ». Gardée côté serveur.                                                                                                                                                    | OK     |
| Désigner l'entreprise | Paramètre `account_id` (`biz_…`) dans les requêtes (listes de membres, memberships, paiements, codes promo, produits…).                                                                                                                                                                      | OK     |
| Version               | En-tête `Api-Version-Date` (documentation : `2026-09-29`, SDK par défaut : `2026-09-23`). Sans en-tête, l'API répond avec les formes de 2025-01-01. On épingle une date, et la même sur les webhooks (`api_version_date`).                                                                   | OK     |
| Base URL              | Production `https://api.whop.com/api/v1`, sandbox `https://sandbox-api.whop.com/api/v1` (comptes et clés sur `sandbox.whop.com`). Dans le SDK 2.0 : option `environment`, pas `baseUrl`.                                                                                                     | OK     |
| Permissions           | Déclarées dans l'onglet Permissions de l'app (100 au plus), chacune justifiée et **requise** ou **facultative** ; approuvées par le créateur à l'installation. Une permission ajoutée plus tard doit être réapprouvée par chaque créateur, et les appels qui en dépendent échouent d'ici là. | OK     |
| Limites de débit      | 600 requêtes/minute par opération et par clé ; au-delà, `429` avec le délai d'attente dans le message. Le SDK retente 2 fois (429, 5xx, 408, 409).                                                                                                                                           | OK     |
| Idempotence           | En-tête `Idempotency-Key` sur les créations (codes promo, invitations, jours offerts…).                                                                                                                                                                                                      | OK     |

**Surfaces (page API Stability).** _Current_ : Accounts, Members, Memberships, Payments, Promo
codes, Notifications, Webhooks, Users, Permissions, People, Stats, Products, Access tokens,
Apps. _Legacy uniquement_ (toujours supportées) : Affiliates, Chat channels, Courses, Course
chapters, Course lessons, Course lesson interactions, Course students, DM channels, DM members,
Experiences, Forums, Forum posts, Invoices, Leads, Messages, Reactions, Support channels. Même
base URL ; `SPEC.md` demande d'épingler `Api-Version-Date` sur la surface Current, on l'envoie
partout (sans effet connu sur la surface Legacy).

## 3. Authentifier l'utilisateur qui ouvre une vue, et vérifier son rôle

| Point                   | Réponse                                                                                                                                                                                                                                                               | Statut                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Jeton transmis par Whop | En-tête **`x-whop-user-token`** : JWT **ES256**, émetteur `urn:whopcom:exp-proxy`, `sub` = l'utilisateur (`user_…`), `aud` = l'id de l'app. Clés publiques : `https://api.whop.com/.well-known/jwks.json` (mise en cache ; nouvelle lecture si une clé est inconnue). | OK                                          |
| Vérification            | Le SDK TypeScript 2.0.0 n'a plus de fonction pour cela (la documentation le signale). On vérifie avec `jose` (`createRemoteJWKSet`, émetteur, audience), comme le fait le SDK Python officiel.                                                                        | OK                                          |
| Même origine            | Le jeton n'est envoyé qu'aux requêtes vers **la même origine que l'iframe** (`App.base_url`). Si l'API est sur un autre domaine, il faut la faire passer par le domaine de l'app (règle d'origine Cloudflare).                                                        | OK — contrainte d'architecture (section 12) |
| Vue créateur            | `GET /users/{id}/access/{biz_…}` → `access_level` ; on exige `admin` (tout membre de l'équipe, modérateurs compris).                                                                                                                                                  | OK                                          |
| Vue membre              | Même appel avec l'expérience `exp_…` : `customer` (membership valide) ou `admin`.                                                                                                                                                                                     | OK                                          |
| Hors de Whop            | OAuth 2.1 + PKCE (« Sign in with Whop ») si besoin plus tard.                                                                                                                                                                                                         | OK                                          |

## 4. Les « app views »

| Vue                                                                      | Champ de l'app    | Chemin recommandé                       | Statut |
| ------------------------------------------------------------------------ | ----------------- | --------------------------------------- | ------ |
| **Vue expérience** (vue membre, dans la barre latérale de la communauté) | `experience_path` | `/experiences/[experienceId]` (`exp_…`) | OK     |
| **Vue tableau de bord** (vue créateur, section Apps du tableau de bord)  | `dashboard_path`  | `/dashboard/[companyId]` (`biz_…`)      | OK     |
| Vue découverte (page publique de l'app)                                  | `discover_path`   | à définir                               | OK     |

`[restPath]` s'ajoute pour les liens profonds (`/dashboard/[companyId]/[restPath]`) : c'est ce
que remplit `rest_path` dans une notification. Les chemins se déclarent dans la section
**Hosting** de l'app, avec l'URL de base (`base_url`).

## 5. Webhooks

Un webhook d'**app** (`resource_id` = `app_…`) reçoit les événements de toutes les entreprises
qui ont installé l'app ; chaque famille exige sa permission `webhook_receive:*`. Standard
Webhooks : HMAC-SHA256 de `webhook-id.webhook-timestamp.corps brut`, clé = le secret `ws_…` tel
quel, signature en base64 dans `webhook-signature` (`v1,…`), horodatage refusé au-delà de
5 minutes. **Répondre en moins de 5 secondes**, sinon Whop retente : on vérifie, on enregistre,
on répond 200, on traite ensuite. Whop désactive un webhook après 3 jours d'échecs continus ;
on peut rejouer une livraison ou une période en gardant le `webhook-id` d'origine.

| Besoin                          | Événement                                                                                                                 | Permission                    | Statut                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| Paiement échoué                 | `payment.failed` (`decline_code`, `failure_message`, parfois `recovery_url`)                                              | `webhook_receive:payments`    | OK                                                         |
| Paiement réussi                 | `payment.succeeded`                                                                                                       | `webhook_receive:payments`    | OK                                                         |
| 3D Secure demandé               | `payment.requires_action` : `data.recovery_url`, lien Whop où le membre valide ; envoyé seulement tant que ce lien existe | `webhook_receive:payments`    | OK                                                         |
| Membership activée / désactivée | `membership.activated`, `membership.deactivated`                                                                          | `webhook_receive:memberships` | OK                                                         |
| Annulation programmée modifiée  | `membership.cancel_at_period_end_changed`                                                                                 | `webhook_receive:memberships` | OK                                                         |
| Fin d'essai proche              | `membership.trial_ending_soon`                                                                                            | `webhook_receive:memberships` | OK                                                         |
| Membre créé / modifié           | `member.created`, `member.updated`                                                                                        | `webhook_receive:members`     | OK                                                         |
| Leçon terminée                  | `course_lesson_interaction.completed`                                                                                     | `webhook_receive:courses`     | OK                                                         |
| Installation / désinstallation  | aucun                                                                                                                     | —                             | NON TROUVÉ                                                 |
| Activité du chat (en plus)      | `chat.message.created`, `chat.reaction.created`                                                                           | `webhook_receive:chat`        | OK (livraison aux webhooks d'app : à confirmer en sandbox) |

**Désinstallation (proposition).** Quand un créateur retire l'app ou ses permissions, les
appels pour son compte devraient échouer (401/403) et `GET /permissions` ne plus rien montrer
d'accordé (comportement à confirmer en sandbox) : le cron marque alors l'entreprise
« désinstallée » et lance le compte à rebours de suppression de 30 jours (Phase 8).

## 6. Actions (permissions confirmées par la spécification OpenAPI)

| Besoin                            | Point d'accès                          | Paramètres utiles                                                                                                                                                                                                   | Permission exigée                          | Statut                                                         |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Pause                             | `POST /memberships/{id}/pause`         | `until` (reprise automatique ; memberships facturées par Whop seulement)                                                                                                                                            | `member:manage`                            | OK                                                             |
| Reprise                           | `POST /memberships/{id}/resume`        | —                                                                                                                                                                                                                   | `member:manage`                            | OK                                                             |
| Jours offerts                     | `POST /memberships/{id}/extend`        | `days` (1 à 1095)                                                                                                                                                                                                   | `member:manage`                            | OK                                                             |
| Annuler une annulation programmée | `PATCH /memberships/{id}`              | `cancel_at_period_end: false`                                                                                                                                                                                       | `member:manage` (ou `membership:cancel`)   | OK                                                             |
| Annulation (inutile à StayPut)    | `POST /memberships/{id}/cancel`        | —                                                                                                                                                                                                                   | `membership:cancel` ou `member:manage`     | OK                                                             |
| Relance de paiement               | `POST /payments/{id}/retry`            | le paiement doit être `retryable`                                                                                                                                                                                   | `payment:manage`                           | OK                                                             |
| Code promo                        | `POST /promo_codes`                    | `account_id`, `code`, `amount_off`, `base_currency`, `promo_type` (`percentage` ou `flat_amount`), `promo_duration_months`, `new_users_only`, `one_per_customer`, `stock`, `expires_at`, `product_id` ou `plan_ids` | `promo_code:create`                        | OK                                                             |
| Notification                      | `POST /notifications`                  | `experience_id` (expérience **de l'app**) ou `account_id` (équipe), `title`, `content`, `user_ids` (doivent avoir accès), `rest_path`                                                                               | **clé d'app** + `notification:create`      | OK                                                             |
| Message public dans un salon      | `POST /messages`                       | `channel_id`, `content` (Markdown)                                                                                                                                                                                  | `chat:message:create`                      | OK                                                             |
| Message privé                     | `POST /dm_channels` + `POST /messages` | —                                                                                                                                                                                                                   | `dms:channel:manage`, `dms:message:manage` | INCERTAIN (auteur du message avec une clé d'app) ; non utilisé |

**Relances de paiement.** Relance StayPut seulement si `retryable` est vrai et que
`next_payment_attempt_at` est vide, dans la limite de 2 par paiement. La notification au membre
part dans tous les cas.

## 7. Lectures

| Besoin                           | Point d'accès                                                                                                                                   | Remarques                                                                                                                                   | Permission                                  | Statut                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| Membres                          | `GET /members`                                                                                                                                  | `last_accessed_at`, `joined_at`, `status` (`joined`/`left`), `access_level`                                                                 | `member:basic:read`                         | OK                                                       |
| Memberships                      | `GET /memberships`                                                                                                                              | filtre `status` (`canceling`, `past_due`, `paused`…), `cancel_at_period_end`, `current_period_end`                                          | `member:basic:read`                         | OK                                                       |
| Paiements                        | `GET /payments`, `GET /payments/{id}`                                                                                                           | `failure_message`, `decline_code`, `retryable`, `next_payment_attempt_at`, `promo_code_id` ; `recovery_url` à la lecture unitaire seulement | `payment:basic:read`                        | OK                                                       |
| Produits, variants               | `GET /products`, `GET /variants`                                                                                                                | prix pour le revenu à risque                                                                                                                | `access_pass:basic:read`, `plan:basic:read` | OK                                                       |
| Messages                         | `GET /messages`                                                                                                                                 | `channel_id` obligatoire, curseur, pas de filtre par date                                                                                   | `chat:read`                                 | OK                                                       |
| Réactions                        | `GET /reactions`                                                                                                                                | par message ou post : préférer `chat.reaction.created`                                                                                      | `chat:read` ou `forum:read`                 | OK                                                       |
| Forums, posts                    | `GET /forums`, `GET /forum_posts`                                                                                                               | —                                                                                                                                           | `forum:read`                                | OK                                                       |
| Interactions de leçons           | `GET /course_lesson_interactions`                                                                                                               | filtres cours, leçon, utilisateur, `completed`                                                                                              | `courses:read` + `course_analytics:read`    | OK                                                       |
| Cours, chapitres, leçons, élèves | `GET /courses`, `/course_chapters`, `/course_lessons`, `/course_students`                                                                       | ordre des leçons (leçon bloquante)                                                                                                          | `courses:read` (+ `course_analytics:read`)  | OK                                                       |
| Tickets support                  | `GET /support_channels`                                                                                                                         | filtre `open`                                                                                                                               | `support_chat:read`                         | OK (dates d'ouverture/résolution à confirmer en sandbox) |
| Statistiques                     | `GET /stats`, `GET /stats/{metric}`                                                                                                             | catalogue des métriques par appel                                                                                                           | selon la métrique                           | INCERTAIN                                                |
| Équipe (rapport du lundi)        | `GET /team_members` ; la notification d'équipe passe par `account_id`                                                                           | —                                                                                                                                           | `company:authorized_user:read`              | OK                                                       |
| Discord lié                      | `GET /users/{id}`                                                                                                                               | profil public : Discord principal et compte X                                                                                               | —                                           | OK                                                       |
| Affiliés                         | `GET/POST /affiliates` ; le lien d'affiliation est donné par les « overrides » (`product_direct_link`, `checkout_direct_link`, `?a=<username>`) | —                                                                                                                                           | `affiliate:basic:read`, `affiliate:create`  | OK                                                       |
| Permissions accordées            | `GET /permissions`                                                                                                                              | ce que notre clé a reçu, pour une ressource                                                                                                 | —                                           | OK                                                       |

## 8. Offre Alumni (décision du 30/09/2026, `SPEC.md` 5.9)

Tout ce qu'il faut existe dans l'API. Essai sandbox du 30/09/2026 : l'invitation automatique
répond `403` ; StayPut passe donc par le **lien de repli** (`purchase_url` du variant gratuit).

**Le problème.** StayPut ne peut montrer le lien qu'à un membre qui a encore accès à son
expérience : questionnaire de départ (annulation programmée) et page de confirmation. Un membre
qui part autrement (paiement échoué jusqu'au bout, remboursement, retrait par le créateur)
échappe à ces deux écrans. L'invitation aurait réglé ce cas, mais la documentation la réserve aux
« accounts enabled for membership invitations » : elle s'ouvre compte par compte (le compte du
créateur, qui invite), et rien n'indique qu'une app puisse l'obtenir pour tous ses créateurs.

**La solution (sans rien demander à Whop).** Whop envoie déjà, s'il est activé, un **message
automatique « User left »** à chaque membre qui quitte la communauté : un DM sur Whop et, case
cochée, un e-mail, signés par le membre de l'équipe choisi (guide « Support Chats », tableau de
bord → Support chats). Le créateur y met le lien Alumni une fois pour toutes ; l'onboarding de
StayPut lui donne le texte et le chemin. Aucune API ne permet de l'activer à sa place : c'est une
action d'une minute pendant l'onboarding, que StayPut ne peut pas vérifier (le créateur la coche).
Si le créateur a déjà un **produit gratuit**, l'expérience Alumni lui est aussi rattachée : un
ancien membre resté dans ce produit n'a pas « quitté la communauté », il reçoit directement les
notifications.

| Étape                                          | Point d'accès                                                                               | Détail                                                                                                                                                                                          | Permission                    | Statut                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Créer le produit « Alumni »                    | `POST /products`                                                                            | `account_id`, `title`, `description`, `visibility`                                                                                                                                              | `access_pass:create`          | OK                                                                                                                                                                                                      |
| Créer le variant gratuit                       | `POST /variants` (`/plans` dans le SDK 2.0.0)                                               | `product_id`, `initial_price: 0` (« use 0 for free »), `plan_type: one_time`, `visibility: hidden` : accessible seulement par son lien direct (`purchase_url`), qui sert aussi de lien de repli | `plan:create`                 | OK : `POST /variants` → 200 en sandbox (identifiant `plan_…`, `purchase_url` renvoyé) ; `DELETE /variants/{id}` → 200                                                                                   |
| Créer l'expérience StayPut « Alumni »          | `POST /experiences`                                                                         | `account_id`, `app_id` (StayPut), `name`                                                                                                                                                        | `experience:create`           | OK                                                                                                                                                                                                      |
| La rattacher au produit                        | `POST /experiences/{id}/attach`                                                             | `product_id`                                                                                                                                                                                    | `experience:attach`           | OK                                                                                                                                                                                                      |
| Inviter l'ancien membre                        | `POST /memberships/invite`                                                                  | `plan_id` (variant gratuit) + `user_id` **ou** `email` ; réponse `202 { invitation_sent: true }` ; Whop envoie l'e-mail, et l'acceptation donne la membership sans paiement                     | `membership:create`           | **403 en sandbox** (30/09/2026) : « This endpoint is not available for your account. » Le compte n'est pas activé pour ce point d'accès expérimental. Non utilisé en V1 ; à redemander à Whop plus tard |
| Repli                                          | lien direct du variant (`purchase_url`)                                                     | affiché dans le questionnaire de départ et sur la page de confirmation                                                                                                                          | —                             | **Retenu** : `https://sandbox.whop.com/checkout/plan_…` obtenu en sandbox                                                                                                                               |
| Lien envoyé à chaque départ                    | message automatique « User left » (tableau de bord du créateur → Support chats ; pas d'API) | DM + e-mail envoyés par Whop, texte du créateur avec le lien Alumni, variables `recipient_name` et `whop_name`                                                                                  | — (réglage du créateur)       | OK (guide « Support Chats ») ; départs involontaires (paiement échoué, remboursement) à vérifier en sandbox                                                                                             |
| Anciens membres restés dans un produit gratuit | `POST /experiences/{id}/attach` sur ce produit                                              | ils gardent l'accès à l'expérience Alumni, donc aux notifications                                                                                                                               | `experience:attach`           | OK                                                                                                                                                                                                      |
| Séquence J+7, J+30, J+60                       | `POST /notifications`                                                                       | `experience_id` = l'expérience Alumni (elle appartient à StayPut), `user_ids` = l'ancien membre (il y a accès), `rest_path` vers l'offre                                                        | `notification:create`         | OK                                                                                                                                                                                                      |
| Code promo de retour                           | `POST /promo_codes`                                                                         | code aléatoire, `stock: 1`, `one_per_customer: true`, `expires_at` = +7 jours, `product_id` = le produit quitté, `new_users_only: false`                                                        | `promo_code:create`           | OK                                                                                                                                                                                                      |
| Départ de l'Alumni                             | `membership.deactivated` sur la membership Alumni                                           | l'ancien membre n'est plus jamais relancé                                                                                                                                                       | `webhook_receive:memberships` | OK                                                                                                                                                                                                      |
| Retour                                         | `payment.succeeded` avec `promo_code_id` = le code envoyé                                   | sauvetage direct, montant du premier paiement                                                                                                                                                   | `webhook_receive:payments`    | OK                                                                                                                                                                                                      |

## 9. Monétisation de StayPut

| Question                                        | Réponse                                                                                                                                                                                                                                        | Statut                                                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Abonnement mensuel                              | Selon la présentation des apps, Whop gère la facturation. L'app a une fiche produit (`App.product_id`) et Whop émet des événements `app_membership.*` et `app_payment.*`. Pas de guide de tarification des apps trouvé dans la documentation.  | INCERTAIN — on regardera les réglages de tarification de l'app dans le tableau de bord développeur en la créant (Phase 1) |
| Prix par membre                                 | Aucun mécanisme natif : paliers Free / Pro / Scale et contrôle du nombre de membres par StayPut.                                                                                                                                               | NON TROUVÉ                                                                                                                |
| Montant variable chaque mois (plan Performance) | Techniquement : facture à prélèvement automatique sur un moyen de paiement enregistré (`POST /invoices`, `payment_method_id`), ou `POST /payments` avec `member_id` + `payment_method_id`. Rien ne dit que c'est permis pour facturer une app. | INCERTAIN — à demander au support Whop en Phase 7, pas avant (le plan reste derrière un feature flag, `SPEC.md` Phase 7)  |

## 10. Permissions à déclarer

**Requises**

- `company:basic:read` : nom et réglages du compte.
- `member:basic:read` : membres et memberships.
- `payment:basic:read` : paiements.
- `access_pass:basic:read`, `plan:basic:read` : produits et prix.
- `member:manage` : pause, reprise, jours offerts, annulation de l'annulation programmée.
- `payment:manage` : relance de paiement.
- `promo_code:create`, `promo_code:basic:read` : codes de rattrapage et de retour.
- `notification:create` : notifications aux membres et à l'équipe.
- `webhook_receive:memberships`, `webhook_receive:payments`, `webhook_receive:members`.

**Facultatives** (la fonction se désactive si le créateur refuse)

- Offre Alumni : `access_pass:create`, `plan:create`, `experience:create`,
  `experience:attach`. (`membership:create` ne servirait qu'à l'invitation, refusée en sandbox :
  on ne la demande pas en V1.)
- Activité et tickets : `chat:read`, `forum:read`, `support_chat:read`, `webhook_receive:chat`.
- Progression : `courses:read`, `course_analytics:read`, `webhook_receive:courses`.
- Annonces publiques : `chat:message:create`.
- Rapport du lundi à l'équipe : `company:authorized_user:read`.
- Affiliation : `affiliate:basic:read`, `affiliate:create`.

## 11. Ce qui reste à vérifier, et ce qu'il faut pour le faire

**Fait le 30/09/2026** avec `NODE_USE_ENV_PROXY=1 node scripts/sandbox/check-invite.mjs <e-mail> --cleanup`
et une clé API de compte sandbox (`WHOP_SANDBOX_API_KEY`) :

| Appel                                            | Réponse                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `GET /accounts/me`                               | 200                                                                         |
| `POST /products` (produit caché)                 | 200                                                                         |
| `POST /variants` (variant gratuit caché)         | 200 : `plan_…`, `purchase_url` = `https://sandbox.whop.com/checkout/plan_…` |
| `POST /memberships/invite`                       | **403** `forbidden` : « This endpoint is not available for your account. »  |
| `DELETE /variants/{id}`, `DELETE /products/{id}` | 200 (nettoyage)                                                             |

Conclusions :

- **`/variants`** fonctionne : StayPut l'utilise (pas `/plans`).
- **Invitation** : refusée pour ce compte (point d'accès réservé aux comptes activés par Whop).
  L'offre Alumni passe par le **lien de repli** (`purchase_url` du variant gratuit), avec la
  solution décrite en section 8 (message automatique « User left » de Whop). Si Whop ouvre un
  jour l'invitation aux apps, on la branchera en plus, sans changer le reste.

Reste à vérifier en sandbox (non bloquant pour la Phase 1) : les dates des tickets support, la
livraison des événements de chat aux webhooks d'app (Phase 2), et le déclenchement du message
« User left » après un départ involontaire (Phase 4).

**Limite du sandbox** (guide « Test in the Sandbox », section « Known limitations », relu le
30/09/2026) : Whop déconseille les **apps et la messagerie** dans le sandbox. L'API des apps y
répond pourtant (`POST /apps`, `PATCH /apps/{id}`, `POST /webhooks` → 200 le 30/09/2026).

**Constaté le 30/09/2026** : l'app s'installe dans « StayPut Test » et apparaît dans la barre du
tableau de bord, mais son iframe affiche la page de Whop « App Base URL not set », alors que
`GET /apps/app_rjFkp2xKgjfPxY` renvoie bien `base_url` = `https://stayput.chezbenz18.workers.dev`.
L'iframe passe par le relais `https://dm4jquomz8hrsmrk6gb9.apps.whop.com` (domaine de production)
et la requête n'atteint jamais le Worker. Même symptôme dans un signalement public
([whopio/whop-public-cli#2](https://github.com/whopio/whop-public-cli/issues/2)). Conclusion :
**les vues de l'app ne s'affichent pas dans le sandbox** ; l'API, elle, y fonctionne (clé de l'app
acceptée, webhooks créés). Reste à voir si les notifications partent (Phases 3 et 4).

**OAuth dans le sandbox** (vérifié le 01/10/2026) : `https://sandbox-api.whop.com/oauth/authorize`
connaît l'app du sandbox (sans adresse de retour déclarée : `redirect_uri is invalid` ; ensuite :
302 vers `https://sandbox.whop.com/oauth/authorize`), `/oauth/token` répond `invalid_grant` à un
faux code, `/oauth/userinfo` demande un jeton. La production répond `client_id is invalid` pour
cette app. Attention : le `.well-known/openid-configuration` du sandbox annonce les adresses de
production ; StayPut utilise donc `sandbox-api.whop.com/oauth` en dur pour le sandbox. C'est la
solution retenue pour tester l'interface dans le sandbox (`DECISIONS.md`, 01/10/2026).

## 12. À trancher au début de la Phase 1

- **Même origine** : le jeton de l'iframe n'est envoyé qu'à l'origine de l'app. Le Worker (API)
  doit donc répondre sous le même domaine que le frontend : Pages et Worker derrière un même
  domaine, ou routage `/api/*` du domaine Pages vers le Worker.
- **Limites de Cloudflare Workers (offre gratuite)** : peu de temps CPU par requête et par cron.
  Le score de milliers de membres se calcule en SQL ou par lots, pas en boucle dans le Worker.
- **Connexion Worker → Postgres** : sockets TCP (`postgres.js` avec `nodejs_compat`) ou
  Hyperdrive, dont la gratuité est à vérifier.
- **Reprise de l'existant** : le StayPut précédent (Next.js, dossier `stayput/` du dépôt SAHA)
  fournit le modèle RLS, les tests SQL sur PGlite, l'installation SQL recollable, la
  vérification des webhooks et du jeton de l'iframe. On reprend ces morceaux, pas l'app.
- **Langue** : code, commentaires et commits en anglais, interface en anglais avec le français
  en seconde langue, comme le demande `SPEC.md`.

## 13. Constats de la Phase 2 (sandbox, 01/10/2026)

Lus avec la clé de compte du sandbox (`Api-Version-Date: 2026-09-29`), sans rien afficher de
personnel :

- **Formes réelles** : une adhésion porte `user_id`, `plan_id`, `product_id`, `member`,
  `current_period_end`, `billing_period_days`, `canceled_at` ; un paiement `member_id`,
  `membership_id`, `plan_id`, `total` (objet Money, montant en texte décimal),
  `next_payment_attempt_at` ; un membre `last_accessed_at` (et non `most_recent_action_at`, que
  StayPut lit aussi). Les fonctions SQL lisent les deux formes (SDK 2.0.0 et version du 29/09).
- **Membre sans utilisateur** : le compte technique créé à l'installation de l'app est un membre
  `admin` dont `user` vaut `null` : StayPut l'ignore.
- **Tri des listes** : `order` + `direction` existent pour les membres (`created_at`,
  `joined_at`, `last_accessed_at`, `usd_total_spent`), les adhésions (`created_at`) et les
  paiements (`created_at`, `paid_at`) ; `direction` seul pour les messages et les tickets
  (`order`: `created_at` ou `last_post_sent_at`). Rien pour les posts de forum et les
  interactions de leçons. Un ticket n'a pas de date de création (`last_message_at`,
  `resolved_at` seulement).
- **Webhooks** : `PATCH /webhooks/{id}` change la liste d'événements (fait : ajout de
  `chat.message.created` et `chat.reaction.created`) ; `GET /webhooks/{id}/deliveries` liste les
  livraisons avec leur code de réponse, et `POST /webhooks/{id}/test` en envoie une d'essai :
  de quoi vérifier depuis l'API que le Worker reçoit bien.
- **Permissions** : une permission ajoutée à l'app n'est accordée à une entreprise déjà
  installée qu'après sa ré-approbation (Whop : « Settings → Authorized apps », ou le lien
  d'installation de l'app) ; avant, l'API répond 403 « App API key is not authorized for the …
  scope ». `GET /permissions?resource_id=biz_…&actions=…` dit, pour la clé qui appelle, quelles
  actions sont accordées (`granted`) : 0 sur 19 avant l'approbation du fondateur, 19 sur 19
  après (01/10/2026). Sans permission, `GET /memberships` répond 200 avec une liste vide au lieu
  de 403.
- **Contenu du sandbox « StayPut Test »** au 01/10/2026 : 2 membres (le fondateur, admin, et le
  compte technique de l'app), 1 adhésion (accès gratuit à l'app), 1 paiement de 0 $, 1 variante,
  1 forum vide, aucun salon de discussion, cours ni ticket.

## Sources

Documentation Whop, lue le 30/09/2026 :
[API Stability](https://docs.whop.com/api-reference/stability),
[Authentication](https://docs.whop.com/developer/guides/authentication),
[Auth & API keys](https://docs.whop.com/developer/guides/auth-scoping),
[App Views](https://docs.whop.com/developer/guides/app-views),
[Permissions](https://docs.whop.com/developer/guides/permissions),
[Push Notifications](https://docs.whop.com/developer/guides/notifications),
[Webhooks](https://docs.whop.com/developer/guides/webhooks),
[Affiliates](https://docs.whop.com/developer/guides/affiliates),
[Direct Messages](https://docs.whop.com/developer/guides/chat/direct-messages),
[Test in the Sandbox](https://docs.whop.com/developer/guides/sandbox),
[Troubleshooting](https://docs.whop.com/developer/troubleshooting),
[Whop Apps](https://docs.whop.com/developer/apps/overview),
[Support Chats](https://docs.whop.com/manage-your-business/growth-marketing/automated-messaging) ; pages de référence :
[Pause Membership](https://docs.whop.com/api-reference/beta/memberships/pause-membership),
[Invite to a Membership](https://docs.whop.com/api-reference/beta/memberships/invite-to-a-membership),
[Retry Payment](https://docs.whop.com/api-reference/beta/payments/retry-payment),
[Create Promo Code](https://docs.whop.com/api-reference/beta/promo-codes/create-promo-code),
[Send Notification](https://docs.whop.com/api-reference/beta/notifications/send-notification),
[Create Product](https://docs.whop.com/api-reference/beta/products/create-product),
[Create Variant](https://docs.whop.com/api-reference/beta/variants/create-variant),
[Create Experience](https://docs.whop.com/api-reference/experiences/create-experience),
[Attach Experience](https://docs.whop.com/api-reference/experiences/attach-experience),
[Check User Access](https://docs.whop.com/api-reference/beta/users/check-user-access).

SDK : `@whop/sdk` 2.0.0 (npm) ; `whop-sdk` 2.0.0 (PyPI), fichier
`whop_sdk/lib/verify_user_token.py`.
