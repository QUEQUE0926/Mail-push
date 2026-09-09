# QQ 邮箱重要合作邮件 Push 系统

> QQ 邮箱收到重要合作邮件后，1～5 分钟内自动识别并 Push 到企业微信 / WxPusher / Bark / ntfy。

## 1. 项目简介

本地 `mail-watcher` 监听 QQ 邮箱 IMAP，经白名单 + 规则 + LLM 分类后，将脱敏结构化 payload 通过 `repository_dispatch` 发送到 GitHub Actions；云端 `push.mjs` 二次校验、去重、自动测试打标，并行 Push 到多路通知渠道。

**核心原则：Key / Code 永远不出本机，完整正文不上传 GitHub。**

---

## 2. 架构图

```text
QQ Mail (IMAP)
    │
    ▼
local/mail-watcher.mjs
    ├─ 最近 6 个月时间闸门
    ├─ 发件人白名单（精确邮箱 / 域名）
    ├─ BODY.PEEK 读取（不修改已读状态）
    ├─ 规则过滤
    ├─ LLM 分类（规则不确定时才调用）
    ├─ Key / Code 脱敏
    └─ 本地去重（UID + Message-ID）
    │
    │ repository_dispatch: mail-push
    │ (仅上传脱敏结构化 payload)
    ▼
GitHub Actions (mail-signal.yml)
    ├─ payload schema 二次校验
    ├─ 云端去重（message_id_hash + mail_type）
    ├─ main / dev 分支隔离
    ├─ 测试消息自动加【测试】
    └─ 多路并行 Push
         ├─ 企业微信群机器人
         ├─ WxPusher
         ├─ Bark
         └─ ntfy
```

---

## 3. 安装步骤

```bash
# 克隆仓库
git clone <repo-url>
cd qq-mail-push

# 零外部依赖，无需 npm install
# （云端模块仅使用 Node.js 内置 https / fs / path / url）

# 复制环境变量模板
cp .env.example .env
# 编辑 .env 填入 QQ 邮箱授权码、GitHub Token 等
```

> 本项目 `package.json` 无 `dependencies`，所有云端 HTTP 请求使用 Node 内置 `https` 模块。

---

## 4. 配置说明

### 4.1 环境变量（`.env`）

| 变量 | 说明 | 本地需要 | 云端需要 |
|---|---|---|---|
| `QQ_MAIL_USER` | QQ 邮箱地址 | 是 | 否 |
| `QQ_MAIL_AUTH_TOKEN` | QQ IMAP 授权码（非登录密码） | 是 | 否 |
| `GITHUB_TOKEN` | GitHub PAT（需 repo 权限） | 是 | 否 |
| `GITHUB_REPO` | 目标仓库 `owner/repo` | 是 | 否 |
| `LLM_API_KEY` | LLM API Key（可选，不配置则纯规则） | 可选 | 否 |
| `LLM_API_URL` | LLM API 地址 | 可选 | 否 |
| `LLM_MODEL` | LLM 模型名 | 可选 | 否 |
| `APP_ENV` | 运行环境（development / production） | 是 | 是 |
| `HISTORICAL_PUSH` | 首次启动是否补推历史邮件（默认 false） | 是 | 否 |
| `WECOM_WEBHOOK` | 企业微信群机器人 Webhook | 否 | 是（Secret） |
| `WXPUSHER_APP_TOKEN` | WxPusher AppToken | 否 | 是（Secret） |
| `WXPUSHER_UIDS` | WxPusher UID（逗号分隔） | 否 | 是（Secret） |
| `BARK_SERVER` | Bark 服务器地址（如 https://api.day.app） | 否 | 是（Secret） |
| `BARK_KEY` | Bark Key | 否 | 是（Secret） |
| `NTFY_SERVER` | ntfy 服务器（默认 https://ntfy.sh） | 否 | 是（Secret） |
| `NTFY_TOPIC` | ntfy Topic | 否 | 是（Secret） |

### 4.2 白名单（`config/whitelist.json`）

```json
{
  "emails": ["hebechen@koeitecmo.com.tw"],
  "domains": ["koeitecmo.com.tw"]
}
```

- `emails`：精确邮箱地址匹配（大小写不敏感）
- `domains`：域名精确匹配（大小写不敏感，不支持子域名通配）
- 白名单提交 Git 管理，新增厂商在 dev 分支修改后合并 main
- **非白名单邮件连正文都不读取，不调用 LLM**

### 4.3 关键词规则（`config/rules.json`）

- `subject_keywords`：主题关键词，命中则进入候选
- `body_keywords`：正文关键词
- `code_patterns`：Code / Key 到达识别模式
- `ignore_patterns`：直接忽略的低价值模式（unsubscribe / newsletter 等）

---

## 5. 本地运行

```bash
# 启动邮件监听（每分钟轮询一次）
node local/mail-watcher.mjs

# 或使用 npm script
npm run watch
```

