import { describe, expect, test } from 'vitest';
import { policyResolver } from '../../../src/main/policies/policyResolver';

describe('main/policies/policyResolver', () => {
  const ctx = { roles: ['user'], id: 'u1', departmentPath: '/root' };

  test('MCP 上限语义：用户自添加在管理员 disabled 时被剔除', () => {
    const admin = [{ id: 'm1', disabled: true, scope: 'org-wide' }];
    const user = [{ id: 'm1' }, { id: 'm2' }];
    const r = policyResolver.resolveMcpList(admin, user, ctx);
    expect(r.find((x) => (x as { id: string }).id === 'm1')).toBeUndefined();
    expect(r.find((x) => (x as { id: string }).id === 'm2')).toBeDefined();
  });

  test('Model 上限语义：管理员禁用 → 模型不可见', () => {
    const admin = [{ id: 'mo1', disabled: true, scope: 'org-wide' }];
    const catalog = [{ id: 'mo1', enabled: true }];
    const r = policyResolver.resolveModelList(admin, catalog, ctx);
    expect(r).toHaveLength(0);
  });

  test('scope 匹配 role:admin 不匹配普通 user', () => {
    const admin = [{ id: 's1', disabled: false, scope: 'role:admin' }];
    const r = policyResolver.resolveSkillList(admin, [], ctx);
    expect(r).toHaveLength(0);
    const r2 = policyResolver.resolveSkillList(admin, [], { ...ctx, roles: ['admin'] });
    expect(r2).toHaveLength(1);
  });

  test('scope 匹配 dept-path 子树', () => {
    const admin = [{ id: 's1', disabled: false, scope: 'dept-path:/root/eng' }];
    const r = policyResolver.resolveSkillList(admin, [], {
      roles: [],
      id: 'u1',
      departmentPath: '/root/eng/web',
    });
    expect(r).toHaveLength(1);
  });
});