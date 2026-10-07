import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runScheduled, scheduledJobs, type JobContext } from '../src/cron';
import type { ClosableDb } from '../src/db';
import {
  logError,
  readOperatorStatus,
  replayFailedWebhooks,
  replayWebhook,
} from '../src/operations';
import { member } from './fixtures/whop';
import { createTestDb, type TestDb } from './helpers/db';

/**
 * StayPut's own running (SPEC Phase 8.5): each scheduled job's runs, the error log (scrubbed:
 * no secret, no person), the internal status page's reading, and Whop's failed deliveries
 * replayed on demand.
 */

// The real time: the actions' `updated_at` is the database's own clock.
const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
  await t.db.query(`insert into stayput.companies (id, name) values ('biz_OpsA', 'Ops Club')`);
});
afterAll(() => t.close());

const ctx = (now: Date) => ({ db: t.db as unknown as ClosableDb, now }) as JobContext;

/** A delivery Whop sent for a member, filed now: `joinedAt` decides whether it fails. */
async function deliver(id: string, joinedAt: string) {
  const who = id.replace(/_/g, '');
  await t.db.query(
    `insert into stayput.webhook_events (id, company_id, type, payload, received_at)
     values ($1, 'biz_OpsA', 'member.created', $2::text::jsonb, $3::timestamptz)`,
    [
      id,
      JSON.stringify({
        type: 'member.created',
        data: member(`mber_${who}`, `user_${who}`, {
          joined_at: joinedAt,
          user: { id: `user_${who}`, name: 'Zorglub Hidden', username: 'zorglub' },
        }),
      }),
      NOW.toISOString(),
    ],
  );
  const [row] = await t.db.query<{ status: string }>(
    'select stayput.process_webhook_event($1, $2::timestamptz) as status',
    [id, NOW.toISOString()],
  );
  return row?.status;
}

describe('the scheduled jobs and the error log', () => {
  it('records each run, and each failure once, counted, without a secret or a person', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const schedule = {
      hourly: [
        { name: 'risk', run: () => Promise.resolve() },
        {
          name: 'actions',
          run: () =>
            Promise.reject(
              new Error('Whop 403 for user_Abc1 (ana@mail.test): Bearer apik_secret123 refused'),
            ),
        },
      ],
    };
    await runScheduled('hourly', schedule, ctx(NOW));
    await runScheduled('hourly', schedule, ctx(later(60)));
    errors.mockRestore();
    info.mockRestore();

    const runs = await t.db.query<Record<string, unknown>>(
      `select job, runs, failures, last_ok_at is not null as ok, last_failed_at is not null as failed,
              last_error from stayput.job_runs order by job`,
    );
    const scrubbed = 'Whop 403 for user_… ([email]): Bearer [redacted] refused';
    expect(runs).toEqual([
      { job: 'actions', runs: 2, failures: 2, ok: false, failed: true, last_error: scrubbed },
      { job: 'risk', runs: 2, failures: 0, ok: true, failed: false, last_error: null },
    ]);
    const logged = await t.db.query<Record<string, unknown>>(
      `select source, company_id, message, count, first_at < last_at as twice
         from stayput.error_log`,
    );
    expect(logged).toEqual([
      { source: 'job:actions', company_id: null, message: scrubbed, count: 2, twice: true },
    ]);
  });

  it('never fails the caller when the error cannot be recorded', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { query: () => Promise.reject(new Error('down')) } as unknown as ClosableDb;
    await expect(logError(broken, 'request', null, new Error('x'), NOW)).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });

  it('forgets an error after 30 days quiet, and a community’s errors with its data', async () => {
    await t.db.query(`insert into stayput.companies (id) values ('biz_OpsGone')`);
    await logError(t.db, 'request', 'biz_OpsGone', 'boom', NOW);
    await logError(t.db, 'request', null, 'old boom', new Date(NOW.getTime() - 31 * 86_400_000));
    const [purged] = await t.db.query<{ n: number }>(
      'select stayput.purge_error_log($1::timestamptz) as n',
      [NOW.toISOString()],
    );
    expect(purged?.n).toBe(1);
    await t.db.query(`select stayput.delete_company_data('biz_OpsGone')`);
    const left = await t.db.query<{ message: string }>(
      `select message from stayput.error_log where message like '%boom' order by message`,
    );
    expect(left).toEqual([]);
  });
});

