import { resolveLocalizedText } from '../../services/skill';
import type { Model } from '../../store/slices/modelSlice';
import type { InstalledKit, MarketplaceKit } from '../../types/kit';
import type { Skill } from '../../types/skill';

type PromptAnalyticsValue = string | number | boolean | null | undefined;

const joinValues = (values: string[]): string | undefined => {
  const normalized = values
    .map(value => value.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized.join(',') : undefined;
};

const bucketPromptLength = (length: number): string => {
  if (length <= 0) return '0';
  if (length <= 20) return '1_20';
  if (length <= 100) return '21_100';
  if (length <= 500) return '101_500';
  if (length <= 2000) return '501_2000';
  return '2000_plus';
};

const bucketPromptLineCount = (count: number): string => {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 20) return '6_20';
  return '20_plus';
};

const bucketBytes = (bytes: number): string => {
  if (bytes <= 0) return 'unknown';
  if (bytes < 1024 * 1024) return '0_1mb';
  if (bytes < 10 * 1024 * 1024) return '1_10mb';
  if (bytes < 50 * 1024 * 1024) return '10_50mb';
  return '50mb_plus';
};

const getExtension = (nameOrPath: string): string => {
  const fileName = nameOrPath.split(/[/\\]/).pop() || nameOrPath;
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : '';
};

const getFileTypeGroup = (nameOrPath: string, isImage?: boolean): string => {
  if (isImage) return 'image';
  const ext = getExtension(nameOrPath);
  if (!ext) return 'other';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff', 'tif', 'ico', 'avif'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'tsv'].includes(ext)) return 'office';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
  if (['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'go', 'rs', 'cpp', 'c', 'h', 'css', 'html', 'json', 'md', 'yaml', 'yml', 'xml', 'sql', 'sh'].includes(ext)) return 'code';
  return 'other';
};

const getPromptLanguageType = (prompt: string): string => {
  const zhMatches = prompt.match(/[一-鿿]/g)?.length ?? 0;
  const latinMatches = prompt.match(/[A-Za-z]/g)?.length ?? 0;
  if (zhMatches === 0 && latinMatches === 0) return 'unknown';
  if (zhMatches > 0 && latinMatches > 0) return 'mixed';
  return zhMatches > 0 ? 'zh' : 'en';
};

export const getPromptTextAnalyticsParams = (
  prompt: string,
): Record<string, PromptAnalyticsValue> => {
  const trimmed = prompt.trim();
  const promptLineCount = trimmed.length > 0 ? trimmed.split('\n').length : 0;
  return {
    promptLengthBucket: bucketPromptLength(trimmed.length),
    promptLineCountBucket: bucketPromptLineCount(promptLineCount),
    inputLanguageType: getPromptLanguageType(trimmed),
    hasQuestionMark: /[?？]/.test(trimmed),
    hasCodeFence: /```/.test(trimmed),
    hasInlineCode: /`[^`\n]+`/.test(trimmed),
    hasUrl: /https?:\/\/|www\./i.test(trimmed),
    hasPathLikeText: /(^|\s)(~\/|\.{1,2}\/|[A-Za-z]:\\|\/[\w.-]+\/|[\w.-]+\\[\w.-]+)/.test(trimmed),
    hasCommandLikeText: /(^|\n)\s*(npm|pnpm|yarn|node|python|pip|git|curl|docker|kubectl|npx|brew)\s+/.test(trimmed),
    hasAtMediaMention: /@(图片|视频|音频)\d+/.test(trimmed),
  };
};

export interface PromptAnalyticsAttachment {
  path: string;
  name: string;
  isImage?: boolean;
  size?: number;
}

export const getAttachmentAnalyticsParams = (
  attachments: PromptAnalyticsAttachment[],
): Record<string, PromptAnalyticsValue> => {
  const groups = Array.from(new Set(attachments.map(attachment => (
    getFileTypeGroup(attachment.name || attachment.path, attachment.isImage)
  ))));
  const totalKnownSize = attachments.reduce((sum, attachment) => sum + (attachment.size ?? 0), 0);
  return {
    attachmentCount: attachments.length,
    imageAttachmentCount: attachments.filter(attachment => (
      attachment.isImage || getFileTypeGroup(attachment.name || attachment.path, attachment.isImage) === 'image'
    )).length,
    fileTypeGroups: joinValues(groups),
    totalAttachmentSizeBucket: totalKnownSize > 0 ? bucketBytes(totalKnownSize) : undefined,
  };
};

export const getSkillAnalyticsParams = (
  activeSkillIds: string[],
  skills: Skill[],
): Record<string, PromptAnalyticsValue> => {
  const activeSkills = activeSkillIds
    .map(id => skills.find(skill => skill.id === id))
    .filter((skill): skill is Skill => Boolean(skill));
  return {
    activeSkillCount: activeSkills.length,
    activeSkillIds: joinValues(activeSkills.map(skill => skill.id)),
    activeSkillNames: joinValues(activeSkills.map(skill => skill.name)),
  };
};

export const getKitAnalyticsParams = (
  activeKitIds: string[],
  marketplaceKits: MarketplaceKit[],
  installedKits: Record<string, InstalledKit>,
): Record<string, PromptAnalyticsValue> => {
  const kitNames = activeKitIds.map((kitId) => {
    const marketplaceKit = marketplaceKits.find(kit => kit.id === kitId);
    if (marketplaceKit) return resolveLocalizedText(marketplaceKit.name);
    return installedKits[kitId]?.id ?? kitId;
  });
  return {
    activeKitCount: activeKitIds.length,
    activeKitIds: joinValues(activeKitIds),
    activeKitNames: joinValues(kitNames),
  };
};

export const getModelAnalyticsParams = (
  model?: Model | null,
): Record<string, PromptAnalyticsValue> => ({
  modelId: model?.id,
  modelName: model?.name,
  modelSource: model ? (model.isServerModel ? 'package' : 'custom') : undefined,
  providerKey: model?.providerKey,
  provider: model?.provider,
  isServerModel: model?.isServerModel === true,
});
