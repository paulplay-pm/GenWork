// Mirror of enterprise_server/src/sso/bindingTypes.ts. The web does not
// import server code (the server is Hono + pg, the web is Vite + React).
// Keep this in sync with the server — the integration test in
// tests/api/ssoBindings.test.ts asserts the wire shape matches.
//
// Per desktop Rulings 1+2: NO `description` (no schema column) and NO
// `boundAt` (no migration added it). If a future migration adds them,
// mirror here AND in the server.
export interface SsoConnectionWithBinding {
  id: string;
  name: string;
  providerType: string;
  sortOrder: number;
  enabled: boolean;
  /** Absolute URL for <img src>, or null. Server's resolveProviderLogoUrl
   *  fills this — see enterprise_server/src/sso/logos.ts. */
  logoUrl: string | null;
  bound: boolean;
  externalId: string | null;
}
