import { allows, requiredTier, type Feature, type PlanView, type Tier } from '@stayput/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { UPGRADE_EVENT, type UpgradeAsk } from './api';

/**
 * The community's plan on the page (decision of 2026-10-10). The Worker decides what each plan
 * opens and refuses the rest (HTTP 402); the page only shows it: the level's badge, a lock where
 * the Worker would refuse, the plan that opens it (`ask`), Free's count of manual actions.
 */
export interface PlanContextValue {
  plan: PlanView;
  /** Plans are set up: off (no products configured), nothing about them shows. */
  on: boolean;
  allows: (feature: Feature) => boolean;
  /** The lowest level that opens `feature`, or null when this one does. */
  lockedTo: (feature: Feature) => Tier | null;
  checkoutFor: (tier: Tier) => string | null;
  /** Free's count after an action the Worker counted. */
  countAction: (made?: number) => void;
  /** Offers the plan that opens what was asked (the dialog, plans/Upgrade.tsx). */
  ask: (tier: Tier) => void;
  asked: UpgradeAsk | null;
  dismiss: () => void;
  /** Where Settings › Plan is. */
  planPage: string;
}

/** Plans off: everything open, nothing shown (outside a dashboard, in the screens' tests). */
export const OPEN_PLAN: PlanView = {
  tier: 'scale',
  source: 'off',
  trialEndsAt: null,
  founder: null,
  manualActions: null,
  checkout: { pro: null, scale: null },
  whopAppId: null,
  stale: false,
};

const PlanContext = createContext<PlanContextValue | null>(null);

export function PlanProvider({
  plan: initial,
  planPage,
  children,
}: {
  plan: PlanView;
  planPage: string;
  children: ReactNode;
}) {
  const [plan, setPlan] = useState(initial);
  const [asked, setAsked] = useState<UpgradeAsk | null>(null);
  // A session read again brings the plan again: it replaces what the page counted.
  const [given, setGiven] = useState(initial);
  if (given !== initial) {
    setGiven(initial);
    setPlan(initial);
  }
  const checkoutFor = useCallback(
    (tier: Tier) =>
      tier === 'scale' ? plan.checkout.scale : tier === 'pro' ? plan.checkout.pro : null,
    [plan.checkout],
  );
  // Whatever screen asked it, a 402 offers the plan that opens it.
  useEffect(() => {
    const listen = (event: Event) => {
      const detail = (event as CustomEvent<UpgradeAsk>).detail;
      if (detail) setAsked(detail);
    };
    window.addEventListener(UPGRADE_EVENT, listen);
    return () => window.removeEventListener(UPGRADE_EVENT, listen);
  }, []);
  const value = useMemo<PlanContextValue>(() => {
    const on = plan.source !== 'off';
    const opens = (feature: Feature) => !on || allows(plan.tier, feature);
    return {
      plan,
      on,
      allows: opens,
      lockedTo: (feature) => (opens(feature) ? null : requiredTier(feature)),
      checkoutFor,
      countAction: (made = 1) =>
        setPlan((current) =>
          current.manualActions
            ? {
                ...current,
                manualActions: {
                  ...current.manualActions,
                  used: Math.min(current.manualActions.limit, current.manualActions.used + made),
                },
              }
            : current,
        ),
      ask: (tier) => setAsked({ tier, checkoutUrl: checkoutFor(tier) }),
      asked,
      dismiss: () => setAsked(null),
      planPage,
    };
  }, [plan, asked, checkoutFor, planPage]);
  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

const OPEN_CONTEXT: PlanContextValue = {
  plan: OPEN_PLAN,
  on: false,
  allows: () => true,
  lockedTo: () => null,
  checkoutFor: () => null,
  countAction: () => {},
  ask: () => {},
  asked: null,
  dismiss: () => {},
  planPage: '',
};

/** The community's plan; everything open outside a dashboard. */
export function usePlan(): PlanContextValue {
  return useContext(PlanContext) ?? OPEN_CONTEXT;
}

/** Whole days from `now` to `end` (a trial's end, the first charge), never below zero. */
export function daysUntil(end: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(end) - now) / 86_400_000));
}
