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

/**
 * The dashboard's structure (the founder, 2 October; the redesign's order): sections in a side
 * menu, each with its tabs on top when it has more than one page. A section's path follows `/dashboard/<company>/` (none for the first);
 * a tab's path follows its section's (none for the first, its home).
 */
export interface Section {
  id: SectionId;
  path: string;
  label: MessageKey;
  description: MessageKey;
  Icon: LucideIcon;
  tabs: readonly { path: string; label: MessageKey }[];
}

export type SectionId =
  'dashboard' | 'space' | 'members' | 'actions' | 'insights' | 'sources' | 'settings';

export const SECTIONS: readonly Section[] = [
  {
    id: 'dashboard',
    path: '',
    label: 'nav.dashboard',
    description: 'nav.dashboard.description',
    Icon: LayoutDashboard,
    // One page (the full lists « Needs attention » and « New members » open from it).
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
    id: 'space',
    path: 'space',
    label: 'nav.space',
    description: 'nav.space.description',
    Icon: Target,
    tabs: [
      { path: '', label: 'tab.overview' },
      { path: 'cards', label: 'tab.testimonials' },
      { path: 'preview', label: 'tab.memberView' },
    ],
  },

  {
    id: 'actions',
    path: 'actions',
    label: 'nav.actions',
    description: 'nav.actions.description',
    Icon: Zap,
    tabs: [
      { path: '', label: 'actions.view.queue' },
      { path: 'scheduled', label: 'actions.view.scheduled' },
      { path: 'history', label: 'actions.view.history' },
      { path: 'alumni', label: 'alumni.title' },
    ],
  },
  {
    id: 'insights',
    path: 'insights',
    label: 'nav.insights',
    description: 'nav.insights.description',
    Icon: ChartColumn,
    tabs: [
      { path: '', label: 'tab.cohorts' },
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
      { path: '', label: 'tab.riskScore' },
      { path: 'actions', label: 'nav.actions' },
      { path: 'space', label: 'nav.space' },
    ],
  },
];

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
