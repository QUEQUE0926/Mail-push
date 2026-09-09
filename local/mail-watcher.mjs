#!/usr/bin/env node
/**
 * mail-watcher.mjs — QQ 邮箱重要合作邮件 Push 系统主入口
 *
 * 由计划任务每分钟拉起。
 *
 * 主流程：
 *   1. 加载配置（环境变量 + config/whitelist.json + config/rules.json）
 *   2. 获取单实例锁，失败则退出
 *   3. 输出 status 行
 *   4. 加载 state，处理 pending dispatch（优先重试，不重复 LLM）
 *   5. 连接 IMAP，SELECT INBOX，获取 uidvalidity
 *   6. 首次启动：SEARCH SINCE <6个月前>，建立基线，historical_push=false
 *   7. 非首次：SEARCH ALL，取 > last_uid 的
 *   8. 对每个新UID：FETCH HEADER → 6个月判断 → 白名单 → 认证 → FETCH BODY → 分类 → 脱敏 → dispatch → 记录processed
 *   9. 全部成功后 advanceCursor
 *  10. 保存state，释放锁，退出
 *
 * 环境变量：
 *   QQ_MAIL_USER, QQ_MAIL_AUTH_TOKEN
 *   GITHUB_TOKEN, GITHUB_REPO (owner/repo)
 *   LLM_API_KEY (可选), LLM_API_URL (可选), LLM_MODEL (可选)
 *   APP_ENV (默认 development), HISTORICAL_PUSH (默认 false)
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
const STATE_FILE = path.join(STATE_DIR, 'mail-state.json');
const LOCK_FILE = path.join(STATE_DIR, 'mail-watcher.lock');
const WHITELIST_FILE = path.join(CONFIG_DIR, 'whitelist.json');
const RULES_FILE = path.join(CONFIG_DIR, 'rules.json');

const MAILBOX = 'INBOX';
const MAILBOX_KEY = 'qq-main';

// ─── 工具函数 ───────────────────────────────────────────────────────

/** 格式化日志时间戳 */
function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 日志输出 */
function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

/**
 * 计算 6 个月前的日期（自然月，不是180天）。
 * 如果当前日期超出目标月天数，取该月最后一天。
 */
