import type { WhopClient } from '@stayput/whop';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeDueActions, prepareActions } from '../src/actions';
import { readDashboard } from '../src/dashboard';
import { refreshDetection } from '../src/risk';
import { recordSaves } from '../src/saves';
import { member, membership, payment } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * A community's key path on the Worker's side (SPEC Phase 8.6), each step through the code that
 * runs it in production: StayPut installed, Whop's deliveries filed, the audit (a member at risk,
 * and why), StayPut acting on its own (automatic mode, through Whop), the payment recovered, and
 * the save attributed to the action and shown on the dashboard. The same paths in a browser:
 * apps/web/e2e/journeys.e2e.ts.
 */

// 1 October 2026, 10:00 in Paris: past the quiet hours.
const NOW = new Date('2026-10-01T08:00:00Z');
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);
const C = 'biz_Journey';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

/** A delivery from Whop, stored then filed as the webhook route does. */
async function deliver(id: string, type: string, data: Record<string, unknown>, when: Date) {
  await t.db.query(
    `insert into stayput.webhook_events (id, company_id, type, payload, received_at)
     values ($1, $2, $3, $4::text::jsonb, $5::timestamptz)`,
    [id, C, type, JSON.stringify({ type, data }), when.toISOString()],
  );
  const [row] = await t.db.query<{ status: string }>(
    'select stayput.process_webhook_event($1, $2::timestamptz) as status',
    [id, when.toISOString()],
  );
  return row?.status;
}

/** Whop's API as the actions call it: every call kept, each answered. */
function fakeWhop() {
  const calls: { method: string; path: string }[] = [];
  const whop = {
    request: vi.fn((method: string, path: string) => {
      calls.push({ method, path });
      // The support chat with a member: Whop opens it, or gives the one there is.
      return Promise.resolve(path === '/support_channels' ? { id: 'supp_1' } : {});
    }),
  } as unknown as WhopClient;
  return { whop, calls };
}

describe('a community’s key path, from Whop’s deliveries to the money saved', () => {
  it('installs, audits, acts on its own through Whop, and attributes the save', async () => {
    // 1. Installed: the team opened StayPut (the session route records the community and who
    //    opened it); automatic mode, sending for real.
    await t.db.query(
      `insert into stayput.companies (id, name, timezone, locale, mode, experience_id)
       values ($1, 'Le Club', 'Europe/Paris', 'en', 'auto', 'exp_Club1')`,
      [C],
    );
    await t.db.query(
      `insert into stayput.company_settings (company_id, dry_run) values ($1, false)
       on conflict (company_id) do update set dry_run = false`,
      [C],
    );
    // RLS checks the team's access against the database's own clock (is_company_admin).
    await t.db.query(
      `insert into stayput.company_admins (company_id, user_id, verified_at)
       values ($1, 'user_Owner', now())`,
      [C],
    );

    // 2. Whop delivers: Bo joins, their monthly membership, then a payment that fails.
    expect(
      await deliver(
        'msg_Join',
        'member.created',
        member('mber_Bo', 'user_Bo', {
          joined_at: '2026-07-01T10:00:00.000Z',
          most_recent_action_at: '2026-09-20T18:00:00.000Z',
        }),
        at(-72),
      ),
    ).toBe('processed');
    expect(
      await deliver(
        'msg_Sub',
        'membership.activated',
        membership('mem_Bo', 'user_Bo', {
          account: { id: C },
          created_at: '2026-07-01T10:00:00.000Z',
        }),
        at(-72),
      ),
    ).toBe('processed');
    const failed = payment('pay_Bo', {
      member_id: 'mber_Bo',
      membership_id: 'mem_Bo',
      created_at: at(-30).toISOString(),
      paid_at: null,
      status: 'open',
      substatus: 'failed',
      failure_message: 'card_declined',
      retryable: true,
    });
    expect(await deliver('msg_Failed', 'payment.failed', failed, at(-30))).toBe('processed');

    // 3. The audit: the hour's scoring puts Bo at risk, and says why.
    await refreshDetection(t.db, C, NOW);
    const [risk] = await t.db.query<{ level: string; reasons: unknown }>(
      `select level, reasons from stayput.member_risk where company_id = $1 and member_id = 'mber_Bo'`,
      [C],
    );
    expect(risk?.level).toMatch(/^(medium|high)$/);
    expect(JSON.stringify(risk?.reasons)).toMatch(/payment/i);

    // 4. StayPut acts on its own: the notice and the retry are planned, scheduled for now (no
    //    approval in automatic mode), then sent through Whop.
    await prepareActions(t.db, C, NOW);
    const planned = await t.db.query<{ type: string; status: string }>(
      `select type, status from stayput.actions where company_id = $1 order by type`,
      [C],
    );
    expect(planned).toEqual(
      expect.arrayContaining([
        { type: 'payment_failed_notice', status: 'scheduled' },
        { type: 'payment_retry', status: 'scheduled' },
      ]),
    );
    const { whop, calls } = fakeWhop();
    const ran = await executeDueActions(t.db, whop, NOW);
    expect(ran.sent).toBeGreaterThanOrEqual(2);
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'POST', path: '/payments/pay_Bo/retry' },
        // The notice, in the support chat with Bo.
        { method: 'POST', path: '/support_channels' },
        { method: 'POST', path: '/messages' },
      ]),
    );

    // 5. The retry goes through: Whop delivers the payment, paid.
    expect(
      await deliver(
        'msg_Paid',
        'payment.succeeded',
        { ...failed, status: 'paid', substatus: 'succeeded', paid_at: at(1).toISOString() },
        at(1),
      ),
    ).toBe('processed');

    // 6. The save, attributed to StayPut's action with its proof, once; then on the dashboard.
    expect(await recordSaves(t.db, C, at(2))).toBe(1);
    expect(await recordSaves(t.db, C, at(3))).toBe(0);
    const saves = await t.db.query<{
      save_type: string;
      category: string;
      amount: string;
      payment_id: string;
    }>(
      `select save_type, category, amount::text, payment_id from stayput.saves
        where company_id = $1`,
      [C],
    );
    expect(saves).toEqual([
      { save_type: 'payment_recovered', category: 'direct', amount: '49.00', payment_id: 'pay_Bo' },
    ]);
    const dashboard = await readDashboard(t.db, 'user_Owner', C, at(3));
    expect(dashboard?.saved.thisMonth).toMatchObject({ direct: 49, saves: 1 });
  });
});
