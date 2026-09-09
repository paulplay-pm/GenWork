import type { JSX } from 'react';
import { useEffect, useState } from 'react';

import type { AgentInput, AgentMarketplaceItem } from '../../../api/agentMarketplace';
import type { ModelView } from '../../../api/models';
import type { ProviderKeyView } from '../../../api/providers';
import { Switch } from '../../../components/Switch';
import { autoIcon } from '../../../lib/autoIcon';
import { GLYPH_ICON, isUrlIcon, tileClass } from '../agentTile';
import { fill, t } from '../types';
import {
  type AgentDraft,
  draftFromAgent,
  draftToInput,
  emptyDraft,
  isDirty,
  validateDraft,
} from './drawerForm';
import { IconColorPicker } from './IconColorPicker';
import { ImChannelPicker } from './ImChannelPicker';
import { ModelSelect } from './ModelSelect';
import { RolesPicker } from './RolesPicker';
import { SkillPicker } from './SkillPicker';
import { SubagentPicker } from './SubagentPicker';

interface AgentDrawerProps {
  mode: 'create' | 'edit';
  agent?: AgentMarketplaceItem;
  roleOptions: string[];
  skills: Array<{ id: string; name: string; name_zh: string | null }>;
  agents: AgentMarketplaceItem[];
  models: ModelView[];
  /** Org providers (模型配置) for the model picker's vendor group labels. */
  providers?: ProviderKeyView[];
  modelsError?: boolean;
  onSave: (input: AgentInput) => Promise<void>;
  onClose: () => void;
  /** Called instead of `onClose` when the draft has unsaved changes; the
   * caller (the page) shows a discard confirmation before actually closing. */
  onDiscardRequest?: () => void;
}

const TAB_IDS = ['identity', 'persona', 'about', 'skills', 'subs', 'im', 'roles'] as const;
type TabId = (typeof TAB_IDS)[number];

const THINKING_LEVELS: Array<{ value: string; key: string }> = [
  { value: 'low', key: 'agentmgmt.thinking.low' },
  { value: 'medium', key: 'agentmgmt.thinking.standard' },
  { value: 'high', key: 'agentmgmt.thinking.high' },
];

const TEXTAREA_CLASS =
  'min-h-48 w-full resize-y rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)]';

/**
 * Unified create/edit drawer for enterprise agents: header (icon tile, name,
 * description), 7 tabs (identity / persona / about / skills / subs / im /
 * roles), and a footer (model, thinking level, enable, save). The im tab
 * renders the ImChannelPicker (per-channel 是否启动 switches); the roles tab
 * renders the RolesPicker (min 1 visible role).
 */
