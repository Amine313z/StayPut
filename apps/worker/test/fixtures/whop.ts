/**
 * Whop objects as the API returns them (shapes of the API reference, 2026-09-29), with only the
 * fields StayPut reads plus the personal ones it must ignore (email, phone).
 */

export const member = (id: string, user: string, over: Record<string, unknown> = {}) => ({
  id,
  access_level: 'customer',
  created_at: '2026-06-01T10:00:00.000Z',
  joined_at: '2026-06-01T10:00:00.000Z',
  most_recent_action_at: '2026-09-20T18:00:00.000Z',
  phone: '+33600000000',
  status: 'joined',
  usd_total_spent: 120,
  user: {
    id: user,
    name: `Name ${user}`,
    username: user.replace('user_', ''),
    email: `${user}@mail.test`,
  },
  ...over,
});

export const variant = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  billing_period: 30,
  currency: 'usd',
  initial_price: 0,
  plan_type: 'renewal',
  product: { id: 'prod_P1' },
  renewal_price: 49,
  ...over,
});

export const membership = (id: string, user: string, over: Record<string, unknown> = {}) => ({
  id,
  account: { id: 'biz_A1' },
  billing_period_days: 30,
  cancel_at_period_end: false,
  canceled_at: null,
  created_at: '2026-06-01T10:00:00.000Z',
  current_period_end: '2026-10-15T10:00:00.000Z',
  member: { access_level: 'customer', last_accessed_at: '2026-09-20T18:00:00.000Z' },
  phone_number: '+33600000000',
  plan_id: 'plan_V1',
  product_id: 'prod_P1',
  status: 'active',
  user_id: user,
  ...over,
});

export const payment = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  created_at: '2026-09-01T10:00:00.000Z',
  currency: 'usd',
  customer_email: 'someone@mail.test',
  failure_message: null,
  member_id: 'mber_M1',
  membership_id: 'mem_S1',
  next_payment_attempt_at: null,
  paid_at: '2026-09-01T10:00:05.000Z',
  promo_code_id: null,
  recovery_url: null,
  retryable: false,
  status: 'paid',
  substatus: 'succeeded',
  total: { amount: '49.00', currency: 'usd', decimals: 2, display_decimals: 2 },
  ...over,
});

export const message = (
  id: string,
  user: string,
  at: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  content: 'never stored',
  created_at: at,
  message_type: 'regular',
  user: { id: user, name: null, username: 'x' },
  ...over,
});

export const page = (data: unknown[], endCursor: string | null = null, hasNext = false) => ({
  data,
  page_info: { end_cursor: endCursor, has_next_page: hasNext },
});
