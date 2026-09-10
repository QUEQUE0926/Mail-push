/**
 * classifier.mjs — 规则优先分类器 + LLM 可插拔接口
 *
 * 硬约束：
 *   - 规则能确定的不调 LLM
 *   - LLM 只处理不确定的，输出固定 JSON Schema
 *   - LLM 未配置 API Key 时自动降级为纯规则分类
 *   - 自己发的邮件 → irrelevant
 */

// ─── 邮件类型固定枚举（13种） ──────────────────────────────────────

export const MAIL_TYPES = [
  'review_invitation',        // 评测邀请
  'review_application_notice', // 评测申请通知
  'review_application_approved', // 评测申请通过
  'review_code_received',      // 评测码已到
  'deadline_notice',           // 截止时间通知
  'deadline_reminder',         // 截止提醒（系统自动发送）
  'embargo_notice',            // 解禁/embargo 通知
  'nda_notice',                // NDA 通知
  'followup_request',          // 跟进请求
  'publisher_reply',           // 厂商回复
  'press_release',             // 新闻稿
  'newsletter',                // 通讯/促销
  'irrelevant',                // 不相关
  'unknown',                   // 未知
];

// ─── Priority 映射 ─────────────────────────────────────────────────

export const PRIORITY_MAP = {
  'deadline_notice': 'P0',
  'deadline_reminder': 'P1',
  'review_code_received': 'P1',
  'embargo_notice': 'P1',
  'review_invitation': 'P2',
  'review_application_notice': 'P2',
  'review_application_approved': 'P2',
  'nda_notice': 'P2',
  'followup_request': 'P2',
  'publisher_reply': 'P2',
  'press_release': 'P3',
  'newsletter': 'P3',
  'irrelevant': 'P3',
  'unknown': 'P3',
};

/** P0/P1/P2 需要 Push，P3 不需要 */
export function shouldPushByPriority(priority) {
  return priority === 'P0' || priority === 'P1' || priority === 'P2';
}

// ─── 关键词定义 ─────────────────────────────────────────────────────

// Subject 关键词
const SUBJECT_KEYWORDS = [
  '评测', '評測', 'レビュー', 'review', 'code', 'key',
  '申请', '申請', '公開片', '鉴赏家', '鑑賞家', 'UP主',
  'steam', 'switch', 'NS2', 'PS5', 'Xbox',
  'embargo', 'NDA', 'deadline', '上市', 'release',
];

// 正文关键词
const BODY_KEYWORDS = [
  '评测码', '評測碼', 'steam key', 'review code',
  'Nintendo Switch', 'PS5', 'Xbox',
  '申请截止', '申請截止', '回复', '回覆',
  '解禁', 'embargo', 'NDA', '上市', '発売', 'release',
];

// Code 相关关键词（触发 review_code_received）
// 注意：这些关键词应该匹配"发送Code"的语境，而不是"申请Code"的语境
const CODE_KEYWORDS = [
  'steam key', 'switch code', 'ps code', 'xbox code',
  'review code', 'activation code', '评测码', '評測碼',
  'シリアルコード', 'activation key', 'download code',
  'code這邊提供', 'code这边提供', 'code請參考', 'code请参考',
  '提供steam key', '提供switch code', '提供ps code', '提供xbox code',
];

// 评测邀请/申请通知关键词（触发 review_invitation）
const INVITATION_KEYWORDS = [
  '公關片申請', '公关片申请', '公開片申請', '公开片申请',
  '若有興趣進行評測', '若有兴趣进行评测',
  '若有興趣評測', '若有兴趣评测',
  '開放申請', '开放申请', '開放公關片', '开放公关片',
  '申請code下載序號', '申请code下载序号',
  '透過郵件申請code', '通过邮件申请code',
];

// 跟进/催回链关键词（触发 followup_request）
const FOLLOWUP_KEYWORDS = [
  '還沒收到您的反饋連結', '还没收到您的反馈链接',
  '還沒收到反饋', '还没收到反馈',
  '請在期限內反饋', '请在期限内反馈',
  '請在期限內回覆', '请在期限内回复',
  '不曉得是我這邊漏信', '不晓得是我这边漏信',
  '再麻煩確認', '再麻烦确认',
  '為了不影響之後申請', '为了不影响之后申请',
];

