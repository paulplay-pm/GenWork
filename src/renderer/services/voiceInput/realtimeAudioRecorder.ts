import { i18nService } from '../i18n';
import {
  VOICE_INPUT_MIN_RECORDING_MS,
  VOICE_INPUT_TARGET_SAMPLE_RATE,
} from './constants';
import { AsrClientError } from './errors';
import { encodePcm16Bytes, mergeAudioChunks, resampleLinear } from './wavEncoder';

type AudioContextConstructor = typeof AudioContext;

export interface RealtimeVoiceRecordingSession {
  stop: () => Promise<void>;
  cancel: () => void;
  getOutputSampleCount: () => number;
}

interface RealtimeVoiceRecordingOptions {
  chunkIntervalMillis: number;
  onPcmChunk: (chunk: Uint8Array) => void;
}

const resolveAudioContext = (): AudioContextConstructor | null => {
  const windowWithWebkit = window as typeof window & {
    webkitAudioContext?: AudioContextConstructor;
  };
  return window.AudioContext ?? windowWithWebkit.webkitAudioContext ?? null;
};

export const startRealtimeVoiceRecording = async ({
  chunkIntervalMillis,
  onPcmChunk,
}: RealtimeVoiceRecordingOptions): Promise<RealtimeVoiceRecordingSession> => {
  const AudioContextImpl = resolveAudioContext();
  if (!AudioContextImpl || !navigator.mediaDevices?.getUserMedia) {
    throw new AsrClientError(i18nService.t('voiceInputMicrophoneUnavailable'));
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const audioContext = new AudioContextImpl();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const mutedOutput = audioContext.createGain();
  mutedOutput.gain.value = 0;

  const pendingChunks: Float32Array[] = [];
  let pendingSourceSamples = 0;
  let outputSampleCount = 0;
  let stopped = false;
  const minSourceSamplesPerChunk = Math.max(
    1,
    Math.round(audioContext.sampleRate * (chunkIntervalMillis / 1000)),
  );

  const flush = () => {
    if (pendingSourceSamples <= 0) return;
    const merged = mergeAudioChunks(pendingChunks);
    pendingChunks.length = 0;
    pendingSourceSamples = 0;
    const resampled = resampleLinear(merged, audioContext.sampleRate, VOICE_INPUT_TARGET_SAMPLE_RATE);
    if (resampled.length === 0) return;
    outputSampleCount += resampled.length;
    const pcmBytes = encodePcm16Bytes(resampled);
    if (pcmBytes.byteLength > 0) {
      onPcmChunk(pcmBytes);
    }
  };

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
    pendingChunks.push(chunk);
    pendingSourceSamples += chunk.length;
    if (pendingSourceSamples >= minSourceSamplesPerChunk) {
      flush();
    }
  };

  source.connect(processor);
  processor.connect(mutedOutput);
  mutedOutput.connect(audioContext.destination);

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    processor.disconnect();
    source.disconnect();
    mutedOutput.disconnect();
    stream.getTracks().forEach((track) => track.stop());
  };

  return {
    stop: async () => {
      cleanup();
      flush();
      await audioContext.close();
      if (outputSampleCount < VOICE_INPUT_TARGET_SAMPLE_RATE * (VOICE_INPUT_MIN_RECORDING_MS / 1000)) {
        throw new AsrClientError(i18nService.t('voiceInputNoAudioCaptured'));
      }
    },
    cancel: () => {
      cleanup();
      void audioContext.close();
    },
    getOutputSampleCount: () => outputSampleCount,
  };
};
