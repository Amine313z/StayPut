/**
 * Deployment step (.github/workflows/deploy.yml): asks Whop whether it accepts WHOP_API_KEY,
 * with the very call the Worker makes (`checkAccess`), about a user that does not exist. Whop
 * answers 401 to a key it refuses and 404 to a key it accepts (checked in the sandbox on
 * 2026-09-30), so a key copied wrong stops the deployment here instead of breaking StayPut inside
 * Whop's iframe. Whop being unreachable is only a warning. Never prints the key.
 *
 *   tsx scripts/deploy/check-whop.ts apps/worker/wrangler.toml
 */
import { readFileSync } from 'node:fs';
import { WhopApiError, createWhopClient, parseWhopEnv, type WhopEnv } from '@stayput/whop';
import { secretValue } from './prepare';

/** A user and an account that do not exist: only the key is on trial. */
const PROBE_USER = 'user_xxxxxxxxxxxxx';
const PROBE_ACCOUNT = 'biz_xxxxxxxxxxxxxx';

export type KeyCheck = 'accepted' | 'refused' | 'unreachable';

/** A `[vars]` value as deployed: the repository variable when set, else wrangler.toml's. */
export function deployedVar(
  name: string,
  variable: string | undefined,
  toml: string,
): string | undefined {
  const override = variable?.trim();
  if (override) return override;
  return new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'm').exec(toml)?.[1];
}

export async function checkWhopKey(
  apiKey: string,
  env: WhopEnv,
  inject: {
    fetch?: (input: string, init: RequestInit) => Promise<Response>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ check: KeyCheck; detail: string }> {
  // Spaces or line breaks cannot travel in a header: Whop would never see such a key.
  if (!/^\S+$/.test(apiKey)) return { check: 'refused', detail: 'not one single value' };
  const whop = createWhopClient({ apiKey, env, ...inject });
  try {
    await whop.checkAccess(PROBE_USER, PROBE_ACCOUNT);
    return { check: 'accepted', detail: 'access check answered' };
  } catch (error) {
    if (error instanceof WhopApiError) {
      const detail = `${error.status} ${error.type}`;
      if (error.status === 401) return { check: 'refused', detail };
      // 404 (no such user) is the expected answer; any other refusal of the request, not of the
      // key, proves the key too. Status 0 is a network failure, not an answer.
      const answered = error.status >= 200 && error.status < 500;
      if (answered && ![408, 429].includes(error.status)) return { check: 'accepted', detail };
      return { check: 'unreachable', detail: `${detail}: ${error.message}` };
    }
    return { check: 'unreachable', detail: error instanceof Error ? error.message : 'unknown' };
  }
}

async function main() {
  const [tomlPath] = process.argv.slice(2);
  if (!tomlPath) throw new Error('usage: check-whop.ts <wrangler.toml>');
  const apiKey = secretValue('WHOP_API_KEY', process.env.WHOP_API_KEY);
  if (!apiKey) {
    console.info('WHOP_API_KEY is not set: nothing to check.');
    return;
  }
  const toml = readFileSync(tomlPath, 'utf8');
  const env = parseWhopEnv(deployedVar('WHOP_ENV', process.env.WHOP_ENV, toml));
  const { check, detail } = await checkWhopKey(apiKey, env);
  if (check === 'refused') {
    throw new Error(
      `Whop (${env}) refuses WHOP_API_KEY (${detail}): store the app's key again, the value` +
        ' after "WHOP_API_KEY=" (it starts with apik_), and check that WHOP_ENV matches the key.',
    );
  }
  if (check === 'unreachable') {
    console.warn(`::warning::Could not ask Whop (${env}) about WHOP_API_KEY: ${detail}.`);
  } else {
    console.info(`Whop (${env}) accepts WHOP_API_KEY (${detail} for a test user, as expected).`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
