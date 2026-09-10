/**
 * deadlines.mjs — 待回链/截止时间管理
 *
 * 功能：
 *   - 维护待回链列表（state/deadlines.json）
 *   - 检查即将到期的回链（前3天、当天、已过期）
 *   - 发送截止提醒推送
 *   - 标记已通知，避免重复推送
 *
 * 硬约束：
 *   - 每个截止项最多通知3次（前3天、前1天、当天）
 *   - 通知后标记，避免重复推送
 *   - 过期7天后自动清理
 */

import fs from 'node:fs';
import path from 'node:path';

// ─── 常量 ────────────────────────────────────────────────────────────

/** 提前多少天开始提醒 */
const REMIND_DAYS_BEFORE = 3;

/** 每个截止项最多通知次数 */
const MAX_NOTIFICATIONS = 3;

/** 过期多少天后自动清理 */
const EXPIRE_CLEANUP_DAYS = 7;

// ─── 状态管理 ────────────────────────────────────────────────────────

/**
 * 加载截止时间状态。
 * @param {string} stateFile - state/deadlines.json 的路径
 * @returns {object} 状态对象
 */
export function loadDeadlines(stateFile) {
  try {
    if (fs.existsSync(stateFile)) {
      const content = fs.readFileSync(stateFile, 'utf8');
      const data = JSON.parse(content);
      return {
        items: Array.isArray(data.items) ? data.items : [],
        last_check: data.last_check || null,
      };
    }
  } catch (_) {}
  return { items: [], last_check: null };
}

/**
 * 保存截止时间状态。
 * @param {object} state - 状态对象
 * @param {string} stateFile - state/deadlines.json 的路径
 */
