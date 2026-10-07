/**
 * Deployment step (.github/workflows/deploy.yml, and Inspect): the Whop app's settings as Whop
 * holds them, compared with what this deployment serves, so that a path typed wrong in Whop's
 * dashboard stops the deployment instead of leaving StayPut blank inside Whop.
 *
 * - `settings`, before anything changes: the views' paths (WHOP_VIEW_PATHS), the permissions the
 *   app asks for (every one StayPut needs, none it never reads: SPEC 8.2), and its status. Read
 *   with `GET /apps/{id}`, which Whop answers without a key (checked on 2026-10-07); the app key
 *   goes along in case Whop shows it more.
 * - `reach <worker-url>`, once the Worker answers: the base URL when Whop shows it (it hides it
 *   from whoever is not a developer of the app's account), and in production `/health` asked
 *   through the app's origin on Whop, the relay Whop's frame loads StayPut through. Whop's page
 *   « App Base URL not set » there stops the deployment; StayPut's own answer proves the base
 *   URL; anything else is a warning (the relay may want a signed-in user).
 *
 * Production stops on a difference. The sandbox only reports: its app predates the Discover
 * view, still asks for the e-mail and phone permissions, and Whop's sandbox shows no app views.
 * Never prints a secret.
 *
 *   tsx scripts/deploy/check-app.ts settings apps/worker/wrangler.toml
 *   tsx scripts/deploy/check-app.ts reach apps/worker/wrangler.toml https://….workers.dev
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { WHOP_VIEW_PATHS, type WhopViewField } from '@stayput/core';
import {
  ALUMNI_PERMISSIONS,
  PHASE_2_PERMISSIONS,
  PHASE_4_PERMISSIONS,
  UNNEEDED_PERMISSIONS,
  WHOP_API_BASE_URL,
  WHOP_API_VERSION_DATE,
  parseWhopEnv,
  type WhopEnv,
} from '@stayput/whop';
import { deployedVar } from './check-whop';
import { secretValue } from './prepare';

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface Finding {
  /** ok: right; error: stops a production deployment; warning: to look at; note: nothing to do. */
  level: 'ok' | 'error' | 'warning' | 'note';
  text: string;
}

/** What StayPut checks of the app, from Whop's answer. */
export interface AppSettings {
  status: string | null;
  /** Null when Whop hides it (or none is set: the relay check tells which). */
  baseUrl: string | null;
  /** The app's own address on Whop, which serves StayPut inside Whop's frame. */
  origin: string | null;
  paths: Record<WhopViewField, string | null>;
  /** The permissions the app asks for; null when Whop listed none. */
  permissions: string[] | null;
}

/** The names Whop's Hosting settings give the paths. */
const PATH_LABELS: Readonly<Record<WhopViewField, string>> = {
  experience_path: 'App path',
  dashboard_path: 'Dashboard path',
  discover_path: 'Discover path',
};

const NEEDED: readonly string[] = [...PHASE_2_PERMISSIONS, ...PHASE_4_PERMISSIONS];
const KNOWN = new Set<string>([...NEEDED, ...ALUMNI_PERMISSIONS, ...UNNEEDED_PERMISSIONS]);

/** Whop's own page when its relay has no address for the app (seen in the sandbox). */
const NOT_SET_PAGE = 'App Base URL not set';

const RELAY_ATTEMPTS = 3;
const RELAY_DELAY_MS = 5_000;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whop's `GET /apps/{id}` answer, as far as StayPut needs it; null for anything else. */
export function readAppSettings(body: unknown): AppSettings | null {
  if (!isRecord(body) || typeof body.id !== 'string') return null;
  const asked = body.requested_permissions;
  const permissions = Array.isArray(asked)
    ? asked.flatMap((item): string[] => {
        const action =
          isRecord(item) && isRecord(item.permission_action)
            ? text(item.permission_action.action)
            : null;
        return action ? [action] : [];
      })
    : null;
  return {
    status: text(body.status),
    baseUrl: text(body.base_url),
    origin: text(body.origin),
    paths: {
      experience_path: text(body.experience_path),
      dashboard_path: text(body.dashboard_path),
      discover_path: text(body.discover_path),
    },
    permissions: permissions && permissions.length > 0 ? permissions : null,
  };
}