// 申请截止/停止申请关键词
const APPLICATION_CLOSED_KEYWORDS = [
  '已經停止申請', '已经停止申请',
  '截止日是昨晚', '截止日是昨天',
  '停止申請了', '停止申请了',
  '申請已截止', '申请已截止',
];

// Newsletter / 促销关键词
const NEWSLETTER_KEYWORDS = [
  'newsletter', 'unsubscribe', '退订', '退訂', '订阅', '訂閱',
  '促销', '促銷', 'discount', 'sale', 'off now', '限时', '限時',
  '新闻稿', '新聞稿', 'press release',
];

// ─── 工具函数 ───────────────────────────────────────────────────────

function lower(str) {
  return (str || '').toLowerCase();
}

function hasKeyword(text, keywords) {
  const t = lower(text);
  for (const kw of keywords) {
    if (t.includes(lower(kw))) return true;
  }
  return false;
}

/** 提取游戏名（简单启发式：Subject 中去掉关键词后的内容） */
function extractGame(subject) {
  if (!subject) return '';
  let game = subject;
  // 去掉常见前缀
  game = game.replace(/^(re|fwd?|fw):\s*/i, '');
  // 去掉关键词
  for (const kw of [...SUBJECT_KEYWORDS, '申请', '申請', '邀请', '邀請', '通知', '通过', '通過']) {
    const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    game = game.replace(re, '');
  }
  game = game.replace(/[【】\[\]（）()「」『』]/g, ' ');
  game = game.replace(/\s+/g, ' ').trim();
  return game || '';
}

/** 提取平台 */
function extractPlatform(subject, body) {
  const text = lower(subject + ' ' + body);
  const platforms = [];
  if (text.includes('nintendo switch') || text.includes('switch') || text.includes('ns2')) {
    platforms.push('Nintendo Switch');
  }
  if (text.includes('ps5') || text.includes('playstation 5') || text.includes('playstation5')) {
    platforms.push('PS5');
  }
  if (text.includes('xbox')) {
    platforms.push('Xbox');
  }
  if (text.includes('steam') || text.includes('pc')) {
    platforms.push('Steam/PC');
  }
  return platforms;
}

/** 提取公司（从发件人域名） */
function extractCompany(from) {
  if (!from || !from.domain) return '';
  // 简单映射
  const domain = from.domain.toLowerCase();
  const companyMap = {
    'koeitecmo.com': 'KOEI TECMO',
    'koeitecmo.co.jp': 'KOEI TECMO',
    'nintendo.com': 'Nintendo',
    'nintendo.co.jp': 'Nintendo',
    'ubisoft.com': 'Ubisoft',
    'sega.com': 'SEGA',
    'capcom.com': 'CAPCOM',
    'bandainamco.com': 'Bandai Namco',
    'square-enix.com': 'Square Enix',
    'sony.com': 'Sony Interactive',
    'microsoft.com': 'Microsoft',
  };
  for (const [d, name] of Object.entries(companyMap)) {
    if (domain === d || domain.endsWith('.' + d)) return name;
  }
  // 兜底：用域名
  return domain || '';
}

/** 检测截止时间是否 < 24h */
function detectUrgentDeadline(body) {
  if (!body) return false;
  const text = lower(body);
  // 关键词：24小时内、今天截止、明天截止、即刻、马上
  const urgentPatterns = [
    /24\s*(小时|時間|hrs?|hours)/i,
    /(今天|今日|today).{0,10}(截止|締切|deadline)/i,
    /(截止|締切|deadline).{0,10}(今天|今日|today)/i,
    /(明天|明日|tomorrow).{0,10}(截止|締切|deadline)/i,
    /(截止|締切|deadline).{0,10}(明天|明日|tomorrow)/i,
    /(即刻|立即|马上|立刻|asap)/i,
    /(申请|申請).{0,20}(即将|即將|即将截止|即將截止)/i,
  ];
  for (const re of urgentPatterns) {
    if (re.test(text)) return true;
  }
  return false;
}

// ─── 截止时间提取 ────────────────────────────────────────────────────

/**
 * 从文本中提取日期。
 * 支持格式：
 *   - 2026年9月20日 / 2026年09月20日
 *   - 9月20日 / 09月20日（默认当前年）
 *   - 2026/9/20 / 2026-09-20 / 2026.09.20
 *   - September 20, 2026 / Sep 20, 2026
 *   - 20 Sep 2026 / 20 September 2026
 * @returns {Date|null}
 */
