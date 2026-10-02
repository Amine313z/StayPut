import type { CreatorSession, MemberRow } from '@stayput/core';
import {
  ChevronsLeft,
  ChevronsRight,
  CircleHelp,
  Ellipsis,
  FlaskConical,
  LogOut,
  Search,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useI18n } from '../i18n';
import { ease } from '../motion';
import { readPreference, writePreference } from '../storage';
import { fold } from '../text';
import { StayPutMark } from '../ui/BrandIcons';
import { buttonClass } from '../ui/Button';
import { CommunityMark } from '../ui/CommunityMark';
import { Dialog } from '../ui/Dialog';
import { LanguageSwitch } from '../ui/LanguageSwitch';
import { MetricSkeleton, Skeleton } from '../ui/Skeleton';
import { ThemeSelect } from '../ui/ThemeSelect';
import { SECTIONS, sectionHref, sectionOf, type Section } from '../views/creator/sections';
import { SignOut } from './SignOut';

const COLLAPSED_KEY = 'stayput.menu.collapsed';
const DEMO_EXIT_KEY = 'stayput.demo.from';

/** The dashboard a creator opened the demo from: « Leave the demo » brings them back to it. */
export function rememberDemoExit(path: string): void {
  if (/^\/dashboard\/biz_[A-Za-z0-9]+(\/|$)/.test(path)) writePreference(DEMO_EXIT_KEY, path);
}

/** The sections the bottom bar of a phone shows; the others are under « More ». */
const PHONE_SECTIONS = ['dashboard', 'members', 'actions', 'insights'] as const;

/**
 * The creator's frame (the redesign): the sections in a side menu that folds to its icons (the
 * open one marked by a mint bar), a top bar with the community, the member search, the
 * language, the theme and help; on a phone the menu becomes a bar at the bottom. The frame never
 * moves: only the page inside it comes in (MOTION.md).
 */
export function CreatorShell({
  session,
  root,
  members,
  demo = false,
  children,
}: {
  session: CreatorSession;
  root: string;
  members: readonly MemberRow[];
  /** The imaginary community of /demo: said on every screen, with the way out. */
  demo?: boolean;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => readPreference(COLLAPSED_KEY) === '1');
  const toggle = () => {
    setCollapsed((current) => {
      writePreference(COLLAPSED_KEY, current ? '0' : '1');
      return !current;
    });
  };
  return (
    <div className="min-h-dvh md:flex">
      <Sidebar session={session} root={root} collapsed={collapsed} onToggle={toggle} />
      <div className="min-w-0 flex-1">
        <TopBar session={session} root={root} members={members} demo={demo} />
        <main className="mx-auto w-full max-w-[1280px] px-4 pt-6 pb-28 sm:px-6 md:pb-10">
          {demo ? <DemoNotice /> : null}
          {children}
        </main>
      </div>
      <PhoneBar root={root} />
    </div>
  );
}

function Sidebar({
  session,
  root,
  collapsed,
  onToggle,
}: {
  session: CreatorSession;
  root: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const current = sectionOf(pathname, root);
  return (
    <aside
      className={`sticky top-0 hidden h-dvh shrink-0 flex-col border-e border-line bg-bg-deep/60 backdrop-blur md:flex ${
        collapsed ? 'w-[4.5rem]' : 'w-60'
      } transition-[width] duration-250 ease-brand`}
    >
      <Link
        to={root}
        className="flex h-16 items-center gap-2.5 px-5 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
      >
        <StayPutMark size={28} />
        {collapsed ? null : (
          <span className="font-display text-base font-bold tracking-tight">{t('app.name')}</span>
        )}
      </Link>
      <nav aria-label={t('creator.sections')} className="flex-1 overflow-y-auto px-3 py-2">
        <ul className="space-y-1">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <NavItem
                section={section}
                href={sectionHref(root, section)}
                active={section.id === current.id}
                collapsed={collapsed}
              />
            </li>
          ))}
        </ul>
      </nav>
      <div className="space-y-2 border-t border-line px-3 py-3">
        {collapsed ? null : <SignOut via={session.via} />}
        <button
          type="button"
          onClick={onToggle}
          aria-label={t(collapsed ? 'shell.expand' : 'shell.collapse')}
          title={t(collapsed ? 'shell.expand' : 'shell.collapse')}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-subtle transition-colors duration-150 hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          {collapsed ? (
            <ChevronsRight aria-hidden="true" className="size-4 shrink-0" />
          ) : (
            <ChevronsLeft aria-hidden="true" className="size-4 shrink-0" />
          )}
          {collapsed ? null : t('shell.collapse')}
        </button>
      </div>
    </aside>
  );
}

