import { describe, expect, test } from 'vitest';

import { buildRealtimeAsrAudioFrames } from './realtimeAsrClient';

const ascii = (bytes: Uint8Array, offset: number, length: number): string => (
  String.fromCharCode(...bytes.slice(offset, offset + length))
);

const makePcmBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = i % 251;
  }
  return bytes;
};

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

describe('buildRealtimeAsrAudioFrames', () => {
  test('keeps the WAV header inside the first binary frame size limit', () => {
    const pcm = makePcmBytes(8192);
    const result = buildRealtimeAsrAudioFrames({
      chunk: pcm,
      isFirstFrame: true,
      maxBinaryFrameBytes: 6400,
    });

    expect(result.isFirstFrame).toBe(false);
    expect(result.frames.map(frame => frame.byteLength)).toEqual([6400, 1836]);
    expect(result.frames.every(frame => frame.byteLength <= 6400)).toBe(true);
    expect(ascii(result.frames[0], 0, 4)).toBe('RIFF');
    expect(ascii(result.frames[0], 8, 4)).toBe('WAVE');
    expect(ascii(result.frames[0], 36, 4)).toBe('data');

    const recoveredPcm = concat([
      result.frames[0].slice(44),
      ...result.frames.slice(1),
    ]);
    expect(recoveredPcm).toEqual(pcm);
  });

  test('splits later PCM chunks without adding another WAV header', () => {
    const pcm = makePcmBytes(15000);
    const result = buildRealtimeAsrAudioFrames({
      chunk: pcm,
      isFirstFrame: false,
      maxBinaryFrameBytes: 6400,
    });

    expect(result.isFirstFrame).toBe(false);
    expect(result.frames.map(frame => frame.byteLength)).toEqual([6400, 6400, 2200]);
    expect(ascii(result.frames[0], 0, 4)).not.toBe('RIFF');
    expect(concat(result.frames)).toEqual(pcm);
  });

  test('normalizes too-small frame limits so splitting still makes progress', () => {
    const pcm = makePcmBytes(4);
    const result = buildRealtimeAsrAudioFrames({
      chunk: pcm,
      isFirstFrame: true,
      maxBinaryFrameBytes: 0,
    });

    expect(result.frames.map(frame => frame.byteLength)).toEqual([45, 3]);
    expect(concat([
      result.frames[0].slice(44),
      ...result.frames.slice(1),
    ])).toEqual(pcm);
  });
});
