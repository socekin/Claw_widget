# OpenClaw Widget Bridge

> Minimal, privacy-safe HTTP bridge for iOS Widget data.

---

## 目录

- [概述](#概述)
- [架构](#架构)
- [API 契约](#api-契约)
- [目录结构](#目录结构)
- [环境要求](#环境要求)
- [安装与配置](#安装与配置)
- [访问方式](#访问方式)
- [安全清单](#安全清单)
- [运营说明](#运营说明)
- [iOS Widget 集成说明](#ios-widget-集成说明)

---

## 概述

本插件暴露单一认证端点：

```
GET /widget/summary
```

返回经过脱敏处理的摘要信息，包含：

- Gateway 健康状态
- 用量统计（Token 数量 + 预估费用）

> **不暴露**会话记录、Channel 详情或任何用户标识符。

---

## 架构

```
iOS Widget
    │
    │  HTTPS (Bearer Token)
    ▼
Cloudflare Tunnel
    │
    ▼
OpenClaw Gateway  ── Plugin Route: /widget/summary
    │
    ├── openclaw gateway call health --json
    └── openclaw gateway call usage.cost --json --params '{"days": N}'
```

---

## API 契约

### 请求

| 项目     | 说明                                       |
| -------- | ------------------------------------------ |
| Method   | `GET`                                      |
| Header   | `Authorization: Bearer <apiToken>`         |
| 可选参数 | `?days=<integer>` 范围 `1-90`，覆盖默认值 |

### 成功响应 `200`

```json
{
  "ok": true,
  "updatedAt": 1771483190719,
  "health": {
    "status": "up",
    "latencyMs": 578,
    "checkedAt": 1771483159633
  },
  "usage": {
    "days": 30,
    "startDate": null,
    "endDate": null,
    "totalTokens": 299262701,
    "totalCostUsd": 124.7866886000002,
    "updatedAt": 1771482216439
  }
}
```

### 错误响应

| 状态码 | 错误码                  | 说明                    |
| ------ | ----------------------- | ----------------------- |
| `401`  | `unauthorized`          | Bearer Token 缺失或无效 |
| `405`  | `method_not_allowed`    | 请求方法不是 GET        |
| `500`  | `plugin_not_configured` | apiToken 未配置         |
| `502`  | `upstream_failed`       | 内部 Gateway 调用失败   |

---

## 目录结构

```
Claw-Widget/
  ├─ package.json
  ├─ openclaw.plugin.json
  └─ index.ts
```

---

## 环境要求

- Linux VPS，已安装并运行 OpenClaw
- `openclaw` CLI 已加入 `PATH`
- Cloudflare 账号（生产环境使用 Tunnel）

---

## 安装与配置

### 1. 开发模式安装（Link Mode）

```bash
openclaw plugins install -l ~/Claw-Widget
openclaw plugins list
```

### 2. 插件配置

```bash
# 生成并保存 API Token
TOKEN_FILE="$HOME/.openclaw/widget-token.txt"
[ -f "$TOKEN_FILE" ] || (openssl rand -hex 32 > "$TOKEN_FILE" && chmod 600 "$TOKEN_FILE")
WIDGET_TOKEN="$(cat "$TOKEN_FILE")"

# 写入插件配置
openclaw config set plugins.entries.openclaw-widget-bridge.enabled true
openclaw config set plugins.entries.openclaw-widget-bridge.config.apiToken "$WIDGET_TOKEN"
openclaw config set plugins.entries.openclaw-widget-bridge.config.cliPath "$(command -v openclaw)"
openclaw config set plugins.entries.openclaw-widget-bridge.config.timeoutMs 8000
openclaw config set plugins.entries.openclaw-widget-bridge.config.usageDays 30

# 重启 Gateway 使配置生效
openclaw gateway restart
```

### 3. 本地验证

```bash
WIDGET_TOKEN="$(openclaw config get plugins.entries.openclaw-widget-bridge.config.apiToken | tr -d '\"[:space:]')"
curl -sS -H "Authorization: Bearer $WIDGET_TOKEN" \
  http://127.0.0.1:18789/widget/summary | jq
```

---

## 访问方式

### 临时公网访问（Quick Tunnel）

```bash
cloudflared tunnel --url http://127.0.0.1:18789 --no-autoupdate
```

使用生成的 `https://*.trycloudflare.com` URL 进行测试。

### 生产环境（Named Tunnel）

**步骤一：创建 Tunnel**

```bash
cloudflared tunnel login
cloudflared tunnel create openclaw-widget
cloudflared tunnel route dns openclaw-widget widget.example.com
```

**步骤二：创建配置文件 `config.yml`**

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /root/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: widget.example.com
    path: ^/widget/summary$
    service: http://127.0.0.1:18789
  - service: http_status:404
```

**步骤三：运行并注册为系统服务**

```bash
cloudflared tunnel run openclaw-widget

cloudflared service install
systemctl enable --now cloudflared
systemctl status cloudflared --no-pager
```

---

## 安全清单

- [x] 使用足够长度的随机 Bearer Token
- [x] 妥善保管 `apiToken`，定期轮换
- [x] Tunnel 路径过滤，仅暴露 `/widget/summary`
- [x] 不暴露原始 health / session / channel 内部接口
- [x] 保持 OpenClaw 和 cloudflared 更新到最新版本

---

## 运营说明

- `usage.cost` 是基于会话用量与模型定价配置计算的**预估值**，可能与服务商实际账单存在差异。
- 若 Token 发生变更，所有 Widget 客户端必须同步更新凭据。

---

## iOS Widget 集成说明

| 项目     | 建议                                           |
| -------- | ---------------------------------------------- |
| 请求方式 | 周期性 HTTPS 拉取，**不使用** WebSocket 长连接 |
| 本地缓存 | 通过 App Group 存储最新 Payload                |
| 错误处理 | 非 `200` 或 `ok: false` 时展示缓存的过期数据  |
| 刷新间隔 | 建议 **15–30 分钟**                            |
