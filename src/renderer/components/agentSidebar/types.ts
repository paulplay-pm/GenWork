import type { Platform } from '../../../shared/platform';
import type { GenWorkSessionStatus } from '../../types/genwork';
import type { AgentSidebarIndicator } from './constants';

export interface AgentSidebarAgentSummary {
  id: string;
  name: string;
  icon: string;
  enabled: boolean;
  pinned: boolean;
  pinOrder?: number | null;
  sortOrder?: number | null;
  isServerOwned?: boolean;
}

export interface AgentSidebarTaskNode {
  id: string;
  agentId: string;
  title: string;
  isScheduledTask: boolean;
  status: GenWorkSessionStatus;
  pinned: boolean;
  pinOrder?: number | null;
  imPlatform?: Platform | null;
  updatedAt: number;
  createdAt: number;
  indicator: AgentSidebarIndicator;
  isSelected: boolean;
}

export interface AgentSidebarAgentNode extends AgentSidebarAgentSummary {
  isExpanded: boolean;
  isTaskListExpanded: boolean;
  canExpandTasks: boolean;
  canCollapseTasks: boolean;
  isLoadingTasks: boolean;
  hasLoadError: boolean;
  tasks: AgentSidebarTaskNode[];
}

export interface AgentSidebarPreferenceState {
  expandedAgentIds: string[];
  expandedTaskListAgentIds: string[];
  selectedAgentId?: string;
  selectedTaskId?: string;
}
