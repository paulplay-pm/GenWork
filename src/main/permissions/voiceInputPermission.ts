import { systemPreferences } from 'electron';

import type { VoiceInputPermissionHandlerOptions } from './types';

const isLocalhost = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';

function isTrustedRendererMediaUrl(requestUrl: string, isDev: boolean, startUrl?: string): boolean {
  try {
    const url = new URL(requestUrl);
    if (url.protocol === 'file:') return true;
    if (!isDev || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false;

    if (startUrl) {
      try {
        return url.origin === new URL(startUrl).origin;
      } catch {
        return false;
      }
    }

    return isLocalhost(url.hostname) && url.port === '5175';
  } catch {
    return false;
  }
}

async function requestMacMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true;

  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  if (status === 'denied' || status === 'restricted') {
    console.warn(`[VoiceInput] macOS microphone access is ${status}`);
    return false;
  }

  try {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (!granted) {
      console.warn('[VoiceInput] macOS microphone access was not granted');
    }
    return granted;
  } catch (error) {
    console.warn('[VoiceInput] macOS microphone access request failed:', error);
    return false;
  }
}

function getPermissionMediaTypes(details: unknown): string[] {
  if (!details || typeof details !== 'object' || !('mediaTypes' in details)) return [];
  const mediaTypes = (details as { mediaTypes?: unknown }).mediaTypes;
  return Array.isArray(mediaTypes) ? mediaTypes.filter((mediaType): mediaType is string => typeof mediaType === 'string') : [];
}

export function registerVoiceInputPermissionHandler({
  session,
  getMainWindow,
  isDev,
  startUrl,
}: VoiceInputPermissionHandlerOptions): void {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== 'media') {
      callback(false);
      return;
    }

    const mediaTypes = getPermissionMediaTypes(details);
    if (!mediaTypes.includes('audio')) {
      callback(false);
      return;
    }

    const requestingUrl = details.requestingUrl || webContents.getURL();
    const mainWindow = getMainWindow();
    if (mainWindow?.webContents !== webContents || !isTrustedRendererMediaUrl(requestingUrl, isDev, startUrl)) {
      console.warn(`[VoiceInput] blocked microphone permission request from ${requestingUrl || 'unknown origin'}`);
      callback(false);
      return;
    }

    void requestMacMicrophoneAccess().then(granted => {
      callback(granted);
    });
  });
}
