import { AsrApiCode } from '../../../shared/asr/constants';
import { i18nService } from '../i18n';

export class AsrClientError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message);
    this.name = 'AsrClientError';
  }
}

export const getFallbackAsrErrorMessage = (code?: number): string => {
  switch (code) {
    case AsrApiCode.Unauthorized:
    case AsrApiCode.AuthTokenInvalid:
      return i18nService.t('voiceInputLoginRequired');
    case AsrApiCode.AudioInvalid:
      return i18nService.t('voiceInputAudioInvalid');
    case AsrApiCode.AudioTooLarge:
      return i18nService.t('voiceInputAudioTooLarge');
    case AsrApiCode.AudioTooLong:
      return i18nService.t('voiceInputAudioTooLong');
    case AsrApiCode.DailyLimitExceeded:
      return i18nService.t('voiceInputDailyLimitExceeded');
    case AsrApiCode.UpstreamRateLimited:
      return i18nService.t('voiceInputRateLimited');
    case AsrApiCode.RecognitionFailed:
      return i18nService.t('voiceInputRecognitionFailed');
    case AsrApiCode.ConfigInvalid:
    case AsrApiCode.UpstreamAuthFailed:
    case AsrApiCode.UpstreamError:
    case AsrApiCode.UpstreamBalanceInsufficient:
    case AsrApiCode.UpstreamInvalidParams:
      return i18nService.t('voiceInputServiceUnavailable');
    default:
      return i18nService.t('voiceInputFailed');
  }
};

export const getAsrErrorMessage = (error: unknown): string => {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return i18nService.t('voiceInputMicrophoneDenied');
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return i18nService.t('voiceInputMicrophoneUnavailable');
  }
  if (error instanceof AsrClientError) {
    if (error.code !== undefined) {
      return getFallbackAsrErrorMessage(error.code);
    }
    return error.message || getFallbackAsrErrorMessage(error.code);
  }
  return i18nService.t('voiceInputFailed');
};