const shown = (value: string | null) => (value === null ? 'empty' : `"${value}"`);

/** The views' paths, the permissions and the status, against what StayPut serves and needs. */
export function settingsFindings(app: AppSettings, env: WhopEnv): Finding[] {
  const production = env === 'production';
  const findings: Finding[] = [];
  for (const field of Object.keys(WHOP_VIEW_PATHS) as WhopViewField[]) {
    const expected = WHOP_VIEW_PATHS[field];
    const actual = app.paths[field];
    const label = PATH_LABELS[field];
    findings.push(
      actual === expected
        ? { level: 'ok', text: `${label}: ${expected}` }
        : {
            // The sandbox app predates the Discover view; its other two views do matter there
            // (Whop's localhost mode opens them).
            level: production ? 'error' : field === 'discover_path' ? 'note' : 'warning',
            text:
              `${label} is ${shown(actual)} on Whop, StayPut serves ${expected}: type it by hand` +
              ' in Developer → StayPut → Hosting, then Save.',
          },
    );
  }

  if (app.permissions === null) {
    findings.push({
      level: production ? 'error' : 'warning',
      text: 'Whop lists no permission for the app: add them in Developer → StayPut → Permissions.',
    });
  } else {
    const asked = new Set(app.permissions);
    const missing = NEEDED.filter((permission) => !asked.has(permission));
    findings.push(
      missing.length === 0
        ? { level: 'ok', text: `Permissions: the ${NEEDED.length} StayPut needs are asked for.` }
        : {
            level: production ? 'error' : 'warning',
            text:
              `The app does not ask for ${missing.join(', ')}: StayPut cannot work without` +
              ` ${missing.length === 1 ? 'it' : 'them'}. Add ${missing.length === 1 ? 'it' : 'them'}` +
              ' in Developer → StayPut → Permissions.',
          },
    );
    const alumni = ALUMNI_PERMISSIONS.filter((permission) => !asked.has(permission));
    if (alumni.length > 0) {
      findings.push({
        level: 'note',
        text: `The Alumni offer's permissions are not asked for (${alumni.join(', ')}): the offer stays off.`,
      });
    }
    const unneeded = UNNEEDED_PERMISSIONS.filter((permission) => asked.has(permission));
    if (unneeded.length > 0) {
      findings.push({
        level: production ? 'error' : 'note',
        text:
          `The app asks for ${unneeded.join(' and ')}, which StayPut never reads (SPEC 8.2):` +
          ' remove them in Developer → StayPut → Permissions.',
      });
    }
    const unknown = [...asked].filter((permission) => !KNOWN.has(permission)).sort();
    if (unknown.length > 0) {
      findings.push({
        level: 'warning',
        text: `The app asks for permissions StayPut does not use: ${unknown.join(', ')}.`,
      });
    }
  }
  findings.push({ level: 'note', text: `Status on Whop: ${app.status ?? 'not given'}.` });
  return findings;
}

/** An address as Whop and StayPut compare it: no trailing slash. */
const bare = (url: string) => url.replace(/\/+$/, '');

/** The base URL, when Whop shows it, against the address StayPut answers at. */
export function baseUrlFinding(app: AppSettings, publicUrl: string, env: WhopEnv): Finding {
  if (app.baseUrl === null) {
    return {
      level: 'note',
      text:
        'Base URL: Whop shows it only to the developers of the app' +
        (env === 'production' ? ', so StayPut is asked through Whop below.' : '.'),
    };
  }
  return bare(app.baseUrl) === bare(publicUrl)
    ? { level: 'ok', text: `Base URL: ${bare(publicUrl)}` }
    : {
        level: env === 'production' ? 'error' : 'warning',
        text:
          `Base URL is "${app.baseUrl}" on Whop, StayPut answers at ${bare(publicUrl)}: type it` +
          ' in Developer → StayPut → Hosting, then Save.',
      };
}