function sixMonthsAgo(now = new Date()) {
  const targetYear = now.getFullYear();
  const targetMonth = now.getMonth() - 6; // 可能为负数，Date 会自动处理年份
  const originalDay = now.getDate();

  // 目标月的最后一天
  const lastDayOfTarget = new Date(targetYear, targetMonth + 1, 0).getDate();
  const day = Math.min(originalDay, lastDayOfTarget);

  return new Date(targetYear, targetMonth, day, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
}

/** 检查配置是否完整 */
function checkConfig() {
  const missing = [];
  if (!process.env.QQ_MAIL_USER) missing.push('QQ_MAIL_USER');
  if (!process.env.QQ_MAIL_AUTH_TOKEN) missing.push('QQ_MAIL_AUTH_TOKEN');
  if (!process.env.GITHUB_TOKEN) missing.push('GITHUB_TOKEN');
  if (!process.env.GITHUB_REPO) missing.push('GITHUB_REPO');
  return missing;
}

// ─── 主流程 ─────────────────────────────────────────────────────────

async function main() {
  // 1. 加载配置
  const appEnv = process.env.APP_ENV || 'development';
  const historicalPush = process.env.HISTORICAL_PUSH === 'true';

  const missing = checkConfig();
  if (missing.length > 0) {
    log(`status=notConfigured missing=${missing.join(',')}`);
    process.exit(1);
  }

  const whitelist = loadWhitelist(WHITELIST_FILE);
  // rules.json 可选（当前分类器内置规则，文件可用于覆盖）
  let rules = {};
  try {
    if (fs.existsSync(RULES_FILE)) {
      rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    }
  } catch (_) { /* 忽略 */ }

  // 2. 获取单实例锁
  const lockResult = acquireLock(LOCK_FILE);
  if (!lockResult.acquired) {
    log('status=ok another_instance_running');
    process.exit(0);
  }

  // 3. 输出 status 行
  log(`status=ok mailbox=${MAILBOX_KEY} env=${appEnv}`);

  // 4. 加载 state，处理 pending dispatch
  const state = loadState(STATE_FILE);
  const pendingItems = takePending(state);
  for (const item of pendingItems) {
    try {
      log(`pending_retry message_id_hash=${item.payload?.message_id_hash?.slice(0, 20)}... retry=${item.retry_count}`);
      const result = await sendDispatch(item.payload, {
        token: process.env.GITHUB_TOKEN,
        repo: process.env.GITHUB_REPO,
      });
      if (result.success) {
        log(`pending_dispatch=success message_id_hash=${item.payload?.message_id_hash?.slice(0, 20)}...`);
        removePending(state, item.payload?.message_id_hash);
      } else {
        log(`pending_dispatch=failed error=${result.error?.slice(0, 100)}`);
        // 更新重试次数
        item.retry_count = (item.retry_count || 0) + 1;
      }
    } catch (err) {
      log(`pending_dispatch=error ${err.message?.slice(0, 100)}`);
    }
  }
  saveState(state, STATE_FILE);

  // 5. 连接 IMAP
  let imapClient;
  try {
    imapClient = await connectImap({
      host: 'imap.qq.com',
      port: 993,
      user: process.env.QQ_MAIL_USER,
      password: process.env.QQ_MAIL_AUTH_TOKEN,
    });
  } catch (err) {
    if (err.message?.includes('LOGIN') || err.message?.includes('AUTH')) {
      log('status=unauthorized IMAP login failed');
    } else {
      log(`status=unavailable IMAP connect failed: ${err.message?.slice(0, 100)}`);
    }
    releaseLock(LOCK_FILE);
    process.exit(1);
  }

  let imapFailed = false;

  try {
    // SELECT INBOX
    const selectResult = await imapClient.select(MAILBOX);
    const uidvalidity = selectResult.uidvalidity;
    log(`mailbox_selected uidvalidity=${uidvalidity} exists=${selectResult.exists}`);

    // 6/7. 获取待处理 UID 列表
    const cursor = getCursor(state, MAILBOX_KEY);
    const firstRun = isFirstRun(state, MAILBOX_KEY);
    const cutoff = sixMonthsAgo();

    let uidsToProcess = [];

    if (firstRun) {
      // 首次启动：扫描最近6个月建立基线
      log(`first_run=yes scanning_since=${cutoff.toISOString()}`);
      try {
        uidsToProcess = await imapClient.searchSince(cutoff);
      } catch (err) {
        log(`status=error IMAP search failed: ${err.message?.slice(0, 100)}`);
        imapFailed = true;
      }
      log(`first_run found=${uidsToProcess.length} emails_in_6_months`);
    } else {
      // 非首次：取所有 UID 中 > last_uid 的
      // 检查 uidvalidity 是否变化
      if (cursor.uidvalidity !== 0 && cursor.uidvalidity !== uidvalidity) {
        log(`uidvalidity_changed old=${cursor.uidvalidity} new=${uidvalidity} resetting_cursor`);
        // UIDVALIDITY 变化 → 重新从6个月前扫描
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

    if (!imapFailed && uidsToProcess.length > 0) {
      // 8. 两阶段读取 + 处理
      // 第一阶段：批量拉取 headers
      let headerResults = [];
      try {
        headerResults = await imapClient.fetchHeaders(uidsToProcess);
      } catch (err) {
        log(`status=error IMAP fetchHeaders failed: ${err.message?.slice(0, 100)}`);
        imapFailed = true;
      }

      if (!imapFailed) {
        let maxProcessedUid = cursor.lastUid;
        let anyFetchBodyFailed = false;

        for (const headerInfo of headerResults) {
          const uid = headerInfo.uid;

          // 解析日期
          const mailDate = parseDate(headerInfo.date);

          // 6个月时间闸门
          if (mailDate && mailDate < cutoff) {
            log(`uid=${uid} skip_reason=older_than_6_months date=${headerInfo.date}`);
            if (uid > maxProcessedUid) maxProcessedUid = uid;
            continue;
          }

          // 解析发件人
          const fromMatch = headerInfo.from?.match(/<([^>]+)>/) ||
            headerInfo.from?.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
          const fromEmail = fromMatch ? fromMatch[1].toLowerCase() : '';
          const fromDomain = fromEmail.includes('@') ? fromEmail.split('@')[1] : '';
          const sender = { email: fromEmail, domain: fromDomain };

          // 自己发的邮件 → irrelevant，不 Push（在白名单闸门之前判断）
          const selfEmail = normalizeEmail(process.env.QQ_MAIL_USER);
          if (selfEmail && fromEmail === selfEmail) {
            log(`uid=${uid} skip_reason=self_sent`);
            if (uid > maxProcessedUid) maxProcessedUid = uid;
            continue;
          }

          // 白名单硬闸门
          const wlResult = matchWhitelist(sender, whitelist);
          if (!wlResult.matched) {
            log(`uid=${uid} skip_reason=not_in_whitelist from=${fromEmail}`);
            if (uid > maxProcessedUid) maxProcessedUid = uid;
            continue;
          }
          log(`uid=${uid} whitelist=${wlResult.type}`);

          // 认证判断（SPF/DKIM/DMARC）
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
            continue; // 不推进 cursor，下轮重试
          }

          // 解析邮件
          const mail = parseEmail(rawBody);

          // 去重检查
          const midHash = hashMessageId(mail.messageId);
          if (isProcessed(state, midHash)) {
            log(`uid=${uid} skip_reason=already_processed`);
            if (uid > maxProcessedUid) maxProcessedUid = uid;
            continue;
          }

          // 分类
          const classification = await classify(
            {
              from: mail.from,
              subject: mail.subject,
              date: mail.date,
              messageId: mail.messageId,
            },
            { textBody: mail.textBody, htmlBody: mail.htmlBody },
            {
              selfEmail: normalizeEmail(process.env.QQ_MAIL_USER),
              llm: {
                apiKey: process.env.LLM_API_KEY,
                apiUrl: process.env.LLM_API_URL,
                model: process.env.LLM_MODEL,
              },
            }
          );

          log(`uid=${uid} class=${classification.type} priority=${classification.priority} shouldPush=${classification.shouldPush}`);

          // 不需要 Push 的邮件也记录为已处理
          if (!classification.shouldPush) {
            addProcessed(state, midHash);
            if (uid > maxProcessedUid) maxProcessedUid = uid;
            continue;
          }

          // 构建脱敏 payload
          const payload = buildPayload(classification, mail, { historicalPush });

          // 首次启动且 historical_push=false → 不补推历史邮件
          if (firstRun && !historicalPush) {
            log(`uid=${uid} historical_skip (historical_push=false)`);
            addProcessed(state, midHash);
            if (uid > maxProcessedUid) maxProcessedUid = uid;
            continue;
          }

          // Dispatch
          try {
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
              // 保存 pending，下轮重试（不重复 LLM）
              addPending(state, { payload, retry_count: 0 });
              // 不推进 cursor（这个 UID 下轮重试）
              anyFetchBodyFailed = true; // 标记，阻止 cursor 推进
            }
          } catch (err) {
            log(`uid=${uid} dispatch=error ${err.message?.slice(0, 100)}`);
            addPending(state, { payload, retry_count: 0 });
            anyFetchBodyFailed = true;
          }
        }

        // 9. 推进 cursor（仅当没有 fetch/dispatch 失败）
        if (!anyFetchBodyFailed && maxProcessedUid > cursor.lastUid) {
          advanceCursor(state, MAILBOX_KEY, uidvalidity, maxProcessedUid);
          log(`cursor_advanced last_uid=${maxProcessedUid}`);
        } else if (anyFetchBodyFailed) {
          log('cursor_not_advanced reason=fetch_or_dispatch_failure');
        }
      }
    } else if (!imapFailed && uidsToProcess.length === 0) {
      log('no_new_emails');
      // 即使没有新邮件，如果是首次启动也设置 cursor（避免下次重复扫描）
      if (firstRun) {
        // 获取最大 UID 作为基线
        try {
          const allUids = await imapClient.searchAll();
          if (allUids.length > 0) {
            const maxUid = Math.max(...allUids);
            advanceCursor(state, MAILBOX_KEY, uidvalidity, maxUid);
            log(`first_run baseline_set last_uid=${maxUid}`);
          }
        } catch (_) { /* 忽略 */ }
      }
    }
  } catch (err) {
    log(`status=error ${err.message?.slice(0, 200)}`);
    imapFailed = true;
  } finally {
    // 10. 保存 state，释放锁，退出
    try {
      saveState(state, STATE_FILE);
    } catch (_) { /* 忽略 */ }
    try {
      if (imapClient) await imapClient.logout();
    } catch (_) { /* 忽略 */ }
    releaseLock(LOCK_FILE);
  }

  if (imapFailed) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[${timestamp()}] status=error fatal: ${err.message}`);
  try { releaseLock(LOCK_FILE); } catch (_) {}
  process.exit(1);
});
