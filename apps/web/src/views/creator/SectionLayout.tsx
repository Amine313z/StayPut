import { useCallback, useState } from 'react';
import { Navigate, Outlet } from 'react-router';
import { useI18n } from '../../i18n';
import { NavTabs } from '../../ui/Tabs';
import { useCreatorData, type CreatorData, type TabCounts } from '../CreatorView';
import { SECTIONS, sectionHref, type SectionId } from './sections';

/**
 * A section of the dashboard: its title and what it is for, its tabs on top, and the open tab.
 * A tab may say how many things each tab holds (`tabCounts`): the section keeps them while the
 * creator moves between its tabs.
 */
export function SectionLayout({ id }: { id: SectionId }) {
  const { t, number } = useI18n();
  const data = useCreatorData();
  const section = SECTIONS.find((s) => s.id === id)!;
  const [counts, setCounts] = useState<TabCounts>({});
  const tabCounts = useCallback(
    (next: TabCounts) =>
      setCounts((current) =>
        Object.entries(next).every(([tab, n]) => current[tab] === n)
          ? current
          : { ...current, ...next },
      ),
    [],
  );
  const context: CreatorData = { ...data, tabCounts };
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t(section.label)}</h1>
        <p className="mt-1 text-sm text-muted">{t(section.description)}</p>
      </header>
      <NavTabs
        label={t('nav.tabs', { section: t(section.label) })}
        items={section.tabs.map((tab) => ({
          to: sectionHref(data.root, section, tab.path),
          end: tab.path === '',
          label: t(tab.label),
          ...(counts[tab.path] === undefined ? {} : { count: number(counts[tab.path]!) }),
        }))}
      />
      <Outlet context={context} />
    </div>
  );
}

/** An address of a section that names no tab of it: its first tab. */
export function SectionHome({ id }: { id: SectionId }) {
  const { root } = useCreatorData();
  return (
    <Navigate
      to={sectionHref(
        root,
        SECTIONS.find((s) => s.id === id)!,
      )}
      replace
    />
  );
}