function extractDate(text) {
  if (!text) return null;
  const now = new Date();
  const year = now.getFullYear();

  // 2026年9月20日
  let m = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));

  // 9月20日（默认当前年）
  m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) {
    const d = new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
    // 如果日期已经过去，可能是明年
    if (d < now && d.getMonth() < now.getMonth() - 1) d.setFullYear(year + 1);
    return d;
  }

  // 6/4 或 6/4(四) 或 8/31(一) 月/日格式（默认当前年）
  // 注意：只匹配 1-12 月和 1-31 日，避免匹配到其他数字
  m = text.match(/(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)/);
  if (m) {
    const month = parseInt(m[1]);
    const day = parseInt(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(year, month - 1, day);
      // 如果日期已经过去超过1个月，可能是明年
      if (d < now && (now.getMonth() - d.getMonth() > 1 || (now.getMonth() < d.getMonth()))) {
        d.setFullYear(year + 1);
      }
      return d;
    }
  }

  // 2026/9/20 或 2026-09-20 或 2026.09.20
  m = text.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));

  // September 20, 2026
  const months = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  m = text.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2}),?\s*(\d{4})?/i);
  if (m) {
    const mon = months[m[1].toLowerCase().slice(0,3)];
    const y = m[3] ? parseInt(m[3]) : year;
    return new Date(y, mon - 1, parseInt(m[2]));
  }

  // 20 Sep 2026
  m = text.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})?/i);
  if (m) {
    const mon = months[m[2].toLowerCase().slice(0,3)];
    const y = m[3] ? parseInt(m[3]) : year;
    return new Date(y, mon - 1, parseInt(m[1]));
  }

  return null;
}

/**
 * 从邮件正文中提取各类截止时间。
 * @param {string} subject
 * @param {string} body
 * @param {Date} [referenceDate] - 邮件发送日期，用于计算相对时间（如"1個月內"）
 * @returns {{application_deadline: Date|null, linkback_deadline: Date|null, general_deadline: Date|null}}
 */
