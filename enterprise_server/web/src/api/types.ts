export interface Claims {
  sub: string;
  orgId: string;
  roles: string[];
}

export interface LoginRequest {
  orgName?: string;
  username: string;
  password: string;
}

export interface OrgSummary {
  id: string;
  name: string;
}

export interface OrgsResponse {
  orgs: OrgSummary[];
}

export interface LoginResponse {
  token: string;
}

export interface RefreshResponse {
  token: string;
}

export interface SetupStatus {
  superAdminExists: boolean;
  hasPendingInvite: boolean;
  setupCompletedAt: string | null;
}

export interface SetupStartResponse {
  orgId: string;
  orgName: string;
  code: string;
  expiresAt: string;
}

export interface SetupRedeemResponse {
  userId: string;
  token: string;
  orgId: string;
  orgName: string;
}
