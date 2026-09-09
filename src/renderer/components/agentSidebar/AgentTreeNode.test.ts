import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { i18nService } from '../../services/i18n';
import AgentTreeNode, { AgentTreeNodeKebabMenu } from './AgentTreeNode';
import type { AgentSidebarAgentNode } from './types';

i18nService.setLanguage('en', { persist: false });

const makeAgent = (over: Partial<AgentSidebarAgentNode> = {}): AgentSidebarAgentNode => ({
  id: 'ent1',
  name: 'Enterprise Agent',
  icon: '',
  enabled: true,
  pinned: false,
  pinOrder: null,
  sortOrder: null,
  isExpanded: false,
  isTaskListExpanded: false,
  canExpandTasks: false,
  canCollapseTasks: false,
  isLoadingTasks: false,
  hasLoadError: false,
  tasks: [],
  isServerOwned: false,
  ...over,
});

const renderKebabMenu = (agent: AgentSidebarAgentNode, isMainAgent = false): string =>
  renderToStaticMarkup(
    React.createElement(AgentTreeNodeKebabMenu, {
      agent,
      isMainAgent,
      onEdit: () => undefined,
      onTogglePin: () => undefined,
      onDelete: () => undefined,
    }),
  );

describe('AgentTreeNode kebab menu — enterprise (read-only) agents', () => {
  test('shows edit but hides delete when isServerOwned; the pin item stays', () => {
    const html = renderKebabMenu(makeAgent({ isServerOwned: true }));
    expect(html).toContain('>Edit</button>');
    expect(html).not.toContain('>Delete</button>');
    expect(html).toContain('>Pin</button>');
  });

  test('shows edit, pin and delete for a regular non-main agent', () => {
    const html = renderKebabMenu(makeAgent({ id: 'custom1', isServerOwned: false }));
    expect(html).toContain('>Edit</button>');
    expect(html).toContain('>Pin</button>');
    expect(html).toContain('>Delete</button>');
  });

  test('keeps the disabled delete item for the main agent (not read-only)', () => {
    const html = renderKebabMenu(makeAgent({ id: 'main' }), true);
    expect(html).toContain('>Edit</button>');
    expect(html).toContain('>Delete</button>');
    expect(html).toContain('disabled');
  });

  test('renders a read-only agent node without the menu open', () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentTreeNode, {
        agent: makeAgent({ isServerOwned: true }),
        isBatchMode: false,
        batchAgentId: null,
        selectedKeys: new Set<string>(),
        onToggleExpanded: () => undefined,
        onEditAgent: () => undefined,
        onCreateTask: () => undefined,
        onDeleteAgent: async () => undefined,
        onToggleAgentPin: async () => undefined,
        onRetryLoadTasks: () => undefined,
        onLoadMoreTasks: () => undefined,
        onCollapseTasks: () => undefined,
        onSelectTask: () => undefined,
        onDeleteTask: async () => undefined,
        onShareTask: async () => undefined,
        onToggleTaskPin: async () => undefined,
        onRenameTask: async () => undefined,
        onToggleSelection: () => undefined,
        onEnterBatchMode: () => undefined,
      }),
    );
    expect(html).toContain('Enterprise Agent');
  });
});