export function extractDeadlines(subject, body, referenceDate = null) {
  const text = (subject || '') + '\n' + (body || '');
  const refDate = referenceDate || new Date();
  const result = {
    application_deadline: null,
    linkback_deadline: null,
    general_deadline: null,
  };

  // 相对时间计算：如"1個月內"、"1个月内"
  function calculateRelativeDeadline(relativeText) {
    // 匹配 "X個月內" / "X个月内" / "X周內" / "X天內"
    const monthMatch = relativeText.match(/(\d+)\s*(個月|个月)\s*(內|内)/);
    if (monthMatch) {
      const months = parseInt(monthMatch[1]);
      const d = new Date(refDate);
      d.setMonth(d.getMonth() + months);
      return d;
    }
    const weekMatch = relativeText.match(/(\d+)\s*(週|周)\s*(內|内)/);
    if (weekMatch) {
      const weeks = parseInt(weekMatch[1]);
      const d = new Date(refDate);
      d.setDate(d.getDate() + weeks * 7);
      return d;
    }
    const dayMatch = relativeText.match(/(\d+)\s*(日|天)\s*(內|内)/);
    if (dayMatch) {
      const days = parseInt(dayMatch[1]);
      const d = new Date(refDate);
      d.setDate(d.getDate() + days);
      return d;
    }
    return null;
  }

  // 回链截止关键词（优先级最高，因为最具体）
  const linkbackPatterns = [
    /(回链|回鏈|link\s*back|linkback).{0,30}(截止|締切|deadline|时间|時間|date|期限)/i,
    /(截止|締切|deadline|时间|時間|date|期限).{0,30}(回链|回鏈|link\s*back|linkback)/i,
    /(请在|請在|please).{0,30}(回链|回鏈|link\s*back)/i,
    /(回链|回鏈|link\s*back).{0,30}(前|之前|before|by)/i,
  ];

  // 申请截止关键词
  // 注意：真实邮件里常见格式是"並於6/4(四)下班前回覆"，没有"申请截止"关键词
  // 所以需要匹配"並於/请在 + 日期 + 前回覆/前回复"这种模式
  const applicationPatterns = [
    /(申请|申請|application).{0,30}(截止|締切|deadline|时间|時間|date|期限)/i,
    /(截止|締切|deadline|时间|時間|date|期限).{0,30}(申请|申請|application)/i,
    /(请在|請在|please).{0,30}(申请|申請|apply|application)/i,
    // 新增：並於/请在 + 日期 + 前回覆/前回复（评测邀请邮件中的申请截止）
    /(並於|并于|请於|请于|請於|請于|please).{0,20}(\d{1,2}[\/\-]\d{1,2}).{0,20}(前回覆|前回复|前回覆|前回復|前申請|前申请)/i,
    /(\d{1,2}[\/\-]\d{1,2}).{0,10}(前回覆|前回复|前回覆|前回復)/i,
  ];

  // 通用截止关键词
  const generalPatterns = [
    /(截止|締切|deadline|期限|due).{0,50}/i,
    /.{0,20}(截止|締切|deadline|期限|due)/i,
  ];

  // 提取回链截止
  for (const re of linkbackPatterns) {
    const match = text.match(re);
    if (match) {
      const context = match[0];
      const date = extractDate(context);
      if (date) {
        result.linkback_deadline = date;
        break;
      }
      // 尝试相对时间
      const relativeDate = calculateRelativeDeadline(context);
      if (relativeDate) {
        result.linkback_deadline = relativeDate;
        break;
      }
    }
  }

  // 如果回链模式没找到日期，在更大范围内搜索
  if (!result.linkback_deadline) {
    for (const re of linkbackPatterns) {
      const match = text.match(re);
      if (match) {
        const idx = match.index || 0;
        const context = text.slice(Math.max(0, idx - 50), idx + 100);
        const date = extractDate(context);
        if (date) {
          result.linkback_deadline = date;
          break;
        }
        // 尝试相对时间
        const relativeDate = calculateRelativeDeadline(context);
        if (relativeDate) {
          result.linkback_deadline = relativeDate;
          break;
        }
      }
    }
  }

  // 专门检测"請於X個月內回覆報導評測連結"这种常见模式
  if (!result.linkback_deadline) {
    const linkbackRelativePatterns = [
      /(請|请).{0,10}(\d+)\s*(個月|个月)\s*(內|内).{0,20}(回覆|回复|回链|回鏈|反饋|反馈)/,
      /(\d+)\s*(個月|个月)\s*(內|内).{0,20}(回覆|回复|回链|回鏈|反饋|反馈)/,
    ];
    for (const re of linkbackRelativePatterns) {
      const match = text.match(re);
      if (match) {
        const relativeDate = calculateRelativeDeadline(match[0]);
        if (relativeDate) {
          result.linkback_deadline = relativeDate;
          break;
        }
      }
    }
  }

  // 提取申请截止
  for (const re of applicationPatterns) {
    const match = text.match(re);
    if (match) {
      const idx = match.index || 0;
      const context = text.slice(Math.max(0, idx - 20), idx + 80);
      // 先尝试从匹配的文本中提取日期
      let date = extractDate(match[0]);
      // 如果没提取到，再从上下文中提取
      if (!date) {
        date = extractDate(context);
      }
      if (date) {
        result.application_deadline = date;
        break;
      }
    }
  }

  // 提取通用截止（仅当没有更具体的截止时间时）
  if (!result.application_deadline && !result.linkback_deadline) {
    for (const re of generalPatterns) {
      const match = text.match(re);
      if (match) {
        const idx = match.index || 0;
        const context = text.slice(Math.max(0, idx - 30), idx + 80);
        const date = extractDate(context);
        if (date) {
          result.general_deadline = date;
          break;
        }
      }
    }
  }

  return result;
}

/** 格式化日期为 YYYY-MM-DD */
function formatDate(d) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ─── 规则分类器 ─────────────────────────────────────────────────────

/**
 * 基于规则分类。
 * @param {{from:{email,domain,name}, subject:string, date:Date, messageId:string}} header
 * @param {{textBody:string, htmlBody:string}} body
 * @param {{selfEmail?:string}} [config]
 * @returns {object|null} 分类结果或 null（不确定，需 LLM）
 */
