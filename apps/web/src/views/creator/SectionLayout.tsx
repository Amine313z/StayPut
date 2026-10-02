import { motion } from 'motion/react';
import { useCallback, useState, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { memberSpaceEnabled } from '../../features';
import { useI18n } from '../../i18n';
import { pageVariants } from '../../motion';
import { NavTabs } from '../../ui/Tabs';
import { useCreatorData, type CreatorData, type TabCounts } from '../CreatorView';
import { SECTIONS, sectionHref, visibleTabs, type SectionId } from './sections';

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
  // A new tab comes in like a page; the section's first one comes in with the section itself.
  const location = useLocation();
  const [arrival] = useState(location.key);
  const tabs = visibleTabs(section);
  // The member space's section, while the member space is off: the dashboard instead.
  if (section.memberSpace && !memberSpaceEnabled()) return <Navigate to={data.root} replace />;
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{t(section.label)}</h1>
        <p className="mt-1 text-sm text-muted">{t(section.description)}</p>
      </header>
      {tabs.length < 2 ? null : (
        <NavTabs
          label={t('nav.tabs', { section: t(section.label) })}
          items={tabs.map((tab) => ({
            to: sectionHref(data.root, section, tab.path),
            end: tab.path === '',
            label: t(tab.label),
            ...(counts[tab.path] === undefined ? {} : { count: number(counts[tab.path]!) }),
          }))}
        />
      )}
      <motion.div
        key={location.pathname}
        variants={pageVariants}
        initial={location.key === arrival ? false : 'initial'}
        animate="enter"
      >
        <Outlet context={context} />
      </motion.div>
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

/** A page of the member space (a settings tab): its section's home while the space is off. */
export function MemberSpaceOnly({
  section,
  children,
}: {
  section: SectionId;
  children: ReactNode;
}) {
  const { root } = useCreatorData();
  if (memberSpaceEnabled()) return <>{children}</>;
  return (
    <Navigate
      to={sectionHref(
        root,
        SECTIONS.find((s) => s.id === section)!,
      )}
      replace
    />
  );
}
