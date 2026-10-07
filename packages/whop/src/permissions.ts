/**
 * The permissions StayPut's app asks for (docs/whop-api-verification.md, section 10), as Whop
 * names them: the app's settings list them (whop.com → Developer → the app → Permissions), each
 * community grants them at install, and the deployment checks that the app asks for exactly
 * these (scripts/deploy/check-app.ts).
 */

/** The read permissions of Phase 2, and the webhooks. */
export const PHASE_2_PERMISSIONS = [
  'company:basic:read',
  'member:basic:read',
  'access_pass:basic:read',
  'plan:basic:read',
  'payment:basic:read',
  'promo_code:basic:read',
  'shipment:basic:read',
  'chat:read',
  'forum:read',
  'support_chat:read',
  'courses:read',
  'course_analytics:read',
  'webhook_receive:memberships',
  'webhook_receive:payments',
  'webhook_receive:members',
  'webhook_receive:chat',
  'webhook_receive:courses',
] as const;

/** What the actions of Phase 4 write: pause, free days, consent, retries, codes. */
export const PHASE_4_PERMISSIONS = [
  'member:manage',
  'payment:manage',
  'promo_code:create',
  'notification:create',
] as const;

/** The Alumni offer (SPEC 5.9), for the creators who turn it on. */
export const ALUMNI_PERMISSIONS = [
  'access_pass:create',
  'plan:create',
  'experience:create',
  'experience:attach',
] as const;

/**
 * Asked of the sandbox app since Phase 2 and never read (SPEC 8.2): StayPut keeps no e-mail and
 * no phone number. The production app leaves them out (Phase 9, the production checklist).
 */
export const UNNEEDED_PERMISSIONS = ['member:email:read', 'member:phone:read'] as const;
