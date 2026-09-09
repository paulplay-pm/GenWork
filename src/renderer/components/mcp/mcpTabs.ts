/**
 * MCP management tabs.
 *
 * Custom servers are not a separate place: a hand-configured server is
 * installed just like one from the marketplace, so it lives in Installed and
 * "add" is a toolbar action rather than a tab.
 */
export const McpTab = {
  Installed: 'installed',
  Marketplace: 'marketplace',
  EnterpriseMarket: 'enterprise-market',
} as const;
export type McpTab = typeof McpTab[keyof typeof McpTab];

/** Enterprise market leads: browsing comes first, matching the requested order. */
export const MCP_TAB_ORDER: readonly McpTab[] = [
  McpTab.EnterpriseMarket,
  McpTab.Marketplace,
  McpTab.Installed,
];

export const MCP_TAB_LABEL_KEYS: Record<McpTab, string> = {
  [McpTab.Installed]: 'mcpInstalled',
  [McpTab.Marketplace]: 'mcpMarketplace',
  [McpTab.EnterpriseMarket]: 'mcpEnterpriseMarketplace',
};
