import type { BrowserWindow } from 'electron';
import { screen } from 'electron';

import {
  AppWindowStoreKey,
  MIN_APP_WINDOW_HEIGHT,
  MIN_APP_WINDOW_WIDTH,
  type WindowRectangle,
} from './windowState';

export interface WindowStatePersistDeps {
  getMainWindow: () => BrowserWindow | null;
  getStore: () => { get: <T>(key: string) => T | undefined; set: (key: string, value: unknown) => void };
}

export function createWindowStatePersistManager(deps: WindowStatePersistDeps) {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressUntil = 0;

  const DEBOUNCE_MS = 300;
  const TRANSITION_GUARD_MS = 500;

  function emitState(): void {
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.webContents.isDestroyed()) return;
    win.webContents.send('window:state-changed', {
      isMaximized: win.isMaximized(),
      isFullscreen: win.isFullScreen(),
      isFocused: win.isFocused(),
    });
  }

  function getDisplayWorkAreas(): WindowRectangle[] {
    return screen.getAllDisplays().map((display) => display.workArea);
  }

  function getCurrentState() {
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed()) return null;

    const bounds = win.isFullScreen()
      ? win.getNormalBounds()
      : win.isMaximized()
        ? win.getNormalBounds()
        : win.getBounds();

    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: win.isMaximized(),
    };
  }

  function persist(): void {
    const state = getCurrentState();
    if (!state) return;
    // Reject obviously invalid bounds that can arise from getNormalBounds()
    // returning wrong values on Windows frameless windows, or from resize
    // events firing with transitional sizes during maximize/unmaximize.
    if (state.width < MIN_APP_WINDOW_WIDTH || state.height < MIN_APP_WINDOW_HEIGHT) return;
    deps.getStore().set(AppWindowStoreKey.State, state);
  }

  function schedulePersist(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }

    saveTimer = setTimeout(() => {
      saveTimer = null;
      // Skip if we are inside a maximize/unmaximize transition window,
      // because getBounds() may return intermediate animation values.
      if (Date.now() < suppressUntil) return;
      persist();
    }, DEBOUNCE_MS);
  }

  function forwardAndPersist(): void {
    emitState();
    // Suppress resize-driven persists during the transition animation,
    // then persist the final settled state after the guard period.
    suppressUntil = Date.now() + TRANSITION_GUARD_MS;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveTimer = setTimeout(() => {
      saveTimer = null;
      suppressUntil = 0;
      persist();
    }, TRANSITION_GUARD_MS);
  }

  /**
   * Fix cross-DPI-monitor scaling: on Windows with frame:false, Electron
   * may divide width/height by the primary monitor's scaleFactor when the
   * window is placed on a secondary monitor with a different DPI.  Detect
   * and correct this before showing the window.
   */
  function fixDpiBounds(initialBounds: WindowRectangle, shouldRestoreMaximized: boolean): void {
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed() || shouldRestoreMaximized) return;
    const actual = win.getBounds();
    if (actual.width < initialBounds.width || actual.height < initialBounds.height) {
      win.setBounds(initialBounds);
      // Re-enforce minimum size after correction
      win.setMinimumSize(MIN_APP_WINDOW_WIDTH, MIN_APP_WINDOW_HEIGHT);
    }
  }

  /**
   * Register all window state persistence event handlers on the main window.
   * Call this once inside createWindow() after the BrowserWindow is created.
   */
  function bindWindowEvents(initialBounds: WindowRectangle, shouldRestoreMaximized: boolean): void {
    const win = deps.getMainWindow();
    if (!win) return;

    win.on('resize', schedulePersist);
    win.on('move', schedulePersist);
    win.on('maximize', forwardAndPersist);
    win.on('unmaximize', forwardAndPersist);
    win.on('enter-full-screen', forwardAndPersist);
    win.on('leave-full-screen', forwardAndPersist);
    win.on('focus', emitState);
    win.on('blur', emitState);

    win.once('ready-to-show', () => {
      fixDpiBounds(initialBounds, shouldRestoreMaximized);
      emitState();
    });
  }

  function cleanup(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }

  return {
    emitState,
    getDisplayWorkAreas,
    persist,
    schedulePersist,
    forwardAndPersist,
    fixDpiBounds,
    bindWindowEvents,
    cleanup,
  };
}