export function classifyByRules(header, body, config = {}) {
  const subject = header.subject || '';
  const textBody = body.textBody || '';
  const combined = subject + '\n' + textBody;
  const selfEmail = normalizeEmail(config.selfEmail || '');

  // 提取截止时间（所有分类共用）
  const deadlines = extractDeadlines(subject, textBody);

  // 规则0：自己发的邮件 → irrelevant
  if (selfEmail && header.from && normalizeEmail(header.from.email) === selfEmail) {
    return _buildResult('irrelevant', {
      confidence: 0.95,
      summary: '自己发送的邮件。',
      action: '',
      game: extractGame(subject),
    });
  }

  // 规则1：Newsletter / 促销 / 新闻稿 → P3 不 Push
  if (hasKeyword(combined, NEWSLETTER_KEYWORDS)) {
    // 但如果同时有 code 关键词，优先 code
    if (!hasKeyword(combined, CODE_KEYWORDS)) {
      const isPressRelease = lower(combined).includes('press release') ||
        lower(combined).includes('新闻稿') || lower(combined).includes('新聞稿');
      const type = isPressRelease ? 'press_release' : 'newsletter';
      return _buildResult(type, {
        confidence: 0.85,
        summary: isPressRelease ? '厂商新闻稿。' : '通讯/促销邮件。',
        action: '',
        game: extractGame(subject),
      });
    }
  }

  // 规则2：跟进/催回链邮件（优先于 Code 检测，因为催回链邮件里可能也有"code"关键词）
  if (hasKeyword(textBody, FOLLOWUP_KEYWORDS)) {
    return _buildResult('followup_request', {
      confidence: 0.9,
      summary: '厂商催回链/跟进，请尽快反馈评测链接。',
      action: '尽快发布评测并回链，或回复厂商说明情况。',
      game: extractGame(subject),
      platform: extractPlatform(subject, textBody),
    });
  }

  // 规则3：申请截止/停止申请通知
  if (hasKeyword(textBody, APPLICATION_CLOSED_KEYWORDS)) {
    return _buildResult('review_application_notice', {
      confidence: 0.85,
      summary: '评测申请已截止/停止申请。',
      action: '下次请尽早申请，关注厂商后续游戏。',
      game: extractGame(subject),
      platform: extractPlatform(subject, textBody),
    });
  }

  // 规则4：正文含 Code 关键词 → review_code_received, P1
  // 注意：只在"发送Code"的语境下触发，排除"申请Code"的语境
  if (hasKeyword(textBody, CODE_KEYWORDS)) {
    // 排除"申请code下载序号"这种邀请语境
    const isInvitationContext = lower(textBody).includes('申請code下載序號') ||
      lower(textBody).includes('申请code下载序号') ||
      lower(textBody).includes('透過郵件申請code') ||
      lower(textBody).includes('通过邮件申请code');
    if (!isInvitationContext) {
      return _buildResult('review_code_received', {
        confidence: 0.9,
        summary: '厂商已发送评测 Code。',
        action: '打开原邮件查看 Code。',
        game: extractGame(subject),
        platform: extractPlatform(subject, textBody),
      });
    }
  }

  // 规则3：截止时间 < 24h → deadline_notice, P0
  if (detectUrgentDeadline(textBody) || hasKeyword(subject, ['deadline', '截止', '締切'])) {
    if (detectUrgentDeadline(textBody)) {
      return _buildResult('deadline_notice', {
        confidence: 0.85,
        priority: 'P0',
        summary: '紧急截止通知（24小时内）。',
        action: '尽快处理，避免错过截止时间。',
        game: extractGame(subject),
        deadline: 'urgent',
      });
    }
  }

  // 规则4：embargo / NDA
  const hasEmbargo = lower(combined).includes('embargo') || lower(combined).includes('解禁');
  const hasNDA = lower(combined).includes('nda') || lower(combined).includes('保密协议');
  if (hasEmbargo) {
    return _buildResult('embargo_notice', {
      confidence: 0.85,
      summary: 'Embargo/解禁时间通知。',
      action: '注意解禁时间，提前准备评测内容。',
      game: extractGame(subject),
    });
  }
  if (hasNDA) {
    return _buildResult('nda_notice', {
      confidence: 0.8,
      summary: 'NDA/保密协议通知。',
      action: '查看并签署保密协议。',
      game: extractGame(subject),
    });
  }

  // 规则5：RE: + 申请/评测 → 厂商回复
  const isReply = /^(re|fwd?):/i.test(subject);
  if (isReply && (lower(subject).includes('申请') || lower(subject).includes('申請') ||
    lower(subject).includes('评测') || lower(subject).includes('評測') ||
    lower(subject).includes('review'))) {
    // 判断是通过还是普通回复
    const approved = lower(combined).includes('通过') || lower(combined).includes('通過') ||
      lower(combined).includes('approved') || lower(combined).includes('accepted');
    if (approved) {
      return _buildResult('review_application_approved', {
        confidence: 0.8,
        summary: '评测申请已通过。',
        action: '等待厂商发送评测码或进一步指示。',
        game: extractGame(subject),
      });
    }
    return _buildResult('publisher_reply', {
      confidence: 0.75,
      summary: '厂商回复了评测相关邮件。',
      action: '查看厂商回复内容。',
      game: extractGame(subject),
    });
  }

  // 规则6：评测邀请（Subject 或正文含 公關片申請/若有興趣進行評測等）
  const invitationKeywords = ['鉴赏家', '鑑賞家', '评测邀请', '評測邀請', 'review invitation', '公開片', '邀请评测', '邀請評測'];
  if (hasKeyword(subject, invitationKeywords) ||
    hasKeyword(textBody, INVITATION_KEYWORDS) ||
    (lower(subject).includes('review') && lower(subject).includes('邀请')) ||
    (lower(subject).includes('review') && lower(subject).includes('invitation'))) {
    return _buildResult('review_invitation', {
      confidence: 0.85,
      summary: '收到评测邀请/公关片申请。',
      action: '评估是否接受评测邀请，在申请截止前回复厂商。',
      game: extractGame(subject),
      platform: extractPlatform(subject, textBody),
    });
  }

  // 规则7：评测申请通知（Subject 含 申请 + 评测/review）
  if ((lower(subject).includes('申请') || lower(subject).includes('申請')) &&
    (lower(subject).includes('评测') || lower(subject).includes('評測') || lower(subject).includes('review'))) {
    return _buildResult('review_application_notice', {
      confidence: 0.75,
      summary: '评测申请相关通知。',
      action: '查看申请状态。',
      game: extractGame(subject),
    });
  }

  // 规则8：跟进请求（正文含 请回复/请确认/follow up）
  if (lower(textBody).includes('follow up') || lower(textBody).includes('follow-up') ||
    lower(textBody).includes('请回复') || lower(textBody).includes('請回覆') ||
    lower(textBody).includes('请确认') || lower(textBody).includes('請確認')) {
    return _buildResult('followup_request', {
      confidence: 0.7,
      summary: '厂商请求跟进/回复。',
      action: '尽快回复厂商。',
      game: extractGame(subject),
    });
  }

  // 规则9：普通截止通知（非紧急）
  if (hasKeyword(subject, ['deadline', '截止', '締切']) || hasKeyword(textBody, ['申请截止', '申請截止'])) {
    return _buildResult('deadline_notice', {
      confidence: 0.7,
      summary: '截止时间通知。',
      action: '注意截止时间，提前完成。',
      game: extractGame(subject),
    });
  }

  // 规则10：Subject 含 code/key 但正文没有明确 code → 可能是 code 通知，交给 LLM
  // 不做确定性判断

  // 规则无法确定 → 返回 null，交给 LLM
  return null;
}

