// enterprise_server/src/routes/auth/ssoBind.ts
// Public (pre-login) half of the two-stage SSO binding flow. `GET /bind-sso`
// renders the prove-with-password form. `POST /auth/sso/bind` validates
// the password against a pending_bind context in ssoLoginContextStore,
// writes users.sso_*, marks the store entry as ready_to_finalize, and
// returns the URL the SPA should redirect to.
import { randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { auditStore } from '../../audit/auditStore';
import { verifyPassword } from '../../auth/password';
import { pool } from '../../db/pool';
import { makeT, pickLocale } from '../../i18n';
import { defaultLogoFor } from '../../sso/logos';
import { ssoLoginContextStore } from '../../sso/ssoLoginContext';

export const ssoBindRoutes = new Hono();

const bindSchema = z.object({
  state: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});

ssoBindRoutes.post('/auth/sso/bind', async (c) => {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = bindSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const { state, username, password } = parsed.data;

  const ctx = ssoLoginContextStore.get(state);
  if (!ctx || ctx.kind !== 'pending_bind') {
    return c.json({ error: 'bind_state_invalid' }, 400);
  }

  // Look up by username within the SSO org. We don't return a distinct
  // error for "user not found" vs "wrong password" (spec §4.2 step 2
  // anti-enumeration). When the user IS found in a different org, we DO
  // return bind_org_mismatch — this matches the brief's Step 1 cross-org
  // test and lets admins diagnose misconfigured bindings. Because users is
  // unique only on (org_id, username), the cross-org check is a SEPARATE
  // org-scoped lookup so row order can't flip a same-org user into a
  // spurious mismatch (a colliding username in another org).
  const sameOrg = await pool.query<{ id: string; password_hash: string; status: string }>(
    `SELECT id, password_hash, status FROM users WHERE username = $1 AND org_id = $2`,
    [username, ctx.orgId]
  );
  const u = sameOrg.rows[0];
  if (!u) {
    const anyOrg = await pool.query<{ org_id: string }>(
      `SELECT org_id FROM users WHERE username = $1 LIMIT 1`,
      [username]
    );
    if (anyOrg.rowCount) return c.json({ error: 'bind_org_mismatch' }, 403);
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  if (u.status !== 'active') {
    return c.json({ error: 'bind_user_disabled' }, 403);
  }
  const ok = await verifyPassword(password, u.password_hash);
  if (!ok) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  // UPSERT binding. ON CONFLICT (sso_connection_id, sso_external_id)
  // WHERE sso_external_id IS NOT NULL → 23505 → 409.
  try {
    await pool.query(
      `UPDATE users
          SET sso_connection_id = $1, sso_external_id = $2
        WHERE id = $3 AND org_id = $4`,
      [ctx.connectionId, ctx.externalId, u.id, ctx.orgId]
    );
  } catch (e: unknown) {
    if ((e as { code?: string }).code === '23505') {
      await auditStore.write({
        orgId: ctx.orgId, action: 'sso_login_failed',
        payload: { reason: 'sso_binding_duplicate_race', ssoConnectionId: ctx.connectionId, externalId: ctx.externalId },
      });
      return c.json({ error: 'sso_binding_duplicate' }, 409);
    }
    throw e;
  }

  await pool.query(
    `INSERT INTO user_idp_identities(id, org_id, user_id, sso_connection_id, external_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [randomUUID(), ctx.orgId, u.id, ctx.connectionId, ctx.externalId]
  );

  // Mark the store entry as ready_to_finalize so the next
  // /auth/sso/callback hit (Task 4) issues the token.
  ssoLoginContextStore.set(state, {
    kind: 'ready_to_finalize',
    orgId: ctx.orgId, connectionId: ctx.connectionId,
    boundUserId: u.id, externalId: ctx.externalId,
    returnTarget: ctx.returnTarget,
    redirectUri: ctx.redirectUri, codeVerifier: ctx.codeVerifier,
    expiresAt: ctx.expiresAt,
  });

  await auditStore.write({
    orgId: ctx.orgId, userId: u.id, action: 'sso_user_self_bound',
    payload: { ssoConnectionId: ctx.connectionId, externalId: ctx.externalId, source: 'pending_bind' },
  });

  // Both console and desktop flows finalize by re-hitting the console
  // callback: the console route reads the ready_to_finalize entry, mints the
  // token, and (for a desktop returnTarget) redirects it to the loopback the
  // desktop is still polling rather than rendering it into the browser.
  const returnTo = `${new URL(c.req.url).origin}/auth/sso/callback?state=${encodeURIComponent(state)}`;
  return c.json({ ok: true, returnTo });
});

// GET /bind-sso?state=xxx — server-rendered HTML form. No auth required
// (the user isn't logged in yet; password IS the auth).
ssoBindRoutes.get('/bind-sso', async (c) => {
  const state = c.req.query('state') ?? '';
  const locale = pickLocale(c);
  const ctx = state ? ssoLoginContextStore.get(state) : undefined;
  if (!ctx || ctx.kind !== 'pending_bind') {
    return c.html(renderBindSsoHtml({ state, valid: false, locale, origin: new URL(c.req.url).origin }));
  }
  // Look up the connection row for name + provider_type (drives the
  // provider chip in the redesigned page and the right built-in logo).
  const r = await pool.query<{ name: string; provider_type: string }>(
    `SELECT name, provider_type FROM sso_connections WHERE id = $1`, [ctx.connectionId]
  );
  return c.html(renderBindSsoHtml({
    state, valid: true, locale, origin: new URL(c.req.url).origin,
    connectionName: r.rows[0]?.name ?? 'SSO',
    providerType: r.rows[0]?.provider_type ?? 'generic-oidc',
    externalId: ctx.externalId,
  }));
});

function renderBindSsoHtml(args: {
  state: string; valid: boolean; locale: 'zh' | 'en'; origin: string;
  connectionName?: string; providerType?: string; externalId?: string;
}): string {
  // Escape & < > " ' to HTML entities so IdP-derived values (connection
  // name, external_id) can't inject markup into this auth page.
  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
  const t = makeT(args.locale).t;
  const providerName = esc(args.connectionName ?? 'SSO');
  const providerType = args.providerType ?? 'generic-oidc';
  // Prefer the per-connection override (if any) over the built-in default.
  const logoPath = defaultLogoFor(providerType);
  const providerLogo = logoPath ? esc(new URL(logoPath, args.origin).toString()) : '';
  const externalId = esc(args.externalId ?? '');
  const stateEsc = esc(args.state);

  if (!args.valid) {
    return `<!doctype html>
<html lang="${args.locale}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t('bind.invalid.title'))} — GenWork</title>
<style>${SHARED_CSS}</style>
</head>
<body>
  <main class="page">
    <div class="card" style="text-align:center">
      <div style="font-size:48px;line-height:1;margin:8px 0 16px;color:#dc2626">⚠</div>
      <h1 class="title">${esc(t('bind.invalid.title'))}</h1>
      <p class="subtitle">${esc(t('bind.invalid.body'))}</p>
    </div>
  </main>
</body></html>`;
  }

  return `<!doctype html>
<html lang="${args.locale}"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t('bind.title'))} — GenWork</title>
<style>${SHARED_CSS}
.view-id[open] .view-id-summary .chev { transform: rotate(180deg); }
.view-id-body { padding: 12px 16px 16px 16px; }
.id-row {
  display: flex; align-items: center; gap: 8px;
  border: 1px dashed #cbd5e1; border-radius: 8px;
  padding: 10px 12px; background: #f8fafc;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
  color: #334155; word-break: break-all;
}
.id-copy {
  flex-shrink: 0; padding: 6px 12px; border-radius: 6px;
  border: 1px solid #e2e8f0; background: #fff; color: #334155;
  font-size: 13px; cursor: pointer; transition: all .15s;
}
.id-copy:hover { border-color: #94a3b8; background: #f1f5f9; }
.id-copy.copied { color: #16a34a; border-color: #86efac; background: #f0fdf4; }
</style>
</head>
<body>
  <main class="page">
    <header class="lang-bar">
      <a class="lang-link${args.locale === 'zh' ? ' active' : ''}" href="?${args.state ? `state=${stateEsc}&` : ''}lang=zh">${esc(t('lang.zh'))}</a>
      <span class="lang-sep">·</span>
      <a class="lang-link${args.locale === 'en' ? ' active' : ''}" href="?${args.state ? `state=${stateEsc}&` : ''}lang=en">${esc(t('lang.en'))}</a>
    </header>

    <div class="brand-row">
      <div class="brand-tile brand-tile--provider">
        ${providerLogo
          ? `<img src="${providerLogo}" alt="${providerName}" />`
          : `<span class="brand-fallback">${providerName.slice(0, 1)}</span>`}
      </div>
      <span class="brand-arrow">→</span>
      <div class="brand-tile brand-tile--genwork"><span>G</span></div>
    </div>

    <h1 class="title">${esc(t('bind.title'))}</h1>
    <p class="subtitle">${esc(t('bind.subtitle', { provider: providerName }))}</p>

    <section class="provider-card">
      <div class="provider-card-logo">
        ${providerLogo
          ? `<img src="${providerLogo}" alt="${providerName}" />`
          : `<span class="brand-fallback">${providerName.slice(0, 1)}</span>`}
      </div>
      <div class="provider-card-meta">
        <div class="provider-card-name">${esc(t('bind.account.provider', { provider: providerName }))}</div>
        <div class="provider-card-status">${esc(t('bind.account.status'))}</div>
      </div>
      <span class="badge">${esc(t('bind.account.badge'))}</span>
    </section>

    ${externalId
      ? `<details class="view-id">
        <summary class="view-id-summary">
          <span>${esc(t('bind.viewId.label'))}</span>
          <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
        </summary>
        <div class="view-id-body">
          <div class="id-row">
            <span id="external-id" style="flex:1;min-width:0">${externalId}</span>
            <button type="button" class="id-copy" data-copy="${externalId}">${esc(t('bind.viewId.copy'))}</button>
          </div>
        </div>
      </details>`
      : ''}

    <form id="bind-form" class="bind-form" method="POST" action="/auth/sso/bind">
      <input type="hidden" name="state" value="${stateEsc}" />

      <label class="field">
        <span class="field-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        </span>
        <input name="username" type="text" autocomplete="username" required placeholder="${esc(t('bind.genworkAccount'))}" />
      </label>

      <label class="field">
        <span class="field-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        </span>
        <input name="password" id="bind-password" type="password" autocomplete="current-password" required placeholder="${esc(t('bind.password'))}" />
        <button type="button" class="field-trailing" id="toggle-password" aria-label="${esc(t('bind.password.show'))}" title="${esc(t('bind.password.show'))}">
          <svg id="eye-show" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          <svg id="eye-hide" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:none"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        </button>
      </label>

      <button type="submit" class="submit-btn">${esc(t('bind.submit'))}</button>
      <p id="err" class="err" role="alert" aria-live="polite"></p>
    </form>
  </main>

  <script>
    (function () {
      // Password show/hide toggle
      var pw = document.getElementById('bind-password');
      var toggle = document.getElementById('toggle-password');
      var show = document.getElementById('eye-show');
      var hide = document.getElementById('eye-hide');
      var showLabel = ${JSON.stringify(t('bind.password.show'))};
      var hideLabel = ${JSON.stringify(t('bind.password.hide'))};
      var copiedLabel = ${JSON.stringify(t('bind.viewId.copied'))};
      if (toggle && pw && show && hide) {
        toggle.addEventListener('click', function () {
          var isPw = pw.type === 'password';
          pw.type = isPw ? 'text' : 'password';
          show.style.display = isPw ? 'none' : '';
          hide.style.display = isPw ? '' : 'none';
          toggle.setAttribute('aria-label', isPw ? hideLabel : showLabel);
          toggle.setAttribute('title', isPw ? hideLabel : showLabel);
        });
      }
      // Copy external_id to clipboard
      var copyBtn = document.querySelector('.id-copy');
      if (copyBtn) {
        var originalLabel = copyBtn.textContent;
        copyBtn.addEventListener('click', function () {
          var value = copyBtn.getAttribute('data-copy') || '';
          var done = function () {
            copyBtn.classList.add('copied');
            copyBtn.textContent = copiedLabel;
            setTimeout(function () {
              copyBtn.classList.remove('copied');
              copyBtn.textContent = originalLabel;
            }, 1500);
          };
          if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(value).then(done).catch(function () { fallback(); });
          } else {
            fallback();
          }
          function fallback() {
            try {
              var ta = document.createElement('textarea');
              ta.value = value; ta.style.position = 'fixed'; ta.style.opacity = '0';
              document.body.appendChild(ta); ta.select();
              document.execCommand('copy'); document.body.removeChild(ta);
              done();
            } catch (e) { /* swallow */ }
          }
        });
      }
      // Form submit → JSON POST → location.assign(returnTo) or show error
      var form = document.getElementById('bind-form');
      var errEl = document.getElementById('err');
      if (form) {
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          errEl.textContent = '';
          var fd = new FormData(form);
          fetch(form.action, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              state: fd.get('state'),
              username: fd.get('username'),
              password: fd.get('password'),
            }),
          }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
            .then(function (r) {
              if (r.body && r.body.returnTo) { location.assign(r.body.returnTo); return; }
              errEl.textContent = (r.body && r.body.error) || ('HTTP ' + r.status);
            })
            .catch(function (e) { errEl.textContent = String(e); });
        });
      }
    })();
  </script>
