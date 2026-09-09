export const SkillIpcChannel = {
  Submit: 'skills:submitSkill',
  MarketplaceChanged: 'skills:marketplace-changed',
} as const;
export type SkillIpcChannel = typeof SkillIpcChannel[keyof typeof SkillIpcChannel];

/**
 * The skill package a member submits to the org's review queue. Desktop-
 * internal shape: the base64 zip travels under `zipBase64`, and the main-
 * process client maps it to the server's `zip` field (T8 `submissionSchema`
 * in `enterprise_server/src/routes/skillSubmissions.ts`). The org comes from
 * the caller's JWT, so there is no `orgId` here. The `scope` a member
 * suggests is advisory — the server stores it raw and the admin re-scopes
 * (sanitizing it) when the submission is approved.
 */
export interface SkillSubmitRequest {
  nameZh?: string;
  desc?: string;
  icon?: string;
  scope: { allCompany?: boolean; deptIds?: string[]; userIds?: string[] };
  zipBase64: string;
}
