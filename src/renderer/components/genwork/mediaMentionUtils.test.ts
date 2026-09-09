import { describe, expect, test } from 'vitest';

import type { DraftAttachment } from '../../store/slices/genworkSlice';
import {
  buildMediaMentionSegments,
  computeMediaLabels,
  extractMediaReferencesFromPrompt,
  filterMediaLabels,
  MediaMentionSegmentKind,
  MediaMentionType,
  resolveMediaMentionTrigger,
} from './mediaMentionUtils';

const makeAttachment = (overrides: Partial<DraftAttachment>): DraftAttachment => ({
  path: overrides.path ?? `/tmp/${overrides.name ?? 'file.png'}`,
  name: overrides.name ?? 'file.png',
  isImage: overrides.isImage,
  dataUrl: overrides.dataUrl,
});

describe('mediaMentionUtils', () => {
  test('numbers images in attachment order', () => {
    const labels = computeMediaLabels([
      makeAttachment({ path: '/tmp/a.png', name: 'a.png', isImage: true }),
      makeAttachment({ path: '/tmp/b.jpg', name: 'b.jpg', isImage: true }),
      makeAttachment({ path: '/tmp/c.webp', name: 'c.webp', isImage: true }),
    ]);

    expect(labels.map(label => label.label)).toEqual(['图片1', '图片2', '图片3']);
    expect(labels.map(label => label.mediaType)).toEqual([
      MediaMentionType.Image,
      MediaMentionType.Image,
      MediaMentionType.Image,
    ]);
  });

  test('numbers mixed media by media type', () => {
    const labels = computeMediaLabels([
      makeAttachment({ path: '/tmp/cover.png', name: 'cover.png' }),
      makeAttachment({ path: '/tmp/demo.mp4', name: 'demo.mp4' }),
      makeAttachment({ path: '/tmp/voice.wav', name: 'voice.wav' }),
      makeAttachment({ path: '/tmp/second.png', name: 'second.png' }),
    ]);

    expect(labels.map(label => label.label)).toEqual(['图片1', '视频1', '音频1', '图片2']);
  });

  test('filters by label or file name', () => {
    const labels = computeMediaLabels([
      makeAttachment({ path: '/tmp/cover.png', name: 'cover.png' }),
      makeAttachment({ path: '/tmp/demo.mp4', name: 'demo.mp4' }),
    ]);

    expect(filterMediaLabels(labels, '图片').map(label => label.label)).toEqual(['图片1']);
    expect(filterMediaLabels(labels, 'demo').map(label => label.label)).toEqual(['视频1']);
  });

  test('extracts valid media references and deduplicates repeated tokens', () => {
    const labels = computeMediaLabels([
      makeAttachment({ path: '/tmp/first.png', name: 'first.png' }),
      makeAttachment({ path: '/tmp/second.png', name: 'second.png' }),
    ]);

    const refs = extractMediaReferencesFromPrompt('参考 @图片2 和 @图片2，忽略 @图片3', labels);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      token: '@图片2',
      mediaType: MediaMentionType.Image,
      index: 2,
      fileId: '/tmp/second.png',
      fileName: 'second.png',
      mimeType: 'image/png',
      localPath: '/tmp/second.png',
      role: 'reference_image',
    });
  });

  test('keeps dataUrl for inline image fallback without localPath', () => {
    const dataUrl = 'data:image/png;base64,abc123';
    const labels = computeMediaLabels([
      makeAttachment({
        path: 'inline:pasted.png:1',
        name: 'pasted.png',
        isImage: true,
        dataUrl,
      }),
    ]);

    const refs = extractMediaReferencesFromPrompt('@图片1', labels);

    expect(refs).toHaveLength(1);
    expect(refs[0].localPath).toBeUndefined();
    expect(refs[0].dataUrl).toBe(dataUrl);
  });

  test('extracts the second inline image when prompt references @图片2', () => {
    const firstDataUrl = 'data:image/png;base64,first';
    const secondDataUrl = 'data:image/png;base64,second';
    const labels = computeMediaLabels([
      makeAttachment({
        path: 'inline:first.png:1',
        name: 'first.png',
        isImage: true,
        dataUrl: firstDataUrl,
      }),
      makeAttachment({
        path: 'inline:second.png:2',
        name: 'second.png',
        isImage: true,
        dataUrl: secondDataUrl,
      }),
    ]);

    const refs = extractMediaReferencesFromPrompt('@图片2 生成一个4s视频', labels);

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      token: '@图片2',
      index: 2,
      fileId: 'inline:second.png:2',
      fileName: 'second.png',
      dataUrl: secondDataUrl,
    });
    expect(refs[0].dataUrl).not.toBe(firstDataUrl);
  });

  test('builds highlight segments for valid media mentions only', () => {
    const labels = computeMediaLabels([
      makeAttachment({ path: '/tmp/first.png', name: 'first.png' }),
    ]);

    const segments = buildMediaMentionSegments('用 @图片1，不用 @图片2', labels);

    expect(segments).toEqual([
      { kind: MediaMentionSegmentKind.Text, text: '用 ' },
      { kind: MediaMentionSegmentKind.Mention, text: '@图片1', label: '图片1' },
      { kind: MediaMentionSegmentKind.Text, text: '，不用 @图片2' },
    ]);
  });

  test('resolves mention trigger after Chinese text', () => {
    const text = '为说明@';

    expect(resolveMediaMentionTrigger(text, text.length)).toEqual({
      atIndex: text.indexOf('@'),
      cursorPos: text.length,
      filter: '',
    });
  });

  test('resolves mention trigger after English and numeric text', () => {
    const text = 'abc123@';

    expect(resolveMediaMentionTrigger(text, text.length)).toEqual({
      atIndex: text.indexOf('@'),
      cursorPos: text.length,
      filter: '',
    });
  });

  test('resolves mention trigger at the beginning of input', () => {
    const text = '@图';

    expect(resolveMediaMentionTrigger(text, text.length)).toEqual({
      atIndex: 0,
      cursorPos: text.length,
      filter: '图',
    });
  });

  test('does not resolve mention trigger after whitespace in the token', () => {
    expect(resolveMediaMentionTrigger('@图片 ', '@图片 '.length)).toBeNull();
    expect(resolveMediaMentionTrigger('@图片\n', '@图片\n'.length)).toBeNull();
  });

  test('uses the nearest at sign before the cursor as the filter token', () => {
    const text = '先@旧 再@图';

    expect(resolveMediaMentionTrigger(text, text.length)).toEqual({
      atIndex: text.lastIndexOf('@'),
      cursorPos: text.length,
      filter: '图',
    });
  });
});
