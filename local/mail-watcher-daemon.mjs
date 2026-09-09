#!/usr/bin/env node
/**
 * mail-watcher-daemon.mjs — 常驻进程模式
 *
 * 与 mail-watcher.mjs（一次性运行）的区别：
 *   - 启动后保持 IMAP 连接，不退出
 *   - 使用 IMAP IDLE 命令实时监听新邮件
 *   - 有新邮件时自动处理，处理完后重新进入 IDLE
 *   - 连接断开时自动重连（指数退避）
 *   - 收到 SIGINT/SIGTERM 时优雅退出
 *
 * 由计划任务"启动一次"运行，而不是每分钟触发。
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { connectImap } from './lib/imap.mjs';
import { parseEmail, parseDate } from './lib/parser.mjs';
import { loadWhitelist, matchWhitelist, normalizeEmail } from './lib/whitelist.mjs';
import { classify } from './lib/classifier.mjs';
import { buildPayload, hashMessageId } from './lib/redact.mjs';
import {
  loadState, saveState, acquireLock, releaseLock,
  getCursor, advanceCursor, isFirstRun,
  addPending, takePending, removePending,
  addProcessed, isProcessed,
} from './lib/state.mjs';
import { sendDispatch } from './lib/dispatch.mjs';

// ─── 路径配置 ───────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const CONFIG_DIR = path.join(PROJECT_ROOT, 'config');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');
const STATE_FILE = path.join(STATE_DIR, 'mail-state.json');
const LOCK_FILE = path.join(STATE_DIR, 'mail-watcher.lock');
const WHITELIST_FILE = path.join(CONFIG_DIR, 'whitelist.json');
const RULES_FILE = path.join(CONFIG_DIR, 'rules.json');
const LOG_FILE = path.join(LOG_DIR, 'daemon.log');

const MAILBOX = 'INBOX';
const MAILBOX_KEY = 'qq-main';

// ─── 全局状态 ───────────────────────────────────────────────────────

let imapClient = null;
let state = null;
let whitelist = null;
let rules = null;
let running = true;
let reconnectDelay = 5000; // 初始重连延迟 5 秒
const MAX_RECONNECT_DELAY = 5 * 60 * 1000; // 最大重连延迟 5 分钟

// ─── 工具函数 ───────────────────────────────────────────────────────

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(msg) {
  const line = `[${timestamp()}] ${msg}`;
  console.log(line);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (_) {}
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

/** 计算 6 个月前的日期（自然月） */
function sixMonthsAgo(now = new Date()) {
  const targetYear = now.getFullYear();
  const targetMonth = now.getMonth() - 6;
  const originalDay = now.getDate();
  const targetDate = new Date(targetYear, targetMonth, 1);
  const lastDayOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0).getDate();
  targetDate.setDate(Math.min(originalDay, lastDayOfMonth));
  targetDate.setHours(0, 0, 0, 0);
  return targetDate;
}

// ─── 核心处理逻辑 ───────────────────────────────────────────────────

/**
 * 处理增量邮件（复用 mail-watcher.mjs 的逻辑）
 * 返回处理的新邮件数量
 */
