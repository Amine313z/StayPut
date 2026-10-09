/**
 * What Whop allows for StayPut's agent in a community (the founder's choice, 2026-10-09: the
 * members see the community's name and logo in the support chat, not « StayPut's agent »).
 * Sandbox only. It reads what the key may do, finds the agent, then sets the agent's name in
 * that community to the community's own (`PATCH /users/{agent}` with `account_id`, the profile
 * override an API key may write) and, with `PICTURE=1`, its picture to the community's logo
 * (`POST /files`, the bytes, then `profile_picture`). One line per step: the status and Whop's
 * own words when it refuses, never a key; ids are the sandbox's.
 *
 *   WHOP_API_KEY=… COMPANY=biz_… [PICTURE=1] npx tsx scripts/ops/agent-profile.ts
 */
import { appendFileSync } from 'node:fs';
import { WHOP_API_BASE_URL, WHOP_API_VERSION_DATE } from '@stayput/whop';
import { secretValue } from '../deploy/prepare';

const key = secretValue('WHOP_API_KEY', process.env.WHOP_API_KEY ?? '');
const company = process.env.COMPANY ?? '';
if (!/^biz_[A-Za-z0-9]+$/.test(company)) throw new Error('COMPANY must be a biz_… id');
const base = WHOP_API_BASE_URL.sandbox;

const lines: string[] = [];
function say(line: string): void {
  console.info(line);
  lines.push(line);
}

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'Api-Version-Date': WHOP_API_VERSION_DATE,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // Not JSON: its status says enough.
  }
  return { status: response.status, json };
}

/** Whop's own words when it refuses (never the request). */
function refusal(json: unknown): string {
  const error = (json as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === 'string' ? error.message.slice(0, 200) : '';
}

const record = (value: unknown) =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');

async function main() {
  // 1. What the key may do in this community.
  const actions = ['user:profile:update', 'company:authorized_user:read', 'company:basic:read'];
  const granted = await call(
    'GET',
    `/permissions?resource_id=${company}&actions=${actions.join(',')}`,
  );
  const rows = (record(granted.json).data as unknown[] | undefined) ?? [];
  say(
    `permissions: HTTP ${granted.status} ${rows
      .map(record)
      .map((p) => `${text(p.action)}=${p.granted === true ? 'yes' : 'no'}`)
      .join(' ')}`,
  );

  // 2. The community, its name and logo.
  const found = await call('GET', `/companies/${company}`);
  const title = text(record(found.json).title);
  const logo = record(record(found.json).logo).url;
  say(
    `company: HTTP ${found.status}, title ${title ? 'known' : 'missing'}, logo ${logo ? 'known' : 'missing'}`,
  );

  // 3. Who the agent is: « me » for the key, and the team's agent.
  const me = await call('GET', '/users/me');
  say(`users/me: HTTP ${me.status} ${refusal(me.json)} id ${text(record(me.json).id)}`);
  const team = await call('GET', `/team_members?account_id=${company}&first=50`);
  const members = (record(team.json).data as unknown[] | undefined) ?? [];
  const agent = members.map(record).find((m) => m.is_agent === true);
  let agentId = text(record(agent?.user).id);
  say(
    `team_members: HTTP ${team.status} ${refusal(team.json)} ${members.length} listed, agent ${agentId || 'not found'}`,
  );
  // Else the author of a message StayPut sent in a support chat (support_chat:read).
  const channels = await call('GET', `/support_channels?company_id=${company}&first=20`);
  const ids = ((record(channels.json).data as unknown[] | undefined) ?? [])
    .map((c) => text(record(c).id))
    .filter(Boolean);
  say(`support_channels: HTTP ${channels.status} ${refusal(channels.json)} ${ids.length} listed`);
  for (const channel of ids) {
    if (agentId) break;
    const messages = await call('GET', `/messages?channel_id=${channel}&first=50`);
    for (const message of (record(messages.json).data as unknown[] | undefined) ?? []) {
      const user = record(record(message).user);
      if (/agent/i.test(text(user.name)) || /agent/i.test(text(user.username))) {
        agentId = text(user.id);
        say(`agent found in a support chat: ${agentId} (${text(user.username)})`);
        break;
      }
    }
  }
  const target = agentId || text(record(me.json).id);
  if (!/^user_[A-Za-z0-9]+$/.test(target)) {
    // Which scope Whop asks for, on a user who does not exist: nothing can change.
    const nobody = await call('PATCH', '/users/user_ProbeNobody0001', {
      account_id: company,
      name: 'Probe',
    });
    say(`scope check (no such user): HTTP ${nobody.status} ${refusal(nobody.json)}`);
    say('No agent to update: stop.');
    return;
  }

  // 4. The agent's name in this community.
  const named = await call('PATCH', `/users/${target}`, {
    account_id: company,
    name: title || 'StayPut Test',
  });
  say(`name override: HTTP ${named.status} ${refusal(named.json)}`);

  // 5. Its picture: the community's logo, uploaded as a Whop file.
  if (process.env.PICTURE !== '1' || typeof logo !== 'string') return;
  const image = await fetch(logo, { signal: AbortSignal.timeout(15_000) });
  const bytes = new Uint8Array(await image.arrayBuffer());
  say(`logo: HTTP ${image.status}, ${bytes.length} bytes, ${image.headers.get('content-type')}`);
  const file = await call('POST', '/files', { filename: 'logo.png' });
  const fileId = text(record(file.json).id);
  const uploadUrl = record(file.json).upload_url;
  say(`file: HTTP ${file.status} ${refusal(file.json)} ${fileId || '-'}`);
  if (!fileId || typeof uploadUrl !== 'string') return;
  const put = await fetch(uploadUrl, { method: 'PUT', body: bytes });
  say(`upload: HTTP ${put.status}`);
  for (let i = 0; i < 10; i += 1) {
    const state = await call('GET', `/files/${fileId}`);
    const status = text(record(state.json).upload_status);
    say(`file status: ${status}`);
    if (status === 'ready') break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const pictured = await call('PATCH', `/users/${target}`, {
    account_id: company,
    profile_picture: { id: fileId },
  });
  say(`picture override: HTTP ${pictured.status} ${refusal(pictured.json)}`);
}

await main().finally(() => {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### StayPut's agent in ${company}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`,
    );
  }
});
