import { CubeIcon, LockClosedIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { AgentLegacyIdentityCleanupStatus } from '@shared/agent';
import type { Platform } from '@shared/platform';
import { PlatformRegistry } from '@shared/platform';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { agentService } from '../../services/agent';
import { genworkService } from '../../services/genwork';
import { i18nService } from '../../services/i18n';
import { imService } from '../../services/im';
import { resolveThinkingLevelForModel } from '../../services/modelThinkingLevelMemory';
import { RootState } from '../../store';
import type { Model } from '../../store/slices/modelSlice';
import type { Agent } from '../../types/agent';
import type { DingTalkInstanceConfig, DiscordInstanceConfig, FeishuInstanceConfig, IMGatewayConfig, PopoInstanceConfig, QQInstanceConfig, TelegramInstanceConfig, WecomInstanceConfig } from '../../types/im';
import type { Skill } from '../../types/skill';
import { getAgentDisplayName, getAgentDisplayNameById, isDefaultAgentId } from '../../utils/agentDisplay';
import { resolveOpenClawModelRef, toOpenClawModelRef } from '../../utils/openclawModelRef';
import { getVisibleIMPlatforms } from '../../utils/regionFilter';
import Modal from '../common/Modal';
import TrashIcon from '../icons/TrashIcon';
import ModelSelector from '../ModelSelector';
import AgentAvatarPicker from './AgentAvatarPicker';
import AgentConfirmDialog from './AgentConfirmDialog';
import AgentDetailToolbar from './AgentDetailToolbar';
import { buildBaselineSubagentCandidates, partitionSubagents } from './agentProvenancePanel';
import AgentSkillSelector from './AgentSkillSelector';
import AgentWorkingDirectoryField from './AgentWorkingDirectoryField';
import { AgentConfirmDialogVariant, AgentDetailTab } from './constants';

type MultiInstancePlatform = 'dingtalk' | 'feishu' | 'qq' | 'wecom' | 'telegram' | 'discord' | 'popo';
type MultiInstanceConfig = DingTalkInstanceConfig | FeishuInstanceConfig | QQInstanceConfig | WecomInstanceConfig | TelegramInstanceConfig | DiscordInstanceConfig | PopoInstanceConfig;

const MULTI_INSTANCE_PLATFORMS: MultiInstancePlatform[] = ['dingtalk', 'feishu', 'qq', 'wecom', 'telegram', 'discord', 'popo'];

const isMultiInstancePlatform = (platform: Platform): platform is MultiInstancePlatform =>
  MULTI_INSTANCE_PLATFORMS.includes(platform as MultiInstancePlatform);

type AgentSettingsActionType =
  | 'open'
  | 'close'
  | 'tab_change'
  | 'save_submit'
  | 'save_success'
  | 'save_failed'
  | 'discard_confirm_open'
  | 'discard_confirm_submit'
  | 'discard_confirm_cancel';

interface AgentSettingsPanelProps {
  agentId: string | null;
  onClose: () => void;
}

const AgentSettingsPanel: React.FC<AgentSettingsPanelProps> = ({ agentId, onClose }) => {
  const agents = useSelector((state: RootState) => state.agent.agents);
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const defaultSelectedModel = useSelector((state: RootState) => state.model.defaultSelectedModel);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const [, setAgent] = useState<Agent | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [identity, setIdentity] = useState('');
  const [userInfo, setUserInfo] = useState('');
  const [icon, setIcon] = useState('');
  const [model, setModel] = useState<Model | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState('');
  // Enterprise (server-owned) agents store their working directory in
  // enterprise_agent_prefs (the local row is read-only), so the value lives
  // separately and is committed by the panel's unified Save, not its own button.
  const [enterpriseWorkingDirectory, setEnterpriseWorkingDirectory] = useState('');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [subagentAllowAgentIds, setSubagentAllowAgentIds] = useState<string[]>([]);
  const [nameTouched, setNameTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<AgentDetailTab>(AgentDetailTab.Prompt);
  const openedAgentIdRef = useRef<string | null>(null);

  // IM binding state — keys are platform names or `platform:<instanceId>` for multi-instance platforms.
  const [imConfig, setImConfig] = useState<IMGatewayConfig | null>(null);
  const [boundKeys, setBoundKeys] = useState<Set<string>>(new Set());
  const [initialBoundKeys, setInitialBoundKeys] = useState<Set<string>>(new Set());
  const isMainAgent = isDefaultAgentId(agentId);
  const agentSummary = agents.find((a) => a.id === agentId);
  const isServerOwned = agentSummary?.isServerOwned === true;
  const enterpriseAgentId = agentSummary?.enterpriseAgentId;

  // Enterprise (server-owned) agents: the baseline sets come from the server
  // and are locked in the UI; everything else is the local overlay.
  const baselineSkillIds = agentSummary?.serverSkillLocalIds ?? [];
  const baselineSubagentIds = agentSummary?.serverSubagentLocalIds ?? [];
  // Raw server collaborator ids (the full baseline, spec §3). Raw ids with
  // no local mirror row are rendered by raw id (decision 3) alongside the
  // resolved baseline rows — see `buildBaselineSubagentCandidates`.
  const serverSubagentIds = agentSummary?.serverSubagentAllowAgentIds ?? [];
  const serverSkillIds = agentSummary?.serverSkillIds ?? [];
  const installedBaselineServerIds = agentSummary?.serverSkillInstalledIds ?? [];
  const { removableSkillIds: addedSubagentIds } = partitionSubagents({
    effectiveSubagentIds: subagentAllowAgentIds,
    baselineSubagentIds,
  });
  const serverImChannels = agentSummary?.serverImChannels ?? [];
  // Server-owned agents: the IM tab is restricted to the channels the
  // server started, limited to known, locale-visible platforms. Unknown
  // server ids are dropped here so they never reach the platform registry
  // (whose lookups are non-null-asserted).
  const visibleServerChannels = serverImChannels.filter(
    (channel) =>
      (PlatformRegistry.platforms as readonly string[]).includes(channel)
      && (getVisibleIMPlatforms(i18nService.getLanguage()) as readonly string[]).includes(channel),
  ) as Platform[];

  // Snapshot of initial values for dirty detection
  const initialValuesRef = useRef({
    name: '',
    description: '',
    systemPrompt: '',
    identity: '',
    userInfo: '',
    icon: '',
    model: '',
    workingDirectory: '',
    skillIds: [] as string[],
    subagentAllowAgentIds: [] as string[],
  });

  // Enterprise agents: the server model default and the locally stored model
  // override (enterprise_agent_prefs) captured at load time. The agent follows
  // the server default unless the user changed the model; the save path writes
  // an override only when the selection diverges from the server default
  // (serverModelRef) and clears it when the user reverts to that default.
  const serverModelRef = useRef('');
  const modelOverrideRef = useRef('');
  // The enterprise working directory loaded from enterprise_agent_prefs at
  // open time; Save persists it back only when it diverges from this value.
  const enterpriseWorkingDirRef = useRef('');

  const parsePrimaryModelRefLocal = (ref: string) => {
    const i = ref.indexOf('/');
    return i > 0 && i < ref.length - 1;
  };

  const getChangedFields = useCallback((): string[] => {
    const init = initialValuesRef.current;
    const changedFields: string[] = [];
    if (name !== init.name) changedFields.push('name');
    if (description !== init.description) changedFields.push('description');
    if (systemPrompt !== init.systemPrompt) changedFields.push('systemPrompt');
    if (identity !== init.identity) changedFields.push('identity');
    if (userInfo !== init.userInfo) changedFields.push('userInfo');
    if (icon !== init.icon) changedFields.push('icon');
    if ((model ? toOpenClawModelRef(model) : '') !== init.model) changedFields.push('model');
    if (workingDirectory !== init.workingDirectory) changedFields.push('workingDirectory');
    if (skillIds.length !== init.skillIds.length || skillIds.some((id, i) => id !== init.skillIds[i])) {
      changedFields.push('skillIds');
    }
    if (
      subagentAllowAgentIds.length !== init.subagentAllowAgentIds.length ||
      subagentAllowAgentIds.some((id, i) => id !== init.subagentAllowAgentIds[i])
    ) {
      changedFields.push('subagentAllowAgentIds');
    }
    if (boundKeys.size !== initialBoundKeys.size || [...boundKeys].some((k) => !initialBoundKeys.has(k))) {
      changedFields.push('imBindings');
    }
    return changedFields;
  }, [
    boundKeys,
    description,
    icon,
    identity,
    initialBoundKeys,
    model,
    name,
    skillIds,
    subagentAllowAgentIds,
    systemPrompt,
    userInfo,
    workingDirectory,
  ]);

  const getSelectedSkills = useCallback((): Skill[] => (
    skillIds
      .map(skillId => skills.find(skill => skill.id === skillId))
      .filter((skill): skill is Skill => Boolean(skill))
  ), [skillIds, skills]);

  const getImPlatformsForAnalytics = useCallback((): string[] => {
    const platforms = new Set<string>();
    boundKeys.forEach((key) => {
      const platform = key.split(':')[0]?.trim();
      if (platform) {
        platforms.add(platform);
      }
    });
    return Array.from(platforms).sort();
  }, [boundKeys]);

  const reportAgentSettingsAction = useCallback((
    actionType: AgentSettingsActionType,
    _options: {
      activeTab?: AgentDetailTab;
      changedFields?: string[];
      includeConfigDetails?: boolean;
      isDirty?: boolean;
      result?: 'success' | 'failed';
      targetTab?: AgentDetailTab;
    } = {},
  ): void => {
    console.debug(`[AgentSettingsPanel] reporting analytics action ${actionType}`);
  }, [
    activeTab,
    agentId,
    boundKeys.size,
    getImPlatformsForAnalytics,
    getSelectedSkills,
    model,
    skillIds.length,
    workingDirectory,
  ]);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setActiveTab(AgentDetailTab.Identity);
    setShowDeleteConfirm(false);
    setShowUnsavedConfirm(false);
    setNameTouched(false);

    void (async () => {
      const a = await window.electron?.agents?.get(agentId);
      if (!a || cancelled) return;

      let nextSystemPrompt = a.systemPrompt;
      let nextIdentity = a.identity;
      const nextUserInfo = await genworkService.readBootstrapFile('USER.md', { agentId });
      if (cancelled) return;
      if (isDefaultAgentId(agentId)) {
        const [mainIdentity, mainSoul] = await Promise.all([
          genworkService.readBootstrapFile('IDENTITY.md', { agentId }),
          genworkService.readBootstrapFile('SOUL.md', { agentId }),
        ]);
        if (cancelled) return;
        nextSystemPrompt = mainSoul;
        nextIdentity = mainIdentity;
      }

      setAgent(a);
      setName(a.name);
      setDescription(a.description);
      setSystemPrompt(nextSystemPrompt);
      setIdentity(nextIdentity);
      setUserInfo(nextUserInfo);
      setIcon(a.icon);
      // Model precedence (enterprise): local override → server default → global.
      // Non-enterprise: server row model → global.
      let effectiveRef = a.model || '';
      // The enterprise working directory lives in enterprise_agent_prefs (the
      // local row's workingDirectory is always ''), so load it from prefs when
      // the row is a server-owned mirror.
      let nextEnterpriseWorkingDirectory = '';
      if (a.source === 'enterprise' && a.enterpriseAgentId) {
        serverModelRef.current = a.model || '';
        const overrideRef = await window.electron?.agents?.getEnterpriseAgentModel(a.enterpriseAgentId)
          ?.then(r => (r.success ? (r.modelRef ?? '') : '')) ?? '';
        modelOverrideRef.current = overrideRef;
        if (overrideRef && parsePrimaryModelRefLocal(overrideRef)) {
          effectiveRef = overrideRef;
        }
        const wdResult = await window.electron?.agents?.getEnterpriseAgentWorkingDirectory(a.enterpriseAgentId);
        if (wdResult?.success) {
          nextEnterpriseWorkingDirectory = wdResult.workingDirectory ?? '';
        }
        enterpriseWorkingDirRef.current = nextEnterpriseWorkingDirectory;
      }
      const resolvedModel = resolveOpenClawModelRef(effectiveRef, availableModels) ?? defaultSelectedModel ?? null;
      const resolvedModelRef = resolvedModel ? toOpenClawModelRef(resolvedModel) : '';
      setModel(resolvedModel);
      setWorkingDirectory(a.workingDirectory ?? '');
      setEnterpriseWorkingDirectory(nextEnterpriseWorkingDirectory);
      setSkillIds(a.skillIds ?? []);
      setSubagentAllowAgentIds(a.subagentAllowAgentIds ?? []);
      initialValuesRef.current = {
        name: a.name,
        description: a.description,
        systemPrompt: nextSystemPrompt,
        identity: nextIdentity,
        userInfo: nextUserInfo,
        icon: a.icon,
        model: resolvedModelRef,
        workingDirectory: a.workingDirectory ?? '',
        skillIds: a.skillIds ?? [],
        subagentAllowAgentIds: a.subagentAllowAgentIds ?? [],
      };
    })();

    // Load IM config and status for bindings
    imService.loadConfig().then((cfg) => {
      if (cfg && !cancelled) {
        setImConfig(cfg);
        const bindings = cfg.settings?.platformAgentBindings || {};
        const bound = new Set<string>();
        for (const [key, boundAgentId] of Object.entries(bindings)) {
          if (boundAgentId === agentId) {
            bound.add(key);
          }
        }
        setBoundKeys(bound);
        setInitialBoundKeys(new Set(bound));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, availableModels, defaultSelectedModel]);

  useEffect(() => {
    if (!agentId) {
      openedAgentIdRef.current = null;
      return;
    }
    if (openedAgentIdRef.current === agentId) return;
    openedAgentIdRef.current = agentId;
    reportAgentSettingsAction('open', {
      activeTab: AgentDetailTab.Identity,
      isDirty: false,
    });
  }, [agentId, reportAgentSettingsAction]);

  const isDirty = useCallback((): boolean => {
    return getChangedFields().length > 0;
  }, [getChangedFields]);

  if (!agentId) return null;

  const handleClose = () => {
    const changedFields = getChangedFields();
    if (changedFields.length > 0) {
      reportAgentSettingsAction('discard_confirm_open', {
        changedFields,
        isDirty: true,
      });
      setShowUnsavedConfirm(true);
    } else {
      reportAgentSettingsAction('close', { isDirty: false });
      onClose();
    }
  };

  const handleConfirmDiscard = () => {
    reportAgentSettingsAction('discard_confirm_submit', {
      changedFields: getChangedFields(),
      isDirty: true,
    });
    setShowUnsavedConfirm(false);
    onClose();
  };

  const handleCancelDiscard = () => {
    reportAgentSettingsAction('discard_confirm_cancel', {
      changedFields: getChangedFields(),
      isDirty: true,
    });
    setShowUnsavedConfirm(false);
  };

  const handleTabChange = (targetTab: AgentDetailTab) => {
    if (targetTab === activeTab) return;
    reportAgentSettingsAction('tab_change', {
      activeTab,
      isDirty: isDirty(),
      targetTab,
    });
    setActiveTab(targetTab);
  };

  /** Persist instance→agent IM bindings when they changed while the panel
   *  was open. Used by both save paths — enterprise agents can bind
   *  instances of the server-started channels, but never take the
   *  main-agent implicit-default path (they are never the main agent). */
  const persistIMBindingsIfNeeded = async (): Promise<void> => {
    const bindingsChanged =
      boundKeys.size !== initialBoundKeys.size ||
      [...boundKeys].some((k) => !initialBoundKeys.has(k));
    if (!bindingsChanged || !imConfig) return;
    const currentBindings = { ...(imConfig.settings?.platformAgentBindings || {}) };
    // Remove old bindings for this agent
    for (const key of Object.keys(currentBindings)) {
      if (currentBindings[key] === agentId) {
        delete currentBindings[key];
      }
    }
    if (isMainAgent) {
      // The main agent is the implicit default. Claiming an IM channel means
      // removing any explicit binding held by another agent.
      for (const key of boundKeys) {
        delete currentBindings[key];
      }
    } else {
      for (const key of boundKeys) {
        currentBindings[key] = agentId;
      }
    }
    await imService.persistConfig({
      settings: { ...imConfig.settings, platformAgentBindings: currentBindings },
    });
    await imService.saveAndSyncConfig();
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    const changedFields = getChangedFields();
    reportAgentSettingsAction('save_submit', {
      changedFields,
      includeConfigDetails: true,
      isDirty: changedFields.length > 0,
    });
    setSaving(true);
    try {
      if (isServerOwned) {
        // Enterprise-managed agents: commit only the local overlay (skills and
        // subagent allowances). Server-owned scalars are read-only and must
        // not be resent, and no bootstrap files are written.
        const overlayResult = await agentService.updateAgent(agentId, {
          skillIds,
          subagentAllowAgentIds,
        });
        if (!overlayResult) {
          reportAgentSettingsAction('save_failed', {
            changedFields,
            includeConfigDetails: true,
            isDirty: changedFields.length > 0,
            result: 'failed',
          });
          window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentSaveFailed') }));
          return;
        }
        // Persist instance→agent bindings for the server-started channels —
        // the only IM control available on enterprise agents.
        await persistIMBindingsIfNeeded();
        // The server model default is read-only, so a changed model selection
        // The enterprise default model (server-configured) is the baseline the
        // agent follows unless the user actually changed it. Persist a local
        // override only when the selection diverges from that default, and clear
        // it back to '' when the user reverts to the default — otherwise the
        // first save pins the displayed model and the agent stops following a
        // server-side default change. A failure must not block the overlay save.
        if (enterpriseAgentId) {
          const nextModelRef = model ? toOpenClawModelRef(model) : '';
          const enterpriseDefaultRef = serverModelRef.current;
          const nextModelOverride =
            nextModelRef && nextModelRef !== enterpriseDefaultRef ? nextModelRef : '';
          if (nextModelOverride !== modelOverrideRef.current) {
            try {
              await window.electron?.agents?.setEnterpriseAgentModel(
                enterpriseAgentId,
                nextModelOverride,
              );
              modelOverrideRef.current = nextModelOverride;
            } catch (error) {
              console.warn('[AgentSettingsPanel] failed to persist enterprise model override:', error);
            }
          }
          // The working directory is the enterprise overlay counterpart of the
          // (read-only) local row's workingDirectory; persist it alongside the
          // model override, skipping the IPC write when unchanged.
          const nextEnterpriseWorkingDirectory = enterpriseWorkingDirectory.trim();
          if (nextEnterpriseWorkingDirectory !== enterpriseWorkingDirRef.current) {
            try {
              await window.electron?.agents?.setEnterpriseAgentWorkingDirectory(enterpriseAgentId, nextEnterpriseWorkingDirectory);
              enterpriseWorkingDirRef.current = nextEnterpriseWorkingDirectory;
            } catch (error) {
              console.warn('[AgentSettingsPanel] failed to persist enterprise working directory:', error);
            }
          }
        }
        reportAgentSettingsAction('save_success', {
          changedFields,
          includeConfigDetails: true,
          isDirty: false,
          result: 'success',
        });
        onClose();
        return;
      }
      const modelRef = model ? toOpenClawModelRef(model) : '';
      const result = await agentService.updateAgent(agentId, {
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        identity: identity.trim(),
        model: modelRef,
        ...(modelRef !== initialValuesRef.current.model
          ? { thinkingLevel: resolveThinkingLevelForModel(model) }
          : {}),
        workingDirectory: workingDirectory.trim(),
        icon: icon.trim(),
        skillIds,
        subagentAllowAgentIds,
      });
      if (!result) {
        reportAgentSettingsAction('save_failed', {
          changedFields,
          includeConfigDetails: true,
          isDirty: changedFields.length > 0,
          result: 'failed',
        });
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentSaveFailed') }));
        return;
      }
      const bootstrapWrites = isMainAgent
        ? [
            genworkService.writeBootstrapFile('IDENTITY.md', identity, { agentId }),
            genworkService.writeBootstrapFile('SOUL.md', systemPrompt, { agentId }),
            genworkService.writeBootstrapFile('USER.md', userInfo, { agentId }),
          ]
        : [
            genworkService.writeBootstrapFile('USER.md', userInfo, { agentId }),
          ];
      if (bootstrapWrites.length > 0) {
        const bootstrapSaved = await Promise.all(bootstrapWrites);
        if (bootstrapSaved.some((saved) => !saved)) {
          reportAgentSettingsAction('save_failed', {
            changedFields,
            includeConfigDetails: true,
            isDirty: changedFields.length > 0,
            result: 'failed',
          });
          window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentSaveFailed') }));
          return;
        }
      }
      if (changedFields.includes('identity')) {
        const cleanupResult = await agentService.cleanupLegacyIdentityBlock(agentId);
        if (cleanupResult.status === AgentLegacyIdentityCleanupStatus.Failed) {
          console.warn('[AgentSettingsPanel] failed to clean legacy AGENTS.md identity block:', cleanupResult.error);
        }
      }
      // Persist IM bindings if changed
      await persistIMBindingsIfNeeded();
      reportAgentSettingsAction('save_success', {
        changedFields,
        includeConfigDetails: true,
        isDirty: false,
        result: 'success',
      });
      onClose();
    } catch {
      reportAgentSettingsAction('save_failed', {
        changedFields,
        includeConfigDetails: true,
        isDirty: changedFields.length > 0,
        result: 'failed',
      });
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentSaveFailed') }));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const success = await agentService.deleteAgent(agentId);
    if (success) {
      setShowDeleteConfirm(false);
      onClose();
    }
  };

  const handleToggleIMBinding = (key: string) => {
    const next = new Set(boundKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setBoundKeys(next);
  };

  /** Check if a multi-instance platform has any enabled instances. */
  const getEnabledInstances = (platform: MultiInstancePlatform) => {
    if (!imConfig) return [];
    const cfg = imConfig[platform];
    const instances = cfg?.instances;
    if (!Array.isArray(instances)) return [];
    return instances.filter((inst: MultiInstanceConfig) => inst.enabled);
  };

  const isPlatformConfigured = (platform: Platform): boolean => {
    if (!imConfig) return false;
    if (isMultiInstancePlatform(platform)) {
      return getEnabledInstances(platform).length > 0;
    }
    // email is a multi-instance platform
    if (platform === 'email') {
      return imConfig.email.instances.length > 0;
    }
    const cfg = imConfig[platform as keyof typeof imConfig];
    if (!cfg || typeof cfg !== 'object') return false;
    return 'enabled' in cfg && (cfg as { enabled: boolean }).enabled === true;
  };

  /** Resolve agent name by id */
  const getAgentName = (aid: string): string | null => {
    return getAgentDisplayNameById(aid, agents);
  };

  const availableSubagentAgents = agents
    .filter((candidate) => candidate.enabled && candidate.id !== agentId)
    .sort((left, right) => getAgentDisplayName(left).localeCompare(getAgentDisplayName(right)));

  const handleToggleSubagentAllowAgent = (targetAgentId: string) => {
    if (isServerOwned && baselineSubagentIds.includes(targetAgentId)) return;
    setSubagentAllowAgentIds((current) => {
      if (current.includes(targetAgentId)) {
        return current.filter(id => id !== targetAgentId);
      }
      return [...current, targetAgentId];
    });
  };

  const nameInputValue = isMainAgent && !nameTouched
    ? getAgentDisplayName({ id: agentId, name })
    : name;

  const baseTabs: { key: AgentDetailTab; label: string }[] = [
    { key: AgentDetailTab.Identity, label: i18nService.t('coworkBootstrapIdentityTitle') },
    { key: AgentDetailTab.Prompt, label: i18nService.t('coworkBootstrapSoulTitle') },
    { key: AgentDetailTab.User, label: i18nService.t('coworkBootstrapUserTitle') },
    { key: AgentDetailTab.Skills, label: i18nService.t('agentTabSkills') },
    { key: AgentDetailTab.Collaboration, label: i18nService.t('agentTabCollaboration') },
    { key: AgentDetailTab.Im, label: i18nService.t('agentTabIM') },
  ];
  // The IM tab is rendered for every agent. For enterprise-managed
  // (server-owned) agents its body is restricted to the server-configured
  // channels, which cannot be enabled or disabled from the panel.

  const renderTextEditor = (
    value: string,
    onChange: (value: string) => void,
    placeholder: string,
    ariaLabel: string,
    hint?: string,
    disabled = false,
  ) => (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {hint && (
        <p className="shrink-0 text-xs leading-5 text-secondary">
          {hint}
        </p>
      )}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        className="min-h-0 flex-1 w-full resize-none border border-transparent bg-transparent text-sm leading-6 text-foreground placeholder:text-secondary/45 focus:outline-none disabled:cursor-not-allowed"
      />
    </div>
  );

  const renderSubagentCandidateRow = (candidate: { id: string; name: string }) => {
    const checked = subagentAllowAgentIds.includes(candidate.id);
    // Baseline rows are the resolved local ids; unresolvable raw server ids
    // (no local mirror row) are also baseline — they render by raw id and
    // must get the same locked/checked treatment.
    const isBaselineCandidate = isServerOwned && (
      baselineSubagentIds.includes(candidate.id) || serverSubagentIds.includes(candidate.id)
    );
    const isAddedCandidate = isServerOwned && addedSubagentIds.includes(candidate.id);
    return (
      <label
        key={candidate.id}
        className={`flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 transition-colors ${
          isBaselineCandidate
            ? 'cursor-not-allowed opacity-60'
            : 'cursor-pointer hover:bg-surface-raised'
        }`}
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised text-sm">
            <span className="font-medium text-secondary">
              {getAgentDisplayName(candidate).slice(0, 1).toUpperCase()}
            </span>
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">
                {getAgentDisplayName(candidate)}
              </span>
              {(isBaselineCandidate || isAddedCandidate) && (
                <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] leading-none text-secondary">
                  {i18nService.t(isBaselineCandidate ? 'agentBaselineBadge' : 'agentAddedBadge')}
                </span>
              )}
            </div>
            <div className="truncate text-xs text-secondary">
              {candidate.id}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isBaselineCandidate && (
            <LockClosedIcon
              className="h-3.5 w-3.5 text-secondary"
              aria-label={i18nService.t('agentBaselineBadge')}
            />
          )}
          <input
            type="checkbox"
            checked={isBaselineCandidate || checked}
            disabled={isBaselineCandidate}
            onChange={() => handleToggleSubagentAllowAgent(candidate.id)}
            className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
            aria-label={getAgentDisplayName(candidate)}
          />
        </div>
      </label>
    );
  };

  const renderCollaborationSettings = () => {
    // Enterprise baseline collaborators must appear even when the local agent
    // is disabled or absent entirely (then rendered by raw server id),
    // checked + locked. The toggleable list is deduped against the baseline
    // ids; unresolvable raw server ids have no local row and so never appear
    // in the toggleable list.
    const baselineCandidates = buildBaselineSubagentCandidates({
      baselineLocalIds: baselineSubagentIds,
      serverRawIds: serverSubagentIds,
      agents,
    });
    const toggleableCandidates = availableSubagentAgents.filter(
      (candidate) => !baselineSubagentIds.includes(candidate.id),
    );
    return (
      <div className="h-full overflow-y-auto">
        <div className="mb-4">
          <div className="text-sm font-semibold text-foreground">
            {i18nService.t('agentSubagentsTitle')}
          </div>
          <p className="mt-1 text-xs leading-5 text-secondary">
            {i18nService.t('agentSubagentsHint')}
          </p>
        </div>
        {baselineCandidates.length === 0 && toggleableCandidates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-secondary">
            {i18nService.t('agentSubagentsEmpty')}
          </div>
        ) : (
          <div className="space-y-1">
            {baselineCandidates.map((candidate) => renderSubagentCandidateRow(candidate))}
            {toggleableCandidates.map((candidate) => renderSubagentCandidateRow(candidate))}
          </div>
        )}
      </div>
    );
  };

  const renderToggle = (isOn: boolean) => (
    <div
      className={`relative w-9 h-5 rounded-full transition-colors ${
        isOn ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
      }`}
    >
      <div
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
          isOn ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </div>
  );

  const renderMultiInstancePlatform = (platform: MultiInstancePlatform) => {
    const enabledInstances = getEnabledInstances(platform);
    const logo = PlatformRegistry.logo(platform);
    const bindings = imConfig?.settings?.platformAgentBindings || {};

    if (enabledInstances.length === 0) {
      // No enabled instances — show disabled row like single-instance unconfigured
      return (
        <div
          key={platform}
          className="flex items-center justify-between px-3 py-2.5 rounded-lg opacity-50"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center">
              <img src={logo} alt={i18nService.t(platform)} className="w-6 h-6 object-contain rounded" />
            </div>
            <div>
              <div className="text-sm font-medium text-foreground">
                {i18nService.t(platform)}
              </div>
              <div className="text-xs text-secondary/50">
                {i18nService.t('agentIMNotConfiguredHint') || 'Please configure in Settings > IM Bots first'}
              </div>
            </div>
          </div>
          <span className="text-xs text-secondary/50">
            {i18nService.t('agentIMNotConfigured') || 'Not configured'}
          </span>
        </div>
      );
    }

    return (
      <div key={platform} className="rounded-lg border border-border overflow-hidden">
        {/* Platform header */}
        <div className="flex items-center gap-3 px-3 py-2.5 bg-surface-raised">
          <div className="flex h-8 w-8 items-center justify-center">
            <img src={logo} alt={i18nService.t(platform)} className="w-6 h-6 object-contain rounded" />
          </div>
          <span className="text-sm font-semibold text-foreground">
            {i18nService.t(platform)}
          </span>
        </div>
        {/* Instance list */}
        {enabledInstances.map((inst: MultiInstanceConfig, idx: number) => {
          const bindingKey = `${platform}:${inst.instanceId}`;
          const otherAgentId = bindings[bindingKey];
          const claimingForMain = isMainAgent && boundKeys.has(bindingKey);
          const boundToOther = Boolean(otherAgentId && otherAgentId !== agentId && !claimingForMain && !boundKeys.has(bindingKey));
          const canToggle = !isMainAgent || boundToOther || claimingForMain;
          const isBound = isMainAgent ? claimingForMain || !boundToOther : boundKeys.has(bindingKey);
          const otherAgentName = boundToOther ? getAgentName(otherAgentId ?? '') : null;

          return (
            <div
              key={inst.instanceId}
              className={`flex items-center justify-between px-3 py-2 pl-14 transition-colors ${
                idx < enabledInstances.length - 1 ? 'border-b border-border-subtle' : ''
              } ${canToggle ? 'cursor-pointer hover:bg-surface-raised' : ''}`}
              onClick={() => canToggle && handleToggleIMBinding(bindingKey)}
            >
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                <span className="text-sm text-foreground">
                  {inst.instanceName}
                </span>
                {boundToOther && otherAgentName && (
                  <span className="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                    {(i18nService.t('agentIMBoundToOther') || '→ {agent}').replace('{agent}', otherAgentName)}
                  </span>
                )}
              </div>
              {renderToggle(isBound)}
            </div>
          );
        })}
      </div>
    );
  };

  const renderSingleInstancePlatform = (platform: Platform) => {
    const logo = PlatformRegistry.logo(platform);
    const configured = isPlatformConfigured(platform);
    const bindings = imConfig?.settings?.platformAgentBindings || {};
    const otherAgentId = bindings[platform];
    const claimingForMain = isMainAgent && boundKeys.has(platform);
    const boundToOther = Boolean(configured && otherAgentId && otherAgentId !== agentId && !claimingForMain && !boundKeys.has(platform));
    const canToggle = configured && (!isMainAgent || boundToOther || claimingForMain);
    const isBound = isMainAgent ? configured && (claimingForMain || !boundToOther) : boundKeys.has(platform);
    const otherAgentName = boundToOther ? getAgentName(otherAgentId ?? '') : null;

    return (
      <div
        key={platform}
        className={`flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors ${
          !configured
            ? 'opacity-50'
            : canToggle
                ? 'hover:bg-surface-raised cursor-pointer'
                : ''
        }`}
        onClick={() => canToggle && handleToggleIMBinding(platform)}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center">
            <img src={logo} alt={i18nService.t(platform)} className="w-6 h-6 object-contain rounded" />
          </div>
          <div>
            <div className="text-sm font-medium text-foreground">
              {i18nService.t(platform)}
            </div>
            {!configured && (
              <div className="text-xs text-secondary/50">
                {i18nService.t('agentIMNotConfiguredHint') || 'Please configure in Settings > IM Bots first'}
              </div>
            )}
          </div>
          {boundToOther && otherAgentName && (
            <span className="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
              {(i18nService.t('agentIMBoundToOther') || '→ {agent}').replace('{agent}', otherAgentName)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {configured ? (
            renderToggle(isBound)
          ) : (
            <span className="text-xs text-secondary/50">
              {i18nService.t('agentIMNotConfigured') || 'Not configured'}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <Modal
        onClose={handleClose}
        overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/10 dark:bg-black/50"
        className="w-[calc(100vw-56px)] max-w-[854px] h-[82vh] max-h-[664px] rounded-xl shadow-[0_12px_40px_rgba(0,0,0,0.16)] bg-surface border border-surface flex flex-col overflow-hidden"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-7 py-5">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <AgentAvatarPicker value={icon} onChange={setIcon} />
            <div className="min-w-0 flex-1 pt-0.5">
              <input
                type="text"
                value={nameInputValue}
                onChange={(e) => {
                  setNameTouched(true);
                  setName(e.target.value);
                }}
                placeholder={i18nService.t('agentNamePlaceholder')}
                aria-label={i18nService.t('agentName')}
                disabled={isServerOwned}
                className="w-full bg-transparent text-lg font-semibold leading-6 text-foreground placeholder:text-secondary/40 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={i18nService.t('agentDescriptionPlaceholder')}
                aria-label={i18nService.t('agentDescription')}
                disabled={isServerOwned}
                className="mt-0.5 w-full bg-transparent text-sm leading-5 text-secondary placeholder:text-secondary/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
              {isServerOwned && (
                <span className="mt-1 inline-block rounded bg-surface-raised px-1.5 py-0.5 text-xs text-secondary">
                  {i18nService.t('agentReadOnlyBadge')}
                </span>
              )}
            </div>
          </div>
          <button type="button" onClick={handleClose} className="mt-1 p-2 rounded-lg hover:bg-surface-raised transition-colors">
            <XMarkIcon className="h-5 w-5 text-secondary" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex shrink-0 border-b border-border px-7">
          {baseTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => handleTabChange(tab.key)}
              className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                activeTab === tab.key
                  ? 'text-foreground'
                  : 'text-secondary hover:text-foreground'
              }`}
            >
              {tab.label}
              {activeTab === tab.key && (
                <div className="absolute bottom-[-1px] left-0 right-0 h-0.5 bg-foreground rounded-full" />
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="px-7 py-7 overflow-hidden flex-1 min-h-0">
          {activeTab === AgentDetailTab.Prompt && renderTextEditor(
            systemPrompt,
            setSystemPrompt,
            i18nService.t('coworkBootstrapPlaceholder'),
            i18nService.t('coworkBootstrapSoulTitle'),
            i18nService.t('coworkBootstrapSoulHint'),
            isServerOwned,
          )}

          {activeTab === AgentDetailTab.Identity && renderTextEditor(
            identity,
            setIdentity,
            i18nService.t('coworkBootstrapPlaceholder'),
            i18nService.t('coworkBootstrapIdentityTitle'),
            i18nService.t('coworkBootstrapIdentityHint'),
            isServerOwned,
          )}

          {activeTab === AgentDetailTab.User && (
            isServerOwned ? (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <p className="shrink-0 text-xs leading-5 text-secondary">
                  {i18nService.t('coworkBootstrapUserHint')}
                </p>
                <div className="min-h-0 flex-1 w-full overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-raised/40 px-3 py-2 text-sm leading-6 text-foreground">
                  {agentSummary?.aboutYou || ''}
                </div>
              </div>
            ) : renderTextEditor(
              userInfo,
              setUserInfo,
              i18nService.t('coworkBootstrapPlaceholder'),
              i18nService.t('coworkBootstrapUserTitle'),
              i18nService.t('coworkBootstrapUserHint'),
            )
          )}

          {activeTab === AgentDetailTab.Skills && (
            <AgentSkillSelector
              selectedSkillIds={skillIds}
              onChange={setSkillIds}
              lockedSkillIds={isServerOwned ? baselineSkillIds : undefined}
              baselineServerSkillIds={isServerOwned ? serverSkillIds : undefined}
              installedBaselineServerIds={isServerOwned ? installedBaselineServerIds : undefined}
            />
          )}

          {activeTab === AgentDetailTab.Collaboration && renderCollaborationSettings()}

          {activeTab === AgentDetailTab.Im && (
            isServerOwned ? (
              <div className="h-full overflow-y-auto">
                <p className="mb-3 text-xs leading-5 text-secondary">
                  {i18nService.t('agentImReadOnlyHint')}
                </p>
                {visibleServerChannels.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-secondary">
                    {i18nService.t('agentImNoChannels')}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {visibleServerChannels.map((platform) => (
                      isMultiInstancePlatform(platform)
                        ? renderMultiInstancePlatform(platform)
                        : renderSingleInstancePlatform(platform)
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="h-full overflow-y-auto">
                <div className="space-y-1">
                  {PlatformRegistry.platforms
                    .filter((platform) => (getVisibleIMPlatforms(i18nService.getLanguage()) as readonly string[]).includes(platform))
                    .map((platform) => {
                      if (isMultiInstancePlatform(platform)) {
                        return renderMultiInstancePlatform(platform);
                      }
                      return renderSingleInstancePlatform(platform);
                    })}
                </div>
              </div>
            )
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-3.5 border-t border-border">
          {isServerOwned ? (
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <div
                className="flex h-8 min-w-0 items-center gap-1 rounded-lg bg-surface-raised/70 pl-2 text-foreground"
                title={i18nService.t('agentDefaultModel')}
              >
                <CubeIcon className="h-4 w-4 flex-shrink-0 text-secondary" />
                <ModelSelector
                  dropdownDirection="up"
                  value={model}
                  onChange={setModel}
                  portal
                />
              </div>
              <AgentWorkingDirectoryField
                value={enterpriseWorkingDirectory}
                onChange={setEnterpriseWorkingDirectory}
                compact
              />
            </div>
          ) : (
            <AgentDetailToolbar
              model={model}
              onModelChange={setModel}
              workingDirectory={workingDirectory}
              onWorkingDirectoryChange={setWorkingDirectory}
            />
          )}
          <div className="flex shrink-0 gap-2">
            {!isMainAgent && !isServerOwned && (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="inline-flex h-9 items-center gap-1.5 px-3 text-sm font-medium rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              >
                <TrashIcon className="h-4 w-4" />
                {i18nService.t('delete')}
              </button>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={!name.trim() || saving}
              className="h-9 px-5 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? i18nService.t('saving') : i18nService.t('save')}
            </button>
          </div>
        </div>
      </Modal>

      {showDeleteConfirm && (
        <AgentConfirmDialog
          variant={AgentConfirmDialogVariant.Delete}
          title={i18nService.t('agentDeleteConfirmTitle')}
          message={i18nService.t('agentDeleteConfirmMessage').replace('{name}', name)}
          cancelLabel={i18nService.t('cancel')}
          confirmLabel={i18nService.t('delete')}
          onCancel={() => setShowDeleteConfirm(false)}
          onConfirm={handleDelete}
        />
      )}

      {showUnsavedConfirm && (
        <AgentConfirmDialog
          variant={AgentConfirmDialogVariant.Unsaved}
          title={i18nService.t('agentUnsavedTitle')}
          message={i18nService.t('agentUnsavedMessage')}
          cancelLabel={i18nService.t('agentUnsavedStay')}
          confirmLabel={i18nService.t('agentUnsavedDiscard')}
          onCancel={handleCancelDiscard}
          onConfirm={handleConfirmDiscard}
        />
      )}
    </>
  );
};

export default AgentSettingsPanel;
