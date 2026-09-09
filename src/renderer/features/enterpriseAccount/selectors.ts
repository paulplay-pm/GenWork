import { isEnterpriseAccountOwnerKey } from '../../../shared/auth/accountOwner';
import { AuthSubscriptionStatus } from '../../../shared/auth/constants';
import {
  EnterpriseAccountMode,
  EnterpriseMemberRole,
} from '../../../shared/enterpriseAccount/constants';
import type { RootState } from '../../store';

export const selectEnterpriseAccountContext = (state: RootState) => (
  state.enterpriseAccount.context
);

export const selectIsEnterpriseAccount = (state: RootState): boolean => {
  // ENTERPRISE_SERVER_URL is configured → the multi-tenant enterprise bridge
  // is the active source of truth. In that mode the legacy youdao redux never
  // populates, but the user IS logged into the enterprise server, so this
  // selector must return true. The chat-send modal uses it to swap the
  // youdao "去登录" CTA for the enterprise "contact admin" copy per
  // docs/superpowers/specs/2026-08-27-desktop-youdao-disconnect-design.md §4.7.
  if (
    typeof window !== 'undefined'
    && (window as unknown as { electron?: { enterpriseMt?: unknown } })
      .electron?.enterpriseMt
  ) {
    return true;
  }
  return (
    state.enterpriseAccount.context !== null ||
    isEnterpriseAccountOwnerKey(state.auth.ownerAccountKey) ||
    state.auth.user?.accountMode === EnterpriseAccountMode.Enterprise ||
    state.auth.quota?.accountMode === EnterpriseAccountMode.Enterprise ||
    state.auth.quota?.subscriptionStatus === AuthSubscriptionStatus.Enterprise
  );
};

export const selectIsEnterpriseSuperAdmin = (state: RootState): boolean => (
  state.enterpriseAccount.context?.role === EnterpriseMemberRole.SuperAdmin
);
