/** IM channels an enterprise agent can be enabled for (the "IM 渠道" tab).
 *
 * Mirrors the desktop `PlatformRegistry` china-region list — same platform ids
 * (the `im_channels` array stores these ids) and the same display order. The
 * desktop honors the stored set when it uses the agent. Logos are copied from
 * the desktop `public/` assets into `web/public/im-logos/` and served at the
 * `/im-logos/` root by Vite. */
export interface ImChannelDef {
  /** Platform id stored in the agent's `im_channels` array. */
  id: string;
  /** Display name (zh primary, matching the desktop IM UI). */
  name: string;
  /** Logo path served from `web/public/im-logos/`. */
  logo: string;
}

export const IM_CHANNELS: readonly ImChannelDef[] = [
  { id: 'weixin', name: '微信', logo: '/im-logos/weixin.png' },
  { id: 'dingtalk', name: '钉钉', logo: '/im-logos/dingding.png' },
  { id: 'feishu', name: '飞书', logo: '/im-logos/feishu.png' },
  { id: 'wecom', name: '企业微信', logo: '/im-logos/wecom.png' },
  { id: 'qq', name: 'QQ', logo: '/im-logos/qq_bot.jpeg' },
  { id: 'popo', name: 'POPO', logo: '/im-logos/popo.png' },
  { id: 'email', name: '龙虾邮箱', logo: '/im-logos/email.svg' },
];

/** Resolve a channel's display name (falls back to the raw id). */
export function imChannelName(id: string): string {
  return IM_CHANNELS.find(c => c.id === id)?.name ?? id;
}
