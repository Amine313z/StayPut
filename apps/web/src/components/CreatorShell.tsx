import type { CreatorSession, MemberRow } from '@stayput/core';
import {
  BookOpen,
  ChevronsLeft,
  ChevronsRight,
  Ellipsis,
  LogOut,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { pageHref, type GuideCard, type Targets } from '../guide';
import { useI18n } from '../i18n';
import { ease } from '../motion';
import { readPreference, writePreference } from '../storage';
import { fold } from '../text';
import { ActionButton } from '../ui/ActionButton';
import { StayPutMark } from '../ui/BrandIcons';
import { Button, buttonClass } from '../ui/Button';
import { CommunityMark } from '../ui/CommunityMark';
import { Dialog } from '../ui/Dialog';
import { MetricSkeleton, Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';
import { sectionHref, sectionOf, visibleSections, type Section } from '../views/creator/sections';
import { GuideContext, type GuideControls } from './guide/context';
import { GuidePanel } from './guide/GuidePanel';
import { Flash } from './guide/Spotlight';
import { ShowMe, Tour } from './guide/Tour';
import { failureText } from './MemberActions';
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
 * The creator's frame (brief v3 §6.1). A top bar across the page: StayPut's « S » at 40 px, the
 * community by its name and logo (never its id), the member search (⌘K) and the guide. Under it,
 * the menu: 64 px folded to its icons (each says its name on hover), 220 px open; the open
 * section marked by a 2 px turquoise bar and a turquoise icon. On a phone the menu is a bar at
 * the bottom. The content is 1280 px at most, with 24 px gutters; the test-mode banner sits on
 * top of it. The frame never moves: only the page inside it comes in (MOTION.md).
 */
export function CreatorShell({
  session,
  root,
  members,
  demo = false,
  testMode = false,
  onTurnOffTestMode,
  children,
}: {
  session: CreatorSession;
  root: string;
  members: readonly MemberRow[];
  /** The imaginary community of /demo: said on every screen, with the way out. */
  demo?: boolean;
  /** StayPut computes everything and sends nothing: the banner, with « Turn off ». */
  testMode?: boolean;
  onTurnOffTestMode?: () => Promise<void>;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => readPreference(COLLAPSED_KEY) === '1');
  const toggle = () => {
    setCollapsed((current) => {
      writePreference(COLLAPSED_KEY, current ? '0' : '1');
      return !current;
    });
  };
  const { currency } = useI18n();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // The guide (brief v4 §10): its panel, and what it lights up (the tour, a card's place, a
  // shortcut's control). Only one at a time: opening one closes the others.
  const [panel, setPanel] = useState(false);
  const [spot, setSpot] = useState<Spot | null>(null);
  const guide: GuideControls = {
    openGuide: () => {
      setSpot(null);
      setPanel(true);
    },
    startTour: () => {
      setPanel(false);
      if (pathname !== root) void navigate(root);
      setSpot({ kind: 'tour', index: 0 });
    },
    showMe: (card) => {
      setPanel(false);
      void navigate(pageHref(root, card.page));
      setSpot({ kind: 'show', card });
    },
    go: (shortcut) => {
      setPanel(false);
      void navigate(pageHref(root, shortcut.page));
      setSpot(
        shortcut.targets.length > 0
          ? { kind: 'flash', targets: shortcut.targets, at: Date.now() }
          : null,
      );
    },
  };
  // « It starts at $0.00 »: in the community's currency, the one most of its members pay in.
  const zero = currency(0, mainCurrency(members));
  return (
    <GuideContext.Provider value={guide}>
      <div className="min-h-dvh">
        <TopBar
          session={session}
          root={root}
          members={members}
          demo={demo}
          onGuide={guide.openGuide}
        />
        <div className="md:flex">
          <Sidebar session={session} root={root} collapsed={collapsed} onToggle={toggle} />
          {/* The light behind the hero number may spread wider than the page: never a scrollbar. */}
          <div className="min-w-0 flex-1 overflow-x-clip">
            <main className="mx-auto w-full max-w-[1280px] px-4 pt-8 pb-28 sm:px-6 md:pb-12">
              {demo ? <DemoNotice /> : null}
              {testMode && onTurnOffTestMode ? (
                <TestModeBanner onTurnOff={onTurnOffTestMode} />
              ) : null}
              {children}
            </main>
          </div>
        </div>
        <PhoneBar root={root} />
      </div>
      {panel ? <GuidePanel root={root} demo={demo} onClose={() => setPanel(false)} /> : null}
      {spot?.kind === 'tour' ? (
        <Tour
          index={spot.index}
          zero={zero}
          onIndex={(index) => setSpot({ kind: 'tour', index })}
          onClose={() => setSpot(null)}
        />
      ) : null}
      {spot?.kind === 'show' ? <ShowMe card={spot.card} onClose={() => setSpot(null)} /> : null}
      {spot?.kind === 'flash' ? (
        <Flash key={spot.at} targets={spot.targets} onDone={() => setSpot(null)} />
      ) : null}
    </GuideContext.Provider>
  );
}

/** What the guide lights up: the tour at a step, a card's place, a shortcut's control. */
type Spot =
  | { kind: 'tour'; index: number }
  | { kind: 'show'; card: GuideCard }
  | { kind: 'flash'; targets: Targets; at: number };

/** The currency most of the members pay in (US dollars when nobody pays yet). */
function mainCurrency(members: readonly MemberRow[]): string {
  const counts = new Map<string, number>();
  for (const member of members) {
    const code = member.membership?.currency?.toUpperCase();
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  let best = 'USD';
  let most = 0;
  for (const [code, count] of counts) {
    if (count > most) [best, most] = [code, count];
  }
  return best;
}

function TopBar({
  session,
  root,
  members,
  demo,
  onGuide,
}: {
  session: CreatorSession;
  root: string;
  members: readonly MemberRow[];
  demo: boolean;
  onGuide: () => void;
}) {
  const { t } = useI18n();
  const name = session.companyName;
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
      <div className="flex h-16 items-center gap-3 ps-3 pe-4 sm:pe-6">
        <Link
          to={root}
          aria-label={t('app.name')}
          className="shrink-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <StayPutMark size={32} />
        </Link>
        <span aria-hidden="true" className="h-6 w-px shrink-0 bg-line" />
        <Link
          to={root}
          className="flex min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <CommunityMark
            name={name}
            size={28}
            src={
              session.companyLogo
                ? `/api/creator/${encodeURIComponent(session.companyId)}/logo`
                : null
            }
          />
          <span className="truncate text-sm font-medium text-fg">
            {name ?? t('shell.communityFallback')}
          </span>
          {demo ? (
            <span className="shrink-0 rounded-full border border-line-strong px-2 py-px text-[0.6875rem] font-medium text-accent">
              {t('demo.badge')}
            </span>
          ) : null}
        </Link>
        <div className="ms-auto flex items-center gap-2">
          <MemberSearch root={root} members={members} />
          <button type="button" onClick={onGuide} className={buttonClass('secondary', 'sm')}>
            <BookOpen aria-hidden="true" className="size-4" />
            {t('shell.guide')}
          </button>
        </div>
      </div>
    </header>
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
      className={`sticky top-16 z-20 hidden h-[calc(100dvh-4rem)] shrink-0 flex-col border-e border-line bg-surface md:flex ${
        collapsed ? 'w-16' : 'w-[220px]'
      }`}
    >
      <nav
        aria-label={t('creator.sections')}
        className={`flex-1 px-2 py-4 ${collapsed ? '' : 'overflow-y-auto'}`}
      >
        <ul className="space-y-1">
          {visibleSections().map((section) => (
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
      <div className="space-y-1 border-t border-line px-2 py-3">
        {collapsed ? null : <SignOut via={session.via} />}
        <button
          type="button"
          onClick={onToggle}
          aria-label={t(collapsed ? 'shell.expand' : 'shell.collapse')}
          className={`group relative flex h-10 w-full items-center gap-3 rounded-lg text-sm text-subtle transition-colors duration-150 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent ${
            collapsed ? 'justify-center' : 'px-3'
          }`}
        >
          {collapsed ? (
            <ChevronsRight aria-hidden="true" className="size-4 shrink-0" />
          ) : (
            <ChevronsLeft aria-hidden="true" className="size-4 shrink-0" />
          )}
          {collapsed ? <Tip>{t('shell.expand')}</Tip> : t('shell.collapse')}
        </button>
      </div>
    </aside>
  );
}

/** What a folded menu's icon is called, beside it on hover or focus. */
function Tip({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute start-full top-1/2 z-50 ms-3 -translate-y-1/2 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs font-medium whitespace-nowrap text-fg opacity-0 shadow-lift transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {children}
    </span>
  );
}

/**
 * A section of the menu: its icon and name. The open one: a 2 px turquoise bar that slides to
 * it, and a turquoise icon. Hovered, a surface fades in (opacity only).
 */
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
      data-tour={`nav-${section.id}`}
      className={`group relative flex h-10 items-center gap-3 rounded-lg text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        collapsed ? 'justify-center' : 'px-3'
      } ${active ? 'text-fg' : 'text-muted hover:text-fg'}`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-0 rounded-lg bg-surface-3 transition-opacity duration-150 ${
          active ? 'opacity-70' : 'opacity-0 group-hover:opacity-50'
        }`}
      />
      {active ? (
        <motion.span
          layoutId="nav-active-bar"
          transition={ease('standard')}
          className="absolute inset-y-2 -start-2 w-0.5 rounded-full bg-turq-300"
        />
      ) : null}
      <Icon
        aria-hidden="true"
        className={`relative size-[1.125rem] shrink-0 ${
          active ? 'text-turq-300' : 'text-subtle group-hover:text-muted'
        }`}
      />
      {collapsed ? (
        <>
          <span className="sr-only">{t(section.label)}</span>
          <Tip>{t(section.label)}</Tip>
        </>
      ) : (
        <span className="relative truncate">{t(section.label)}</span>
      )}
    </Link>
  );
}

/** ⌘K on a Mac, Ctrl K elsewhere. */
function onMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
}

/**
 * Finds a member by name among those the dashboard read; ⌘K (Ctrl K) from anywhere puts the
 * cursor in it. Enter or a click opens the members with that name searched.
 */
function MemberSearch({ root, members }: { root: string; members: readonly MemberRow[] }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const found = useMemo(() => {
    const words = fold(query.trim());
    if (!words) return [];
    return members.filter((m) => fold(m.name ?? '').includes(words)).slice(0, 6);
  }, [members, query]);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', shortcut);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', shortcut);
    };
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
        ref={input}
        type="search"
        role="combobox"
        aria-expanded={open && query.trim() !== ''}
        aria-controls={listId}
        aria-label={t('shell.search')}
        aria-keyshortcuts="Meta+K Control+K"
        placeholder={t('shell.search')}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && query.trim()) go(found[0]?.name ?? query.trim());
          if (event.key === 'Escape') setOpen(false);
        }}
        className="h-8 w-56 rounded-lg border border-line bg-surface ps-9 pe-14 text-[0.8125rem] text-fg transition-colors duration-150 placeholder:text-subtle hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:w-72"
      />
      {focused || query ? null : (
        <kbd
          aria-hidden="true"
          className="pointer-events-none absolute end-2 top-1/2 -translate-y-1/2 rounded border border-line px-1.5 font-sans text-[0.6875rem] text-subtle"
        >
          {t(onMac() ? 'shell.shortcut.mac' : 'shell.shortcut.other')}
        </kbd>
      )}
      <AnimatePresence>
        {open && query.trim() ? (
          <motion.ul
            id={listId}
            role="listbox"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: ease('micro') }}
            exit={{ opacity: 0, transition: ease('micro') }}
            className="absolute end-0 top-10 z-40 w-full min-w-64 overflow-hidden rounded-xl border border-line bg-surface-2 p-1 shadow-lift"
          >
            {found.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted">{t('shell.searchNone')}</li>
            ) : (
              found.map((member) => (
                <li key={member.id} role="option" aria-selected={false}>
                  <button
                    type="button"
                    onClick={() => go(member.name ?? '')}
                    className="flex w-full items-center rounded-lg px-3 py-2 text-start text-sm hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-accent"
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
 * Test mode (brief v3 §7): a slim bar outlined in turquoise on top of every screen, its words
 * muted, and « Turn off » (asked once more: from then on StayPut really sends).
 */
function TestModeBanner({ onTurnOff }: { onTurnOff: () => Promise<void> }) {
  const { t } = useI18n();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  return (
    <div
      role="note"
      className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-turq-300/40 px-4 py-1.5 text-[0.8125rem] text-subtle"
    >
      <p className="min-w-0 flex-1 basis-64">{t('testMode.banner')}</p>
      {asking ? (
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-muted">{t('testMode.confirm')}</span>
          <ActionButton
            variant="secondary"
            size="sm"
            run={async () => {
              await onTurnOff();
              toast({ title: t('testMode.off') });
            }}
            onError={(error) => toast({ tone: 'error', title: failureText(error, t) })}
          >
            {t('testMode.turnOff')}
          </ActionButton>
          <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
            {t('common.cancel')}
          </Button>
        </span>
      ) : (
        <Button variant="secondary" size="sm" onClick={() => setAsking(true)}>
          {t('testMode.turnOff')}
        </Button>
      )}
    </div>
  );
}

/**
 * Over every screen of the demo: what it is, and the way back to the creator's own dashboard
 * (or StayPut's home for a visitor). The same slim bar as the test mode.
 */
function DemoNotice() {
  const { t } = useI18n();
  const exit = readPreference(DEMO_EXIT_KEY) ?? '/';
  return (
    <div
      role="note"
      className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line px-4 py-1.5 text-[0.8125rem] text-subtle"
    >
      <p className="min-w-0 flex-1 basis-64">{t('demo.notice')}</p>
      <Link to={exit} className={buttonClass('ghost', 'sm', '-my-0.5')}>
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
  const sections = visibleSections();
  const main = sections.filter((s) => (PHONE_SECTIONS as readonly string[]).includes(s.id));
  const others = sections.filter((s) => !(PHONE_SECTIONS as readonly string[]).includes(s.id));
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
                  data-tour={`nav-${section.id}`}
                  className={`flex flex-col items-center gap-1 px-1 py-2.5 text-[0.6875rem] font-medium ${
                    active ? 'text-turq-300' : 'text-subtle'
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
              data-tour="nav-more"
              className={`flex w-full flex-col items-center gap-1 px-1 py-2.5 text-[0.6875rem] font-medium ${
                inOthers ? 'text-turq-300' : 'text-subtle'
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
                  className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium hover:bg-surface-3"
                >
                  <section.Icon aria-hidden="true" className="size-5 text-subtle" />
                  {t(section.label)}
                </Link>
              </li>
            ))}
          </ul>
        </Dialog>
      ) : null}
    </>
  );
}

/**
 * The frame while the session is read: the top bar, the menu and the first figures in their own
 * shapes (MOTION.md: never a page-wide spinner).
 */
export function ShellSkeleton() {
  const { t } = useI18n();
  return (
    <div className="min-h-dvh" role="status" aria-label={t('common.loading')}>
      <div className="flex h-16 items-center gap-3 border-b border-line ps-3 pe-6">
        <StayPutMark size={32} />
        <Skeleton className="h-4 w-36" />
      </div>
      <div className="md:flex">
        <div className="hidden h-[calc(100dvh-4rem)] w-[220px] shrink-0 space-y-2 border-e border-line bg-surface px-2 py-4 md:block">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
        <div className="mx-auto w-full max-w-[1280px] px-4 pt-8 sm:px-6">
          <Skeleton className="h-6 w-40" />
          <div className="mt-8 grid grid-cols-1 gap-8 rounded-xl border border-line p-6 lg:grid-cols-[1.4fr_1fr]">
            <MetricSkeleton hero />
            <div className="space-y-6">
              <MetricSkeleton />
              <MetricSkeleton />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
