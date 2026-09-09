/** Row shape for `GET /me/sso-binding/connections`. The server fills
 *  `logoUrl` as an absolute URL so the renderer never has to rebuild
 *  it from a relative path. Mirrored by hand from
 *  `enterprise_server/src/sso/bindingTypes.ts` — keep in sync.
 *  No `description` / `boundAt` fields: the underlying schema
 *  doesn't have them (per ledger Rulings 1 + 2 of plan
 *  2026-10-13-sso-binding-management-page).
 *  The renderer test asserts field equality with the server's response
 *  via the live integration fixture. */
export interface SsoConnectionWithBinding {
  id: string;
  name: string;
  providerType: string;
  sortOrder: number;
  enabled: boolean;
  /** Absolute URL the login UI uses as the SSO button's <img src>, or
   *  null when neither a per-connection logo_url nor a built-in
   *  default exists for this provider type. */
  logoUrl: string | null;
  bound: boolean;
  externalId: string | null;
}

/** IPC channel names for the desktop SSO self-binding surface. The
 *  server-side counterparts live under `/me/sso-binding/*`. */
export const SSO_BINDING_IPC = {
  List: 'sso:listMyBindings',
  Unbind: 'sso:unbindMyConnection',
  Start: 'sso:startMyBinding',
} as const;
export type SsoBindingIpc = typeof SSO_BINDING_IPC[keyof typeof SSO_BINDING_IPC];