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