/** A section of the menu: its icon and name; the open one with its mint bar, which slides. */
function NavItem({
  section,
  href,
  active,
  collapsed,
}: {
  section: Section;
  href: string;
  active: boolean;
  collapsed: boolean;
}) {
  const { t } = useI18n();
  const Icon: LucideIcon = section.Icon;
  return (
    <Link
      to={href}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? t(section.label) : undefined}
      className={`relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        active ? 'bg-accent-soft/60 text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg'
      }`}
    >
      {active ? (
        <motion.span
          layoutId="nav-active-bar"
          transition={ease('standard')}
          className="absolute inset-y-2 -start-3 w-1 rounded-e-full bg-accent"
        />
      ) : null}
      <Icon aria-hidden="true" className="size-[1.125rem] shrink-0" />
      {collapsed ? <span className="sr-only">{t(section.label)}</span> : t(section.label)}
    </Link>
  );
}

function TopBar({
  session,
  root,
  members,
  demo,
}: {
  session: CreatorSession;
  root: string;
  members: readonly MemberRow[];
  demo: boolean;
}) {
  const { t } = useI18n();
  const [help, setHelp] = useState(false);
  const name = session.companyName;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-[1280px] items-center gap-3 px-4 sm:px-6">
        <Link
          to={root}
          className="flex min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <CommunityMark
            name={name}
            src={
              session.companyLogo
                ? `/api/creator/${encodeURIComponent(session.companyId)}/logo`
                : null
            }
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold">
              {name ?? t('shell.communityFallback')}
            </span>
            {demo ? (
              <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-px text-xs font-medium text-accent">
                <FlaskConical aria-hidden="true" className="size-3" />
                {t('demo.badge')}
              </span>
            ) : (
              <span className="block text-xs text-subtle">{t('nav.team')}</span>
            )}
          </span>
        </Link>
        <div className="ms-auto flex items-center gap-2">
          <MemberSearch root={root} members={members} />
          <span className="hidden sm:inline-flex">
            <LanguageSwitch />
          </span>
          <ThemeSelect compact />
          <button
            type="button"
            onClick={() => setHelp(true)}
            aria-label={t('shell.help')}
            title={t('shell.help')}
            className="flex size-9 items-center justify-center rounded-lg border border-line bg-surface text-subtle transition-colors duration-150 hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <CircleHelp aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>
      {help ? <HelpDialog root={root} demo={demo} onClose={() => setHelp(false)} /> : null}
    </header>
  );
}

/**
 * Finds a member by name among those the dashboard read: Enter or a click opens the members with
 * that name searched.
 */
function MemberSearch({ root, members }: { root: string; members: readonly MemberRow[] }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const found = useMemo(() => {
    const words = fold(query.trim());
    if (!words) return [];
    return members.filter((m) => fold(m.name ?? '').includes(words)).slice(0, 6);
  }, [members, query]);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const go = (name: string) => {
    setOpen(false);
    setQuery('');
    void navigate(`${root}/members?q=${encodeURIComponent(name)}`);
  };
  return (
    <div ref={box} className="relative hidden md:block">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-subtle"
      />
      <input
        type="search"
        role="combobox"
        aria-expanded={open && query.trim() !== ''}
        aria-controls={listId}
        aria-label={t('shell.search')}
        placeholder={t('shell.search')}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && query.trim()) go(found[0]?.name ?? query.trim());
          if (event.key === 'Escape') setOpen(false);
        }}
        className="h-9 w-56 rounded-lg border border-line bg-surface ps-9 pe-3 text-sm text-fg placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:w-72"
      />
      <AnimatePresence>
        {open && query.trim() ? (
          <motion.ul
            id={listId}
            role="listbox"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: ease('micro') }}
            exit={{ opacity: 0, transition: ease('micro') }}
            className="absolute end-0 top-11 z-40 w-full min-w-64 overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-lift"
          >
            {found.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted">{t('shell.searchNone')}</li>
            ) : (
              found.map((member) => (
                <li key={member.id} role="option" aria-selected={false}>
                  <button
                    type="button"
                    onClick={() => go(member.name ?? '')}
                    className="flex w-full items-center rounded-lg px-3 py-2 text-start text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    {member.name}
                  </button>
                </li>
              ))
            )}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * How StayPut works, in four short answers: risk, saved money, guardrails, test mode; and, from
 * a real dashboard, the way to the demo community.
 */