</body></html>`;
}

// Inline CSS for the redesigned bind-sso page. Kept as a string constant so
// the server-rendered HTML is self-contained (no external asset pipeline, no
// public/ folder) and so the same look is rendered in any locale.
const SHARED_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
               "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue",
               Helvetica, Arial, sans-serif;
  background: #f4f5f7; color: #0f172a;
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
}
.page {
  max-width: 540px; margin: 0 auto; padding: 32px 24px 80px;
}
.lang-bar {
  display: flex; justify-content: flex-end; gap: 6px; align-items: center;
  font-size: 13px; color: #64748b; margin-bottom: 12px;
}
.lang-link {
  color: #64748b; text-decoration: none; padding: 4px 6px; border-radius: 4px;
}
.lang-link:hover { color: #0f172a; }
.lang-link.active { color: #3b5bdb; font-weight: 600; }
.lang-sep { color: #cbd5e1; }

.brand-row {
  display: flex; align-items: center; gap: 12px; margin: 0 0 24px 0;
}
.brand-tile {
  width: 48px; height: 48px; border-radius: 10px; display: flex;
  align-items: center; justify-content: center; overflow: hidden;
  box-shadow: 0 1px 2px rgba(15,23,42,.08);
}
.brand-tile img { width: 100%; height: 100%; object-fit: contain; }
.brand-tile--provider { background: #fff; }
.brand-tile--genwork { background: #1f2937; color: #fff; font-weight: 700; font-size: 22px; }
.brand-fallback { font-weight: 700; font-size: 20px; color: #1f2937; }
.brand-arrow { color: #94a3b8; font-size: 18px; }

.title {
  font-size: 26px; line-height: 1.25; font-weight: 700; color: #0f172a;
  margin: 0 0 10px 0;
}
.subtitle {
  font-size: 15px; line-height: 1.55; color: #475569;
  margin: 0 0 24px 0;
}

.provider-card {
  display: flex; align-items: center; gap: 14px;
  background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;
  padding: 14px 16px; margin-bottom: 20px;
}
.provider-card-logo {
  width: 44px; height: 44px; border-radius: 10px; background: #fff;
  display: flex; align-items: center; justify-content: center; overflow: hidden;
  flex-shrink: 0; box-shadow: 0 1px 2px rgba(15,23,42,.06);
}
.provider-card-logo img { width: 100%; height: 100%; object-fit: contain; }
.provider-card-meta { flex: 1; min-width: 0; }
.provider-card-name { font-size: 15px; font-weight: 600; color: #0f172a; line-height: 1.3; }
.provider-card-status { font-size: 13px; color: #64748b; margin-top: 2px; }
.badge {
  background: #fef3c7; color: #b45309; font-size: 12px; font-weight: 600;
  padding: 4px 10px; border-radius: 999px; flex-shrink: 0;
}

.view-id {
  border: none; margin: 0 0 24px 0; padding: 0;
}
.view-id-summary {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  list-style: none; color: #475569; font-size: 13px; user-select: none;
}
.view-id-summary::-webkit-details-marker { display: none; }
.view-id-summary .chev { transition: transform .2s; color: #94a3b8; }

.bind-form { display: flex; flex-direction: column; gap: 16px; }
.field {
  position: relative; display: flex; align-items: center;
  background: #f1f5f9; border-radius: 10px; padding: 0 14px;
  border: 1px solid transparent; transition: border-color .15s, background .15s;
}
.field:focus-within { border-color: #3b5bdb; background: #fff; }
.field-icon { color: #64748b; display: flex; align-items: center; flex-shrink: 0; }
.field input {
  flex: 1; min-width: 0; background: transparent; border: 0; outline: 0;
  font: inherit; color: inherit; padding: 14px 0 14px 12px; height: 24px;
}
.field input::placeholder { color: #94a3b8; }
.field-trailing {
  background: transparent; border: 0; padding: 4px; margin-right: -4px;
  color: #64748b; cursor: pointer; border-radius: 4px; display: flex;
  align-items: center; justify-content: center;
}
.field-trailing:hover { color: #0f172a; }

.submit-btn {
  background: #3b5bdb; color: #fff; border: 0; border-radius: 10px;
  padding: 14px 18px; font: inherit; font-weight: 600; font-size: 15px;
  cursor: pointer; margin-top: 4px; transition: background .15s, transform .05s;
}
.submit-btn:hover { background: #324fbf; }
.submit-btn:active { transform: translateY(1px); }
.submit-btn:disabled { background: #94a3b8; cursor: not-allowed; }

.err {
  min-height: 1.4em; margin: 0; font-size: 13px; color: #dc2626;
}
`;
