import { createContext, useContext } from 'react';
import type { GuideCard, Shortcut } from '../../guide';

/**
 * What the frame (CreatorShell) lets any screen do with the guide: open it, run the tour (the
 * welcome's last step does), light up a card's place, take a shortcut.
 */
export interface GuideControls {
  openGuide: () => void;
  /** The tour, from its first step, on the dashboard. */
  startTour: () => void;
  /** « Show me »: the card's page, its place lit up. */
  showMe: (card: GuideCard) => void;
  /** A shortcut: its page, the control it is about brought forward. */
  go: (shortcut: Shortcut) => void;
}

export const GuideContext = createContext<GuideControls | null>(null);

export function useGuide(): GuideControls {
  const controls = useContext(GuideContext);
  if (!controls) throw new Error('useGuide outside CreatorShell');
  return controls;
}
