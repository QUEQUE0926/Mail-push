#!/usr/bin/env node
/**
 * historical-push.mjs — 历史邮件补推脚本
 *
 * 扫描最近 N 天（默认30天）的邮件，对白名单发件人发来的重要合作邮件进行补推。
 * 不修改正常的 cursor 状态，独立运行。
 *
 * 用法：
 *   node local/historical-push.mjs [天数]
 *   例：node local/historical-push.mjs 30  （补推最近30天）
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { connectImap } from './lib/imap.mjs';
import { parseEmail, parseDate } from './lib/parser.mjs';
import { loadWhitelist, matchWhitelist, normalizeEmail } from './lib/whitelist.mjs';
import { classify } from './lib/classifier.mjs';
import { buildPayload, hashMessageId } from './lib/redact.mjs';
import { sendDispatch } from './lib/dispatch.mjs';

// ─── 路径配置 ───────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const WHITELIST_FILE = path.join(CONFIG_DIR, 'whitelist.json');
const RULES_FILE = path.join(CONFIG_DIR, 'rules.json');
const HISTORICAL_LOG = path.join(STATE_DIR, 'historical-push-log.json');

const MAILBOX = 'INBOX';

// ─── 工具函数 ───────────────────────────────────────────────────────

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

/** 加载 .env */
function loadEnv() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('未找到 .env 文件');
    process.exit(1);
  }
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** 计算 N 天前的日期 */
function daysAgo(n, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return d;
}

/** 格式化为 IMAP SEARCH SINCE 日期 (DD-MMM-YYYY) */
function formatImapDate(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(date.getDate()).padStart(2, '0');
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

/** 加载历史补推日志（去重用） */
function loadHistoricalLog() {
  try {
    if (fs.existsSync(HISTORICAL_LOG)) {
      return JSON.parse(fs.readFileSync(HISTORICAL_LOG, 'utf8'));
    }
  } catch (_) {}
  return { pushed: [] };
}

/** 保存历史补推日志 */
function saveHistoricalLog(logData) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(HISTORICAL_LOG, JSON.stringify(logData, null, 2), 'utf8');
  } catch (err) {
    log(`保存历史日志失败: ${err.message}`);
  }
}

// ─── 主流程 ─────────────────────────────────────────────────────────