async function processIncremental() {
  if (!imapClient || !imapClient.isConnected()) {
    throw new Error('IMAP not connected');
  }

  const cursor = getCursor(state, MAILBOX_KEY);
  const firstRun = isFirstRun(state, MAILBOX_KEY);
  const cutoff = sixMonthsAgo();

  // SELECT INBOX（每次处理前重新 SELECT，确保状态最新）
  const selectResult = await imapClient.select(MAILBOX);
  const uidvalidity = selectResult.uidvalidity;
  const exists = selectResult.exists;
  log(`mailbox_selected uidvalidity=${uidvalidity} exists=${exists}`);

  // 处理 pending dispatch（优先重试）
  // takePending 返回整个 pending 数组，需要遍历处理
  const pendingItems = takePending(state);
  for (const pending of pendingItems) {
    const midHash = pending.payload?.message_id_hash;
    log(`pending_retry mail_type=${pending.payload?.mail_type}`);
    const result = await sendDispatch(pending.payload, {
      token: process.env.GITHUB_TOKEN,
      repo: process.env.GITHUB_REPO,
    });
    if (result.success) {
      log(`pending_retry success`);
      removePending(state, midHash);
    } else {
      pending.retry_count = (pending.retry_count || 0) + 1;
      if (pending.retry_count >= 3) {
        log(`pending_retry gave_up after 3 attempts`);
        removePending(state, midHash);
      } else {
        log(`pending_retry failed (attempt ${pending.retry_count}), will retry next round`);
        // 不 break，继续处理其他 pending；失败的留在队列里下轮重试
      }
    }
  }

  // 搜索新邮件
  let uidsToProcess = [];
  let imapFailed = false;

  if (firstRun) {
    // 首次启动：搜索最近6个月
    try {
      uidsToProcess = await imapClient.searchSince(cutoff);
    } catch (err) {
      log(`status=error IMAP search failed: ${err.message?.slice(0, 100)}`);
      imapFailed = true;
    }
    log(`first_run found=${uidsToProcess.length} emails_in_6_months`);
  } else {
    // 非首次：检查 uidvalidity，然后取 > last_uid 的
    if (cursor.uidvalidity !== 0 && cursor.uidvalidity !== uidvalidity) {
      log(`uidvalidity_changed old=${cursor.uidvalidity} new=${uidvalidity} resetting_cursor`);
      try {
        uidsToProcess = await imapClient.searchSince(cutoff);
      } catch (err) {
        log(`status=error IMAP search failed: ${err.message?.slice(0, 100)}`);
        imapFailed = true;
      }
    } else {
      try {
        const allUids = await imapClient.searchAll();
        uidsToProcess = allUids.filter((uid) => uid > cursor.lastUid);
      } catch (err) {
        log(`status=error IMAP search failed: ${err.message?.slice(0, 100)}`);
        imapFailed = true;
      }
    }
    log(`incremental found=${uidsToProcess.length} new_emails (last_uid=${cursor.lastUid})`);
  }

  if (imapFailed || uidsToProcess.length === 0) {
    if (!imapFailed && uidsToProcess.length === 0 && firstRun) {
      // 首次启动但没有邮件，设置基线
      try {
        const allUids = await imapClient.searchAll();
        if (allUids.length > 0) {
          const maxUid = Math.max(...allUids);
          advanceCursor(state, MAILBOX_KEY, uidvalidity, maxUid);
          log(`first_run baseline_set last_uid=${maxUid}`);
        }
      } catch (_) {}
    }
    saveState(state, STATE_FILE);
    return 0;
  }

  // 两阶段读取 + 处理
  let headerResults = [];
  try {
    headerResults = await imapClient.fetchHeaders(uidsToProcess);
  } catch (err) {
    log(`status=error IMAP fetchHeaders failed: ${err.message?.slice(0, 100)}`);
    saveState(state, STATE_FILE);
    return 0;
  }

  let maxProcessedUid = cursor.lastUid;
  let anyFetchBodyFailed = false;
  const selfEmail = normalizeEmail(process.env.QQ_MAIL_USER);
  const llmConfig = {
    apiKey: process.env.LLM_API_KEY,
    apiUrl: process.env.LLM_API_URL,
    model: process.env.LLM_MODEL,
  };

  for (const headerInfo of headerResults) {
    if (!running) break; // 优雅退出

    const uid = headerInfo.uid;
    const mailDate = parseDate(headerInfo.date);

    // 6个月时间闸门
    if (mailDate && mailDate < cutoff) {
      if (uid > maxProcessedUid) maxProcessedUid = uid;
      continue;
    }

    // 解析发件人
    const fromMatch = headerInfo.from?.match(/<([^>]+)>/) ||
      headerInfo.from?.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
    const fromEmail = fromMatch ? fromMatch[1].toLowerCase() : '';
    const fromDomain = fromEmail.includes('@') ? fromEmail.split('@')[1] : '';
    const sender = { email: fromEmail, domain: fromDomain };

    // 自己发的跳过
    if (selfEmail && fromEmail === selfEmail) {
      if (uid > maxProcessedUid) maxProcessedUid = uid;
      continue;
    }

    // 白名单硬闸门
    const wlResult = matchWhitelist(sender, whitelist);
    if (!wlResult.matched) {
      if (uid > maxProcessedUid) maxProcessedUid = uid;
      continue;
    }
    log(`uid=${uid} whitelist=${wlResult.type} from=${fromEmail}`);

    // 认证判断
    const authStatus = headerInfo.authResults || '';
    const receivedSpf = headerInfo.receivedSpf || '';
    const authFail = /spf\s*=\s*fail/i.test(authStatus) ||
      /dkim\s*=\s*fail/i.test(authStatus) ||
      /dmarc\s*=\s*fail/i.test(authStatus) ||
      /^\s*fail/i.test(receivedSpf);
    if (authFail) {
      log(`uid=${uid} skip_reason=sender_auth_failed`);
      if (uid > maxProcessedUid) maxProcessedUid = uid;
      continue;
    }

    // 第二阶段：拉取正文
    let rawBody;
    try {
      rawBody = await imapClient.fetchBody(uid);
    } catch (err) {
      log(`uid=${uid} fetch_body_failed ${err.message?.slice(0, 100)}`);
      anyFetchBodyFailed = true;
      continue;
    }

    // 解析邮件
    const mail = parseEmail(rawBody);

    // 去重
    const midHash = hashMessageId(mail.messageId);
    if (isProcessed(state, midHash)) {
      if (uid > maxProcessedUid) maxProcessedUid = uid;
      continue;
    }

    // 分类
    const classification = await classify(
      { from: mail.from, subject: mail.subject, date: mail.date, messageId: mail.messageId },
      { textBody: mail.textBody, htmlBody: mail.htmlBody },
      { selfEmail, rules, llmConfig }
    );

    log(`uid=${uid} classified type=${classification.type} priority=${classification.priority} game=${classification.game || 'N/A'}`);

    // P3 不 Push，但记录已处理
    if (classification.priority === 'P3' || classification.type === 'irrelevant' || classification.type === 'unknown') {
      addProcessed(state, midHash);
      if (uid > maxProcessedUid) maxProcessedUid = uid;
      continue;
    }

    // 构建 payload + dispatch
    const payload = buildPayload(classification, mail);
    const result = await sendDispatch(payload, {
      token: process.env.GITHUB_TOKEN,
      repo: process.env.GITHUB_REPO,
    });

    if (result.success) {
      log(`uid=${uid} dispatch=success`);
      addProcessed(state, midHash);
      if (uid > maxProcessedUid) maxProcessedUid = uid;
    } else {
      log(`uid=${uid} dispatch=failed error=${result.error?.slice(0, 100)}`);
      addPending(state, { payload, retry_count: 0 });
      anyFetchBodyFailed = true;
    }
  }

  // 推进 cursor
  if (!anyFetchBodyFailed && maxProcessedUid > cursor.lastUid) {
    advanceCursor(state, MAILBOX_KEY, uidvalidity, maxProcessedUid);
    log(`cursor_advanced last_uid=${maxProcessedUid}`);
  } else if (anyFetchBodyFailed) {
    log('cursor_not_advanced reason=fetch_or_dispatch_failure');
  }

  saveState(state, STATE_FILE);
  return uidsToProcess.length;
}

