/**
 * Which of the permissions StayPut asks for Whop really grants to the app's key on a company
 * (`GET /permissions`, answered for the calling key): reading (Phase 2), the actions (Phase 4)
 * and the optional Alumni offer. A permission added to the app is granted
 * only once the company re-approves it (Dashboard → Settings → Authorized apps): until then the
 * sync gets 403. Never prints the key.
 *
 *   WHOP_API_KEY=… WHOP_ENV=sandbox npx tsx scripts/ops/whop-permissions.ts [biz_…]
 *
 * The Inspect workflow runs it after the database report.
 */
import { appendFileSync } from 'node:fs';
import {
  ALUMNI_PERMISSIONS,
  PHASE_2_PERMISSIONS,
  PHASE_4_PERMISSIONS,
  UNNEEDED_PERMISSIONS,
  WHOP_API_BASE_URL,
  WHOP_API_VERSION_DATE,
  parseWhopEnv,
} from '@stayput/whop';
import { secretValue } from '../deploy/prepare';

const GROUPS: readonly { title: string; actions: readonly string[]; wanted: boolean }[] = [
  { title: 'Phase 2, reading', actions: PHASE_2_PERMISSIONS, wanted: true },
  { title: 'Phase 4, actions', actions: PHASE_4_PERMISSIONS, wanted: true },
  { title: 'Alumni offer (optional)', actions: ALUMNI_PERMISSIONS, wanted: true },
  { title: 'Not needed (SPEC 8.2)', actions: UNNEEDED_PERMISSIONS, wanted: false },
];

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
  url.searchParams.set('actions', GROUPS.flatMap((g) => g.actions).join(','));
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
    const granted = new Map(body.data.map((p) => [p.action, p.granted]));
    for (const group of GROUPS) {
      const missing = group.actions.filter((action) => granted.get(action) !== true);
      const extra = group.actions.filter((action) => granted.get(action) === true);
      lines.push(
        `**${group.title}**: ` +
          (!group.wanted
            ? extra.length === 0
              ? 'none granted, as it should be.'
              : `still granted (${extra.join(', ')}): leave them out of the production app.`
            : missing.length === 0
              ? `all ${group.actions.length} granted.`
              : `not granted (${missing.length} of ${group.actions.length}): ${missing.join(', ')}.`),
        '',
        '| permission | granted |',
        '| --- | --- |',
        ...group.actions.map((action) => {
          const state = granted.get(action);
          return `| ${action} | ${state === true ? 'yes' : state === false ? 'NO' : 'not answered'} |`;
        }),
        '',
      );
    }
    lines.push(
      'A permission added to the app is granted once the company re-approves it in Whop: ' +
        'Dashboard → Settings → Authorized apps.',
    );
  }
  // The community's name (its public title), as each address answers the app key: StayPut
  // shows it in the dashboard, the messages and the cards.
  lines.push('', `### The community's name, read with the app key`, '');
  lines.push('| address | HTTP | title |', '| --- | --- | --- |');
  for (const path of [`/companies/${companyId}`, `/accounts/${companyId}`]) {
    const answer = await fetch(`${WHOP_API_BASE_URL[env]}${path}`, {
      headers: { Authorization: `Bearer ${key}`, 'Api-Version-Date': WHOP_API_VERSION_DATE },
    });
    const read = (await answer.json().catch(() => null)) as { title?: unknown } | null;
    const title = typeof read?.title === 'string' ? read.title : '(none)';
    lines.push(`| \`${path}\` | ${answer.status} | ${title} |`);
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