async function main() {
  const days = parseInt(process.argv[2] || '30', 10);
  if (isNaN(days) || days <= 0) {
    console.error('天数必须是正整数');
    process.exit(1);
  }

  log(`=== 历史邮件补推：最近 ${days} 天 ===`);

  // 1. 加载环境变量
  loadEnv();

  // 2. 加载白名单和规则
  const whitelist = loadWhitelist(WHITELIST_FILE);
  const rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  log(`白名单: ${whitelist.emails?.size || 0} 个邮箱, ${whitelist.domains?.size || 0} 个域名`);

  // 3. 加载历史补推日志（去重）
  const histLog = loadHistoricalLog();
  const pushedSet = new Set(histLog.pushed || []);
  log(`已补推记录: ${pushedSet.size} 条`);

  // 4. 连接 IMAP
  log('连接 IMAP...');
  const imapClient = await connectImap({
    user: process.env.QQ_MAIL_USER,
    authToken: process.env.QQ_MAIL_AUTH_TOKEN,
    host: process.env.QQ_MAIL_HOST || 'imap.qq.com',
    port: parseInt(process.env.QQ_MAIL_PORT || '993', 10),
  });

  // 5. SELECT INBOX
  const selectResult = await imapClient.select(MAILBOX);
  const uidvalidity = selectResult.uidvalidity;
  const exists = selectResult.exists;
  log(`邮箱已选择: uidvalidity=${uidvalidity}, exists=${exists}`);

  // 6. 搜索最近 N 天的邮件
  const sinceDate = daysAgo(days);
  const sinceStr = formatImapDate(sinceDate);
  log(`搜索日期: SINCE ${sinceStr} (${sinceDate.toISOString().slice(0, 10)})`);

  const allUids = await imapClient.searchSince(sinceStr);
  log(`找到 ${allUids.length} 封邮件（最近 ${days} 天）`);

  if (allUids.length === 0) {
    log('没有邮件，退出');
    await imapClient.logout();
    return;
  }

  // 7. 分批拉取 Header
  log('开始拉取 Header...');
  const headerResults = await imapClient.fetchHeaders(allUids);
  log(`拉取到 ${headerResults.length} 个 Header`);

  // 8. 过滤白名单
  const selfEmail = normalizeEmail(process.env.QQ_MAIL_USER);
  const whitelistUids = [];

  for (const h of headerResults) {
    // 自己发的跳过
    const fromMatch = h.from?.match(/<([^>]+)>/) || h.from?.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
    const fromEmail = fromMatch ? fromMatch[1].toLowerCase() : '';
    if (selfEmail && fromEmail === selfEmail) continue;

    const fromDomain = fromEmail.includes('@') ? fromEmail.split('@')[1] : '';
    const sender = { email: fromEmail, domain: fromDomain };
    const wlResult = matchWhitelist(sender, whitelist);
    if (wlResult.matched) {
      whitelistUids.push({ uid: h.uid, from: fromEmail, date: h.date, subject: h.subject });
    }
  }

  log(`白名单命中: ${whitelistUids.length} 封`);

  if (whitelistUids.length === 0) {
    log('没有白名单邮件，退出');
    await imapClient.logout();
    return;
  }

  // 9. 对白名单邮件拉取正文、分类、补推
  let pushedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const llmConfig = {
    apiKey: process.env.LLM_API_KEY,
    apiUrl: process.env.LLM_API_URL,
    model: process.env.LLM_MODEL,
  };

  for (const item of whitelistUids) {
    const { uid, from, date, subject } = item;
    log(`--- 处理 UID=${uid} from=${from} subject=${subject?.slice(0, 50)}`);

    // 拉取正文
    let rawBody;
    try {
      rawBody = await imapClient.fetchBody(uid);
    } catch (err) {
      log(`  拉取正文失败: ${err.message?.slice(0, 80)}`);
      failedCount++;
      continue;
    }

    // 解析邮件
    const mail = parseEmail(rawBody);

    // 去重检查
    const midHash = hashMessageId(mail.messageId);
    if (pushedSet.has(midHash)) {
      log(`  跳过：已补推过 (message_id_hash)`);
      skippedCount++;
      continue;
    }

    // 分类
    const classification = await classify(
      { from: mail.from, subject: mail.subject, date: mail.date, messageId: mail.messageId },
      { textBody: mail.textBody, htmlBody: mail.htmlBody },
      { selfEmail, rules, llmConfig }
    );

    log(`  分类: type=${classification.type}, priority=${classification.priority}, game=${classification.game || 'N/A'}`);

    // 只补推重要邮件（非 irrelevant/unknown，且非 P3）
    if (classification.type === 'irrelevant' || classification.type === 'unknown') {
      log(`  跳过：非重要邮件 (${classification.type})`);
      skippedCount++;
      continue;
    }
    if (classification.priority === 'P3') {
      log(`  跳过：P3 低优先级`);
      skippedCount++;
      continue;
    }

    // 构建 payload 并发送
    const payload = buildPayload(classification, mail, { historicalPush: true });
    const result = await sendDispatch(payload, {
      token: process.env.GITHUB_TOKEN,
      repo: process.env.GITHUB_REPO,
    });

    if (result.success) {
      log(`  ✅ 补推成功 (status=${result.status})`);
      pushedCount++;
      pushedSet.add(midHash);
      // 定期保存日志
      if (pushedCount % 5 === 0) {
        saveHistoricalLog({ pushed: Array.from(pushedSet) });
      }
    } else {
      log(`  ❌ 补推失败: ${result.error?.slice(0, 80)}`);
      failedCount++;
    }

    // 避免请求过快
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 10. 保存历史补推日志
  saveHistoricalLog({ pushed: Array.from(pushedSet) });

  // 11. 断开 IMAP
  await imapClient.logout();

  // 12. 输出统计
  log('=== 补推完成 ===');
  log(`总白名单邮件: ${whitelistUids.length}`);
  log(`成功补推: ${pushedCount}`);
  log(`跳过（非重要/已补推）: ${skippedCount}`);
  log(`失败: ${failedCount}`);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
