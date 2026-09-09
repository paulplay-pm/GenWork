import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { ModelThinkingLevel } from '@shared/providers/modelThinking';

interface AgentSummary {
  id: string;
  name: string;
  description: string;
  aboutYou: string;
  icon: string;
  model: string;
  thinkingLevel: ModelThinkingLevel | '';
  workingDirectory: string;
  enabled: boolean;
  pinned: boolean;
  pinOrder?: number | null;
  sortOrder?: number | null;
  isDefault: boolean;
  source: 'custom' | 'preset' | 'enterprise';
  enterpriseAgentId?: string;
  skillIds: string[];
  subagentAllowAgentIds: string[];
  serverSkillIds: string[];
  serverSubagentAllowAgentIds: string[];
  serverImChannels: string[];
  serverSkillLocalIds?: string[];
  serverSubagentLocalIds?: string[];
  serverSkillInstalledIds?: string[];
  isServerOwned?: boolean;
}

export interface EnterpriseSyncReport {
  upserted: number;
  removed: number;
  skipped: number;
}

interface AgentState {
  agents: AgentSummary[];
  currentAgentId: string;
  loading: boolean;
  lastEnterpriseSyncReport: EnterpriseSyncReport | null;
}

const initialState: AgentState = {
  agents: [],
  currentAgentId: 'main',
  loading: false,
  lastEnterpriseSyncReport: null,
};

const agentSlice = createSlice({
  name: 'agent',
  initialState,
  reducers: {
    setAgents(state, action: PayloadAction<AgentSummary[]>) {
      state.agents = action.payload.map((a) => ({ ...a, isServerOwned: a.source === 'enterprise' }));
    },

    setCurrentAgentId(state, action: PayloadAction<string>) {
      state.currentAgentId = action.payload;
    },

    setLoading(state, action: PayloadAction<boolean>) {
      state.loading = action.payload;
    },

    addAgent(state, action: PayloadAction<AgentSummary>) {
      state.agents.push({ ...action.payload, isServerOwned: action.payload.source === 'enterprise' });
    },

    updateAgent(state, action: PayloadAction<{ id: string; updates: Partial<AgentSummary> }>) {
      const index = state.agents.findIndex((a) => a.id === action.payload.id);
      if (index !== -1) {
        state.agents[index] = { ...state.agents[index], ...action.payload.updates };
      }
    },

    removeAgent(state, action: PayloadAction<string>) {
      state.agents = state.agents.filter((a) => a.id !== action.payload);
      if (state.currentAgentId === action.payload) {
        state.currentAgentId = 'main';
      }
    },

    setEnterpriseSyncReport(state, action: PayloadAction<EnterpriseSyncReport | null>) {
      state.lastEnterpriseSyncReport = action.payload;
    },
  },
});

export const {
  setAgents,
  setCurrentAgentId,
  setLoading,
  addAgent,
  updateAgent,
  removeAgent,
  setEnterpriseSyncReport,
} = agentSlice.actions;

export default agentSlice.reducer;