> `local/` 模块由本地代理负责，本仓库确保接口一致（payload 协议、白名单格式、状态文件路径）。

---

## 6. Windows 计划任务设置

每分钟拉起一次 `mail-watcher`，watcher 内部有单实例锁防止重叠。

### 6.1 创建计划任务（PowerShell，管理员）

```powershell
$action = New-ScheduledTaskAction `
  -Execute "node" `
  -Argument "I:\AIstore\16.mail\qq-mail-push\local\mail-watcher.mjs" `
  -WorkingDirectory "I:\AIstore\16.mail\qq-mail-push"

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 1)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName "QQMailPush-Watcher" `
  -Action $action -Trigger $trigger -Settings $settings
```

### 6.2 单实例锁

watcher 启动时检查 `state/mail-watcher.lock`：
- 锁存在且进程活跃 → 当前实例退出
- 锁超过 10 分钟且进程不存在 → 接管

---

## 7. 测试

```bash
# 运行本地回归测试（L1 单元 + L2 Fixture 回放）
node local/run-tests.mjs

# 或
npm test
```

测试覆盖：
- 日期 6 个月边界
- 邮箱地址标准化 / 域名精确匹配
- Message-ID hash
- Key 脱敏
- Priority 映射
- 测试标题注入
- UID cursor / pending retry
- Fixture 邮件回归

---

## 8. GitHub 部署

### 8.1 创建仓库

```bash
git init
git add .
git commit -m "init: qq-mail-push"
git branch -M main
git checkout -b dev
# 在 dev 上开发测试
git checkout main
git merge dev
git remote add origin <repo-url>
git push -u origin main dev
```

### 8.2 设置 Secrets

在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加：

| Secret | 说明 |
|---|---|
| `WECOM_WEBHOOK` | 企业微信群机器人 Webhook URL |
| `WXPUSHER_APP_TOKEN` | WxPusher AppToken |
| `WXPUSHER_UIDS` | WxPusher UID（逗号分隔多个） |
| `BARK_SERVER` | Bark 服务器地址 |
| `BARK_KEY` | Bark Key |
| `NTFY_SERVER` | ntfy 服务器（可选，默认 ntfy.sh） |
| `NTFY_TOPIC` | ntfy Topic |

> 未配置的 provider 会自动 skip，不影响其他通道。

### 8.3 分支策略

- `main`：生产分支，`repository_dispatch` 在此运行，Push 不带【测试】
- `dev`：开发/测试分支，所有 Push 自动带【测试】
- `workflow_dispatch` 在 `main` 上被拒绝（防呆），只能通过 `manual.yml` 做 smoke test

### 8.4 云端去重持久化

GitHub Actions runner 每次 checkout 后 `state/` 为空，第一版云端去重主要依赖单次运行内的状态。如需跨运行去重，可在 workflow 中添加 `actions/cache` 缓存 `state/push-state.json`：

```yaml
- name: Cache push state
  uses: actions/cache@v4
  with:
    path: state/push-state.json
    key: push-state-${{ github.run_id }}
    restore-keys: push-state-
```

---

## 9. 16 条硬约束清单

1. **只处理最近 6 个月内的邮件**，超过直接忽略
2. **只有白名单发件人**才允许进入 Push 流程，非白名单不读正文、不调 LLM
3. **使用 BODY.PEEK** 读取邮件，绝不修改已读/未读状态
4. **不依赖 UNSEEN**，使用 UIDVALIDITY + UID 游标，已读邮件也处理
5. **Key / Code 永远不出本机**，Push 只说"Code 已到"，让用户打开原邮件
6. **完整正文不上传 GitHub**，repository_dispatch 只传脱敏结构化 payload
7. **payload 禁止包含** body、fullText、key、code、authToken、password、cookie 等敏感字段
8. **本地去重 + 云端去重**双层幂等，同一邮件不重复 Push
9. **测试 Push 必须带【测试】**，由程序自动注入，不由 LLM 或人工决定
10. **非 main 分支 / PUSH_TEST=1 / APP_ENV!=production** 任一成立则加【测试】
11. **workflow_dispatch 在 main 上拒绝执行**，防止测试覆盖生产
12. **4 个 Push provider 独立失败不影响其他路**，未配置则 skip 不报错
13. **凭证只在本机**：QQ 授权码、LLM Key、GitHub PAT 均不提交 Git
14. **日志不打印**完整正文、Key/Code、授权码、Token
15. **IMAP 拉取失败时绝不推进 cursor**，否则会漏邮件
16. **首次启动默认不补推历史邮件**（HISTORICAL_PUSH=false），只建立基线

---

## 10. 邮件类型和优先级说明

### 10.1 邮件类型（13 种枚举）

