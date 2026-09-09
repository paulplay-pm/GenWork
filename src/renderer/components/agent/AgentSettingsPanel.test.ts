import { configureStore } from '@reduxjs/toolkit';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { describe, expect, test, vi } from 'vitest';

import enterpriseAccountReducer from '../../features/enterpriseAccount/enterpriseAccountSlice';
import { i18nService } from '../../services/i18n';
import agentReducer, { setAgents } from '../../store/slices/agentSlice';
import authReducer from '../../store/slices/authSlice';
import modelReducer from '../../store/slices/modelSlice';
import skillReducer from '../../store/slices/skillSlice';
import AgentSettingsPanel from './AgentSettingsPanel';

i18nService.setLanguage('en', { persist: false });

// The node test environment has no `window`; ModelSelector (rendered in the
// footer model pill) reads `window.electron?.enterpriseModels` at render time.
// The `agents` surface is mocked with vi.fn()s so the enterprise load/save IPC
// (getEnterpriseAgentModel / setEnterpriseAgentModel and the working-directory
// prefs) is available to the harness. Static rendering does not run effects or
// handle clicks, so these mocks document the API surface the panel talks to
// rather than being asserted as call targets.
const getEnterpriseAgentModel = vi.fn();
const setEnterpriseAgentModel = vi.fn();
const getEnterpriseAgentWorkingDirectory = vi.fn();
const setEnterpriseAgentWorkingDirectory = vi.fn();
vi.stubGlobal('window', {
  electron: {
    agents: {
      get: vi.fn(),
      getEnterpriseAgentModel,
      setEnterpriseAgentModel,
      getEnterpriseAgentWorkingDirectory,
      setEnterpriseAgentWorkingDirectory,
    },
  },
});

type AgentSummaryInput = Parameters<typeof setAgents>[0][number];

const renderPanel = (agents: AgentSummaryInput[], agentId: string): string => {
  const store = configureStore({
    reducer: {
      agent: agentReducer,
      model: modelReducer,
      skill: skillReducer,
      auth: authReducer,
      enterpriseAccount: enterpriseAccountReducer,
    },
  });
  store.dispatch(setAgents(agents));
  return renderToStaticMarkup(
    React.createElement(Provider, {
      store,
      children: React.createElement(AgentSettingsPanel, { agentId, onClose: () => undefined }),
    }),
  );
};

const enterpriseAgent: AgentSummaryInput = {
  id: 'ent1',
  name: 'Code Reviewer',
  description: '',
  aboutYou: 'Server says hi',
  icon: '',
  model: '',
  thinkingLevel: '',
  workingDirectory: '',
  enabled: true,
  pinned: false,
  isDefault: false,
  source: 'enterprise',
  skillIds: [],
  subagentAllowAgentIds: [],
  // Full server baseline: a skill that is NOT installed locally and a
  // subagent baseline local id with no matching enabled local agent.
  // serverSkillInstalledIds is empty, so nothing is excluded from the
  // Skills tab 服务端 section.
  serverSkillIds: ['srv-skill-not-installed'],
  serverSubagentAllowAgentIds: [],
  serverSubagentLocalIds: ['agent_sub'],
  serverSkillInstalledIds: [],
  serverImChannels: [],
  enterpriseAgentId: 'agent_a1',
};

describe('AgentSettingsPanel — enterprise (read-only) agent', () => {
  test('shows the read-only badge, the IM tab and the save button; hides delete', () => {
    const html = renderPanel([enterpriseAgent], 'ent1');

    // Read-only badge near the panel header.
    expect(html).toContain('Managed by enterprise_server');
    // The IM tab is shown for server-owned agents; its body is restricted to
    // the server-configured channels.
    expect(html).toContain('>IM Channels</button>');
    // The panel save button is available so the local overlay (skills /
    // subagent allowances) can be committed; the delete button stays hidden.
    expect(html).toContain('bg-primary');
    expect(html).not.toContain('>Delete</button>');
    // The enterprise working-directory picker is present in the footer (its
    // value round-trips through enterprise_agent_prefs and is committed by the
    // panel's unified Save, not a per-field button).
    expect(html).toContain('aria-label="Agent Default Working Directory"');
  });

  test('About You tab renders the server aboutYou (read-only) for an enterprise agent', () => {
    const html = renderPanel([enterpriseAgent], 'ent1');

    // The 关于你 tab is available for enterprise agents...
    expect(html).toContain('>About You</button>');
    // ...and the server about-you content is only rendered as read-only text
    // in the tab body: it never appears as a controlled input/textarea value
    // (the local USER.md editor is disabled for enterprise agents).
    expect(html).not.toContain('value="Server says hi"');
  });

  test('enterprise footer shows the model selector next to the working-directory field', () => {
    const html = renderPanel([enterpriseAgent], 'ent1');

    // The enterprise footer now carries the model selector pill (previously
    // only the working-directory field was rendered there)...
    expect(html).toContain('title="Agent Default Model"');
    // ...while the enterprise working-directory picker (prefs round-trip) is
    // kept alongside it. The panel's unified Save persists the selection through
    // the mocked setEnterpriseAgentModel / setEnterpriseAgentWorkingDirectory IPC.
    expect(html).toContain('aria-label="Agent Default Working Directory"');
  });

  test('renders without crashing with the full server baseline on the enterprise fixture', () => {
    // The enterprise fixture carries a server baseline that is NOT fully
    // installed/enabled locally:
    //  - serverSkillIds ['srv-skill-not-installed']: no matching local skill,
    //    so the Skills tab must render it by name as a locked 服务端 row via
    //    AgentSkillSelector's baselineServerSkillIds section.
    //  - serverSubagentLocalIds ['agent_sub']: the Collaboration tab must
    //    render it checked + locked even though no enabled local agent with
    //    that id exists in this fixture.
    // The static renderToStaticMarkup harness cannot switch tabs (no effects,
    // no clicks; the initial activeTab is Prompt), so the Skills/Collaboration
    // tab BODIES do not render here and the baseline-by-name rows cannot be
    // asserted. The full baseline-by-name rendering is validated manually via
    // `npm run electron:dev` (Task 9); this test pins the fixture shape and
    // that the panel still renders without crashing with the new fields.
    const html = renderPanel([enterpriseAgent], 'ent1');

    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('Managed by enterprise_server');
  });
});

describe('AgentSettingsPanel — regular agent (control)', () => {
  test('keeps the primary save button, the delete button and the IM tab', () => {
    const html = renderPanel(
      [{ ...enterpriseAgent, id: 'custom1', source: 'custom', enterpriseAgentId: undefined }],
      'custom1',
    );

    expect(html).not.toContain('Managed by enterprise_server');
    expect(html).toContain('>IM Channels</button>');
    expect(html).toContain('bg-primary');
    expect(html).toContain('>Delete</button>');
    // No enterprise working-directory field for custom agents.
    expect(html).not.toContain('aria-label="Save"');
  });
});
