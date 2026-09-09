import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { IpcChannel as ScheduledTaskIpc } from '../scheduledTask/constants';
import { AgentIpcChannel, AgentLegacyIdentityCleanupStatus } from '../shared/agent/constants';
import { AppIpcChannel } from '../shared/app/constants';
import { AppSettingsIpc } from '../shared/appSettings/constants';
import { AppUpdateIpc } from '../shared/appUpdate/constants';
import { ArtifactPreviewIpc } from '../shared/artifactPreview/constants';
import {
  AsrIpcChannel,
  type AsrRealtimeSessionRequest,
} from '../shared/asr/constants';
import {
  AuthIpcChannel,
  type AuthLifecycleEvent,
  type AuthSessionChangedEvent,
} from '../shared/auth/constants';
import { BrowserIpc, type BrowserRuntimeProfile } from '../shared/browserWebAccess/constants';
import { ClipboardIpc } from '../shared/clipboard/constants';
import { DataMigrationIpc } from '../shared/dataMigration/constants';
import { DialogIpc } from '../shared/dialog/constants';
import { DshIpcChannel } from '../shared/dshEngine/constants';
import { EnterpriseIpcChannel, EnterpriseModelIpcChannel } from '../shared/enterprise/constants';
import {
  EnterpriseAccountIpcChannel,
  type EnterpriseQuotaRequestType,
} from '../shared/enterpriseAccount/constants';
import type { CoworkBrowserAnnotationMessageBatch } from '../shared/genwork/browserAnnotations';
import type {
  CoworkBtwAbortRequest,
  CoworkBtwAbortResponse,
  CoworkBtwEntry,
  CoworkBtwSubmitRequest,
  CoworkBtwSubmitResponse,
} from '../shared/genwork/btw';
import {
  GenWorkIpcChannel,
  type GenWorkSessionsChangedPayload,
} from '../shared/genwork/constants';
import type { CoworkSearchMessageCursor } from '../shared/genwork/search';
import {
  HtmlShareIpc,
} from '../shared/htmlShare/constants';
import type {
  KitReference,
  KitSkillMetadata,
  ResolvedKitCapabilities,
} from '../shared/kit/constants';
import { LibraryIpc } from '../shared/library/constants';
import type {
  LibraryArtifactCandidate,
  LibraryBackfillState,
  LibraryChangedPayload,
  LibraryCloudListOptions,
  LibraryFavoriteInput,
  LibraryGetLocalItemsInput,
  LibraryLocalListOptions,
} from '../shared/library/types';
import {
  type ListLocalWebServicesOptions,
  type LocalWebService,
  LocalWebServicesIpc,
} from '../shared/localWebServices/constants';
import { type ConnectorSubmitRequest, McpIpcChannel } from '../shared/mcp/constants';
import { OpenClawEngineIpc } from '../shared/openclawEngine/constants';
import { PermissionIpcChannel } from '../shared/permissions/constants';
import type { Platform } from '../shared/platform';
import {
  type ShareDeploymentAnalyzeProjectInput,
  type ShareDeploymentCreateNodeInput,
  type ShareDeploymentDetectCandidatesInput,
  type ShareDeploymentDownloadPersistenceInput,
  type ShareDeploymentGetByLocalServiceInput,
  ShareDeploymentIpc,
  type ShareDeploymentSelectPersistencePathInput,
} from '../shared/shareDeployment/constants';
import { type ShellGetBrowserAppsInput, ShellIpc } from '../shared/shell/constants';
import {
  type SiteAnalyticsOptions,
  type SiteDeploymentQuotaOptions,
  SiteIpc,
  type SiteListOptions,
  type SiteQuotaReservationInput,
  type SiteUpdateAccessModeInput,
  type SiteUpdateAccessStatusInput,
  type SiteUpdateTitleInput,
} from '../shared/site/constants';
import { SkillIpcChannel,type SkillSubmitRequest } from '../shared/skills/constants';
import { SkinIpc } from '../shared/skin/constants';
import type {
  SkinApplyResponse,
  SkinBindThemeResponse,
  SkinDeactivateResponse,
  SkinDeleteResponse,
  SkinGetActiveResponse,
  SkinListResponse,
} from '../shared/skin/types';
import { SSO_BINDING_IPC } from '../shared/sso/binding';
import { OpenClawSessionIpc } from './openclawSession/constants';
import { OpenClawSessionPolicyIpc } from './openclawSessionPolicy/constants';

/**
 * Mirror of `SaveCredentialPayload` from `src/main/mcp/mcpAuthFlows.ts`.
 * Defined locally because preload lives in the `electron/` bundle and
 * should not import from `src/main/mcp/`. Keep this union in sync with
 * the main-side source.
 */
export type SaveCredentialPayloadLike =
  | { kind: 'bearer'; bearer: string }
  | { kind: 'apiKey'; headerName: string; value: string }
  | { kind: 'env'; envKey: string; value: string }
  | {
      kind: 'oauth';
      providerId: string;
      /** Non-secret per-connector endpoint config; mirrors `GenericOauthConfig`
       * from `src/main/mcp/genericOauthFlow.ts` (no `clientSecret`). */
      oauthConfig?: { authorizeUrl: string; tokenUrl: string; clientId: string; scopes?: string[] };
    };