/** 构建分类结果对象 */
function _buildResult(type, overrides = {}) {
  const priority = overrides.priority || PRIORITY_MAP[type] || 'P3';
  return {
    type,
    priority,
    shouldPush: shouldPushByPriority(priority),
    confidence: overrides.confidence || 0.7,
    game: overrides.game || '',
    platform: overrides.platform || [],
    company: overrides.company || '',
    summary: overrides.summary || '',
    action: overrides.action || '',
    deadline: overrides.deadline || null,
    deadlines: overrides.deadlines || { application_deadline: null, linkback_deadline: null, general_deadline: null },
  };
}

// ─── LLM 分类（可插拔） ────────────────────────────────────────────

/**
 * 使用 LLM 分类（可插拔接口）。
 * 未配置 API Key 时返回 {type:'unknown', shouldPush:false}
 *
 * @param {object} header
 * @param {{textBody:string}} body
 * @param {{apiKey?:string, apiUrl?:string, model?:string}} config
 * @returns {Promise<object>}
 */
export async function classifyWithLLM(header, body, config = {}) {
  const apiKey = config.apiKey || process.env.LLM_API_KEY;
  const apiUrl = config.apiUrl || process.env.LLM_API_URL;
  const model = config.model || process.env.LLM_MODEL || 'gpt-4o-mini';

  // 未配置 → 降级
  if (!apiKey || !apiUrl) {
    return {
      type: 'unknown',
      priority: 'P3',
      shouldPush: false,
      confidence: 0,
      game: '',
      platform: [],
      company: '',
      summary: '',
      action: '',
      deadline: null,
      llm_used: false,
    };
  }

  try {
    // 构建 prompt（只传必要信息，不传敏感内容）
    const subject = header.subject || '';
    const textSnippet = (body.textBody || '').slice(0, 2000); // 限制长度

    const prompt = `你是一个游戏媒体邮件分类器。请根据以下邮件信息分类。

邮件类型（只能选一个）：
- review_invitation: 评测邀请
- review_application_notice: 评测申请通知
- review_application_approved: 评测申请通过
- review_code_received: 评测码已到
- deadline_notice: 截止时间通知
- embargo_notice: 解禁/embargo通知
- nda_notice: NDA通知
- followup_request: 跟进请求
- publisher_reply: 厂商回复
- press_release: 新闻稿
- newsletter: 通讯/促销
- irrelevant: 不相关
- unknown: 未知

Subject: ${subject}
正文摘要: ${textSnippet}

请输出严格的 JSON（不要 markdown）：
{"type":"...","priority":"P0|P1|P2|P3","shouldPush":true|false,"confidence":0-1,"game":"...","platform":["..."],"company":"...","summary":"...","action":"...","deadline":null}`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);

    // 校验 type
    if (!MAIL_TYPES.includes(parsed.type)) {
      parsed.type = 'unknown';
    }
    if (!['P0', 'P1', 'P2', 'P3'].includes(parsed.priority)) {
      parsed.priority = PRIORITY_MAP[parsed.type] || 'P3';
    }
    parsed.shouldPush = shouldPushByPriority(parsed.priority);
    parsed.llm_used = true;
    parsed.platform = Array.isArray(parsed.platform) ? parsed.platform : [];

    return parsed;
  } catch (err) {
    // LLM 失败 → 降级为 unknown
    return {
      type: 'unknown',
      priority: 'P3',
      shouldPush: false,
      confidence: 0,
      game: '',
      platform: [],
      company: '',
      summary: '',
      action: '',
      deadline: null,
      llm_used: false,
      error: err.message,
    };
  }
}

