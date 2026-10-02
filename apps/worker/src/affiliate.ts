import { parseAffiliateUrl } from '@stayput/core';
import type { WhopClient } from '@stayput/whop';

/**
 * The member's own affiliate link to the community (SPEC 5.6), read from Whop: their affiliate
 * record in the company, then the product page link of one of its per-variant commissions (a
 * revenue share has no link). Whop makes a link only once the creator sets a commission, which
 * is theirs to decide: StayPut reads it, never creates one. Null when there is none, or when the
 * app may not read affiliates (`affiliate:basic:read`): the member then pastes theirs.
 */
export async function memberAffiliateLink(
  whop: WhopClient,
  companyId: string,
  userId: string,
): Promise<string | null> {
  try {
    const user = await whop.request<{ username?: unknown }>(
      'GET',
      `/users/${encodeURIComponent(userId)}`,
    );
    if (typeof user.username !== 'string' || !user.username) return null;
    // Whop searches affiliates by username; the user's id says which one is the member.
    const affiliates = await whop.listPage<{ id?: unknown; user?: { id?: unknown } }>(
      '/affiliates',
      { account_id: companyId, query: user.username, status: 'active' },
      { first: 20 },
    );
    const affiliate = affiliates.items.find((a) => a.user?.id === userId);
    if (typeof affiliate?.id !== 'string') return null;
    const overrides = await whop.listPage<{
      product_direct_link?: unknown;
      checkout_direct_link?: unknown;
    }>(
      `/affiliates/${encodeURIComponent(affiliate.id)}/overrides`,
      { override_type: 'standard' },
      { first: 20 },
    );
    for (const override of overrides.items) {
      for (const link of [override.product_direct_link, override.checkout_direct_link]) {
        const url = parseAffiliateUrl(link);
        if (url) return url;
      }
    }
    return null;
  } catch (error) {
    // Most often the app may not read affiliates: the member pastes their link.
    console.error('Affiliate link not read:', error instanceof Error ? error.message : error);
    return null;
  }
}
