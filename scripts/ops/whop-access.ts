/**
 * What Whop answers the app key about the founder on the operator's community, as the Worker
 * asks it (`GET /users/{id}/access/{resource}`, then the permissions granted there): the level
 * (admin, customer, no access) or the refusal (its HTTP status and code). The dashboard opens
 * for a team member only when this answers `admin`; a 404 is an account the key cannot reach
 * (the app not installed, or not authorized, there). Then the same for the experiences of that
 * community the key can list (the member view's doors): how many, how many are this app's
 * (WHOP_APP_ID), and what Whop answers about the founder on each. Never prints the key, an id or
 * a name: it runs on production too, whose logs are public.
 *
 *   WHOP_API_KEY=… WHOP_ENV=production OPERATOR_COMPANY_ID=biz_… ADMIN_USER_ID=user_… \
 *     WHOP_APP_ID=app_… [CHECK_USER_ID=user_…] npx tsx scripts/ops/whop-access.ts
 *
 * CHECK_USER_ID (Inspect's `user_id` input): the id a refusal's detail line showed, asked about
 * instead of the founder, with whether it is the founder's, the app's creator's, and one the key
 * can read.
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
  // The user asked about: the founder (ADMIN_USER_ID), or the id a refusal's detail line showed
  // (Inspect's `user_id` input), to hear Whop's exact answer about it.
  const adminId = secretValue('ADMIN_USER_ID', process.env.ADMIN_USER_ID);
  const asked = process.env.CHECK_USER_ID?.trim() || null;
  const userId = asked ?? adminId;
  const who = asked ? 'the user asked about' : 'the founder';
  const env = parseWhopEnv(process.env.WHOP_ENV || undefined);
  const lines = [`### What Whop (${env}) answers about ${who} on the operator's community`, ''];
  if (asked && !/^user_[A-Za-z0-9]+$/.test(asked)) {
    console.info(lines[0]);
    console.info('Not asked: `user_id` is not a Whop user id.');
    process.exitCode = 1;
    return;
  }
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
    const headers = { Authorization: `Bearer ${key}`, 'Api-Version-Date': WHOP_API_VERSION_DATE };
    const appId = process.env.WHOP_APP_ID?.trim() || null;
    if (asked) {
      // Who the asked user is, without naming them: the founder's id, the app's creator, a user
      // the key can read at all (HTTP 404 here is an id Whop does not know).
      lines.push(`- The user asked about is ADMIN_USER_ID: ${asked === adminId}.`);
      if (appId) {
        const app = await fetch(`${WHOP_API_BASE_URL[env]}/apps/${appId}`, { headers });
        const body = (await app.json().catch(() => null)) as { creator?: { id?: unknown } } | null;
        lines.push(
          `- The user asked about created the app (WHOP_APP_ID): ${
            app.ok ? String(body?.creator?.id === asked) : `Whop answered HTTP ${app.status}`
          }.`,
        );
      }
      const user = await fetch(`${WHOP_API_BASE_URL[env]}/users/${asked}`, { headers });
      lines.push(`- Reading the user asked about with the key: HTTP ${user.status}.`);
    }
    // The access check, as the Worker makes it for the dashboard and the member view.
    try {
      const answer = await whop.checkAccess(userId, companyId);
      lines.push(
        `- Access of ${who} to the community: **${answer.accessLevel}** (has_access: ${
          answer.hasAccess
        }). The dashboard opens for \`admin\` only.`,
      );
    } catch (error) {
      lines.push(
        error instanceof WhopApiError
          ? `- Access check for ${who} refused: **HTTP ${error.status}** (${error.type}${
              error.details.code ? `, ${error.details.code}` : ''
            }). The Worker reads 400, 404 and 422 as « no access »: the key cannot reach this ` +
              'community (app not installed there, or not authorized by it), or does not know ' +
              'this user.'
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
    const read = await fetch(`${WHOP_API_BASE_URL[env]}/companies/${companyId}`, { headers });
    lines.push(`- Reading the community with the key: HTTP ${read.status}.`);
    // The experiences of the community the key can list, and the founder's access to each: the
    // member view asks Whop the same (requireMember), and a 404 there is an experience the key
    // cannot reach (another app's, the old production app's for one).
    const list = new URL(`${WHOP_API_BASE_URL[env]}/experiences`);
    list.searchParams.set('account_id', companyId);
    list.searchParams.set('first', '20');
    const listed = await fetch(list, { headers });
    const experiences = (await listed.json().catch(() => null)) as {
      data?: { id?: unknown; app?: { id?: unknown } }[];
    } | null;
    if (!listed.ok || !Array.isArray(experiences?.data)) {
      lines.push(`- Experiences of the community: Whop answered HTTP ${listed.status}.`);
    } else {
      const all = experiences.data.filter((e) => typeof e.id === 'string');
      const ours = appId ? all.filter((e) => e.app?.id === appId) : all;
      lines.push(
        `- Experiences of the community the key can list: ${all.length}` +
          (appId ? `, of which ${ours.length} of this app (WHOP_APP_ID).` : '.'),
      );
      for (const [index, experience] of ours.slice(0, 3).entries()) {
        const id = experience.id as string;
        let access: string;
        try {
          const answer = await whop.checkAccess(userId, id);
          access = `**${answer.accessLevel}** (has_access: ${answer.hasAccess})`;
        } catch (error) {
          access =
            error instanceof WhopApiError
              ? `refused, HTTP ${error.status} (${error.type})`
              : `failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        const one = await fetch(`${WHOP_API_BASE_URL[env]}/experiences/${id}`, { headers });
        lines.push(
          `  - Experience ${index + 1}: access of ${who} ${access}; reading it with the` +
            ` key: HTTP ${one.status}. The member view opens for \`admin\` or \`customer\`.`,
        );
      }
    }
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
