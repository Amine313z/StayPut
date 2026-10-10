/**
 * What StayPut keeps in its code without shipping it (decision of 2026-10-02). The member space
 * (goals, results, badges, testimonial cards and their pages, buddies, rescue challenges) is off
 * in V1: its section, its settings and its part of the member view are hidden; the departure
 * survey stays. Built with VITE_MEMBER_SPACE_ENABLED=true it comes back; the Worker has its own
 * switch (MEMBER_SPACE_ENABLED), which must say the same.
 */
export function memberSpaceEnabled(): boolean {
  return import.meta.env.VITE_MEMBER_SPACE_ENABLED === 'true';
}

/**
 * The legal pages (privacy policy, terms, DPA) are off (decision of 2026-10-10): Whop asks for
 * none and no app on Whop shows any. Off, StayPut links to none of them (Settings, Discover, the
 * member space); built with VITE_LEGAL_PAGES_ENABLED=true they come back, the Worker's own
 * switch (LEGAL_PAGES_ENABLED) saying the same.
 */
export function legalPagesEnabled(): boolean {
  return import.meta.env.VITE_LEGAL_PAGES_ENABLED === 'true';
}
