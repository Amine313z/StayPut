import type { MessageKey } from '@stayput/i18n';
import {
  ChartColumn,
  LayoutDashboard,
  Plug,
  SlidersHorizontal,
  Target,
  Users,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { memberSpaceEnabled } from '../../features';

/**
 * The dashboard's structure (the redesign brief of 2 October): six sections in a side menu,
 * Dashboard · Members · Automations · Analytics · Integrations · Settings, each with its tabs on
 * top when it has more than one page. A section's path follows `/dashboard/<company>/` (none
 * for the first); a tab's path follows its section's (none for the first, its home). The member
 * space keeps its section and its settings in the code, shown only when it is on (features.ts).
 */
export interface Section {
  id: SectionId;
  path: string;
  label: MessageKey;
  /** What it is for, under its title; none on the Dashboard (brief v3: nothing but its blocks). */
  description?: MessageKey;
  Icon: LucideIcon;
  tabs: readonly Tab[];
  /** Part of the member space: hidden while it is off. */
  memberSpace?: boolean;
}

export interface Tab {
  path: string;
  label: MessageKey;
  /** Part of the member space: hidden while it is off. */
  memberSpace?: boolean;
}

export type SectionId =
  'dashboard' | 'members' | 'actions' | 'insights' | 'sources' | 'settings' | 'space';

export const SECTIONS: readonly Section[] = [
  {
    id: 'dashboard',
    path: '',
    label: 'nav.dashboard',
    Icon: LayoutDashboard,
    tabs: [{ path: '', label: 'tab.overview' }],
  },
  {
    id: 'members',
    path: 'members',
    label: 'nav.members',
    description: 'nav.members.description',
    Icon: Users,
    tabs: [
      { path: '', label: 'tab.allMembers' },
      { path: 'never-contact', label: 'tab.neverContact' },
    ],
  },
  {
    id: 'actions',
    path: 'actions',
    label: 'nav.actions',
    description: 'nav.actions.description',
    Icon: Zap,
    // The queue's filters (to approve, scheduled, history, Alumni) live inside its tab.
    tabs: [
      { path: '', label: 'rules.tab' },
      { path: 'queue', label: 'queue.tab' },
    ],
  },
  {
    id: 'insights',
    path: 'insights',
    label: 'nav.insights',
    description: 'nav.insights.description',
    Icon: ChartColumn,
    // The forecast first: the money to come, then why members leave (brief v4 §9.5).
    tabs: [
      { path: '', label: 'tab.overview' },
      { path: 'cohorts', label: 'tab.cohorts' },
      { path: 'lessons', label: 'tab.lessons' },
    ],
  },
  {
    id: 'sources',
    path: 'sources',
    label: 'nav.sources',
    description: 'nav.sources.description',
    Icon: Plug,
    tabs: [
      { path: '', label: 'sources.whop.name' },
      { path: 'discord', label: 'sources.discord.name' },
      { path: 'telegram', label: 'sources.telegram.name' },
      { path: 'activity', label: 'tab.activity' },
    ],
  },
  {
    id: 'settings',
    path: 'settings',
    label: 'nav.settings',
    description: 'nav.settings.description',
    Icon: SlidersHorizontal,
    tabs: [
      { path: '', label: 'tab.general' },
      { path: 'risk', label: 'tab.riskScore' },
      { path: 'actions', label: 'nav.actions' },
      { path: 'space', label: 'nav.space', memberSpace: true },
    ],
  },
  {
    id: 'space',
    path: 'space',
    label: 'nav.space',
    description: 'nav.space.description',
    Icon: Target,
    memberSpace: true,
    tabs: [
      { path: '', label: 'tab.overview' },
      { path: 'cards', label: 'tab.testimonials' },
      { path: 'preview', label: 'tab.memberView' },
    ],
  },
];

/** The sections the menu shows: the member space's only while it is on. */
export function visibleSections(): readonly Section[] {
  return SECTIONS.filter((section) => !section.memberSpace || memberSpaceEnabled());
}

/** A section's tabs as shown: the member space's only while it is on. */
export function visibleTabs(section: Section): readonly Tab[] {
  return section.tabs.filter((tab) => !tab.memberSpace || memberSpaceEnabled());
}

/** The section a path of the dashboard is in: by its first part, the dashboard's by default. */
export function sectionOf(pathname: string, root: string): Section {
  const rest = pathname.startsWith(root) ? pathname.slice(root.length) : pathname;
  const first = rest.split('/').find(Boolean) ?? '';
  return SECTIONS.find((s) => s.path !== '' && s.path === first) ?? SECTIONS[0]!;
}

/** The address of a section, or of one of its tabs. */
export function sectionHref(root: string, section: Section, tab = ''): string {
  return [root, section.path, tab].filter(Boolean).join('/');
}