export type RelayAnswer =
  | { kind: 'stayput' }
  /** StayPut answered, but a deployment of the other environment. */
  | { kind: 'wrong_env'; whopEnv: string }
  | { kind: 'not_set' }
  | { kind: 'other' };

/** What Whop's relay answered to `/health`. */
export function relayAnswer(body: string, env: WhopEnv): RelayAnswer {
  if (body.includes(NOT_SET_PAGE)) return { kind: 'not_set' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: 'other' };
  }
  if (!isRecord(parsed) || parsed.status !== 'ok') return { kind: 'other' };
  return parsed.whopEnv === env
    ? { kind: 'stayput' }
    : { kind: 'wrong_env', whopEnv: String(parsed.whopEnv) };
}

/**
 * `/health` through the app's origin on Whop, as Whop's frame reaches StayPut. Asked a few times
 * a few seconds apart: Whop may take a moment to follow a change of its settings.
 */
export async function checkRelay(
  origin: string | null,
  env: WhopEnv,
  publicUrl: string,
  inject: { fetch?: Fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Finding> {
  if (env !== 'production') {
    return {
      level: 'note',
      text:
        "Whop's sandbox shows no app views (its frames go through the production relay, which" +
        ' knows only production apps): the relay is checked in production.',
    };
  }
  if (!origin || !/^https:\/\/[a-z0-9.-]+$/.test(bare(origin))) {
    return { level: 'warning', text: 'Whop gives the app no origin: its relay was not checked.' };
  }
  const send: Fetch = inject.fetch ?? ((url, init) => fetch(url, init));
  const sleep =
    inject.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const url = `${bare(origin)}/health`;
  let last: { status: number; type: string; answer: RelayAnswer } | null = null;
  for (let attempt = 1; attempt <= RELAY_ATTEMPTS; attempt += 1) {
    try {
      const response = await send(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/json' },
      });
      const body = (await response.text()).slice(0, 65_536);
      last = {
        status: response.status,
        type: response.headers.get('content-type') ?? '',
        answer: relayAnswer(body, env),
      };
      if (last.answer.kind === 'stayput') {
        return { level: 'ok', text: `Whop's relay (${bare(origin)}) reaches StayPut: /health ok.` };
      }
    } catch {
      last = null;
    }
    if (attempt < RELAY_ATTEMPTS) await sleep(RELAY_DELAY_MS);
  }
  if (!last) {
    return { level: 'warning', text: `Could not reach Whop's relay (${bare(origin)}).` };
  }
  switch (last.answer.kind) {
    case 'not_set':
      return {
        level: 'error',
        text:
          `Whop's relay (${bare(origin)}) answers « ${NOT_SET_PAGE} »: the base URL is missing.` +
          ` Type ${bare(publicUrl)} in Developer → StayPut → Hosting, then Save.`,
      };
    case 'wrong_env':
      return {
        level: 'error',
        text:
          `Whop's relay reaches the ${last.answer.whopEnv} StayPut: the app's base URL must be` +
          ` ${bare(publicUrl)} (Developer → StayPut → Hosting).`,
      };
    default:
      return {
        level: 'warning',
        text:
          `Whop's relay answered HTTP ${last.status}${last.type ? ` (${last.type.split(';')[0]})` : ''}` +
          ': StayPut could not be confirmed through it. Open StayPut in your community to check.',
      };
  }
}

export type AppRead =
  | { found: true; app: AppSettings }
  | { found: false; reason: 'missing' | 'unreachable'; detail: string };

/** `GET /apps/{id}`, with the app key when there is one, and again without if Whop refuses it. */
export async function readApp(
  appId: string,
  env: WhopEnv,
  apiKey: string | null,
  inject: { fetch?: Fetch } = {},
): Promise<AppRead> {
  const send: Fetch = inject.fetch ?? ((url, init) => fetch(url, init));
  const url = `${WHOP_API_BASE_URL[env]}/apps/${encodeURIComponent(appId)}`;
  const ask = async (key: string | null) => {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'Api-Version-Date': WHOP_API_VERSION_DATE,
    };
    if (key) headers.authorization = `Bearer ${key}`;
    return send(url, { headers, signal: AbortSignal.timeout(15_000) });
  };
  try {
    let response = await ask(apiKey);
    if (apiKey && (response.status === 401 || response.status === 403)) response = await ask(null);
    if (response.status === 404) {
      return { found: false, reason: 'missing', detail: `Whop (${env}) has no app ${appId}` };
    }
    if (!response.ok) {
      return {
        found: false,
        reason: 'unreachable',
        detail: `Whop answered HTTP ${response.status}`,
      };
    }
    const app = readAppSettings(await response.json().catch(() => null));
    return app
      ? { found: true, app }
      : { found: false, reason: 'unreachable', detail: 'Whop answered something else than an app' };
  } catch (error) {
    return {
      found: false,
      reason: 'unreachable',
      detail: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

const MARKS: Readonly<Record<Finding['level'], string>> = {
  ok: '✅',
  error: '❌',
  warning: '⚠️',
  note: 'ℹ️',
};

async function main() {
  const [mode, tomlPath, workerUrl = ''] = process.argv.slice(2);
  if ((mode !== 'settings' && mode !== 'reach') || !tomlPath) {
    throw new Error('usage: check-app.ts settings|reach <wrangler.toml> [https://<the Worker>]');
  }
  if (mode === 'reach' && !/^https:\/\/[a-z0-9.-]+$/.test(workerUrl)) {
    throw new Error('usage: check-app.ts reach <wrangler.toml> https://<the Worker address>');
  }
  const toml = readFileSync(tomlPath, 'utf8');
  const env = parseWhopEnv(deployedVar('WHOP_ENV', process.env.WHOP_ENV, toml));
  const appId = deployedVar('WHOP_APP_ID', process.env.WHOP_APP_ID, toml) ?? '';
  const title = `### The Whop app (${env}): ${mode === 'settings' ? 'its settings' : 'reaching StayPut'}`;
  let findings: Finding[];
  if (!/^app_[A-Za-z0-9]+$/.test(appId)) {
    findings = [
      {
        level: env === 'production' ? 'error' : 'note',
        text: 'WHOP_APP_ID is not an app id (app_…): the app was not checked.',
      },
    ];
  } else {
    const apiKey = secretValue('WHOP_API_KEY', process.env.WHOP_API_KEY) || null;
    const read = await readApp(appId, env, apiKey);
    if (!read.found) {
      findings = [
        read.reason === 'missing'
          ? {
              level: env === 'production' ? 'error' : 'warning',
              text: `${read.detail}: WHOP_APP_ID must be the id of the ${env} app (app_…).`,
            }
          : { level: 'warning', text: `Could not read the app's settings: ${read.detail}.` },
      ];
    } else if (mode === 'settings') {
      findings = [{ level: 'note', text: `App: ${appId}` }, ...settingsFindings(read.app, env)];
    } else {
      const publicUrl = process.env.STAYPUT_URL?.trim() || workerUrl;
      findings = [
        baseUrlFinding(read.app, publicUrl, env),
        await checkRelay(read.app.origin, env, publicUrl),
      ];
    }
  }
  const summary = [title, ''];
  for (const { level, text: line } of findings) {
    console.info(
      level === 'error' ? `::error::${line}` : level === 'warning' ? `::warning::${line}` : line,
    );
    summary.push(`- ${MARKS[level]} ${line}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  }
  const errors = findings.filter((finding) => finding.level === 'error').length;
  if (errors > 0) {
    throw new Error(
      `The Whop app differs from what StayPut serves (${errors} to fix, listed above): fix it on` +
        ' whop.com, then run the deployment again.',
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
