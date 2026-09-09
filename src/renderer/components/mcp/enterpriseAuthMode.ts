import { McpAuthMethod } from '../../../shared/mcp/constants';
import type { McpEnterpriseMarketServer } from '../../types/mcp';

/**
 * Map an enterprise connector's wire `authMode` (6 modes) to the local
 * `McpAuthMethod` the install form should pre-fill. The downstream
 * `deriveAuthStatus` (mcpStore) then turns a non-None method with no
 * credential into the `needs-auth` state (orange dot + Connect button), which
 * is the spec's 待配置 affordance.
 *
 * - User-credential direct-link modes map to their real method:
 *   `user-oauth`/`sso` → OAuth (both drive the same generic PKCE flow off the
 *   connector's own endpoints), `user-key` → ApiKey.
 * - Org-credential modes (shared-key / client-creds) map to a neutral
 *   placeholder: the org key is gateway-injected in the MCP-gateway plan, so
 *   the desktop just parks them in needs-auth.
 */
export function mapEnterpriseAuthModeToMcpAuthMethod(
  authMode: McpEnterpriseMarketServer['authMode']
): McpAuthMethod {
  switch (authMode) {
    case 'none':
      return McpAuthMethod.None;
    case 'user-key':
      return McpAuthMethod.ApiKey;
    case 'user-oauth':
      return McpAuthMethod.OAuth;
    case 'sso':
      return McpAuthMethod.OAuth;
    case 'shared-key':
    case 'client-creds':
      return McpAuthMethod.Bearer;
    default:
      return McpAuthMethod.None;
  }
}