// ─── 连接管理 ───────────────────────────────────────────────────────

async function connect() {
  log('连接 IMAP...');
  imapClient = await connectImap({
    user: process.env.QQ_MAIL_USER,
    authToken: process.env.QQ_MAIL_AUTH_TOKEN,
    host: process.env.QQ_MAIL_HOST || 'imap.qq.com',
    port: parseInt(process.env.QQ_MAIL_PORT || '993', 10),
  });
  log('IMAP 连接成功');
  reconnectDelay = 5000; // 重置重连延迟
}

async function disconnect() {
  if (imapClient) {
    try {
      await imapClient.logout();
    } catch (_) {}
    imapClient = null;
  }
}

async function reconnect() {
  await disconnect();
  log(`等待 ${reconnectDelay / 1000} 秒后重连...`);
  await new Promise((r) => setTimeout(r, reconnectDelay));
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY); // 指数退避
  await connect();
}

// ─── 主循环 ─────────────────────────────────────────────────────────

async function mainLoop() {
  while (running) {
    try {
      // 确保连接
      if (!imapClient || !imapClient.isConnected()) {
        await connect();
      }

      // 处理增量邮件
      const processed = await processIncremental();
      if (processed > 0) {
        log(`本轮处理完成，共 ${processed} 封新邮件`);
      }

      if (!running) break;

      // 进入 IDLE 模式等待新邮件
      log('进入 IDLE 模式，等待新邮件...');
      try {
        const newExists = await imapClient.idle();
        log(`IDLE 收到通知: EXISTS=${newExists}，开始处理新邮件`);
      } catch (idleErr) {
        if (idleErr.message === 'IDLE timeout') {
          log('IDLE 超时，重新进入循环（会重新 SELECT 检查新邮件）');
        } else {
          log(`IDLE 错误: ${idleErr.message?.slice(0, 100)}，尝试重连`);
          await reconnect();
        }
      }
    } catch (err) {
      log(`主循环错误: ${err.message?.slice(0, 200)}`);
      log(err.stack?.split('\n').slice(0, 5).join('\n'));
      try {
        await reconnect();
      } catch (reconnectErr) {
        log(`重连失败: ${reconnectErr.message?.slice(0, 100)}，继续重试`);
      }
    }
  }
}

// ─── 优雅退出 ───────────────────────────────────────────────────────

async function shutdown() {
  log('收到退出信号，正在优雅退出...');
  running = false;

  // 保存状态
  try {
    if (state) saveState(state, STATE_FILE);
  } catch (_) {}

  // 释放锁
  try {
    releaseLock(LOCK_FILE);
  } catch (_) {}

  // 断开连接
  await disconnect();

  log('已退出');
  process.exit(0);
}

// ─── 启动 ───────────────────────────────────────────────────────────

async function main() {
  log('=== QQ 邮箱合作邮件 Push 系统（常驻进程模式）===');
  log(`APP_ENV=${process.env.APP_ENV || 'development'}`);

  // 加载环境
  loadEnv();

  // 加载配置
  whitelist = loadWhitelist(WHITELIST_FILE);
  rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  log(`白名单: ${whitelist.emails?.size || 0} 个邮箱, ${whitelist.domains?.size || 0} 个域名`);

  // 加载状态
  state = loadState(STATE_FILE);

  // 获取单实例锁
  const lockAcquired = acquireLock(LOCK_FILE);
  if (!lockAcquired) {
    log('另一个实例正在运行，退出');
    process.exit(0);
  }

  // 注册信号处理
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 启动主循环
  try {
    await mainLoop();
  } catch (err) {
    log(`致命错误: ${err.message}`);
    await shutdown();
  }
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
