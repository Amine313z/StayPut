/**
 * Which of the permissions StayPut asks for Whop really grants to the app's key on a company
 * (`GET /permissions`, answered for the calling key). A permission added to the app is granted
 * only once the company re-approves it (Dashboard → Settings → Authorized apps): until then the
 * sync gets 403. Never prints the key.
 *
 *   WHOP_API_KEY=… WHOP_ENV=sandbox npx tsx scripts/ops/whop-permissions.ts [biz_…]
 *
 * The Inspect workflow runs it after the database report.
 */
import { appendFileSync } from 'node:fs';
import { WHOP_API_BASE_URL, WHOP_API_VERSION_DATE, parseWhopEnv } from '@stayput/whop';
import { secretValue } from '../deploy/prepare';

/** The read permissions of Phase 2 (docs/whop-api-verification.md, section 10). */
export const PHASE_2_PERMISSIONS = [
  'company:basic:read',
  'member:basic:read',
  'member:email:read',
  'member:phone:read',
  'access_pass:basic:read',
  'plan:basic:read',
  'payment:basic:read',
  'promo_code:basic:read',
  'shipment:basic:read',
  'chat:read',
  'forum:read',
  'support_chat:read',
  'courses:read',
  'course_analytics:read',
  'webhook_receive:memberships',
  'webhook_receive:payments',
  'webhook_receive:members',
  'webhook_receive:chat',
  'webhook_receive:courses',
] as const;

/** « StayPut Test », the founder's sandbox account. */
const SANDBOX_COMPANY = 'biz_2whAzkbCRpcGqQ';

async function main() {
  // The stored secret may hold more than the key (a line `NAME=…` around it): the deployment
  // reads it the same way.
  const key = secretValue('WHOP_API_KEY', process.env.WHOP_API_KEY);
  if (!key) {
    console.info('WHOP_API_KEY is not set: permissions not checked.');
    return;
  }
  const env = parseWhopEnv(process.env.WHOP_ENV || undefined);
  const companyId = process.argv[2] ?? SANDBOX_COMPANY;
  const url = new URL(`${WHOP_API_BASE_URL[env]}/permissions`);
  url.searchParams.set('resource_id', companyId);
  url.searchParams.set('actions', PHASE_2_PERMISSIONS.join(','));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, 'Api-Version-Date': WHOP_API_VERSION_DATE },
  });
  const body = (await response.json().catch(() => null)) as {
    data?: { action: string; granted: boolean }[];
  } | null;
  const lines = [`### Whop permissions of the app key on ${companyId} (${env})`, ''];
  if (!response.ok || !Array.isArray(body?.data)) {
    lines.push(`Whop answered HTTP ${response.status}.`);
  } else {
    const missing = body.data.filter((p) => !p.granted).map((p) => p.action);
    lines.push(
      missing.length === 0
        ? `All ${body.data.length} permissions granted.`
        : `Not granted (${missing.length} of ${body.data.length}): ${missing.join(', ')}. ` +
            'The company re-approves them in Whop: Dashboard → Settings → Authorized apps.',
    );
    lines.push('', '| permission | granted |', '| --- | --- |');
    for (const p of body.data) lines.push(`| ${p.action} | ${p.granted ? 'yes' : 'NO'} |`);
  }
  for (const line of lines) console.info(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${lines.join('\n')}\n`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