export function AgentDrawer({
  mode,
  agent,
  roleOptions,
  skills,
  agents,
  models,
  providers,
  modelsError,
  onSave,
  onClose,
  onDiscardRequest,
}: AgentDrawerProps): JSX.Element {
  const [draft, setDraft] = useState<AgentDraft>(() => (agent ? draftFromAgent(agent) : emptyDraft()));
  const [initial] = useState<AgentDraft>(() => (agent ? draftFromAgent(agent) : emptyDraft()));
  const [tab, setTab] = useState<TabId>('identity');
  const [popOpen, setPopOpen] = useState<null | 'icon' | 'model'>(null);
  const [saving, setSaving] = useState(false);
  const [nameErr, setNameErr] = useState(false);
  const [rolesErr, setRolesErr] = useState(false);

  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]): void => {
    setDraft(d => ({ ...d, [key]: value }));
  };

  // Header tile glyph; undefined for unknown values (falls back to autoIcon).
  const Glyph = GLYPH_ICON[draft.icon];

  // Non-blocking duplicate-name note (edit mode): another agent in the
  // catalog shares the draft name (case-insensitive, excluding self).
  const dupName = mode === 'edit' && draft.name.trim() !== ''
    ? agents.find(a => a.agentId !== (agent?.agentId ?? '')
      && a.name.trim().toLowerCase() === draft.name.trim().toLowerCase())?.name ?? null
    : null;

  const requestClose = (): void => {
    if (isDirty(draft, initial)) onDiscardRequest?.();
    else onClose();
  };

  const save = async (): Promise<void> => {
    const errs = validateDraft(draft);
    if (errs.name) { setNameErr(true); return; }
    if (errs.roles) { setTab('roles'); setRolesErr(true); return; }
    setSaving(true);
    try {
      await onSave(draftToInput(draft));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (popOpen) { setPopOpen(null); return; }
      requestClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // requestClose is recreated each render; the effect re-subscribes when
    // its inputs change so the handler never sees a stale draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popOpen, draft, initial, onDiscardRequest, onClose]);

  return (
    <div className="fixed inset-0 z-40 bg-black/30" onClick={requestClose}>
    <div
      className="ml-auto flex h-full w-[680px] max-w-full flex-col border-l border-[var(--border-default)] bg-[var(--bg-secondary)]"
      onClick={(e) => e.stopPropagation()}
    >
      {/* header: icon tile + name/description inputs + close */}
      <div className="flex items-start gap-3 border-b border-[var(--border-default)] p-4">
        <div className="relative">
          <button
            type="button"
            aria-label={t('agentmgmt.icon.change')}
            onClick={() => setPopOpen(popOpen === 'icon' ? null : 'icon')}
            className={`flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl text-[20px] ${tileClass(draft.iconColor)}`}
          >
            {isUrlIcon(draft.icon)
              ? <img src={draft.icon} alt="" className="h-11 w-11 object-cover" />
              : Glyph
                ? <Glyph className="h-5 w-5" />
                : <span>{autoIcon(draft.name || draft.icon)}</span>}
          </button>
          {popOpen === 'icon' ? (
            <IconColorPicker
              icon={draft.icon}
              iconColor={draft.iconColor}
              onPick={g => set('icon', g)}
              onColor={c => set('iconColor', c)}
            />
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <input
            aria-label="Agent 名称"
            className="h-9 w-full min-w-0 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 text-sm font-medium text-[var(--text-primary)]"
            placeholder={t('agentmgmt.name')}
            maxLength={32}
            value={draft.name}
            onChange={e => { set('name', e.target.value); }}
            onBlur={() => setNameErr(false)}
          />
          <input
            aria-label={t('agentmgmt.desc')}
            className="h-9 w-full min-w-0 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 text-sm text-[var(--text-primary)]"
            placeholder={t('agentmgmt.desc')}
            maxLength={120}
            value={draft.description}
            onChange={e => set('description', e.target.value)}
          />
          {nameErr && !draft.name.trim() ? (
            <div className="text-xs text-[var(--danger-primary)]">{t('agentmgmt.nameRequired')}</div>
          ) : null}
          {dupName ? (
            <div className="text-xs text-[var(--text-tertiary)]">{fill(t('agentmgmt.dup.name'), { name: dupName })}</div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={requestClose}
          aria-label={t('common.close')}
          className="mt-0.5 h-8 px-2 text-lg leading-none text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          ×
        </button>
      </div>

      {/* tabs */}
      <div className="flex shrink-0 overflow-x-auto border-b border-[var(--border-default)] px-4" role="tablist">
        {TAB_IDS.map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => { setTab(id); setPopOpen(null); }}
            className={`shrink-0 border-b-2 px-3 py-2.5 text-sm ${
              tab === id
                ? 'border-[var(--accent-primary)] font-medium text-[var(--accent-primary)]'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
          >
            {t(`agentmgmt.tab.${id}`)}
          </button>
        ))}
      </div>

      {/* active tab body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'identity' ? (
          <textarea
            data-field="identity"
            className={TEXTAREA_CLASS}
            placeholder={t('agentmgmt.identity')}
            value={draft.identity}
            onChange={e => set('identity', e.target.value)}
          />
        ) : tab === 'persona' ? (
          <textarea
            data-field="systemPrompt"
            className={TEXTAREA_CLASS}
            placeholder={t('agentmgmt.systemPrompt')}
            value={draft.systemPrompt}
            onChange={e => set('systemPrompt', e.target.value)}
          />
        ) : tab === 'about' ? (
          <textarea
            data-field="aboutYou"
            className={TEXTAREA_CLASS}
            placeholder={t('agentmgmt.aboutYou')}
            value={draft.aboutYou}
            onChange={e => set('aboutYou', e.target.value)}
          />
        ) : tab === 'skills' ? (
          <SkillPicker
            skills={skills}
            selected={draft.skillIds}
            onToggle={(id) => setDraft(d => ({ ...d, skillIds: d.skillIds.includes(id) ? d.skillIds.filter(x => x !== id) : [...d.skillIds, id] }))}
          />
        ) : tab === 'subs' ? (
          <SubagentPicker
            agents={agents}
            currentId={draft.agentId}
            selected={draft.subagentAllowAgentIds}
            onToggle={(id) => setDraft(d => ({ ...d, subagentAllowAgentIds: d.subagentAllowAgentIds.includes(id) ? d.subagentAllowAgentIds.filter(x => x !== id) : [...d.subagentAllowAgentIds, id] }))}
          />
        ) : tab === 'roles' ? (
          <RolesPicker
            options={roleOptions}
            selected={draft.allowedRoles}
            onChange={(v) => { setDraft(d => ({ ...d, allowedRoles: v })); if (v.length >= 1) setRolesErr(false); }}
            error={rolesErr ? t('agentmgmt.roles.min') : undefined}
          />
        ) : (
          <ImChannelPicker
            selected={draft.imChannels}
            onToggle={(id) => setDraft(d => ({ ...d, imChannels: d.imChannels.includes(id) ? d.imChannels.filter(x => x !== id) : [...d.imChannels, id] }))}
          />
        )}
      </div>

      {/* footer: model + thinking + enable | cancel + save */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--border-default)] p-3">
        <ModelSelect
          value={draft.model}
          onChange={v => set('model', v)}
          models={models}
          providers={providers}
          fallbackFree={!!modelsError}
        />
        <div className="flex items-center rounded-lg border border-[var(--border-default)] p-0.5">
          {THINKING_LEVELS.map(l => (
            <button
              key={l.value}
              type="button"
              onClick={() => set('thinkingLevel', l.value)}
              className={`rounded-md px-2.5 py-1 text-xs ${
                draft.thinkingLevel === l.value
                  ? 'bg-[var(--accent-primary)] text-white'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
            >
              {t(l.key)}
            </button>
          ))}
        </div>
        <span className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
          {t('agentmgmt.enabled')}
          <Switch checked={draft.enabled} onChange={v => set('enabled', v)} label={t('agentmgmt.enabled')} />
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={requestClose}
            className="h-9 rounded-lg border border-[var(--border-default)] px-3 text-sm text-[var(--text-primary)]"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => { void save(); }}
            disabled={saving}
            className="h-9 rounded-lg bg-[var(--accent-primary)] px-4 text-sm text-white disabled:opacity-50"
          >
            {saving ? t('agentmgmt.saveSaving') : mode === 'create' ? t('agentmgmt.save.create') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
    </div>
  );
}
