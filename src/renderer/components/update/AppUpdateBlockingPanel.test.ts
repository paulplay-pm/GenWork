import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import { type AppUpdateRuntimeState, AppUpdateSource, AppUpdateStatus } from '../../../shared/appUpdate/constants';
import AppUpdateBlockingPanel from './AppUpdateBlockingPanel';

const createState = (status: AppUpdateRuntimeState['status']): AppUpdateRuntimeState => ({
  status,
  source: AppUpdateSource.Manual,
  info: {
    latestVersion: '2026.7.16',
    date: '2026-07-16',
    changeLog: {
      zh: { title: '本次更新', content: ['第一项更新', '第二项更新', '第三项更新'] },
      en: { title: 'Release notes', content: ['First change', 'Second change', 'Third change'] },
    },
    url: 'https://updates.example.com/genwork.exe',
  },
  progress: null,
  readyFilePath: null,
  readyFileHash: null,
  errorMessage: null,
});

describe('AppUpdateBlockingPanel', () => {
  test('shows every release note without redundant actions while installing', () => {
    const html = renderToStaticMarkup(
      React.createElement(AppUpdateBlockingPanel, {
        updateState: createState(AppUpdateStatus.Installing),
        onCancelDownload: vi.fn(),
      }),
    );

    expect(html).toContain('第一项更新');
    expect(html).toContain('第二项更新');
    expect(html).toContain('第三项更新');
    expect(html).toContain('overflow-y-auto');
    expect(html).toContain('max-h-full');
    expect(html).toContain('overflow-hidden');
    expect(html).toContain('bg-surface');
    expect(html).toContain('shadow-elevated');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).not.toContain('bg-surface-raised');
    expect(html).not.toContain('shadow-modal');
    expect(html).not.toContain('查看更新内容');
    expect(html).not.toContain('<button');
  });

  test('keeps progress and cancellation available while downloading', () => {
    const state = createState(AppUpdateStatus.Downloading);
    state.progress = { received: 50, total: 100, percent: 0.5, speed: 20 };

    const html = renderToStaticMarkup(
      React.createElement(AppUpdateBlockingPanel, {
        updateState: state,
        onCancelDownload: vi.fn(),
      }),
    );

    expect(html).toContain('50%');
    expect(html).toContain('取消下载');
    expect(html).toContain('<button');
  });

  test('falls back to a status panel when update metadata is unavailable', () => {
    const state = createState(AppUpdateStatus.Installing);
    state.info = null;

    const html = renderToStaticMarkup(
      React.createElement(AppUpdateBlockingPanel, {
        updateState: state,
        onCancelDownload: vi.fn(),
      }),
    );

    expect(html).toContain('正在安装更新');
    expect(html).not.toContain('v2026.7.16');
  });

  test('ignores invalid progress values', () => {
    const state = createState(AppUpdateStatus.Downloading);
    state.progress = { received: 0, total: 100, percent: Number.NaN, speed: 0 };

    const html = renderToStaticMarkup(
      React.createElement(AppUpdateBlockingPanel, {
        updateState: state,
        onCancelDownload: vi.fn(),
      }),
    );

    expect(html).not.toContain('NaN');
    expect(html).toContain('正在下载');
  });
});
