/**
 * whitelist.mjs — 白名单匹配
 *
 * 硬约束：
 *   - 精确邮箱匹配 + 精确域名匹配
 *   - 大小写不敏感
 *   - 禁止按显示名匹配
 *   - 禁止模糊域名匹配（不能用 contains / endsWith 子串）
 *     域名匹配必须是完整域名相等，不匹配子域名。
 *     例如 whitelist domain="example.com"，发件人 "sub.example.com" 不匹配。
 */

import fs from 'node:fs';

/**
 * 标准化邮箱：小写 + trim
 */
export function normalizeEmail(email) {
  if (!email) return '';
  return String(email).trim().toLowerCase();
}

/**
 * 标准化域名：小写 + trim + 去掉末尾点
 */
function normalizeDomain(domain) {
  if (!domain) return '';
  return String(domain).trim().toLowerCase().replace(/\.$/, '');
}

/**
 * 从文件加载白名单。
 * 文件格式：{"emails":["a@b.com"],"domains":["example.com"]}
 * 返回 {emails:Set, domains:Set}
 */
export function loadWhitelist(path) {
  try {
    const raw = fs.readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    const emails = new Set();
    const domains = new Set();
    if (Array.isArray(data.emails)) {
      for (const e of data.emails) {
        const normalized = normalizeEmail(e);
        if (normalized) emails.add(normalized);
      }
    }
    if (Array.isArray(data.domains)) {
      for (const d of data.domains) {
        const normalized = normalizeDomain(d);
        if (normalized) domains.add(normalized);
      }
    }
    return { emails, domains };
  } catch (_) {
    return { emails: new Set(), domains: new Set() };
  }
}

/**
 * 从对象加载白名单（用于测试）。
 */
export function whitelistFromObject(obj) {
  const emails = new Set();
  const domains = new Set();
  if (obj && Array.isArray(obj.emails)) {
    for (const e of obj.emails) {
      const normalized = normalizeEmail(e);
      if (normalized) emails.add(normalized);
    }
  }
  if (obj && Array.isArray(obj.domains)) {
    for (const d of obj.domains) {
      const normalized = normalizeDomain(d);
      if (normalized) domains.add(normalized);
    }
  }
  return { emails, domains };
}

/**
 * 匹配白名单。
 * @param {{email:string, domain:string, name?:string}} sender — 发件人信息
 * @param {{emails:Set, domains:Set}} whitelist
 * @returns {{matched:boolean, type:'exact_email'|'domain'|null}}
 *
 * 注意：只使用 sender.email 和 sender.domain，绝不使用 sender.name（显示名）。
 */
export function matchWhitelist(sender, whitelist) {
  if (!sender || !whitelist) return { matched: false, type: null };

  const email = normalizeEmail(sender.email);
  const domain = normalizeDomain(sender.domain);

  // 1. 精确邮箱匹配
  if (email && whitelist.emails.has(email)) {
    return { matched: true, type: 'exact_email' };
  }

  // 2. 精确域名匹配（完整域名相等，不匹配子域名）
  if (domain && whitelist.domains.has(domain)) {
    return { matched: true, type: 'domain' };
  }

  return { matched: false, type: null };
}