// ─── 统一分类入口（规则优先） ───────────────────────────────────────

/**
 * 分类入口：规则优先，不确定才调 LLM。
 * @param {object} header
 * @param {object} body
 * @param {object} config — {selfEmail, llm:{apiKey, apiUrl, model}}
 * @returns {Promise<object>}
 */
export async function classify(header, body, config = {}) {
  // 提取截止时间（所有分类共用）
  // 传入邮件发送日期，用于计算相对时间（如"1個月內"）
  const referenceDate = header.date instanceof Date ? header.date : new Date();
  const deadlines = extractDeadlines(header.subject || '', body.textBody || '', referenceDate);

  // 1. 规则分类
  const ruleResult = classifyByRules(header, body, config);
  if (ruleResult) {
    // 补充 company
    if (!ruleResult.company && header.from) {
      ruleResult.company = extractCompany(header.from);
    }
    // 补充 deadlines
    ruleResult.deadlines = deadlines;
    ruleResult.classifier = 'rules';
    return ruleResult;
  }

  // 2. 规则不确定 → LLM
  const llmConfig = config.llm || {};
  const llmResult = await classifyWithLLM(header, body, llmConfig);
  if (!llmResult.company && header.from) {
    llmResult.company = extractCompany(header.from);
  }
  // 补充 deadlines
  llmResult.deadlines = deadlines;
  llmResult.classifier = llmResult.llm_used ? 'llm' : 'rules_fallback';
  return llmResult;
}

// ─── 辅助：邮箱标准化（内部用，避免循环依赖） ──────────────────────
function normalizeEmail(email) {
  if (!email) return '';
  return String(email).trim().toLowerCase();
}
