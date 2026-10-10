import type { PlanView } from '@stayput/core';

/** The session's plan while plans are off (no products configured): everything open; the tests' app. */
export const OPEN_PLAN_VIEW: PlanView = {
  tier: 'scale',
  source: 'off',
  trialEndsAt: null,
  founder: null,
  manualActions: null,
  checkout: { pro: null, scale: null },
  whopAppId: 'app_stayput',
  stale: false,
};