describe('the status page and the replays', () => {
  it('reads the jobs, the deliveries without their content, the refusals and failed actions', async () => {
    expect(await deliver('msg_OpsBad', 'not a date')).toBe('failed');
    await t.db.query(
      `insert into stayput.sync_state (company_id, stream, last_error, last_error_at)
       values ('biz_OpsA', 'members', '403 forbidden for ana@mail.test', $1::timestamptz)`,
      [NOW.toISOString()],
    );
    await t.db.query(
      `insert into stayput.members (id, company_id, user_id, status)
       values ('mber_OpsM', 'biz_OpsA', 'user_OpsM', 'joined')`,
    );
    await t.db.query(
      `insert into stayput.actions (company_id, member_id, type, status, trigger, error_log)
       values ('biz_OpsA', 'mber_OpsM', 'payment_retry', 'failed', 'payment.failed',
               '[{"at": "2026-10-05T09:00:00Z", "error": "Whop 500 for user_OpsM"}]')`,
    );
    const status = await readOperatorStatus(t.db, later(60), {
      whopEnv: 'sandbox',
      database: 'ok',
      jobs: scheduledJobs(),
    });
    // Every job of the schedule: the two run above, the others never.
    expect(status.jobs.map((job) => job.job)).toEqual(scheduledJobs().map((job) => job.job));
    const state = Object.fromEntries(status.jobs.map((job) => [job.job, job.state]));
    expect(state).toMatchObject({ risk: 'ok', actions: 'failing', sync: 'never' });
    expect(status.webhooks.failedCount).toBe(1);
    expect(status.webhooks.failed).toEqual([
      {
        id: 'msg_OpsBad',
        type: 'member.created',
        companyId: 'biz_OpsA',
        companyName: 'Ops Club',
        attempts: 1,
        retrying: true,
        lastError: expect.stringContaining('not a date') as string,
        receivedAt: expect.any(String) as string,
      },
    ]);
    expect(status.syncErrors).toEqual([
      expect.objectContaining({ companyId: 'biz_OpsA', error: '403 forbidden for [email]' }),
    ]);
    expect(status.failedActions).toEqual([
      expect.objectContaining({
        companyId: 'biz_OpsA',
        type: 'payment_retry',
        count: 1,
        lastError: 'Whop 500 for user_…',
      }),
    ]);
    expect(status.companies).toMatchObject({ active: expect.any(Number) as number });
    // What a delivery held never shows: its member's name, for one.
    expect(JSON.stringify(status)).not.toContain('Zorglub');
  });

  it('replays a failed delivery, even one the automatic replays gave up on', async () => {
    await t.db.query(`update stayput.webhook_events set attempts = 5 where id = 'msg_OpsBad'`);
    const [skipped] = await t.db.query<{ counts: unknown }>(
      'select stayput.process_pending_webhooks(100, $1::timestamptz) as counts',
      [later(120).toISOString()],
    );
    expect(skipped?.counts).toEqual({});
    // What made it fail is fixed (here, the date it carried): replayed, it goes through.
    await t.db.query(
      `update stayput.webhook_events
          set payload = jsonb_set(payload, '{data,joined_at}', '"2026-06-01T10:00:00Z"')
        where id = 'msg_OpsBad'`,
    );
    expect(await replayWebhook(t.db, 'msg_OpsBad', later(120))).toBe('processed');
    const [filed] = await t.db.query<{ n: number }>(
      `select count(*)::int as n from stayput.members where id = 'mber_msgOpsBad'`,
    );
    expect(filed?.n).toBe(1);
    expect(await replayWebhook(t.db, 'msg_OpsBad', later(121))).toBe('missing');
    expect(await replayWebhook(t.db, 'msg_Unknown', later(121))).toBe('missing');
  });

  it('replays every failed delivery at once, and says how each ended', async () => {
    expect(await deliver('msg_OpsBad2', 'never')).toBe('failed');
    expect(await deliver('msg_OpsBad3', 'nope')).toBe('failed');
    await t.db.query(
      `update stayput.webhook_events
          set payload = jsonb_set(payload, '{data,joined_at}', '"2026-06-02T10:00:00Z"')
        where id = 'msg_OpsBad2'`,
    );
    expect(await replayFailedWebhooks(t.db, later(130))).toEqual({
      counts: { processed: 1, failed: 1 },
    });
  });
});