export function saveDeadlines(state, stateFile) {
  try {
    const dir = path.dirname(stateFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
  } catch (_) {}
}

// ─── 添加截止项 ──────────────────────────────────────────────────────

/**
 * 添加一个待回链/截止项。
 * 如果已存在相同 message_id_hash 的项，则更新。
 *
 * @param {object} state - 状态对象
 * @param {object} item - 截止项
 * @param {string} item.game - 游戏名
 * @param {string} item.company - 厂商
 * @param {string} item.deadline_type - 'linkback' | 'application' | 'general'
 * @param {string} item.deadline_date - 截止日期 ISO 字符串
 * @param {string} item.message_id_hash - 关联邮件的 hash
 * @param {string[]} item.platform - 平台列表
 */
export function addDeadline(state, item) {
  if (!item || !item.deadline_date || !item.message_id_hash) return;

  // 检查是否已存在
  const existingIdx = state.items.findIndex(
    (i) => i.message_id_hash === item.message_id_hash && i.deadline_type === item.deadline_type
  );

  const deadlineItem = {
    game: item.game || '',
    company: item.company || '',
    deadline_type: item.deadline_type || 'general',
    deadline_date: item.deadline_date,
    message_id_hash: item.message_id_hash,
    platform: Array.isArray(item.platform) ? item.platform : [],
    notification_count: 0,
    last_notified: null,
    created_at: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    // 保留 notification_count
    deadlineItem.notification_count = state.items[existingIdx].notification_count || 0;
    deadlineItem.last_notified = state.items[existingIdx].last_notified || null;
    state.items[existingIdx] = deadlineItem;
  } else {
    state.items.push(deadlineItem);
  }
}

/**
 * 从分类结果中提取截止项并添加到状态。
 * @param {object} state - 状态对象
 * @param {object} classification - classify() 返回的分类结果
 * @param {string} messageIdHash - 邮件 message_id_hash
 */
export function addDeadlinesFromClassification(state, classification, messageIdHash) {
  if (!classification || !classification.deadlines) return;

  const deadlines = classification.deadlines;
  const base = {
    game: classification.game || '',
    company: classification.company || '',
    message_id_hash: messageIdHash,
    platform: classification.platform || [],
  };

  if (deadlines.linkback_deadline) {
    const d = new Date(deadlines.linkback_deadline);
    if (!isNaN(d.getTime())) {
      addDeadline(state, {
        ...base,
        deadline_type: 'linkback',
        deadline_date: d.toISOString(),
      });
    }
  }

  if (deadlines.application_deadline) {
    const d = new Date(deadlines.application_deadline);
    if (!isNaN(d.getTime())) {
      addDeadline(state, {
        ...base,
        deadline_type: 'application',
        deadline_date: d.toISOString(),
      });
    }
  }
}

// ─── 检查到期项 ──────────────────────────────────────────────────────

/**
 * 计算两个日期之间的天数差（date2 - date1）。
 * @param {Date} date1
 * @param {Date} date2
 * @returns {number} 天数差
 */
function daysBetween(date1, date2) {
  const oneDay = 24 * 60 * 60 * 1000;
  const d1 = new Date(date1.getFullYear(), date1.getMonth(), date1.getDate());
  const d2 = new Date(date2.getFullYear(), date2.getMonth(), date2.getDate());
  return Math.round((d2 - d1) / oneDay);
}

/**
 * 检查是否需要发送提醒。
 * @param {object} item - 截止项
 * @param {Date} now - 当前时间
 * @returns {boolean} 是否需要提醒
 */
function shouldNotify(item, now) {
  if (item.notification_count >= MAX_NOTIFICATIONS) return false;

  const deadline = new Date(item.deadline_date);
  if (isNaN(deadline.getTime())) return false;

  const daysUntil = daysBetween(now, deadline);

  // 前3天、前1天、当天/已过期 各通知一次
  if (daysUntil <= REMIND_DAYS_BEFORE && daysUntil > 1 && item.notification_count === 0) {
    return true; // 前3天通知
  }
  if (daysUntil <= 1 && daysUntil > 0 && item.notification_count <= 1) {
    return true; // 前1天通知
  }
  if (daysUntil <= 0 && item.notification_count <= 2) {
    return true; // 当天/已过期通知
  }

  return false;
}

/**
 * 检查即将到期的截止项，返回需要提醒的列表。
 * 同时清理过期超过7天的项。
 *
 * @param {object} state - 状态对象
 * @param {Date} [now] - 当前时间（用于测试）
 * @returns {object[]} 需要提醒的截止项列表
 */
export function checkDueDeadlines(state, now = new Date()) {
  const dueItems = [];
  const keepItems = [];

  for (const item of state.items) {
    const deadline = new Date(item.deadline_date);
    if (isNaN(deadline.getTime())) continue;

    const daysUntil = daysBetween(now, deadline);

    // 清理过期超过7天的项
    if (daysUntil < -EXPIRE_CLEANUP_DAYS) {
      continue;
    }

    // 检查是否需要提醒
    if (shouldNotify(item, now)) {
      dueItems.push({
        ...item,
        days_until: daysUntil,
      });
    }

    keepItems.push(item);
  }

  state.items = keepItems;
  state.last_check = now.toISOString();

  return dueItems;
}

/**
 * 标记截止项已通知。
 * @param {object} state - 状态对象
 * @param {string} messageIdHash - 邮件 hash
 * @param {string} deadlineType - 截止类型
 */
export function markNotified(state, messageIdHash, deadlineType) {
  const item = state.items.find(
    (i) => i.message_id_hash === messageIdHash && i.deadline_type === deadlineType
  );
  if (item) {
    item.notification_count = (item.notification_count || 0) + 1;
    item.last_notified = new Date().toISOString();
  }
}

// ─── 构建提醒 Payload ────────────────────────────────────────────────

/**
 * 构建截止提醒的 dispatch payload。
 * @param {object} item - 截止项
 * @returns {object} payload
 */
export function buildDeadlineReminderPayload(item) {
  const deadline = new Date(item.deadline_date);
  const pad = (n) => String(n).padStart(2, '0');
  const deadlineStr = `${deadline.getFullYear()}-${pad(deadline.getMonth() + 1)}-${pad(deadline.getDate())}`;

  const typeLabels = {
    linkback: '回链截止',
    application: '申请截止',
    general: '截止',
  };
  const typeLabel = typeLabels[item.deadline_type] || '截止';

  let urgency = '';
  if (item.days_until < 0) {
    urgency = `已过期 ${Math.abs(item.days_until)} 天`;
  } else if (item.days_until === 0) {
    urgency = '今天截止';
  } else if (item.days_until === 1) {
    urgency = '明天截止';
  } else {
    urgency = `还有 ${item.days_until} 天`;
  }

  return {
    priority: 'P1',
    mail_type: 'deadline_reminder',
    title: `${typeLabel}提醒`,
    game: item.game || '未知游戏',
    platform: item.platform || [],
    company: item.company || '',
    summary: `${typeLabel}：${deadlineStr}（${urgency}）。`,
    action: item.deadline_type === 'linkback' ? '尽快发布评测并回链。' : '尽快处理，避免错过截止时间。',
    received_at: new Date().toISOString(),
    message_id_hash: `deadline-${item.message_id_hash}-${item.deadline_type}-${Date.now()}`,
  };
}