// 暴露安全的 API 到渲染进程
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  arch: process.arch,
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('store:set', key, value),
    remove: (key: string) => ipcRenderer.invoke('store:remove', key),
  },
  ssoBinding: {
    list: () => ipcRenderer.invoke(SSO_BINDING_IPC.List),
    unbind: () => ipcRenderer.invoke(SSO_BINDING_IPC.Unbind),
    start: (connectionId: string) =>
      ipcRenderer.invoke(SSO_BINDING_IPC.Start, { connectionId }),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    setEnabled: (options: { id: string; enabled: boolean }) =>
      ipcRenderer.invoke('skills:setEnabled', options),
    delete: (id: string) => ipcRenderer.invoke('skills:delete', id),
    download: (source: string) => ipcRenderer.invoke('skills:download', source),
    upgrade: (skillId: string, downloadUrl: string) =>
      ipcRenderer.invoke('skills:upgrade', skillId, downloadUrl),
    confirmInstall: (pendingId: string, action: string) =>
      ipcRenderer.invoke('skills:confirmInstall', pendingId, action),
    getRoot: () => ipcRenderer.invoke('skills:getRoot'),
    autoRoutingPrompt: () => ipcRenderer.invoke('skills:autoRoutingPrompt'),
    getConfig: (skillId: string) => ipcRenderer.invoke('skills:getConfig', skillId),
    setConfig: (skillId: string, config: Record<string, string>) =>
      ipcRenderer.invoke('skills:setConfig', skillId, config),
    getEmailAccountsConfig: (skillId: string) =>
      ipcRenderer.invoke('skills:getEmailAccountsConfig', skillId),
    setEmailAccountsConfig: (skillId: string, config: unknown) =>
      ipcRenderer.invoke('skills:setEmailAccountsConfig', skillId, config),
    testEmailAccountConnectivity: (skillId: string, account: unknown) =>
      ipcRenderer.invoke('skills:testEmailAccountConnectivity', skillId, account),
    testEmailConnectivity: (skillId: string, config: Record<string, string>) =>
      ipcRenderer.invoke('skills:testEmailConnectivity', skillId, config),
    fetchMarketplace: () => ipcRenderer.invoke('skills:fetchMarketplace'),
    detectFromOpenClaw: () => ipcRenderer.invoke('skills:detectFromOpenClaw'),
    syncFromOpenClaw: () => ipcRenderer.invoke('skills:syncFromOpenClaw'),
    refreshPluginSkillIds: () => ipcRenderer.invoke('skills:refreshPluginSkillIds'),
    submit: (req: SkillSubmitRequest) =>
      ipcRenderer.invoke(SkillIpcChannel.Submit, req),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('skills:changed', handler);
      return () => ipcRenderer.removeListener('skills:changed', handler);
    },
    onMarketplaceChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(SkillIpcChannel.MarketplaceChanged, handler);
      return () => ipcRenderer.removeListener(SkillIpcChannel.MarketplaceChanged, handler);
    },
  },
  mcp: {
    list: () => ipcRenderer.invoke(McpIpcChannel.List),
    create: (data: any) => ipcRenderer.invoke(McpIpcChannel.Create, data),
    update: (id: string, data: any) => ipcRenderer.invoke(McpIpcChannel.Update, id, data),
    delete: (id: string) => ipcRenderer.invoke(McpIpcChannel.Delete, id),
    deleteByRegistryId: (registryId: string) =>
      ipcRenderer.invoke(McpIpcChannel.DeleteByRegistryId, registryId),
    setEnabled: (options: { id: string; enabled: boolean }) =>
      ipcRenderer.invoke(McpIpcChannel.SetEnabled, options),
    setEnabledByRegistryId: (options: { registryId: string; enabled: boolean }) =>
      ipcRenderer.invoke(McpIpcChannel.SetEnabledByRegistryId, options),
    retryLaunchResolution: (id: string) => ipcRenderer.invoke(McpIpcChannel.RetryLaunchResolution, id),
    fetchEnterpriseMarketplace: () => ipcRenderer.invoke(McpIpcChannel.FetchEnterpriseMarketplace),
    submitConnectorRequest: (cfg: ConnectorSubmitRequest) =>
      ipcRenderer.invoke(McpIpcChannel.SubmitConnectorRequest, cfg),
    connectQichacha: () => ipcRenderer.invoke(McpIpcChannel.ConnectQichacha),
    startAuth: (options: { id: string }) => ipcRenderer.invoke(McpIpcChannel.StartAuth, options),
    saveCredential: (options: { id: string; payload: SaveCredentialPayloadLike }) =>
      ipcRenderer.invoke(McpIpcChannel.SaveCredential, options),
    probeAuthorization: (options: { id: string }) =>
      ipcRenderer.invoke(McpIpcChannel.ProbeAuthorization, options),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(McpIpcChannel.Changed, handler);
      return () => ipcRenderer.removeListener(McpIpcChannel.Changed, handler);
    },
    onAuthFlowRequested: (callback: (options: { id: string }) => void) => {
      const handler = (_event: unknown, options: { id: string }) => callback(options);
      ipcRenderer.on(McpIpcChannel.AuthFlowRequested, handler);
      return () => ipcRenderer.removeListener(McpIpcChannel.AuthFlowRequested, handler);
    },
  },
  kits: {
    fetchStore: () => ipcRenderer.invoke('kits:fetchStore'),
    fetchEnterpriseStore: () => ipcRenderer.invoke('kits:fetchEnterpriseStore'),
    install: (params: {
      kitId: string;
      bundleUrl: string;
      version: string;
      skillListIds: string[];
      skillList?: KitSkillMetadata[];
      mcpServers?: unknown[] | null;
      connectors?: unknown[] | null;
    }) =>
      ipcRenderer.invoke('kits:install', params),
    uninstall: (kitId: string) => ipcRenderer.invoke('kits:uninstall', kitId),
    listInstalled: () => ipcRenderer.invoke('kits:listInstalled'),
  },
  skin: {
    getActive: (): Promise<SkinGetActiveResponse> => ipcRenderer.invoke(SkinIpc.GetActive),
    list: (): Promise<SkinListResponse> => ipcRenderer.invoke(SkinIpc.List),
    apply: (skinId: string, boundThemeId?: string): Promise<SkinApplyResponse> =>
      ipcRenderer.invoke(SkinIpc.Apply, skinId, boundThemeId),
    bindTheme: (skinId: string, themeId: string): Promise<SkinBindThemeResponse> =>
      ipcRenderer.invoke(SkinIpc.BindTheme, skinId, themeId),
    deactivate: (): Promise<SkinDeactivateResponse> => ipcRenderer.invoke(SkinIpc.Deactivate),
    delete: (skinId: string): Promise<SkinDeleteResponse> => ipcRenderer.invoke(SkinIpc.Delete, skinId),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(SkinIpc.Changed, handler);
      return () => ipcRenderer.removeListener(SkinIpc.Changed, handler);
    },
  },
  permissions: {
    checkCalendar: () => ipcRenderer.invoke(PermissionIpcChannel.CheckCalendar),
    requestCalendar: () => ipcRenderer.invoke(PermissionIpcChannel.RequestCalendar),
  },
  enterprise: {
    getConfig: () => ipcRenderer.invoke('enterprise:getConfig'),
  },
  enterpriseAccount: {
    getContext: () => ipcRenderer.invoke(EnterpriseAccountIpcChannel.GetContext),
    getIdentities: () => ipcRenderer.invoke(EnterpriseAccountIpcChannel.GetIdentities),
    requestQuotaIncrease: (enterpriseId: number, requestType: EnterpriseQuotaRequestType) => (
      ipcRenderer.invoke(EnterpriseAccountIpcChannel.RequestQuotaIncrease, enterpriseId, requestType)
    ),
    onContextInvalidated: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(EnterpriseAccountIpcChannel.ContextInvalidated, handler);
      return () => ipcRenderer.removeListener(EnterpriseAccountIpcChannel.ContextInvalidated, handler);
    },
  },
  api: {
    // 普通 API 请求（非流式）
    fetch: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => ipcRenderer.invoke('api:fetch', options),

    // 流式 API 请求
    stream: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      requestId: string;
    }) => ipcRenderer.invoke('api:stream', options),

    // 取消流式请求
    cancelStream: (requestId: string) => ipcRenderer.invoke('api:stream:cancel', requestId),

    // 监听流式数据
    onStreamData: (requestId: string, callback: (chunk: string) => void) => {
      const handler = (_event: any, chunk: string) => callback(chunk);
      ipcRenderer.on(`api:stream:${requestId}:data`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:data`, handler);
    },

    // 监听流式完成
    onStreamDone: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:done`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:done`, handler);
    },

    // 监听流式错误
    onStreamError: (requestId: string, callback: (error: string) => void) => {
      const handler = (_event: any, error: string) => callback(error);
      ipcRenderer.on(`api:stream:${requestId}:error`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:error`, handler);
    },

    // 监听流式取消
    onStreamAbort: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:abort`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:abort`, handler);
    },
  },
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => {
      ipcRenderer.send(channel, ...args);
    },
    on: (channel: string, func: (...args: any[]) => void) => {
      const handler = (_event: any, ...args: any[]) => func(...args);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    toggleMaximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    showSystemMenu: (position: { x: number; y: number }) =>
      ipcRenderer.send('window:showSystemMenu', position),
    onStateChanged: (
      callback: (state: {
        isMaximized: boolean;
        isFullscreen: boolean;
        isFocused: boolean;
      }) => void,
    ) => {
      const handler = (
        _event: any,
        state: { isMaximized: boolean; isFullscreen: boolean; isFocused: boolean },
      ) => callback(state);
      ipcRenderer.on('window:state-changed', handler);
      return () => ipcRenderer.removeListener('window:state-changed', handler);
    },
  },
  getApiConfig: () => ipcRenderer.invoke('get-api-config'),
  checkApiConfig: (options?: { probeModel?: boolean }) =>
    ipcRenderer.invoke('check-api-config', options),
  saveApiConfig: (config: {
    apiKey: string;
    baseURL: string;
    model: string;
    apiType?: 'anthropic' | 'openai';
  }) => ipcRenderer.invoke('save-api-config', config),
  generateSessionTitle: (userInput: string | null) =>
    ipcRenderer.invoke('generate-session-title', userInput),
  getRecentCwds: (limit?: number) => ipcRenderer.invoke('get-recent-cwds', limit),
  dsh: {
    getState: () => ipcRenderer.invoke(DshIpcChannel.GetState),
    getConfig: () => ipcRenderer.invoke(DshIpcChannel.GetConfig),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke(DshIpcChannel.SetEnabled, enabled),
    openWorkbench: () => ipcRenderer.invoke(DshIpcChannel.OpenWorkbench),
    stop: () => ipcRenderer.invoke(DshIpcChannel.Stop),
  },
  openclaw: {
    engine: {
      getStatus: () => ipcRenderer.invoke(OpenClawEngineIpc.GetStatus),
      install: () => ipcRenderer.invoke(OpenClawEngineIpc.Install),
      retryInstall: () => ipcRenderer.invoke(OpenClawEngineIpc.RetryInstall),
      restartGateway: () => ipcRenderer.invoke(OpenClawEngineIpc.RestartGateway),
      repairGatewayState: () => ipcRenderer.invoke(OpenClawEngineIpc.RepairGatewayState),
      onProgress: (callback: (status: any) => void) => {
        const handler = (_event: any, status: any) => callback(status);
        ipcRenderer.on(OpenClawEngineIpc.OnProgress, handler);
        return () => ipcRenderer.removeListener(OpenClawEngineIpc.OnProgress, handler);
      },
    },
    sessionPolicy: {
      get: () => ipcRenderer.invoke(OpenClawSessionPolicyIpc.Get),
      set: (config: { keepAlive: '1d' | '7d' | '30d' | '365d' }) =>
        ipcRenderer.invoke(OpenClawSessionPolicyIpc.Set, config),
    },
    session: {
      patch: (options: {
        sessionId: string;
        patch: {
          model?: string | null;
          thinkingLevel?: string | null;
          reasoningLevel?: string | null;
          elevatedLevel?: string | null;
          responseUsage?: 'off' | 'tokens' | 'full' | null;
          sendPolicy?: 'allow' | 'deny' | null;
        };
      }) => ipcRenderer.invoke(OpenClawSessionIpc.Patch, options),
    },
    browser: {
      getStatus: (options?: { profile?: BrowserRuntimeProfile }) => ipcRenderer.invoke(BrowserIpc.GetStatus, options),
      listProfiles: () => ipcRenderer.invoke(BrowserIpc.ListProfiles),
      test: (options?: { profile?: BrowserRuntimeProfile }) => ipcRenderer.invoke(BrowserIpc.Test, options),
      resetProfile: (options?: { profile?: BrowserRuntimeProfile }) => ipcRenderer.invoke(BrowserIpc.ResetProfile, options),
    },
    dataMigration: {
      backup: () => ipcRenderer.invoke(DataMigrationIpc.Backup),
      restore: () => ipcRenderer.invoke(DataMigrationIpc.Restore),
      getLastRestoreResult: () => ipcRenderer.invoke(DataMigrationIpc.GetLastRestoreResult),
    },
  },
  agents: {
    list: async () => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.List);
      return result?.success ? result.agents : [];
    },
    get: async (id: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.Get, id);
      return result?.success ? result.agent : null;
    },
    create: async (request: {
      id?: string;
      name: string;
      description?: string;
      systemPrompt?: string;
      identity?: string;
      model?: string;
      thinkingLevel?: string;
      workingDirectory?: string;
      icon?: string;
      skillIds?: string[];
      subagentAllowAgentIds?: string[];
      source?: string;
      presetId?: string;
    }) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.Create, request);
      return result?.success ? result.agent : null;
    },
    update: async (
      id: string,
      updates: {
        name?: string;
        description?: string;
        systemPrompt?: string;
        identity?: string;
        model?: string;
        thinkingLevel?: string;
        workingDirectory?: string;
        icon?: string;
        skillIds?: string[];
        subagentAllowAgentIds?: string[];
        enabled?: boolean;
        pinned?: boolean;
        sortOrder?: number | null;
      },
    ) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.Update, id, updates);
      return result?.success ? result.agent : null;
    },
    reorder: async (agentIds: string[]) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.Reorder, agentIds);
      return result?.success ? result.agents : null;
    },
    cleanupLegacyIdentityBlock: async (id: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.CleanupLegacyIdentityBlock, id);
      return result?.result ?? {
        status: AgentLegacyIdentityCleanupStatus.Failed,
        error: result?.error || 'Failed to clean legacy identity block',
      };
    },
    delete: async (id: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.Delete, id);
      return result?.success ? result.deleted : false;
    },
    presets: async () => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.Presets);
      return result?.success ? result.presets : [];
    },
    presetTemplates: async () => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.PresetTemplates);
      return result?.success ? result.presets : [];
    },
    addPreset: async (presetId: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.AddPreset, presetId);
      return result?.success ? result.agent : null;
    },
    fetchEnterpriseAgents: async () => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.FetchEnterpriseAgents);
      return result as { success: boolean; report?: { upserted: number; removed: number; skipped: number }; error?: string };
    },
    getEnterpriseAgentWorkingDirectory: async (agentId: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.GetEnterpriseAgentWorkingDirectory, agentId);
      return result as { success: boolean; workingDirectory?: string; error?: string };
    },
    setEnterpriseAgentWorkingDirectory: async (agentId: string, workingDirectory: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.SetEnterpriseAgentWorkingDirectory, { agentId, workingDirectory });
      return result as { success: boolean; error?: string };
    },
    getEnterpriseAgentModel: async (agentId: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.GetEnterpriseAgentModel, agentId);
      return result as { success: boolean; modelRef?: string; error?: string };
    },
    setEnterpriseAgentModel: async (agentId: string, modelRef: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.SetEnterpriseAgentModel, { agentId, modelRef });
      return result as { success: boolean; error?: string };
    },
  },
  cowork: {
    // Session management
    startSession: (options: {
      prompt: string;
      cwd?: string;
      systemPrompt?: string;
      title?: string;
      activeSkillIds?: string[];
      runtimeSkillIds?: string[];
      kitIds?: string[];
      kitReferences?: KitReference[];
      resolvedKitCapabilities?: ResolvedKitCapabilities;
      selectedTextSnippets?: Array<{ id: string; text: string; sourceMessageId?: string; sourceMessageType?: 'assistant' | 'artifact_markdown' | 'artifact_text'; sourceId?: string; sourceType?: 'assistant' | 'artifact_markdown' | 'artifact_text'; sourceTitle?: string; sourcePath?: string; artifactId?: string; createdAt: number; startOffset?: number; endOffset?: number }>;
      browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
      agentId?: string;
      modelOverride?: string;
      thinkingLevel?: string;
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string; sizeBytes?: number; localPath?: string; previewMimeType?: string; previewBase64Data?: string }>;
      mediaSelection?: { mode: string; modelId?: string; modelName?: string; imageModelId?: string; videoModelId?: string }; mediaReferences?: Array<{ token: string; mediaType: string; index: number; fileId: string; fileName: string; mimeType: string; localPath?: string; remoteUrl?: string; dataUrl?: string; role?: string }>;
    }) => ipcRenderer.invoke('genwork:session:start', options),
    continueSession: (options: {
      sessionId: string;
      prompt: string;
      systemPrompt?: string;
      activeSkillIds?: string[];
      runtimeSkillIds?: string[];
      kitIds?: string[];
      kitReferences?: KitReference[];
      resolvedKitCapabilities?: ResolvedKitCapabilities;
      selectedTextSnippets?: Array<{ id: string; text: string; sourceMessageId?: string; sourceMessageType?: 'assistant' | 'artifact_markdown' | 'artifact_text'; sourceId?: string; sourceType?: 'assistant' | 'artifact_markdown' | 'artifact_text'; sourceTitle?: string; sourcePath?: string; artifactId?: string; createdAt: number; startOffset?: number; endOffset?: number }>;
      browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string; sizeBytes?: number; localPath?: string; previewMimeType?: string; previewBase64Data?: string }>;
      mediaSelection?: { mode: string; modelId?: string; modelName?: string; imageModelId?: string; videoModelId?: string };
      mediaReferences?: Array<{
        token: string;
        mediaType: string;
        index: number;
        fileId: string;
        fileName: string;
        mimeType: string;
        localPath?: string;
        remoteUrl?: string;
        dataUrl?: string; role?: string;
      }>;
    }) => ipcRenderer.invoke('genwork:session:continue', options),
    submitBtw: (options: CoworkBtwSubmitRequest): Promise<CoworkBtwSubmitResponse> =>
      ipcRenderer.invoke(GenWorkIpcChannel.SubmitBtw, options),
    abortBtw: (options: CoworkBtwAbortRequest): Promise<CoworkBtwAbortResponse> =>
      ipcRenderer.invoke(GenWorkIpcChannel.AbortBtw, options),
    submitSteer: (options: { sessionId: string; text: string; clientSteerId: string }) =>
      ipcRenderer.invoke(GenWorkIpcChannel.SubmitSteer, options),
    runGoalCommand: (options: { sessionId: string; command: string }) =>
      ipcRenderer.invoke(GenWorkIpcChannel.GoalCommand, options),
    stopSession: (sessionId: string) =>
      ipcRenderer.invoke(GenWorkIpcChannel.StopSession, sessionId),
    deleteSession: (sessionId: string) => ipcRenderer.invoke('genwork:session:delete', sessionId),
    deleteSessions: (sessionIds: string[]) =>
      ipcRenderer.invoke('genwork:session:deleteBatch', sessionIds),
    setSessionPinned: (options: { sessionId: string; pinned: boolean }) =>
      ipcRenderer.invoke('genwork:session:pin', options),
    renameSession: (options: { sessionId: string; title: string }) =>
      ipcRenderer.invoke('genwork:session:rename', options),
    forkSession: (options: {
      sessionId: string;
      forkedFromMessageId?: string | null;
      title?: string;
    }) => ipcRenderer.invoke(GenWorkIpcChannel.ForkSession, options),
    getSession: (sessionId: string) => ipcRenderer.invoke('genwork:session:get', sessionId),
    markSessionViewed: (sessionId: string) =>
      ipcRenderer.invoke(GenWorkIpcChannel.MarkSessionViewed, sessionId),
    setActiveSession: (sessionId: string | null) =>
      ipcRenderer.invoke(GenWorkIpcChannel.SetActiveSession, sessionId),
    notifyOpenSessionFromNotificationReady: () =>
      ipcRenderer.invoke(GenWorkIpcChannel.OpenSessionFromNotificationReady),
    remoteManaged: (sessionId: string) =>
      ipcRenderer.invoke('genwork:session:remoteManaged', sessionId),
    listSessions: (options?: { limit?: number; offset?: number; agentId?: string; searchQuery?: string }) =>
      ipcRenderer.invoke('genwork:session:list', options),
    getSessionMessages: (options: { sessionId: string; limit?: number; offset?: number }) =>
      ipcRenderer.invoke('genwork:session:getMessages', options),
    getSessionSearchMessages: (options: {
      sessionId: string;
      limit?: number;
      offset?: number;
      cursor?: CoworkSearchMessageCursor;
      knownTotal?: number;
    }) =>
      ipcRenderer.invoke(GenWorkIpcChannel.GetSessionSearchMessages, options),
    getSessionMessageRailIndex: (sessionId: string) =>
      ipcRenderer.invoke(GenWorkIpcChannel.GetSessionMessageRailIndex, sessionId),
    getContextUsage: (sessionId: string) =>
      ipcRenderer.invoke('genwork:session:contextUsage', sessionId),
    compactContext: (sessionId: string) =>
      ipcRenderer.invoke('genwork:session:compactContext', sessionId),
    exportResultImage: (options: {
      rect: { x: number; y: number; width: number; height: number };
      defaultFileName?: string;
    }) => ipcRenderer.invoke('genwork:session:exportResultImage', options),
    captureImageChunk: (options: {
      rect: { x: number; y: number; width: number; height: number };
    }) => ipcRenderer.invoke('genwork:session:captureImageChunk', options),
    saveResultImage: (options: { pngBase64: string; defaultFileName?: string }) =>
      ipcRenderer.invoke('genwork:session:saveResultImage', options),
    exportSessionText: (options: {
      content: string;
      defaultFileName?: string;
      fileExtension?: string;
    }) => ipcRenderer.invoke('genwork:session:exportText', options),
    exportSessionDiagnostics: (options: { sessionId: string }) =>
      ipcRenderer.invoke(GenWorkIpcChannel.ExportSessionDiagnostics, options),

    // Subagent tracking
    getSubTaskHistory: (options: {
      parentSessionId: string;
      agentId: string;
      sessionKey?: string;
    }) => ipcRenderer.invoke(GenWorkIpcChannel.SubTaskHistory, options),
    listSubagentSessions: (parentSessionId: string) =>
      ipcRenderer.invoke(GenWorkIpcChannel.SubagentList, { parentSessionId }),
    listSubagentSessionsByAgent: (options: { agentId: string; limit?: number; offset?: number }) =>
      ipcRenderer.invoke(GenWorkIpcChannel.SubagentListByAgent, options),
    deleteSubagentSession: (options: { parentSessionId: string; runId: string }) =>
      ipcRenderer.invoke(GenWorkIpcChannel.SubagentDelete, options),

    // Media task management
    cancelMediaTask: (taskId: string) =>
      ipcRenderer.invoke(GenWorkIpcChannel.CancelMediaTask, taskId),

    // Permission handling
    respondToPermission: (options: { requestId: string; result: any }) =>
      ipcRenderer.invoke('genwork:permission:respond', options),

    // Configuration
    getConfig: () => ipcRenderer.invoke('genwork:config:get'),
    setConfig: (config: {
      workingDirectory?: string;
      executionMode?: 'auto' | 'local' | 'sandbox';
      agentEngine?: 'openclaw';
      memoryEnabled?: boolean;
      memoryImplicitUpdateEnabled?: boolean;
      memoryLlmJudgeEnabled?: boolean;
      memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
      memoryUserMemoriesMaxItems?: number;
      skipMissedJobs?: boolean;
      openClawHeartbeatEnabled?: boolean;
      embeddingEnabled?: boolean;
      embeddingProvider?: string;
      embeddingModel?: string;
      embeddingLocalModelPath?: string;
      embeddingVectorWeight?: number;
      embeddingRemoteBaseUrl?: string;
      embeddingRemoteApiKey?: string;
    }) => ipcRenderer.invoke('genwork:config:set', config),

    // Session temp storage (.cowork-temp) maintenance
    getTempStorageUsage: () => ipcRenderer.invoke(GenWorkIpcChannel.TempStorageUsage),
    cleanTempStorage: (options?: { cwds?: string[] }) =>
      ipcRenderer.invoke(GenWorkIpcChannel.TempStorageClean, options),
    listMemoryEntries: (input: {
      query?: string;
      status?: 'created' | 'stale' | 'deleted' | 'all';
      includeDeleted?: boolean;
      limit?: number;
      offset?: number;
    }) => ipcRenderer.invoke('genwork:memory:listEntries', input),
    createMemoryEntry: (input: { text: string; confidence?: number; isExplicit?: boolean }) =>
      ipcRenderer.invoke('genwork:memory:createEntry', input),
    updateMemoryEntry: (input: {
      id: string;
      text?: string;
      confidence?: number;
      status?: 'created' | 'stale' | 'deleted';
      isExplicit?: boolean;
    }) => ipcRenderer.invoke('genwork:memory:updateEntry', input),
    deleteMemoryEntry: (input: { id: string }) =>
      ipcRenderer.invoke('genwork:memory:deleteEntry', input),
    getMemoryStats: () => ipcRenderer.invoke('genwork:memory:getStats'),
    readMemoryFileRaw: () => ipcRenderer.invoke(GenWorkIpcChannel.MemoryReadRaw),
    writeMemoryFileRaw: (input: { content: string }) =>
      ipcRenderer.invoke(GenWorkIpcChannel.MemoryWriteRaw, input),
    getDreamingStatus: () => ipcRenderer.invoke('genwork:dreaming:status'),
    getDreamDiary: () => ipcRenderer.invoke('genwork:dreaming:diary'),
    readBootstrapFile: (filename: string, options?: { agentId?: string }) =>
      ipcRenderer.invoke(GenWorkIpcChannel.BootstrapRead, filename, options),
    writeBootstrapFile: (filename: string, content: string, options?: { agentId?: string }) =>
      ipcRenderer.invoke(GenWorkIpcChannel.BootstrapWrite, filename, content, options),
    // Stream event listeners
    onStreamMessage: (callback: (data: { sessionId: string; message: any; beforeMessageId?: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; message: any; beforeMessageId?: string }) => callback(data);
      ipcRenderer.on('genwork:stream:message', handler);
      return () => ipcRenderer.removeListener('genwork:stream:message', handler);
    },
    onStreamMessageUpdate: (
      callback: (data: {
        sessionId: string;
        messageId: string;
        content: string;
        metadata?: Record<string, unknown>;
      }) => void,
    ) => {
      const handler = (
        _event: any,
        data: {
          sessionId: string;
          messageId: string;
          content: string;
          metadata?: Record<string, unknown>;
        },
      ) => callback(data);
      ipcRenderer.on('genwork:stream:messageUpdate', handler);
      return () => ipcRenderer.removeListener('genwork:stream:messageUpdate', handler);
    },
    onMediaStatusPollUpdate: (callback: (data: { sessionId: string; toolCallId: string; details: Record<string, unknown> }) => void) => {
      const handler = (_event: any, data: { sessionId: string; toolCallId: string; details: Record<string, unknown> }) => callback(data);
      ipcRenderer.on(GenWorkIpcChannel.MediaStatusPollUpdate, handler);
      return () => ipcRenderer.removeListener(GenWorkIpcChannel.MediaStatusPollUpdate, handler);
    },
    onStreamSessionStatus: (callback: (data: { sessionId: string; status: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; status: string }) => callback(data);
      ipcRenderer.on('genwork:stream:sessionStatus', handler);
      return () => ipcRenderer.removeListener('genwork:stream:sessionStatus', handler);
    },
    onStreamContextUsage: (callback: (data: { sessionId: string; usage: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; usage: any }) => callback(data);
      ipcRenderer.on('genwork:stream:contextUsage', handler);
      return () => ipcRenderer.removeListener('genwork:stream:contextUsage', handler);
    },
    onStreamGoal: (callback: (data: { sessionId: string; goal: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; goal: any }) => callback(data);
      ipcRenderer.on(GenWorkIpcChannel.StreamGoal, handler);
      return () => ipcRenderer.removeListener(GenWorkIpcChannel.StreamGoal, handler);
    },
    onStreamBtwResult: (
      callback: (data: { sessionId: string; result: CoworkBtwEntry }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { sessionId: string; result: CoworkBtwEntry },
      ) => callback(data);
      ipcRenderer.on(GenWorkIpcChannel.StreamBtwResult, handler);
      return () => ipcRenderer.removeListener(GenWorkIpcChannel.StreamBtwResult, handler);
    },
    onStreamContextMaintenance: (
      callback: (data: { sessionId: string; active: boolean }) => void,
    ) => {
      const handler = (_event: any, data: { sessionId: string; active: boolean }) => callback(data);
      ipcRenderer.on('genwork:stream:contextMaintenance', handler);
      return () => ipcRenderer.removeListener('genwork:stream:contextMaintenance', handler);
    },
    onStreamPermission: (callback: (data: { sessionId: string; request: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; request: any }) => callback(data);
      ipcRenderer.on('genwork:stream:permission', handler);
      return () => ipcRenderer.removeListener('genwork:stream:permission', handler);
    },
    onStreamPermissionDismiss: (callback: (data: { requestId: string }) => void) => {
      const handler = (_event: any, data: { requestId: string }) => callback(data);
      ipcRenderer.on('genwork:stream:permissionDismiss', handler);
      return () => ipcRenderer.removeListener('genwork:stream:permissionDismiss', handler);
    },
    onStreamComplete: (
      callback: (data: { sessionId: string; claudeSessionId: string | null }) => void,
    ) => {
      const handler = (_event: any, data: { sessionId: string; claudeSessionId: string | null }) =>
        callback(data);
      ipcRenderer.on('genwork:stream:complete', handler);
      return () => ipcRenderer.removeListener('genwork:stream:complete', handler);
    },
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; error: string }) => callback(data);
      ipcRenderer.on('genwork:stream:error', handler);
      return () => ipcRenderer.removeListener('genwork:stream:error', handler);
    },
    onSessionsChanged: (callback: (data?: GenWorkSessionsChangedPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data?: GenWorkSessionsChangedPayload) => callback(data);
      ipcRenderer.on(GenWorkIpcChannel.SessionsChanged, handler);
      return () => ipcRenderer.removeListener(GenWorkIpcChannel.SessionsChanged, handler);
    },
    onSessionModelOverrideChanged: (
      callback: (data: { sessionId: string; modelOverride: string }) => void,
    ) => {
      const handler = (_event: any, data: { sessionId: string; modelOverride: string }) => callback(data);
      ipcRenderer.on(GenWorkIpcChannel.SessionModelOverrideChanged, handler);
      return () => ipcRenderer.removeListener(GenWorkIpcChannel.SessionModelOverrideChanged, handler);
    },
    onOpenSessionFromNotification: (callback: (data: { sessionId: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string }) => callback(data);
      ipcRenderer.on(GenWorkIpcChannel.OpenSessionFromNotification, handler);
      return () => ipcRenderer.removeListener(GenWorkIpcChannel.OpenSessionFromNotification, handler);
    },
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
    selectFile: (options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => ipcRenderer.invoke('dialog:selectFile', options),
    selectFiles: (options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => ipcRenderer.invoke('dialog:selectFiles', options),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    saveInlineFile: (options: {
      dataBase64: string;
      fileName?: string;
      mimeType?: string;
      cwd?: string;
    }) => ipcRenderer.invoke('dialog:saveInlineFile', options),
    readFileAsDataUrl: (filePath: string) =>
      ipcRenderer.invoke('dialog:readFileAsDataUrl', filePath),
    statFile: (filePath: string) =>
      ipcRenderer.invoke(DialogIpc.StatFile, filePath),
    readTextFile: (filePath: string) =>
      ipcRenderer.invoke(DialogIpc.ReadTextFile, filePath),
    saveFileCopy: (filePath: string) =>
      ipcRenderer.invoke(DialogIpc.SaveFileCopy, filePath),
    generateThumbnail: (filePath: string) =>
      ipcRenderer.invoke(DialogIpc.GenerateThumbnail, filePath),
    showMessageBox: (options: {
      message: string;
      type?: 'none' | 'info' | 'error' | 'question' | 'warning';
      title?: string;
    }) => ipcRenderer.invoke('dialog:showMessageBox', options),
  },
  shell: {
    openPath: (filePath: string) => ipcRenderer.invoke(ShellIpc.OpenPath, filePath),
    showItemInFolder: (filePath: string) => ipcRenderer.invoke(ShellIpc.ShowItemInFolder, filePath),
    openExternal: (url: string) => ipcRenderer.invoke(ShellIpc.OpenExternal, url),
    openHtmlInBrowser: (htmlContent: string) =>
      ipcRenderer.invoke(ShellIpc.OpenHtmlInBrowser, htmlContent),
    getAppsForFile: (filePath: string) => ipcRenderer.invoke(ShellIpc.GetAppsForFile, filePath),
    getBrowserApps: (options?: ShellGetBrowserAppsInput) =>
      ipcRenderer.invoke(ShellIpc.GetBrowserApps, options),
    openPathWithApp: (filePath: string, appPath: string) =>
      ipcRenderer.invoke(ShellIpc.OpenPathWithApp, filePath, appPath),
    openUrlWithApp: (url: string, appPath: string) =>
      ipcRenderer.invoke(ShellIpc.OpenUrlWithApp, url, appPath),
  },
  clipboard: {
    writeText: (text: string) =>
      ipcRenderer.invoke(ClipboardIpc.WriteText, text),
    writeImageFromFile: (filePath: string) =>
      ipcRenderer.invoke(ClipboardIpc.WriteImageFromFile, filePath),
    writeImageFromDataUrl: (dataUrl: string) =>
      ipcRenderer.invoke(ClipboardIpc.WriteImageFromDataUrl, dataUrl),
  },
  htmlShare: {
    createFromHtmlFile: (options: {
      sessionId: string;
      artifactId: string;
      filePath: string;
      title: string;
      clientSourceKey?: string;
      expiresAt?: string;
      accessMode?: 'public' | 'org';
    }) => ipcRenderer.invoke(HtmlShareIpc.CreateFromHtmlFile, options),
    // Legacy compat shims: the enterprise server exposes no artifact-level
    // create/update/by-file endpoints. These back only the superseded inline
    // share dialog in ArtifactPanel.tsx (unreachable dead code) and always fail.
    createFromArtifactFile: () =>
      Promise.resolve({
        success: false as const,
        error: 'legacy_share_create_unavailable',
      }),
    updateFromHtmlFile: () =>
      Promise.resolve({
        success: false as const,
        error: 'legacy_share_update_unavailable',
      }),
    updateFromArtifactFile: () =>
      Promise.resolve({
        success: false as const,
        error: 'legacy_share_update_unavailable',
      }),
    getByHtmlFile: () =>
      Promise.resolve({
        success: false as const,
        error: 'legacy_share_lookup_unavailable',
      }),
    getByArtifactFile: () =>
      Promise.resolve({
        success: false as const,
        error: 'legacy_share_lookup_unavailable',
      }),
    createFromBakedHtml: (options: {
      html: string;
      sourceType: string;
      clientSourceKey: string;
      title: string;
      expiresAt?: string;
      accessMode?: 'public' | 'org';
    }) => ipcRenderer.invoke(HtmlShareIpc.CreateFromBakedHtml, options),
    get: (shareId: string) => ipcRenderer.invoke(HtmlShareIpc.Get, shareId),
    getBySource: (options: { sourceType: string; clientSourceKey: string }) =>
      ipcRenderer.invoke(HtmlShareIpc.GetBySource, options),
    updateStatus: (options: { shareId: string; status: 'live' | 'disabled' }) =>
      ipcRenderer.invoke(HtmlShareIpc.UpdateStatus, options),
    updateAccessMode: (options: { shareId: string; accessMode: 'code' | 'public' | 'org' }) =>
      ipcRenderer.invoke(HtmlShareIpc.UpdateAccessMode, options),
    getQuota: () => ipcRenderer.invoke(HtmlShareIpc.GetQuota),
    delete: (shareId: string) => ipcRenderer.invoke(HtmlShareIpc.Delete, shareId),
  },
  shareDeployment: {
    detectProjectCandidates: (options: ShareDeploymentDetectCandidatesInput) =>
      ipcRenderer.invoke(ShareDeploymentIpc.DetectProjectCandidates, options),
    analyzeProjectDirectory: (options: ShareDeploymentAnalyzeProjectInput) =>
      ipcRenderer.invoke(ShareDeploymentIpc.AnalyzeProjectDirectory, options),
    selectPersistencePath: (options: ShareDeploymentSelectPersistencePathInput) =>
      ipcRenderer.invoke(ShareDeploymentIpc.SelectPersistencePath, options),
    createNodeDeployment: (options: ShareDeploymentCreateNodeInput) =>
      ipcRenderer.invoke(ShareDeploymentIpc.CreateNodeDeployment, options),
    get: (deploymentId: string) => ipcRenderer.invoke(ShareDeploymentIpc.Get, deploymentId),
    getByLocalService: (options: ShareDeploymentGetByLocalServiceInput) =>
      ipcRenderer.invoke(ShareDeploymentIpc.GetByLocalService, options),
    getPersistence: (deploymentId: string) =>
      ipcRenderer.invoke(ShareDeploymentIpc.GetPersistence, deploymentId),
    downloadPersistenceArchive: (options: ShareDeploymentDownloadPersistenceInput) =>
      ipcRenderer.invoke(ShareDeploymentIpc.DownloadPersistenceArchive, options),
  },
  sites: {
    list: (options: SiteListOptions = {}) => ipcRenderer.invoke(SiteIpc.List, options),
    get: (shareId: string) => ipcRenderer.invoke(SiteIpc.Get, shareId),
    updateTitle: (input: SiteUpdateTitleInput) => ipcRenderer.invoke(SiteIpc.UpdateTitle, input),
    updateAccessMode: (input: SiteUpdateAccessModeInput) =>
      ipcRenderer.invoke(SiteIpc.UpdateAccessMode, input),
    updateAccessStatus: (input: SiteUpdateAccessStatusInput) =>
      ipcRenderer.invoke(SiteIpc.UpdateAccessStatus, input),
    delete: (shareId: string) => ipcRenderer.invoke(SiteIpc.Delete, shareId),
    getAnalytics: (shareId: string, options: SiteAnalyticsOptions = {}) =>
      ipcRenderer.invoke(SiteIpc.GetAnalytics, shareId, options),
    getDeploymentQuota: (options: SiteDeploymentQuotaOptions = {}) =>
      ipcRenderer.invoke(SiteIpc.GetDeploymentQuota, options),
    createQuotaReservation: (input: SiteQuotaReservationInput) =>
      ipcRenderer.invoke(SiteIpc.CreateQuotaReservation, input),
    releaseQuotaReservation: (reservationId: string) =>
      ipcRenderer.invoke(SiteIpc.ReleaseQuotaReservation, reservationId),
  },
  library: {
    listLocal: (options: LibraryLocalListOptions = {}) =>
      ipcRenderer.invoke(LibraryIpc.ListLocal, options),
    listCloud: (options: LibraryCloudListOptions = {}) =>
      ipcRenderer.invoke(LibraryIpc.ListCloud, options),
    getLocalItems: (input: LibraryGetLocalItemsInput) =>
      ipcRenderer.invoke(LibraryIpc.GetLocalItems, input),
    getLocalDetail: (itemId: string) =>
      ipcRenderer.invoke(LibraryIpc.GetLocalDetail, itemId),
    recordCandidates: (candidates: LibraryArtifactCandidate[]) =>
      ipcRenderer.invoke(LibraryIpc.RecordCandidates, candidates),
    addLocalFiles: (filePaths: string[]) =>
      ipcRenderer.invoke(LibraryIpc.AddLocalFiles, filePaths),
    setFavorite: (input: LibraryFavoriteInput) =>
      ipcRenderer.invoke(LibraryIpc.SetFavorite, input),
    openLocal: (itemId: string) => ipcRenderer.invoke(LibraryIpc.OpenLocal, itemId),
    revealLocal: (itemId: string) => ipcRenderer.invoke(LibraryIpc.RevealLocal, itemId),
    repairIndex: () => ipcRenderer.invoke(LibraryIpc.RepairIndex),
    getIndexStatus: () => ipcRenderer.invoke(LibraryIpc.GetIndexStatus),
    getBackfillState: () => ipcRenderer.invoke(LibraryIpc.GetBackfillState),
    setBackfillState: (state: LibraryBackfillState) =>
      ipcRenderer.invoke(LibraryIpc.SetBackfillState, state),
    onChanged: (callback: (payload: LibraryChangedPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: LibraryChangedPayload) => {
        callback(payload);
      };
      ipcRenderer.on(LibraryIpc.Changed, handler);
      return () => ipcRenderer.removeListener(LibraryIpc.Changed, handler);
    },
  },
  asr: {
    createRealtimeSession: (options: AsrRealtimeSessionRequest) =>
      ipcRenderer.invoke(AsrIpcChannel.CreateRealtimeSession, options),
  },
  artifact: {
    watchFile: (filePath: string) => ipcRenderer.invoke('artifact:watchFile', filePath),
    unwatchFile: (filePath: string) => ipcRenderer.invoke('artifact:unwatchFile', filePath),
    onFileChanged: (callback: (data: { filePath: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { filePath: string }) =>
        callback(data);
      ipcRenderer.on('artifact:file:changed', handler);
      return () => {
        ipcRenderer.removeListener('artifact:file:changed', handler);
      };
    },
    createPreviewSession: (filePath: string) =>
      ipcRenderer.invoke(ArtifactPreviewIpc.CreateSession, filePath),
    createOfficePreviewSession: (filePath: string) =>
      ipcRenderer.invoke(ArtifactPreviewIpc.CreateOfficeSession, filePath),
    destroyPreviewSession: (sessionId: string) =>
      ipcRenderer.invoke(ArtifactPreviewIpc.DestroySession, sessionId),
    clearBrowserCookies: async () => {
      try {
        return await ipcRenderer.invoke(ArtifactPreviewIpc.ClearBrowserCookies);
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    clearBrowserCache: async () => {
      try {
        return await ipcRenderer.invoke(ArtifactPreviewIpc.ClearBrowserCache);
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    saveBrowserAnnotationAsset: (input: unknown) =>
      ipcRenderer.invoke(ArtifactPreviewIpc.SaveBrowserAnnotationAsset, input),
    readBrowserAnnotationAsset: (input: unknown) =>
      ipcRenderer.invoke(ArtifactPreviewIpc.ReadBrowserAnnotationAsset, input),
    deleteBrowserAnnotationAsset: (input: unknown) =>
      ipcRenderer.invoke(ArtifactPreviewIpc.DeleteBrowserAnnotationAsset, input),
    deleteBrowserAnnotationBatchAssets: (input: unknown) =>
      ipcRenderer.invoke(ArtifactPreviewIpc.DeleteBrowserAnnotationBatchAssets, input),
    listLocalWebServices: (options?: ListLocalWebServicesOptions) =>
      ipcRenderer.invoke(LocalWebServicesIpc.List, options) as Promise<LocalWebService[]>,
  },
  autoLaunch: {
    get: () => ipcRenderer.invoke(AppSettingsIpc.GetAutoLaunch),
    set: (enabled: boolean) => ipcRenderer.invoke(AppSettingsIpc.SetAutoLaunch, enabled),
  },
  preventSleep: {
    get: () => ipcRenderer.invoke(AppSettingsIpc.GetPreventSleep),
    set: (enabled: boolean) => ipcRenderer.invoke(AppSettingsIpc.SetPreventSleep, enabled),
  },
  appInfo: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getSystemLocale: () => ipcRenderer.invoke('app:getSystemLocale'),
    getKeyfromAttribution: () => ipcRenderer.invoke(AppIpcChannel.GetKeyfromAttribution),
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
    openSystemNotificationSettings: () =>
      ipcRenderer.invoke(AppIpcChannel.OpenSystemNotificationSettings),
  },
  appUpdate: {
    getState: () => ipcRenderer.invoke(AppUpdateIpc.GetState),
    checkNow: (options?: { manual?: boolean; userId?: string | null }) =>
      ipcRenderer.invoke(AppUpdateIpc.CheckNow, options),
    retryDownload: () => ipcRenderer.invoke(AppUpdateIpc.RetryDownload),
    cancelDownload: () => ipcRenderer.invoke(AppUpdateIpc.CancelDownload),
    installReady: () => ipcRenderer.invoke(AppUpdateIpc.InstallReady),
    getCompletedUpdate: () => ipcRenderer.invoke(AppUpdateIpc.GetCompletedUpdate),
    onStateChanged: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(AppUpdateIpc.StateChanged, handler);
      return () => ipcRenderer.removeListener(AppUpdateIpc.StateChanged, handler);
    },
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    detect: () => ipcRenderer.invoke('plugins:detect'),
    sync: () => ipcRenderer.invoke('plugins:sync'),
    install: (params: {
      source: 'npm' | 'clawhub' | 'git' | 'local';
      spec: string;
      registry?: string;
      version?: string;
    }) => ipcRenderer.invoke('plugins:install', params),
    uninstall: (pluginId: string) => ipcRenderer.invoke('plugins:uninstall', pluginId),
    setEnabled: (pluginId: string, enabled: boolean) =>
      ipcRenderer.invoke('plugins:set-enabled', pluginId, enabled),
    getConfigSchema: (pluginId: string) =>
      ipcRenderer.invoke('plugins:get-config-schema', pluginId),
    saveConfig: (pluginId: string, config: Record<string, unknown>) =>
      ipcRenderer.invoke('plugins:save-config', pluginId, config),
    batchSave: (changes: {
      toggles?: Array<{ pluginId: string; enabled: boolean }>;
      configs?: Array<{ pluginId: string; config: Record<string, unknown> }>;
    }) => ipcRenderer.invoke('plugins:batch-save', changes),
    checkUpdates: (pluginIds?: string[]) => ipcRenderer.invoke('plugins:check-updates', pluginIds),
    update: (pluginId: string) => ipcRenderer.invoke('plugins:update', pluginId),
    onInstallLog: (callback: (line: string) => void) => {
      const handler = (_event: any, line: string) => callback(line);
      ipcRenderer.on('plugins:install-log', handler);
      return () => ipcRenderer.removeListener('plugins:install-log', handler);
    },
  },
  log: {
    getPath: () => ipcRenderer.invoke('log:getPath'),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
    exportZip: () => ipcRenderer.invoke('log:exportZip'),
    fromRenderer: (level: string, tag: string, message: string) =>
      ipcRenderer.send('log:fromRenderer', level, tag, message),
  },
  im: {
    // Configuration
    getConfig: () => ipcRenderer.invoke('im:config:get'),
    setConfig: (
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:config:set', config, options),
    syncConfig: () => ipcRenderer.invoke('im:config:sync'),

    // Gateway control
    startGateway: (platform: Platform) => ipcRenderer.invoke('im:gateway:start', platform),
    stopGateway: (platform: Platform) => ipcRenderer.invoke('im:gateway:stop', platform),
    testGateway: (platform: Platform, configOverride?: any) =>
      ipcRenderer.invoke('im:gateway:test', platform, configOverride),

    // Status
    getStatus: () => ipcRenderer.invoke('im:status:get'),
    getLocalIp: () => ipcRenderer.invoke('im:getLocalIp') as Promise<string>,
    // OpenClaw config schema
    getOpenClawConfigSchema: () => ipcRenderer.invoke('im:openclaw:config-schema'),

    // Weixin QR login
    weixinQrLoginStart: () => ipcRenderer.invoke('im:weixin:qr-login-start'),
    weixinQrLoginWait: (sessionKey?: string) =>
      ipcRenderer.invoke('im:weixin:qr-login-wait', sessionKey),

    // POPO QR login
    popoQrLoginStart: () => ipcRenderer.invoke('im:popo:qr-login-start'),
    popoQrLoginPoll: (taskToken: string) => ipcRenderer.invoke('im:popo:qr-login-poll', taskToken),

    // POPO Multi-Instance
    addPopoInstance: (name: string) => ipcRenderer.invoke('im:popo:instance:add', name),
    deletePopoInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:popo:instance:delete', instanceId),
    setPopoInstanceConfig: (
      instanceId: string,
      config: Record<string, unknown>,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:popo:instance:config:set', instanceId, config, options),

    // Pairing
    listPairingRequests: (platform: string) => ipcRenderer.invoke('im:pairing:list', platform),
    approvePairingCode: (platform: string, code: string) =>
      ipcRenderer.invoke('im:pairing:approve', platform, code),
    rejectPairingRequest: (platform: string, code: string) =>
      ipcRenderer.invoke('im:pairing:reject', platform, code),

    // DingTalk Multi-Instance
    addDingTalkInstance: (name: string) => ipcRenderer.invoke('im:dingtalk:instance:add', name),
    deleteDingTalkInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:dingtalk:instance:delete', instanceId),
    setDingTalkInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:dingtalk:instance:config:set', instanceId, config, options),

    // QQ Multi-Instance
    addQQInstance: (name: string) => ipcRenderer.invoke('im:qq:instance:add', name),
    deleteQQInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:qq:instance:delete', instanceId),
    setQQInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean }) =>
      ipcRenderer.invoke('im:qq:instance:config:set', instanceId, config, options),

    // Feishu Multi-Instance
    addFeishuInstance: (name: string) => ipcRenderer.invoke('im:feishu:instance:add', name),
    deleteFeishuInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:feishu:instance:delete', instanceId),
    setFeishuInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:feishu:instance:config:set', instanceId, config, options),

    // Email Multi-Instance
    addEmailInstance: (name: string) => ipcRenderer.invoke('im:email:instance:add', name),
    deleteEmailInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:email:instance:delete', instanceId),
    setEmailInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:email:instance:config:set', instanceId, config, options),

    // WeCom Multi-Instance
    addWecomInstance: (name: string) => ipcRenderer.invoke('im:wecom:instance:add', name),
    deleteWecomInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:wecom:instance:delete', instanceId),
    setWecomInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:wecom:instance:config:set', instanceId, config, options),

    // Telegram Multi-Instance
    addTelegramInstance: (name: string) => ipcRenderer.invoke('im:telegram:instance:add', name),
    deleteTelegramInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:telegram:instance:delete', instanceId),
    setTelegramInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:telegram:instance:config:set', instanceId, config, options),

    // Discord Multi-Instance
    addDiscordInstance: (name: string) => ipcRenderer.invoke('im:discord:instance:add', name),
    deleteDiscordInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:discord:instance:delete', instanceId),
    setDiscordInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:discord:instance:config:set', instanceId, config, options),

    // Event listeners
    onStatusChange: (callback: (status: any) => void) => {
      const handler = (_event: any, status: any) => callback(status);
      ipcRenderer.on('im:status:change', handler);
      return () => ipcRenderer.removeListener('im:status:change', handler);
    },
    onMessageReceived: (callback: (message: any) => void) => {
      const handler = (_event: any, message: any) => callback(message);
      ipcRenderer.on('im:message:received', handler);
      return () => ipcRenderer.removeListener('im:message:received', handler);
    },
  },
  scheduledTasks: {
    // Task CRUD
    list: () => ipcRenderer.invoke(ScheduledTaskIpc.List),
    get: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Get, id),
    create: (input: any) => ipcRenderer.invoke(ScheduledTaskIpc.Create, input),
    update: (id: string, input: any) => ipcRenderer.invoke(ScheduledTaskIpc.Update, id, input),
    delete: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Delete, id),
    toggle: (id: string, enabled: boolean) =>
      ipcRenderer.invoke(ScheduledTaskIpc.Toggle, id, enabled),

    // Execution
    runManually: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.RunManually, id),
    stop: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Stop, id),

    // Run history
    listRuns: (taskId: string, limit?: number, offset?: number, filter?: any) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ListRuns, taskId, limit, offset, filter),
    countRuns: (taskId: string) => ipcRenderer.invoke(ScheduledTaskIpc.CountRuns, taskId),
    listAllRuns: (limit?: number, offset?: number, filter?: any) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ListAllRuns, limit, offset, filter),
    resolveSession: (input: string | { sessionId?: string | null; sessionKey?: string | null }) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ResolveSession, input),

    // Delivery channels
    listChannels: () => ipcRenderer.invoke(ScheduledTaskIpc.ListChannels),
    listChannelConversations: (channel: string, accountId?: string, filterAccountId?: string) =>
      ipcRenderer.invoke(
        ScheduledTaskIpc.ListChannelConversations,
        channel,
        accountId,
        filterAccountId,
      ),

    // Stream event listeners
    onStatusUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(ScheduledTaskIpc.StatusUpdate, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.StatusUpdate, handler);
    },
    onRunUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(ScheduledTaskIpc.RunUpdate, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.RunUpdate, handler);
    },
    onRefresh: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(ScheduledTaskIpc.Refresh, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.Refresh, handler);
    },
  },
  networkStatus: {
    send: (status: 'online' | 'offline') => ipcRenderer.send('network:status-change', status),
  },
  auth: {
    onQuotaChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(AuthIpcChannel.QuotaChanged, handler);
      return () => ipcRenderer.removeListener(AuthIpcChannel.QuotaChanged, handler);
    },
    onSessionChanged: (callback: (event: AuthSessionChangedEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: AuthSessionChangedEvent) => callback(data);
      ipcRenderer.on(AuthIpcChannel.SessionChanged, handler);
      return () => ipcRenderer.removeListener(AuthIpcChannel.SessionChanged, handler);
    },
    onLifecycleEvent: (callback: (event: AuthLifecycleEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: AuthLifecycleEvent) => callback(data);
      ipcRenderer.on(AuthIpcChannel.LifecycleEvent, handler);
      return () => ipcRenderer.removeListener(AuthIpcChannel.LifecycleEvent, handler);
    },
  },
  media: {
    getModels: (type: 'image' | 'video') =>
      ipcRenderer.invoke(GenWorkIpcChannel.GetMediaModels, type) as Promise<{ success: boolean; models?: unknown[]; error?: string }>,
    getTaskStatus: (taskId: number, type: 'image' | 'video') =>
      ipcRenderer.invoke('media:getTaskStatus', taskId, type) as Promise<{ success: boolean; task?: unknown; error?: string }>,
  },
  feishu: {
    install: {
      qrcode: (isLark: boolean) =>
        ipcRenderer.invoke('feishu:install:qrcode', { isLark }) as Promise<{
          url: string;
          deviceCode: string;
          interval: number;
          expireIn: number;
        }>,
      poll: (deviceCode: string) =>
        ipcRenderer.invoke('feishu:install:poll', { deviceCode }) as Promise<{
          done: boolean;
          appId?: string;
          appSecret?: string;
          domain?: string;
          error?: string;
        }>,
      verify: (appId: string, appSecret: string) =>
        ipcRenderer.invoke('feishu:install:verify', { appId, appSecret }) as Promise<{
          success: boolean;
          error?: string;
        }>,
    },
  },
  dingtalk: {
    install: {
      qrcode: () =>
        ipcRenderer.invoke('dingtalk:install:qrcode') as Promise<{
          url: string;
          deviceCode: string;
          interval: number;
          expireIn: number;
        }>,
      poll: (deviceCode: string) =>
        ipcRenderer.invoke('dingtalk:install:poll', { deviceCode }) as Promise<{
          done: boolean;
          clientId?: string;
          clientSecret?: string;
          error?: string;
        }>,
      verify: (clientId: string, clientSecret: string) =>
        ipcRenderer.invoke('dingtalk:install:verify', { clientId, clientSecret }) as Promise<{
          success: boolean;
          error?: string;
        }>,
    },
  },
  githubCopilot: {
    requestDeviceCode: () =>
      ipcRenderer.invoke('github-copilot:request-device-code') as Promise<{
        userCode: string;
        verificationUri: string;
        deviceCode: string;
        interval: number;
        expiresIn: number;
      }>,
    pollForToken: (deviceCode: string, interval: number, expiresIn: number) =>
      ipcRenderer.invoke('github-copilot:poll-for-token', {
        deviceCode,
        interval,
        expiresIn,
      }) as Promise<{
        success: boolean;
        token?: string;
        githubUser?: string;
        baseUrl?: string;
        error?: string;
      }>,
    cancelPolling: () => ipcRenderer.invoke('github-copilot:cancel-polling') as Promise<void>,
    signOut: () => ipcRenderer.invoke('github-copilot:sign-out') as Promise<void>,
    refreshToken: () =>
      ipcRenderer.invoke('github-copilot:refresh-token') as Promise<{
        success: boolean;
        token?: string;
        baseUrl?: string;
        error?: string;
      }>,
    onTokenUpdated: (callback: (data: { token: string; baseUrl: string }) => void) => {
      const handler = (_event: unknown, data: { token: string; baseUrl: string }) => callback(data);
      ipcRenderer.on('github-copilot:token-updated', handler);
      return () => ipcRenderer.removeListener('github-copilot:token-updated', handler);
    },
  },
  openaiCodexOAuth: {
    start: () =>
      ipcRenderer.invoke('openai-codex-oauth:start') as Promise<
        | { success: true; email: string | null; accountId: string | null; expiresAt: number }
        | { success: false; error: string }
      >,
    cancel: () => ipcRenderer.invoke('openai-codex-oauth:cancel') as Promise<void>,
    logout: () => ipcRenderer.invoke('openai-codex-oauth:logout') as Promise<void>,
    status: () =>
      ipcRenderer.invoke('openai-codex-oauth:status') as Promise<
        | { loggedIn: true; email: string | null; accountId: string | null; expiresAt: number }
        | { loggedIn: false }
      >,
  },
  xaiOAuth: {
    start: () =>
      ipcRenderer.invoke('xai-oauth:start') as Promise<
        | { success: true; email: string | null; flow: 'browser' | 'device-code' }
        | { success: false; error: string }
      >,
    cancel: () => ipcRenderer.invoke('xai-oauth:cancel') as Promise<void>,
    logout: () => ipcRenderer.invoke('xai-oauth:logout') as Promise<void>,
    status: () =>
      ipcRenderer.invoke('xai-oauth:status') as Promise<{
        loggedIn: boolean;
        email?: string;
        displayName?: string;
        expiresAt?: number;
      }>,
    onDeviceCode: (
      callback: (info: {
        userCode: string;
        verificationUri: string;
        verificationUriComplete?: string;
        expiresInMs: number;
      }) => void,
    ) => {
      const handler = (
        _event: unknown,
        info: {
          userCode: string;
          verificationUri: string;
          verificationUriComplete?: string;
          expiresInMs: number;
        },
      ) => callback(info);
      ipcRenderer.on('xai-oauth:device-code', handler);
      return () => ipcRenderer.removeListener('xai-oauth:device-code', handler);
    },
  },
  enterpriseMt: {
    login: (args: {
      orgId: string;
      username: string;
      password: string;
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.Login, args),
    logout: (): Promise<void> => ipcRenderer.invoke(EnterpriseIpcChannel.Logout),
    onSessionRevoked: (callback: () => void): (() => void) => {
      const handler = (): void => callback();
      ipcRenderer.on(EnterpriseIpcChannel.SessionRevoked, handler);
      return () => ipcRenderer.removeListener(EnterpriseIpcChannel.SessionRevoked, handler);
    },
    listOrgs: (): Promise<{ orgs: { id: string; name: string }[] }> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.ListOrgs),
    getMe: (): Promise<unknown> => ipcRenderer.invoke(EnterpriseIpcChannel.GetMe),
    updateMe: (displayName: string): Promise<unknown> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.UpdateMe, displayName),
    changePassword: (args: {
      currentPassword: string;
      newPassword: string;
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.ChangePassword, args),
    getModels: (): Promise<unknown[]> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.GetModels),
    getPolicies: (type: 'mcp' | 'skill'): Promise<unknown[]> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.GetPolicies, type),
    postAudit: (events: unknown[]): Promise<void> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.PostAudit, events),
    getUsageToday: (): Promise<unknown> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.GetUsageToday),
    getBootstrapStatus: (): Promise<{ configured: boolean; url: string | null }> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.BootstrapStatus),
    getStoredUrl: (): Promise<{ url: string | null }> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.GetStoredUrl),
    verifyUrl: (url: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.VerifyUrl, url),
    saveUrl: (url: string): Promise<{ ok: boolean; status?: { configured: boolean; url: string | null }; error?: string }> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.SaveUrl, url),
    setUrl: (url: string): Promise<{ configured: boolean; url: string | null }> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.SetUrl, url),
    setLastSelectedModelId: (id: string): Promise<void> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.SetLastSelectedModelId, id),
    quit: (): Promise<void> => ipcRenderer.invoke(EnterpriseIpcChannel.Quit),
    ssoProviders: (orgName: string): Promise<{ providers: Array<{ id: string; name: string; provider_type: string; sort_order: number }> }> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.SsoProviders, orgName),
    ssoLogin: (args: { orgName: string; connectionId: string }): Promise<{ ok: true; token: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke(EnterpriseIpcChannel.SsoLogin, args),
  },
  enterpriseModels: {
    list: (): Promise<unknown[]> =>
      ipcRenderer.invoke(EnterpriseModelIpcChannel.ListModels),
    refresh: (): Promise<{ ok: boolean; refreshed?: number; error?: string }> =>
      ipcRenderer.invoke(EnterpriseModelIpcChannel.Refresh),
    setActive: (modelId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(EnterpriseModelIpcChannel.SetActive, modelId),
    getActive: (): Promise<{ modelId: string | null }> =>
      ipcRenderer.invoke(EnterpriseModelIpcChannel.GetActive),
  },
});
