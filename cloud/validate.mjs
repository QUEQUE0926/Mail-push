/**
 * validate.mjs — Payload Schema 校验 + 云端去重
 *
 * 与本地 mail-watcher 共享 repository_dispatch payload 协议。
 * 云端二次校验，防止非法或被篡改的 payload 进入 Push 流程。
 */

// ── 邮件类型枚举（13 种，必须与本地一致）──────────────────────────
export const MAIL_TYPES = Object.freeze([
  'review_invitation',
  'review_application_notice',
  'review_application_approved',
  'review_code_received',
  'deadline_notice',
  'embargo_notice',
  'nda_notice',
  'followup_request',
  'publisher_reply',
  'press_release',
  'newsletter',
  'irrelevant',
  'unknown',
]);

// ── 优先级枚举 ───────────────────────────────────────────────────
export const PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3']);

// ── 禁止字段（敏感信息绝不能出现在 payload 中）────────────────────
const FORBIDDEN_FIELDS = Object.freeze([
  'body',
  'fullText',
  'full_text',
  'html',
  'htmlBody',
  'html_body',
  'key',
  'code',
  'authToken',
  'auth_token',
  'password',
  'passwd',
  'cookie',
  'cookies',
  'token',
  'secret',
  'attachment',
  'attachments',
]);

/**
 * 校验 payload 是否符合协议。
 * @param {object} payload - 待校验对象
 * @returns {{valid:boolean, errors:string[]}}
 */
export function validatePayload(payload) {
  const errors = [];

  // 必须是对象
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { valid: false, errors: ['payload 必须是对象'] };
  }

  // 禁止字段检测（先检查，避免敏感信息进入后续流程）
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      errors.push(`禁止字段: ${field}（敏感信息不得出现在 payload 中）`);
    }
  }

  // 注意：payload_version 和 source 不再校验
  // 因为 GitHub client_payload 限制最多 10 个属性，这两个字段已从 buildPayload 移除
  // source 始终是 "qq-mail"，version 硬编码为 1

  // priority 必须是 P0/P1/P2/P3
  if (!PRIORITIES.includes(payload.priority)) {
    errors.push(`priority 必须是 P0/P1/P2/P3 之一，当前: ${payload.priority}`);
  }

  // mail_type 必须是 13 种固定枚举之一
  if (!MAIL_TYPES.includes(payload.mail_type)) {
    errors.push(
      `mail_type 必须是合法枚举之一，当前: ${payload.mail_type}`
    );
  }

  // title 非空字符串
  if (
    typeof payload.title !== 'string' ||
    payload.title.trim().length === 0
  ) {
    errors.push('title 必须是非空字符串');
  }

  // message_id_hash 非空
  if (
    typeof payload.message_id_hash !== 'string' ||
    payload.message_id_hash.trim().length === 0
  ) {
    errors.push('message_id_hash 必须是非空字符串');
  }

  // received_at 是合法 ISO8601
  if (typeof payload.received_at !== 'string') {
    errors.push('received_at 必须是字符串');
  } else {
    const date = new Date(payload.received_at);
    if (Number.isNaN(date.getTime())) {
      errors.push(`received_at 不是合法 ISO8601: ${payload.received_at}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 云端去重：message_id_hash + mail_type 组合判断。
 * @param {object} payload
 * @param {{recent_pushes:Array<{id:string,type:string,pushed_at:string}>}} pushState
 * @returns {boolean} true = 重复
 */
export function isDuplicate(payload, pushState) {
  if (!pushState || !Array.isArray(pushState.recent_pushes)) {
    return false;
  }
  return pushState.recent_pushes.some(
    (entry) =>
      entry.id === payload.message_id_hash &&
      entry.type === payload.mail_type
  );
}

/**
 * 记录已 push，保留最近 100 条（FIFO）。
 * @param {object} payload
 * @param {{recent_pushes:Array}} pushState
 * @returns {{recent_pushes:Array}} 更新后的 state
 */
export function addToPushState(payload, pushState) {
  const state = pushState && Array.isArray(pushState.recent_pushes)
    ? pushState
    : { recent_pushes: [] };

  const entry = {
    id: payload.message_id_hash,
    type: payload.mail_type,
    pushed_at: new Date().toISOString(),
  };

  state.recent_pushes.push(entry);

  // 保留最近 100 条
  if (state.recent_pushes.length > 100) {
    state.recent_pushes = state.recent_pushes.slice(-100);
  }

  return state;
}
