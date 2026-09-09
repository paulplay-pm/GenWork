// enterprise_server/src/sso/bindingTypes.ts
// Type definitions for the user-facing SSO binding management surface.
//
// `SsoConnectionWithBinding` is the row shape returned by
// `GET /me/sso-binding/connections`: every enabled SSO connection in
// the caller's org, annotated with the caller's binding status so the
// desktop can render a "Bound" / "Not bound" badge without a second
// round-trip.

/** Row shape for `GET /me/sso-binding/connections` — every enabled
 *  connection in the caller's org, annotated with the caller's binding
 *  status. `bound: false` rows have `externalId` as null.
 *  The server fills `logoUrl` (absolute) so the client never has to
 *  rebuild it from a relative path. */
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
