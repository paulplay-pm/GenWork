import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import type { AgentMarketplaceItem } from '../../../src/api/agentMarketplace';
import { setLang } from '../../../src/i18n';
import { AgentDrawer } from '../../../src/pages/agentManage/drawer/AgentDrawer';

const item = (): AgentMarketplaceItem => ({ agentId: 'a1', name: 'N', description: 'd', identity: 'i', systemPrompt: 'p', model: 'gpt-5', thinkingLevel: 'medium', icon: 'bot', iconColor: 2, aboutYou: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: ['feishu'] });

describe('AgentDrawer', () => {
  test('renders all 7 tabs and the save button', () => {
    // jsdom reports navigator.language = 'en-US'; the assertions below are
    // written against the zh dictionary, so pin the locale explicitly.
    setLang('zh');
    render(<AgentDrawer mode="edit" agent={item()} roleOptions={['org_admin','agent_admin']} skills={[]} agents={[item()]} models={[]} modelsError onSave={async()=>{}} onClose={()=>{}} />);
    for (const label of ['助手身份','助手性格','关于你','技能','协作','IM 渠道','可见范围']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: /保存/ })).toBeInTheDocument();
  });

  test('skills tab lists skills and toggling updates selection via save payload', async () => {
    let saved: unknown;
    const skills = [
      { id: 's1', name: 'SQL 查询', name_zh: 'SQL 查询' },
      { id: 's2', name: '文档生成', name_zh: '文档生成' },
    ];
    // Brief defect (documented deviation): the brief's render call seeded a
    // fresh create-mode draft with no roles, but save validation requires
    // >= 1 visible role (design spec; pinned by drawerForm.test.ts and the
    // Task 6 ruling), and the 可见范围 RolesPicker only arrives in Task 9.
    // Seed the draft via the agent fixture (allowedRoles: ['org_admin'],
    // skillIds: []) so the save-payload assertion can run; the skills
    // toggling behavior under test is unchanged.
    render(<AgentDrawer mode="create" agent={item()} roleOptions={['org_admin']} skills={skills} agents={[]} models={[]} onSave={async (i) => { saved = i; }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: '技能' }));
    expect(screen.getByText('SQL 查询')).toBeInTheDocument();
    // Click the SQL row to select it.
    fireEvent.click(screen.getByText('SQL 查询'));
    fireEvent.change(screen.getByRole('textbox', { name: /Agent 名称/i }), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: /创建智能体/ }));
    await waitFor(() => expect((saved as { skill_ids?: string[] }).skill_ids).toEqual(['s1']));
  });

  test('roles tab shows chips and save is blocked when all removed', async () => {
    let saved: unknown;
    // Seed one role (org_admin) so there is a chip to remove — emptyDraft()
    // starts with no roles (Task 6 min-1 ruling), so a bare create draft has
    // none; this mirrors the Task 7 test's documented deviation.
    render(<AgentDrawer mode="create" agent={item()} roleOptions={['org_admin','agent_admin']} skills={[]} agents={[]} models={[]} onSave={async (i) => { saved = i; }} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: /Agent 名称/i }), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('tab', { name: '可见范围' }));
    // Remove the only role (org_admin) via its chip.
    fireEvent.click(screen.getByRole('button', { name: /org_admin/ }));
    // Now click save → should be blocked (roles empty), no POST.
    fireEvent.click(screen.getByRole('button', { name: /创建智能体/ }));
    await waitFor(() => expect(saved).toBeUndefined());
    expect(screen.getByText('至少选择一个角色')).toBeInTheDocument();
  });

  test('icon tile popover changes the draft color on pick', async () => {
    let saved: unknown;
    // Brief defect (documented deviation): the brief's render call seeded a
    // fresh create-mode draft with no roles, but validateDraft enforces
    // >= 1 visible role (Task 6 ruling; emptyDraft().allowedRoles is []),
    // so save would be blocked and onSave would never fire. Seed the draft
    // via the agent fixture (allowedRoles: ['org_admin']) so save can fire,
    // while keeping mode="create" + the name change; the icon_color pick is
    // the real behavior under test.
    render(<AgentDrawer mode="create" agent={item()} roleOptions={['org_admin']} skills={[]} agents={[]} models={[]} onSave={async (i) => { saved = i; }} onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: /Agent 名称/i }), { target: { value: 'X' } });
    // Open the icon popover via the tile's aria-label 更换图标.
    fireEvent.click(screen.getByRole('button', { name: /更换图标/ }));
    // Pick the 6th color swatch (index 5). The item() fixture seeds
    // iconColor: 2, so asserting icon_color === 5 proves the swatch pick
    // actually changed the draft color (a no-op pick would still read 2).
    const swatches = screen.getAllByRole('button', { name: /颜色/ });
    fireEvent.click(swatches[5]);
    fireEvent.click(screen.getByRole('button', { name: /创建智能体/ }));
    await waitFor(() => expect((saved as { icon_color?: number }).icon_color).toBe(5));
  });

  test('subagent tab disables a cyclic candidate with a 成环 note', async () => {
    // editing a1; a2 references a1 → selecting a2 would form a cycle.
    const a1: AgentMarketplaceItem = { agentId: 'a1', name: 'A1', description: '', identity: '', systemPrompt: '', model: '', thinkingLevel: 'medium', icon: 'bot', iconColor: 0, aboutYou: '', skillIds: [], subagentAllowAgentIds: [], allowedRoles: ['org_admin'], enabled: true, imChannels: [] };
    const a2: AgentMarketplaceItem = { ...a1, agentId: 'a2', name: 'A2', subagentAllowAgentIds: ['a1'] };
    render(<AgentDrawer mode="edit" agent={a1} roleOptions={['org_admin']} skills={[]} agents={[a1, a2]} models={[]} onSave={async()=>{}} onClose={()=>{}} />);
    fireEvent.click(screen.getByRole('tab', { name: '协作' }));
    const a2row = screen.getByText('A2').closest('button') as HTMLButtonElement;
    expect(a2row).toBeDisabled();
    expect(screen.getByText('成环')).toBeInTheDocument();
  });

  test('IM tab lists all 7 channels with switches; toggling one puts it in im_channels', async () => {
    setLang('zh');
    let saved: unknown;
    // item() seeds imChannels: ['feishu'], so 飞书 starts on and the rest off.
    render(<AgentDrawer mode="create" agent={item()} roleOptions={['org_admin']} skills={[]} agents={[]} models={[]} onSave={async (i) => { saved = i; }} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'IM 渠道' }));
    const names = ['微信', '钉钉', '飞书', '企业微信', 'QQ', 'POPO', '龙虾邮箱'];
    for (const n of names) {
      expect(screen.getByText(n)).toBeInTheDocument();
    }
    // 飞书 is pre-selected (on); 微信 starts off.
    expect(screen.getByRole('switch', { name: '飞书' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: '微信' })).toHaveAttribute('aria-checked', 'false');
    // Turn on 龙虾邮箱 (popo), then save.
    fireEvent.click(screen.getByRole('switch', { name: '龙虾邮箱' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Agent 名称/i }), { target: { value: 'IM Bot' } });
    fireEvent.click(screen.getByRole('button', { name: /创建智能体/ }));
    await waitFor(() => expect((saved as { im_channels?: string[] }).im_channels).toEqual(['feishu', 'email']));
  });

  test('edit mode shows a non-blocking warning when another agent shares the draft name', () => {
    setLang('zh');
    // a1 and a2 share the name 'N' (the item() fixture) but differ by agentId.
    const a1 = item();
    const a2: AgentMarketplaceItem = { ...a1, agentId: 'a2' };
    render(<AgentDrawer mode="edit" agent={a1} roleOptions={['org_admin']} skills={[]} agents={[a1, a2]} models={[]} onSave={async()=>{}} onClose={()=>{}} />);
    // The warning is a note under the name field — it does not block save.
    expect(screen.getByText(/已有同名智能体/)).toBeInTheDocument();
  });
});
