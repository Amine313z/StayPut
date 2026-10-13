/**
 * What Whop answers the app key about the founder on the operator's community, as the Worker
 * asks it (`GET /users/{id}/access/{resource}`, then the permissions granted there): the level
 * (admin, customer, no access) or the refusal (its HTTP status and code). The dashboard opens
 * for a team member only when this answers `admin`; a 404 is an account the key cannot reach
 * (the app not installed, or not authorized, there). Never prints the key, an id or a name: it
 * runs on production too, whose logs are public.
 *
 *   WHOP_API_KEY=… WHOP_ENV=production OPERATOR_COMPANY_ID=biz_… ADMIN_USER_ID=user_… \
 *     npx tsx scripts/ops/whop-access.ts
 */
import { appendFileSync } from 'node:fs';
import {
  ALUMNI_PERMISSIONS,
  PHASE_2_PERMISSIONS,
  PHASE_4_PERMISSIONS,
  WHOP_API_BASE_URL,
  WHOP_API_VERSION_DATE,
  WhopApiError,
  createWhopClient,
  parseWhopEnv,
} from '@stayput/whop';
import { secretValue } from '../deploy/prepare';

const NEEDED = [...PHASE_2_PERMISSIONS, ...PHASE_4_PERMISSIONS, ...ALUMNI_PERMISSIONS];

async function main() {
  const key = secretValue('WHOP_API_KEY', process.env.WHOP_API_KEY);
  const companyId = secretValue('OPERATOR_COMPANY_ID', process.env.OPERATOR_COMPANY_ID);
  const userId = secretValue('ADMIN_USER_ID', process.env.ADMIN_USER_ID);
  const env = parseWhopEnv(process.env.WHOP_ENV || undefined);
  const lines = [
    `### What Whop (${env}) answers about the founder on the operator's community`,
    '',
  ];
  if (!key || !companyId || !userId) {
    lines.push(
      `Not asked: ${[
        !key && 'WHOP_API_KEY',
        !companyId && 'OPERATOR_COMPANY_ID',
        !userId && 'ADMIN_USER_ID',
      ]
        .filter(Boolean)
        .join(', ')} not set.`,
    );
  } else {
    const whop = createWhopClient({ apiKey: key, env });
    // The access check, as the Worker makes it for the dashboard and the member view.
    try {
      const answer = await whop.checkAccess(userId, companyId);
      lines.push(
        `- Access of the founder to the community: **${answer.accessLevel}** (has_access: ${
          answer.hasAccess
        }). The dashboard opens for \`admin\` only.`,
      );
    } catch (error) {
      lines.push(
        error instanceof WhopApiError
          ? `- Access check refused: **HTTP ${error.status}** (${error.type}${
              error.details.code ? `, ${error.details.code}` : ''
            }). The Worker reads 400, 404 and 422 as « no access »: the key cannot reach this ` +
              'community (app not installed there, or not authorized by it).'
          : `- Access check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // The permissions granted to the key on that community (counts and missing names only).
    const url = new URL(`${WHOP_API_BASE_URL[env]}/permissions`);
    url.searchParams.set('resource_id', companyId);
    url.searchParams.set('actions', NEEDED.join(','));
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, 'Api-Version-Date': WHOP_API_VERSION_DATE },
    });
    const body = (await response.json().catch(() => null)) as {
      data?: { action: string; granted: boolean }[];
    } | null;
    if (!response.ok || !Array.isArray(body?.data)) {
      lines.push(`- Permissions: Whop answered HTTP ${response.status}.`);
    } else {
      const granted = new Set(body.data.filter((p) => p.granted).map((p) => p.action));
      const missing = NEEDED.filter((action) => !granted.has(action));
      lines.push(
        missing.length === 0
          ? `- Permissions: all ${NEEDED.length} granted on the community.`
          : `- Permissions: ${missing.length} of ${NEEDED.length} NOT granted: ${missing.join(
              ', ',
            )}. The community re-approves them in Whop: Dashboard → Settings → Authorized apps.`,
      );
    }
    // Whether the key reads the community at all (status only).
    const read = await fetch(`${WHOP_API_BASE_URL[env]}/companies/${companyId}`, {
      headers: { Authorization: `Bearer ${key}`, 'Api-Version-Date': WHOP_API_VERSION_DATE },
    });
    lines.push(`- Reading the community with the key: HTTP ${read.status}.`);
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
