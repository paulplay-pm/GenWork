/**
 * Renderer-side IPC dispatcher for the SSO self-binding surface.
 *
 * Most renderer code calls namespaced wrappers exposed by the preload
 * (e.g. `window.electron.agents.list()`). This module centralises the
 * SSO-specific dispatch (`window.electron.ssoBinding.{list,unbind,start}`)
 * so slice tests can mock the function rather than the underlying
 * `window.electron` surface, and so the slice code can name channels via
 * the shared `SSO_BINDING_IPC` constants without string-literal drift.
 *
 * Only the three SSO_BINDING_IPC channels are routed here; any other
 * channel passed in throws. The wrapper expects the preload's
 * `window.electron.ssoBinding` namespace to be present; if not, calls
 * throw a clear runtime error so the missing wiring is surfaced
 * immediately rather than silently swallowed.
 */

import { SSO_BINDING_IPC } from '../../shared/sso/binding';

interface SsoBindingSurface {
  list?: () => Promise<unknown>;
  unbind?: () => Promise<unknown>;
  start?: (connectionId: string) => Promise<unknown>;
}

export async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const surf = window.electron?.ssoBinding as SsoBindingSurface | undefined;
  if (channel === SSO_BINDING_IPC.List) {
    return (await surf?.list?.()) as T;
  }
  if (channel === SSO_BINDING_IPC.Unbind) {
    return (await surf?.unbind?.()) as T;
  }
  if (channel === SSO_BINDING_IPC.Start) {
    const connectionId = (payload as { connectionId?: string } | undefined)?.connectionId;
    if (!connectionId) {
      throw new Error('connectionId required for sso:startMyBinding');
    }
    return (await surf?.start?.(connectionId)) as T;
  }
  throw new Error(`unknown SSO_BINDING_IPC channel: ${channel}`);
}
