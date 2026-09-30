// Phase 0 check: does "Invite to a Membership" work on a Whop sandbox account?
// It is an experimental endpoint, reserved to accounts Whop has enabled (403 otherwise).
//
//   WHOP_SANDBOX_API_KEY=... node scripts/sandbox/check-invite.mjs you+test@example.com
//   WHOP_SANDBOX_API_KEY=... node scripts/sandbox/check-invite.mjs --user user_xxx
//   add --cleanup to delete the test variant and product afterwards
//
// Behind an HTTP proxy (Claude Code cloud sessions), Node's fetch ignores HTTPS_PROXY unless
// NODE_USE_ENV_PROXY=1 is set (Node >= 22.21).
//
// Needs an account API key from sandbox.whop.com with access_pass:create, plan:create and
// membership:create. Creates a hidden product and a free hidden variant (the "Alumni" offer of
// SPEC.md 5.9), sends the invitation and prints Whop's answers. Never prints the key.

const BASE = 'https://sandbox-api.whop.com/api/v1';
const API_VERSION_DATE = '2026-09-29';

const key = process.env.WHOP_SANDBOX_API_KEY;
if (!key) {
  console.error('Set WHOP_SANDBOX_API_KEY (a sandbox account API key).');
  process.exit(1);
}
const args = process.argv.slice(2);
const cleanup = args.includes('--cleanup');
const userFlag = args.indexOf('--user');
const recipient =
  userFlag >= 0 ? { user_id: args[userFlag + 1] } : { email: args.find((a) => a.includes('@')) };
if (!recipient.user_id && !recipient.email) {
  console.error('Pass an e-mail address to invite, or --user user_xxx.');
  process.exit(1);
}

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'api-version-date': API_VERSION_DATE,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  console.info(`${method} ${path} -> ${response.status}`);
  return { status: response.status, json };
}

const account = await call('GET', '/accounts/me');
if (account.status !== 200) {
  console.error(account.json);
  process.exit(1);
}
const accountId = account.json.id;
console.info(`account: ${accountId}`);

const product = await call('POST', '/products', {
  account_id: accountId,
  title: 'StayPut Alumni (sandbox check)',
  description: 'News and comeback offers for former members.',
  visibility: 'hidden',
});
if (product.status >= 300) {
  console.error(product.json);
  process.exit(1);
}

// The current docs call them variants; SDK 2.0.0 still calls them plans. Try both.
const variantBody = {
  account_id: accountId,
  product_id: product.json.id,
  title: 'Alumni',
  plan_type: 'one_time',
  initial_price: 0,
  visibility: 'hidden',
};
let variant = await call('POST', '/variants', variantBody);
let variantPath = '/variants';
if (variant.status === 404) {
  variant = await call('POST', '/plans', variantBody);
  variantPath = '/plans';
}
if (variant.status >= 300) {
  console.error(variant.json);
  process.exit(1);
}
console.info(`free variant: ${variant.json.id} via ${variantPath}`);
console.info(`fallback link (purchase_url): ${variant.json.purchase_url}`);

const invite = await call('POST', '/memberships/invite', {
  plan_id: variant.json.id,
  ...recipient,
});
console.info('invite answer:', JSON.stringify(invite.json));
console.info(
  invite.status === 202
    ? 'RESULT: invitation sent. The endpoint works on this account.'
    : invite.status === 403
      ? 'RESULT: 403. The key lacks membership:create, or the account is not enabled for invitations: use the fallback link.'
      : 'RESULT: unexpected answer, see above.',
);

if (cleanup) {
  await call('DELETE', `${variantPath}/${variant.json.id}`);
  await call('DELETE', `/products/${product.json.id}`);
}
