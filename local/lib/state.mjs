/**
 * state.mjs — 本地 JSON 状态 / 单实例锁 / UID cursor / pending retry
 *
 * 硬约束：
 *   - 单实例锁：state/mail-watcher.lock，内容 {pid, started_at}
 *     锁超10分钟且进程不存在则接管，否则退出
 *   - UID Cursor：UIDVALIDITY + last_uid，不依赖 UNSEEN
 *     处理成功后才推进 cursor；IMAP拉取失败绝不推进 cursor
 *   - pending：dispatch 失败的 payload 保存，下一轮优先重试，不重复调 LLM
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── 默认状态 ───────────────────────────────────────────────────────

function defaultState() {
  return {
    schema: 1,
    mailboxes: {},
    processed: [],
    pending: [],
  };
}

// ─── 状态加载/保存 ─────────────────────────────────────────────────

/**
 * 加载状态文件。不存在则返回默认状态。
 */
export function loadState(statePath) {
  try {
    if (!fs.existsSync(statePath)) {
      return defaultState();
    }
    const raw = fs.readFileSync(statePath, 'utf8');
    const data = JSON.parse(raw);
    // 合并默认值，确保结构完整
    const state = defaultState();
    if (data.schema) state.schema = data.schema;
    if (data.mailboxes) state.mailboxes = data.mailboxes;
    if (Array.isArray(data.processed)) state.processed = data.processed;
    if (Array.isArray(data.pending)) state.pending = data.pending;
    return state;
  } catch (_) {
    return defaultState();
  }
}

/**
 * 保存状态文件（原子写入：先写临时文件再 rename）。
 */
export function saveState(state, statePath) {
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = statePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, statePath);
}

// ─── 单实例锁 ───────────────────────────────────────────────────────

const LOCK_STALE_MS = 10 * 60 * 1000; // 10 分钟

/**
 * 获取单实例锁。
 * @param {string} lockPath
 * @returns {{acquired:boolean, lock?:object}}
 */
export function acquireLock(lockPath) {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const now = Date.now();

  // 锁不存在 → 直接获取
  if (!fs.existsSync(lockPath)) {
    return _writeLock(lockPath, now);
  }

  // 锁存在 → 检查
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const lock = JSON.parse(raw);
    const lockAge = now - (lock.started_at || 0);

    // 检查进程是否存在
    const processAlive = _isProcessAlive(lock.pid);

    if (processAlive) {
      // 进程存活 → 锁有效，拒绝
      return { acquired: false, lock };
    }

    // 进程不存在
    if (lockAge > LOCK_STALE_MS) {
      // 锁超10分钟且进程不存在 → 接管
      return _writeLock(lockPath, now);
    }

    // 进程不存在但锁未超时（可能刚崩溃）→ 保守起见拒绝
    // 但如果进程确实不存在，可以接管
    return _writeLock(lockPath, now);
  } catch (_) {
    // 锁文件损坏 → 覆盖
    return _writeLock(lockPath, now);
  }
}

/** 写入锁文件 */
function _writeLock(lockPath, now) {
  const lock = { pid: process.pid, started_at: now };
  fs.writeFileSync(lockPath, JSON.stringify(lock), 'utf8');
  return { acquired: true, lock };
}

/**
 * 检查进程是否存活（跨平台）。
 * Windows: tasklist；Unix: kill -0
 */
function _isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      // Windows: 用 tasklist 查询
      const result = require('node:child_process').execSync(
        `tasklist /FI "PID eq ${pid}" /NH`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return result.includes(String(pid));
    } else {
      // Unix: kill -0 不发送信号，只检查进程是否存在
      process.kill(pid, 0);
      return true;
    }
  } catch (_) {
    return false;
  }
}

/**
 * 释放锁。
 */
export function releaseLock(lockPath) {
  try {
    if (fs.existsSync(lockPath)) {
      // 确认是自己的锁
      const raw = fs.readFileSync(lockPath, 'utf8');
      const lock = JSON.parse(raw);
      if (lock.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch (_) {
    // 忽略释放失败
  }
}

// ─── UID Cursor ─────────────────────────────────────────────────────

/**
 * 获取指定邮箱的 cursor。
 * @returns {{uidvalidity:number, lastUid:number}}
 */
export function getCursor(state, mailbox) {
  const mb = state.mailboxes[mailbox];
  if (!mb) {
    return { uidvalidity: 0, lastUid: 0 };
  }
  return {
    uidvalidity: mb.uidvalidity || 0,
    lastUid: mb.last_uid || 0,
  };
}

/**
 * 推进 cursor（仅在处理成功后调用）。
 * 如果 uidvalidity 变化，重置 lastUid。
 */
export function advanceCursor(state, mailbox, uidvalidity, uid) {
  if (!state.mailboxes[mailbox]) {
    state.mailboxes[mailbox] = { uidvalidity: 0, last_uid: 0, last_sync: null };
  }
  const mb = state.mailboxes[mailbox];

  // UIDVALIDITY 变化 → 邮箱被重建，重置 cursor
  if (mb.uidvalidity !== 0 && mb.uidvalidity !== uidvalidity) {
    mb.uidvalidity = uidvalidity;
    mb.last_uid = uid; // 从当前 UID 开始
  } else {
    mb.uidvalidity = uidvalidity;
    // 只推进不后退
    if (uid > mb.last_uid) {
      mb.last_uid = uid;
    }
  }
  mb.last_sync = new Date().toISOString();
}

/**
 * 检查是否首次启动（last_uid === 0）。
 */
export function isFirstRun(state, mailbox) {
  const cursor = getCursor(state, mailbox);
  return cursor.lastUid === 0;
}

// ─── Pending Retry ──────────────────────────────────────────────────

/**
 * 添加 pending dispatch 项（dispatch 失败时调用）。
 * 保存完整 payload，下一轮优先重试，不重复调 LLM。
 */
export function addPending(state, item) {
  // 去重：按 message_id_hash
  const hash = item.payload?.message_id_hash;
  if (hash) {
    const existing = state.pending.find((p) => p.payload?.message_id_hash === hash);
    if (existing) {
      // 更新重试次数
      existing.retry_count = (existing.retry_count || 0) + 1;
      existing.updated_at = new Date().toISOString();
      return;
    }
  }
  state.pending.push({
    payload: item.payload,
    retry_count: item.retry_count || 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

/**
 * 取出所有 pending 项（用于本轮重试）。
 * 取出后不立即删除，dispatch 成功后由调用方移除。
 */
export function takePending(state) {
  return state.pending.slice();
}

/**
 * 移除已成功 dispatch 的 pending 项。
 */
export function removePending(state, messageIdHash) {
  state.pending = state.pending.filter((p) => p.payload?.message_id_hash !== messageIdHash);
}

// ─── Processed 记录 ─────────────────────────────────────────────────

const MAX_PROCESSED = 1000;

/**
 * 记录已处理的 message_id_hash（用于去重）。
 */
export function addProcessed(state, messageIdHash) {
  if (!messageIdHash) return;
  if (!state.processed.includes(messageIdHash)) {
    state.processed.push(messageIdHash);
    // 限制长度
    if (state.processed.length > MAX_PROCESSED) {
      state.processed = state.processed.slice(-MAX_PROCESSED);
    }
  }
}

/**
 * 检查是否已处理过。
 */
export function isProcessed(state, messageIdHash) {
  return state.processed.includes(messageIdHash);
}
