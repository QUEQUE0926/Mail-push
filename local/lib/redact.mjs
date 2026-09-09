/**
 * redact.mjs — Key/Code 脱敏 + Payload 构建
 *
 * 硬约束：
 *   - 完整 Key 永远不出本机
 *   - dispatch 之前脱敏
 *   - Push 只说 "Code已到"
 *   - payload 禁止包含：完整正文、完整Key、邮箱授权码、附件、Cookie、Token
 */

import crypto from 'node:crypto';

// ─── Code 正则模式 ──────────────────────────────────────────────────

/**
 * 各平台 Code 格式：
 * - Steam: XXXXX-XXXXX-XXXXX (5-5-5 字母数字)
 * - Nintendo: 16位字母数字（可能有连字符 4-4-4-4）
 * - PS: 12位字母数字（可能 4-4-4）
 * - Xbox: 25位字母数字（5x5）
 * - 通用 activation code: 各种长度
 */

const CODE_PATTERNS = [
  // Steam key: XXXXX-XXXXX-XXXXX
  {
    name: 'Steam',
    regex: /\b[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b/g,
    platform: 'Steam',
  },
  // Nintendo 16位（4-4-4-4）
  {
    name: 'Nintendo',
    regex: /\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/g,
    platform: 'Nintendo Switch',
  },
  // Nintendo 16位纯字母数字
  {
    name: 'Nintendo16',
    regex: /\b[A-HJ-NP-Za-hj-np-z2-9]{16}\b/g,
    platform: 'Nintendo Switch',
  },
  // PS code: 12位（4-4-4）
  {
    name: 'PS',
    regex: /\b[A-HJ-NP-Za-hj-np-z2-9]{4}-[A-HJ-NP-Za-hj-np-z2-9]{4}-[A-HJ-NP-Za-hj-np-z2-9]{4}\b/g,
    platform: 'PS5',
  },
  // PS 12位纯字母数字
  {
    name: 'PS12',
    regex: /\b[A-HJ-NP-Za-hj-np-z2-9]{12}\b/g,
    platform: 'PS5',
  },
  // Xbox 25位（5x5）
  {
    name: 'Xbox',
    regex: /\b[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b/g,
    platform: 'Xbox',
  },
  // 通用 activation code: 较长字母数字串（>=12位），含连字符
  {
    name: 'Generic',
    regex: /\b[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){2,5}\b/g,
    platform: 'Unknown',
  },
];

// 敏感信息模式（绝不出现在 payload 中）
const SENSITIVE_PATTERNS = [
  /[A-Za-z0-9]{16,}/g, // 长串字母数字（可能是 token/key）
  /(?:password|passwd|pwd|secret|token|api[_-]?key|auth[_-]?token|cookie|session)\s*[:=]\s*\S+/gi,
  /(?:授权码|验证码|密码)\s*[:：]\s*\S+/g,
];

// ─── 脱敏函数 ───────────────────────────────────────────────────────

/**
 * 对文本中的 Key/Code 进行脱敏。
 * 返回 {redactedText, hasCode, codePlatforms}
 */
export function redactKeys(text) {
  if (!text) return { redactedText: '', hasCode: false, codePlatforms: [] };

  let redacted = text;
  const platforms = new Set();
  let hasCode = false;

  for (const pattern of CODE_PATTERNS) {
    const matches = redacted.match(pattern.regex);
    if (matches && matches.length > 0) {
      hasCode = true;
      platforms.add(pattern.platform);
      // 替换为 [REDACTED_CODE]
      redacted = redacted.replace(pattern.regex, '[REDACTED_CODE]');
    }
  }

  // 额外：移除明显的长串 token（保守策略，只在明确上下文时）
  // 不做过度替换，避免破坏正常文本

  return {
    redactedText: redacted,
    hasCode,
    codePlatforms: Array.from(platforms),
  };
}

/**
 * 检查文本是否包含 Code（不修改文本）。
 */
export function detectCodes(text) {
  if (!text) return { hasCode: false, codePlatforms: [] };
  const platforms = new Set();
  let hasCode = false;
  for (const pattern of CODE_PATTERNS) {
    if (pattern.regex.test(text)) {
      hasCode = true;
      platforms.add(pattern.platform);
    }
    pattern.regex.lastIndex = 0; // 重置 global regex
  }
  return { hasCode, codePlatforms: Array.from(platforms) };
}

// ─── Message-ID Hash ────────────────────────────────────────────────

/**
 * 计算 message_id_hash = sha256(Message-ID)
 * 返回 "sha256:<hex>"
 */
export function hashMessageId(messageId) {
  const id = (messageId || '').trim();
  const hash = crypto.createHash('sha256').update(id).digest('hex');
  return 'sha256:' + hash;
}

// ─── Title 映射 ─────────────────────────────────────────────────────

const TYPE_TITLES = {
  'review_invitation': '评测邀请',
  'review_application_notice': '评测申请通知',
  'review_application_approved': '评测申请通过',
  'review_code_received': '评测码已到',
  'deadline_notice': '截止时间提醒',
  'embargo_notice': 'Embargo 通知',
  'nda_notice': 'NDA 通知',
  'followup_request': '厂商跟进请求',
  'publisher_reply': '厂商回复',
  'press_release': '新闻稿',
  'newsletter': '通讯邮件',
  'irrelevant': '不相关邮件',
  'unknown': '未知邮件',
};

// ─── Payload 构建 ───────────────────────────────────────────────────

/**
 * 构建脱敏后的 dispatch payload。
 *
 * @param {object} classification — classify() 返回的分类结果
 * @param {object} mail — parseEmail() 返回的解析结果
 * @param {object} [options] — {historicalPush:boolean}
 * @returns {object} 可直接 dispatch 的 payload
 *
 * 严格禁止包含：完整正文、完整Key、邮箱授权码、附件、Cookie、Token
 */
export function buildPayload(classification, mail, options = {}) {
  const type = classification.type || 'unknown';
  const priority = classification.priority || 'P3';

  // 检测正文是否含 Code（用于 summary 和 action）
  const codeDetection = detectCodes(mail.textBody || '');

  // summary：如果含 code，不暴露具体内容
  let summary = classification.summary || '';
  if (codeDetection.hasCode && type === 'review_code_received') {
    summary = '厂商已发送评测 Code。';
  }

  // action：如果含 code，引导用户去原邮件查看
  let action = classification.action || '';
  if (codeDetection.hasCode) {
    action = '打开原邮件查看 Code。';
  }

  // received_at：ISO 格式
  // 当 mail.date 为 null 或无效 Date 时，回退使用当前时间，
  // 确保 payload 始终有合法时间戳，避免云端 validatePayload 拒绝。
  let receivedAt;
  if (mail.date && mail.date instanceof Date && !isNaN(mail.date.getTime())) {
    receivedAt = mail.date.toISOString();
  } else {
    receivedAt = new Date().toISOString();
  }

  // platform：合并分类结果和 code 检测
  const platforms = new Set();
  if (Array.isArray(classification.platform)) {
    for (const p of classification.platform) platforms.add(p);
  }
  for (const p of codeDetection.codePlatforms) platforms.add(p);

  // 注意：GitHub client_payload 最多 10 个属性，不要超过
  // event_type/source/payload_version 不需要放在 client_payload 里
  const payload = {
    priority,
    mail_type: type,
    title: TYPE_TITLES[type] || '邮件通知',
    game: classification.game || '',
    platform: Array.from(platforms),
    company: classification.company || '',
    summary,
    action,
    received_at: receivedAt,
    message_id_hash: hashMessageId(mail.messageId),
  };

  // 如果是历史邮件，标记
  if (options.historicalPush) {
    payload.historical = true;
  }

  // 安全检查：确保 payload 中不含敏感信息
  _sanitizePayload(payload);

  return payload;
}

/**
 * 安全检查：递归扫描 payload 中的字符串，移除敏感信息。
 * 这是最后一道防线。
 */
function _sanitizePayload(obj) {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      // 检查是否包含 code 模式
      const { redactedText } = redactKeys(val);
      if (redactedText !== val) {
        obj[key] = redactedText;
      }
      // 检查敏感字段名
      const lowerKey = key.toLowerCase();
      if (['body', 'content', 'text', 'html', 'raw', 'password', 'token', 'secret', 'cookie', 'authorization'].includes(lowerKey)) {
        obj[key] = '[REDACTED]';
      }
    } else if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        if (typeof val[i] === 'string') {
          const { redactedText } = redactKeys(val[i]);
          val[i] = redactedText;
        } else if (typeof val[i] === 'object' && val[i] !== null) {
          _sanitizePayload(val[i]);
        }
      }
    } else if (typeof val === 'object' && val !== null) {
      _sanitizePayload(val);
    }
  }
}