| 类型 | 说明 | 典型优先级 |
|---|---|---|
| `review_invitation` | 新评测 / Code 申请邀请 | P2 |
| `review_application_notice` | 申请通知 | P2 |
| `review_application_approved` | 申请通过 | P1 |
| `review_code_received` | Code / Key 到达 | P1 |
| `deadline_notice` | Deadline 通知 | P0（24h内）/ P1 |
| `embargo_notice` | Embargo 通知 | P1 |
| `nda_notice` | NDA 通知 | P1 |
| `followup_request` | 跟进请求 | P2 |
| `publisher_reply` | 厂商回复 | P1 / P2 |
| `press_release` | 新闻稿 | P3（不Push） |
| `newsletter` | Newsletter | P3（不Push） |
| `irrelevant` | 无关邮件 | P3（不Push） |
| `unknown` | 未知类型 | P3（不Push） |

### 10.2 优先级

| 优先级 | 含义 | 行为 |
|---|---|---|
| **P0** | URGENT（24h内 Deadline / 紧急变更） | 立即 Push，Bark level=active，ntfy priority=5 |
| **P1** | IMPORTANT（Code到达 / 申请通过 / 厂商重要回复） | 立即 Push，Bark level=active，ntfy priority=5 |
| **P2** | NORMAL（新评测邀请 / 新合作） | 正常 Push，Bark level=active，ntfy priority=4 |
| **P3** | IGNORE（新闻稿 / Newsletter / 广告） | 不 Push，仅记录 |

---

## 11. 安全说明

### 11.1 凭证只在本机

- QQ 邮箱 IMAP 授权码、LLM API Key、GitHub PAT 全部只存储在本地 `.env`
- `.env` 和 `.env.*` 已在 `.gitignore` 中排除
- GitHub 仓库只保存 Push Provider 的 Webhook / Token（作为 Secrets）

### 11.2 Key 不出本机

- 本地检测到 Code / Key 后，**只记录 `has_code: true`**，不保存完整 Code
- Push 内容只说"厂商已发送评测 Code，请打开原邮件查看"
- 日志、状态文件、payload 中均不出现完整 Code
- 脱敏发生在 `repository_dispatch` 之前

### 11.3 不修改已读状态

- 使用 IMAP `BODY.PEEK[]` 而非 `BODY[]` 读取邮件
- 系统处理状态与 QQ 邮箱已读状态完全分离
- QQ 邮箱显示未读 + Push 系统显示已处理 = 正常状态

### 11.4 防伪造

- 白名单按真实邮箱地址匹配，**不按显示名匹配**
- 域名必须精确匹配，防止 `koeitecmo.com.tw.attacker.com` 等攻击
- 解析 `Authentication-Results` / `Received-SPF` / `DKIM-Signature`，明确 fail 则拒绝 Push

### 11.5 repository_dispatch 安全

- dispatch 目标 URL 精确为 `https://api.github.com/repos/<owner>/<repo>/dispatches`
- 禁止任意 redirect
- GitHub PAT 不打印日志
- 云端 `validate.mjs` 二次校验 payload schema 和禁止字段

---

## 12. 目录结构

```text
qq-mail-push/
├── cloud/                          # 云端模块（GitHub Actions 中运行）
│   ├── push.mjs                    # Push 主逻辑（多路并行+测试打标+去重）
│   ├── validate.mjs                # payload schema 校验 + 云端去重
│   └── providers/
│       ├── wecom.mjs               # 企业微信群机器人
│       ├── wxpusher.mjs            # WxPusher
│       ├── bark.mjs                # Bark
│       └── ntfy.mjs                # ntfy
├── local/                          # 本地模块（mail-watcher，由本地代理负责）
│   ├── mail-watcher.mjs
│   └── run-tests.mjs
├── .github/
│   └── workflows/
│       ├── mail-signal.yml         # repository_dispatch 入口（mail-push）
│       └── manual.yml              # 手动 / smoke test
├── config/
│   ├── whitelist.json              # 白名单（提交 Git 管理）
│   └── rules.json                  # 关键词规则
├── state/
│   └── .gitkeep                    # 占位（运行时状态文件不提交）
├── package.json                    # 零 dependencies
├── .gitignore
├── .env.example
└── README.md
```

---

## repository_dispatch payload 协议

本地 dispatch 发送到 GitHub 的 `client_payload` 结构：

```json
{
  "event_type": "mail-push",
  "source": "qq-mail",
  "payload_version": 1,
  "priority": "P1",
  "mail_type": "review_code_received",
  "title": "评测码已到",
  "game": "Wo Long: Fallen Dynasty Complete Edition",
  "platform": ["Nintendo Switch 2"],
  "company": "KOEI TECMO",
  "summary": "厂商已发送评测 Code。",
  "action": "打开原邮件查看 Code。",
  "received_at": "2026-09-04T17:39:00+08:00",
  "message_id_hash": "sha256:..."
}
```

**禁止包含**：完整正文、完整 Key、邮箱授权码、附件、Cookie、Token。

---

## License

MIT
