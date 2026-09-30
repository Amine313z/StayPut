import { describe, expect, it } from 'vitest';
import {
  canOpenCreatorView,
  canOpenMemberView,
  isAccessLevel,
  isCompanyId,
  isExperienceId,
  isUserId,
  isWhopId,
} from '../src';

describe('Whop identifiers', () => {
  it('accepts well-formed ids of the expected kind', () => {
    expect(isCompanyId('biz_2T7tC1fnFVo6d4')).toBe(true);
    expect(isUserId('user_v9KUoZvTGp6ID')).toBe(true);
    expect(isExperienceId('exp_XXXXXXXX')).toBe(true);
    expect(isWhopId('plan', 'plan_abc123')).toBe(true);
  });

  it('rejects another kind, an empty tail, odd characters and non-strings', () => {
    expect(isCompanyId('user_v9KUoZvTGp6ID')).toBe(false);
    expect(isCompanyId('biz_')).toBe(false);
    expect(isCompanyId("biz_1' or 1=1")).toBe(false);
    expect(isCompanyId('biz_abc/../x')).toBe(false);
    expect(isCompanyId(`biz_${'a'.repeat(65)}`)).toBe(false);
    expect(isUserId(undefined)).toBe(false);
    expect(isUserId(42)).toBe(false);
  });
});

describe('access levels', () => {
  it('knows the three levels Whop returns', () => {
    expect(isAccessLevel('admin')).toBe(true);
    expect(isAccessLevel('customer')).toBe(true);
    expect(isAccessLevel('no_access')).toBe(true);
    expect(isAccessLevel('owner')).toBe(false);
    expect(isAccessLevel(null)).toBe(false);
  });

  it('opens the creator view to the team only', () => {
    expect(canOpenCreatorView('admin')).toBe(true);
    expect(canOpenCreatorView('customer')).toBe(false);
    expect(canOpenCreatorView('no_access')).toBe(false);
  });

  it('opens the member view to members and to the team', () => {
    expect(canOpenMemberView('customer')).toBe(true);
    expect(canOpenMemberView('admin')).toBe(true);
    expect(canOpenMemberView('no_access')).toBe(false);
  });
});
