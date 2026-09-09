import { describe, expect, test, vi } from 'vitest';

import { EnterpriseApiErrorCode } from '../../shared/enterpriseAccount/constants';
import {
  createEnterpriseAuthSessionSnapshot,
  createEnterpriseMembershipRevocationHandler,
  type EnterpriseAuthSessionSnapshot,
  EnterpriseMembershipRevocationSource,
  readEnterpriseApiErrorCode,
  resolveEnterpriseMembershipRevocationSource,
} from './membershipRevocation';

const enterpriseSession = (
  enterpriseId: number,
  accountGeneration: number,
): EnterpriseAuthSessionSnapshot => ({
  enterpriseId,
  ownerAccountKey: `enterprise:user@example.com:${enterpriseId}`,
  accountGeneration,
});

describe('enterprise membership revocation', () => {
  test('creates snapshots only for the matching enterprise account scope', () => {
    expect(createEnterpriseAuthSessionSnapshot(enterpriseSession(1001, 3), 1001))
      .toEqual(enterpriseSession(1001, 3));
    expect(createEnterpriseAuthSessionSnapshot(enterpriseSession(1001, 3), 1002)).toBeNull();
    expect(createEnterpriseAuthSessionSnapshot({
      ownerAccountKey: 'personal:user@example.com',
      accountGeneration: 3,
    }, 1001)).toBeNull();
  });

  test('invalidates the current enterprise session once for code 41602', () => {
    let currentSession: EnterpriseAuthSessionSnapshot | null = enterpriseSession(1001, 3);
    const invalidateCurrentSession = vi.fn();
    const handleRevocation = createEnterpriseMembershipRevocationHandler({
      getCurrentSession: () => currentSession,
      invalidateCurrentSession,
    });
    const event = {
      code: EnterpriseApiErrorCode.NotMember,
      source: EnterpriseMembershipRevocationSource.LlmSse,
      requestSession: enterpriseSession(1001, 3),
    };

    expect(handleRevocation(event)).toBe(true);
    expect(handleRevocation(event)).toBe(false);
    expect(invalidateCurrentSession).toHaveBeenCalledOnce();

    currentSession = null;
    expect(handleRevocation(event)).toBe(false);
  });

  test('ignores an old enterprise or account generation after identity switching', () => {
    let currentSession: EnterpriseAuthSessionSnapshot | null = enterpriseSession(1002, 4);
    const invalidateCurrentSession = vi.fn();
    const handleRevocation = createEnterpriseMembershipRevocationHandler({
      getCurrentSession: () => currentSession,
      invalidateCurrentSession,
    });

    expect(handleRevocation({
      code: EnterpriseApiErrorCode.NotMember,
      source: EnterpriseMembershipRevocationSource.LlmSse,
      requestSession: enterpriseSession(1001, 3),
    })).toBe(false);
    expect(handleRevocation({
      code: EnterpriseApiErrorCode.NotMember,
      source: EnterpriseMembershipRevocationSource.LlmSse,
      requestSession: enterpriseSession(1002, 3),
    })).toBe(false);
    expect(invalidateCurrentSession).not.toHaveBeenCalled();

    currentSession = enterpriseSession(1002, 5);
    expect(handleRevocation({
      code: EnterpriseApiErrorCode.NotMember,
      source: EnterpriseMembershipRevocationSource.JsonApi,
      requestSession: enterpriseSession(1002, 5),
    })).toBe(true);
  });

  test('ignores non-membership errors', () => {
    const invalidateCurrentSession = vi.fn();
    const handleRevocation = createEnterpriseMembershipRevocationHandler({
      getCurrentSession: () => enterpriseSession(1001, 3),
      invalidateCurrentSession,
    });

    expect(handleRevocation({
      code: EnterpriseApiErrorCode.EnterprisePoolExhausted,
      source: EnterpriseMembershipRevocationSource.LlmSse,
      requestSession: enterpriseSession(1001, 3),
    })).toBe(false);
    expect(invalidateCurrentSession).not.toHaveBeenCalled();
    expect(readEnterpriseApiErrorCode({ code: 41602 })).toBe(41602);
    expect(readEnterpriseApiErrorCode({ code: '41602' })).toBe(41602);
    expect(readEnterpriseApiErrorCode({ code: 'not-a-code' })).toBeNull();
  });

  test('classifies JSON response sources without logging request details', () => {
    expect(resolveEnterpriseMembershipRevocationSource('https://server/api/enterprise/context'))
      .toBe(EnterpriseMembershipRevocationSource.EnterpriseContext);
    expect(resolveEnterpriseMembershipRevocationSource('https://server/api/html-shares/1'))
      .toBe(EnterpriseMembershipRevocationSource.JsonApi);
    expect(resolveEnterpriseMembershipRevocationSource('not-a-url /api/user/profile-summary'))
      .toBe(EnterpriseMembershipRevocationSource.JsonApi);
  });

  test('EnterpriseMembershipRevocationSource no longer includes publisher sources', () => {
    expect(EnterpriseMembershipRevocationSource.Models).toBeUndefined();
    expect(EnterpriseMembershipRevocationSource.Profile).toBeUndefined();
    expect(EnterpriseMembershipRevocationSource.Quota).toBeUndefined();
    expect(EnterpriseMembershipRevocationSource.Refresh).toBeUndefined();
    expect(EnterpriseMembershipRevocationSource.EnterpriseContext).toBeDefined();
    expect(EnterpriseMembershipRevocationSource.JsonApi).toBeDefined();
    expect(EnterpriseMembershipRevocationSource.LlmSse).toBeDefined();
  });
});
