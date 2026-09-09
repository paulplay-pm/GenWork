# enterprise_server 部署指南

## 必需环境变量

| 名称 | 说明 |
|---|---|
| `DATABASE_URL` | `postgres://user:pass@host:5432/db` |
| `JWT_SECRET` | ≥32 字符随机串；用于签发与校验 JWT |
| `GENWORK_VAULT_MASTER_KEY` | 32 字节 base64（生成：`openssl rand -base64 32`）；provider key 加密主密钥 |
| `PORT` | 默认 `8787` |
| `ORG_ID` | （可选）CLI init 使用的 org id，默认 `default-org` |

## 启动步骤

```bash
# 1. 安装企业服务端依赖（首次）
npm run enterprise:install

# 2. 配置环境变量
export DATABASE_URL='postgres://...'
export JWT_SECRET="$(openssl rand -hex 32)"
export GENWORK_VAULT_MASTER_KEY="$(openssl rand -base64 32)"

# 3. 初始化数据库 + 打印 Super Admin 邀请码
npm run enterprise:init

# 4. （一次性）用邀请码在浏览器走 /admin/setup/redeem 完成 Super Admin 注册

# 5. 启动服务端
npm run enterprise:dev

# 6. 在桌面端配置 ENTERPRISE_SERVER_URL=https://<host>:8787 后启动
```

## 主密钥丢失

所有 provider key 不可恢复，必须重新录入。`providerKeyVault.add` 重新调用。

## 邀请码丢失/过期

```bash
npm run enterprise:reinit
```

## token_usage 冷归档

`token_usage` 表随使用量膨胀。每 90 天由管理员把超过窗口期的行 detach 到对象存储；详见 `scripts/security-check.cjs` 与 plan §11 v2（005_token_usage_partition.sql 占位）。

## 桌面端兼容矩阵

| 桌面版本 | 是否兼容 multi-tenant |
|---|---|
| 2026.8.25 之前 | 否（保留旧的 enterpriseAccount 自有账号） |
| 2026.8.25 起 | | 是（新装与升级走 `migrate-to-multi-tenant.cjs`） |

## 已知遗留（v1 → v1.1 边界）

- 管理员控制台 Web SPA：v1 仅暴露 REST API；v1.1 单独 spec。
- 管理员实际直读用户 workspace：v1 仅审计；v1.1 提供 `GET /admin/users/:id/workspace` 数据面。
- token_usage 按月 partition：v1 单表；v2 上线 partition + detach。
- bcryptjs（pure JS）代替 bcrypt：性能略低，避免 native binding 安装；可在 v2 升级。
- 桌面端遗留 `enterpriseAccount`（旧模式）：保留，与 multi-tenant (`enterpriseMt`) 并存至桌面端大版本切换。