function HelpDialog({ root, demo, onClose }: { root: string; demo: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const parts = [
    ['help.risk.title', 'help.risk.body'],
    ['help.saved.title', 'help.saved.body'],
    ['help.guardrails.title', 'help.guardrails.body'],
    ['help.test.title', 'help.test.body'],
  ] as const;
  return (
    <Dialog title={t('help.title')} description={t('help.lead')} onClose={onClose}>
      <dl className="space-y-4">
        {parts.map(([title, body]) => (
          <div key={title}>
            <dt className="font-semibold">{t(title)}</dt>
            <dd className="mt-1 text-sm text-muted">{t(body)}</dd>
          </div>
        ))}
      </dl>
      {demo ? null : (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 p-4">
          <p className="min-w-0 flex-1 basis-48 text-sm text-muted">{t('help.demoHint')}</p>
          <Link
            to={`/demo?from=${encodeURIComponent(root)}`}
            onClick={onClose}
            className={buttonClass('secondary', 'sm')}
          >
            <Sparkles aria-hidden="true" className="size-4" />
            {t('help.demo')}
          </Link>
        </div>
      )}
    </Dialog>
  );
}

/**
 * Over every screen of the demo: what it is, and the way back to the creator's own dashboard
 * (or StayPut's home for a visitor).
 */
function DemoNotice() {
  const { t } = useI18n();
  const exit = readPreference(DEMO_EXIT_KEY) ?? '/';
  return (
    <div
      role="note"
      className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line-strong bg-accent-soft/40 px-4 py-2.5 text-sm"
    >
      <FlaskConical aria-hidden="true" className="size-4 shrink-0 text-accent" />
      <p className="min-w-0 flex-1 basis-64">{t('demo.notice')}</p>
      <Link to={exit} className={buttonClass('ghost', 'sm', '-my-1')}>
        <LogOut aria-hidden="true" className="size-4" />
        {t('demo.leave')}
      </Link>
    </div>
  );
}

/** On a phone: the main sections at the bottom of the screen, the others under « More ». */
function PhoneBar({ root }: { root: string }) {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const current = sectionOf(pathname, root);
  const [more, setMore] = useState(false);
  const main = SECTIONS.filter((s) => (PHONE_SECTIONS as readonly string[]).includes(s.id));
  const others = SECTIONS.filter((s) => !(PHONE_SECTIONS as readonly string[]).includes(s.id));
  const inOthers = others.some((s) => s.id === current.id);
  return (
    <>
      <nav
        aria-label={t('shell.phoneNav')}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        <ul className="grid grid-cols-5">
          {main.map((section) => {
            const active = section.id === current.id;
            const Icon = section.Icon;
            return (
              <li key={section.id}>
                <Link
                  to={sectionHref(root, section)}
                  aria-current={active ? 'page' : undefined}
                  className={`flex flex-col items-center gap-1 px-1 py-2.5 text-[0.6875rem] font-medium ${
                    active ? 'text-accent' : 'text-subtle'
                  }`}
                >
                  <Icon aria-hidden="true" className="size-5" />
                  <span className="max-w-full truncate">{t(section.label)}</span>
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setMore(true)}
              aria-current={inOthers ? 'page' : undefined}
              className={`flex w-full flex-col items-center gap-1 px-1 py-2.5 text-[0.6875rem] font-medium ${
                inOthers ? 'text-accent' : 'text-subtle'
              }`}
            >
              <Ellipsis aria-hidden="true" className="size-5" />
              {t('shell.more')}
            </button>
          </li>
        </ul>
      </nav>
      {more ? (
        <Dialog title={t('shell.more')} onClose={() => setMore(false)}>
          <ul className="space-y-1">
            {others.map((section) => (
              <li key={section.id}>
                <Link
                  to={sectionHref(root, section)}
                  onClick={() => setMore(false)}
                  className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium hover:bg-surface-2"
                >
                  <section.Icon aria-hidden="true" className="size-5 text-subtle" />
                  {t(section.label)}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
            <span className="text-sm text-muted">{t('settings.language')}</span>
            <LanguageSwitch />
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

/**
 * The frame while the session is read: the menu, the top bar and the first figures in their
 * own shapes (MOTION.md: never a page-wide spinner).
 */
export function ShellSkeleton() {
  const { t } = useI18n();
  return (
    <div className="min-h-dvh md:flex" role="status" aria-label={t('common.loading')}>
      <div className="hidden w-60 shrink-0 space-y-3 border-e border-line bg-bg-deep/60 px-5 py-5 md:block">
        <Skeleton className="h-7 w-28" />
        <div className="space-y-2 pt-4">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full rounded-xl" />
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex h-16 items-center gap-3 border-b border-line px-4 sm:px-6">
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="h-4 w-36" />
        </div>
        <div className="mx-auto grid w-full max-w-[1280px] grid-cols-1 gap-4 px-4 pt-6 sm:grid-cols-2 sm:px-6 xl:grid-cols-4">
          <MetricSkeleton hero />
          <MetricSkeleton hero />
          <MetricSkeleton hero />
          <MetricSkeleton hero />
        </div>
      </div>
    </div>
  );
}
