// enterprise_server/src/i18n.ts
// Server-side i18n for server-rendered HTML pages (the bind-sso flow, the
// console-callback HTML, etc.). The React SPA has its own i18n module under
// web/src/i18n.ts; this is a small, dependency-free helper for the
// public/auth pre-login pages that are emitted as HTML strings.
//
// Locale resolution order:
//   1. ?lang=zh|en explicit query param (the SPA deep-links to ?lang= when
//      it knows the user's preference).
//   2. The Accept-Language header (browser default).
//   3. Hard fallback: 'zh' (matches the rest of the product's primary
//      audience — the screenshot of the redesigned bind-sso page is in zh).
//
// To add a new key: add it to BOTH dicts in this file. The renderer's
// web/src/i18n.ts is a separate file (different runtime, different
// consumer); mirror the key there too if the same string is also shown
// in the SPA.
export type Locale = 'zh' | 'en';

const dicts: Record<Locale, Record<string, string>> = {
  zh: {
    // bind-sso page
    'bind.title': '绑定 GenWork 账号',
    'bind.subtitle': '当前{provider}账号尚未绑定 GenWork,请使用 GenWork 账号和密码完成绑定,之后即可直接用{provider}一键登录。',
    'bind.account.provider': '{provider}账号',
    'bind.account.status': '尚未关联 GenWork 身份',
    'bind.account.badge': '待绑定',
    'bind.viewId.label': '查看账号标识',
    'bind.viewId.copy': '复制',
    'bind.viewId.copied': '已复制',
    'bind.genworkAccount': 'GenWork 账号',
    'bind.password': '密码',
    'bind.password.show': '显示密码',
    'bind.password.hide': '隐藏密码',
    'bind.submit': '绑定并登录',
    'bind.invalid.title': '会话已过期',
    'bind.invalid.body': '登录会话已过期或无效,请重新从登录页发起 SSO 登录。',
    // shared
    'lang.zh': '中文',
    'lang.en': 'English',
  },
  en: {
    'bind.title': 'Bind GenWork account',
    'bind.subtitle': 'Your {provider} account is not yet bound to GenWork. Sign in with your GenWork account and password to bind — then you can sign in with {provider} in one click.',
    'bind.account.provider': '{provider} account',
    'bind.account.status': 'Not linked to a GenWork identity',
    'bind.account.badge': 'Pending bind',
    'bind.viewId.label': 'View account ID',
    'bind.viewId.copy': 'Copy',
    'bind.viewId.copied': 'Copied',
    'bind.genworkAccount': 'GenWork account',
    'bind.password': 'Password',
    'bind.password.show': 'Show password',
    'bind.password.hide': 'Hide password',
    'bind.submit': 'Bind and sign in',
    'bind.invalid.title': 'Session expired',
    'bind.invalid.body': 'Your sign-in session has expired or is invalid. Please restart SSO login from the sign-in page.',
    'lang.zh': '中文',
    'lang.en': 'English',
  },
};

function interpolate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = vars[k];
    return v === undefined ? `{${k}}` : v;
  });
}

export function pickLocale(c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }): Locale {
  const q = c.req.query('lang');
  if (q === 'zh' || q === 'en') return q;
  const al = c.req.header('accept-language') ?? '';
  // Honor the highest-priority Accept-Language tag that we support.
  const tags = al.split(',').map((t) => t.split(';')[0]!.trim().toLowerCase());
  for (const t of tags) {
    if (t.startsWith('zh')) return 'zh';
    if (t.startsWith('en')) return 'en';
  }
  return 'zh';
}

export interface Translator {
  locale: Locale;
  t: (key: string, vars?: Record<string, string | undefined>) => string;
}

export function makeT(locale: Locale): Translator {
  const dict = dicts[locale];
  const fallback = dicts.en;
  return {
    locale,
    t(key, vars) {
      const raw = dict[key] ?? fallback[key] ?? key;
      return vars ? interpolate(raw, vars) : raw;
    },
  };
}
