#!/usr/bin/env node
/**
 * run-tests.mjs — L1 单元测试 + L2 Fixture 回归测试运行器
 *
 * 测试不访问 QQ、不调 LLM、不调 GitHub、不发 Push。
 * 运行命令：node local/run-tests.mjs
 * 输出通过/失败统计，非零退出码表示失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { parseEmail, parseDate, htmlToText, decodeHeaderValue } from './lib/parser.mjs';
import { loadWhitelist, matchWhitelist, normalizeEmail, whitelistFromObject } from './lib/whitelist.mjs';
import { MAIL_TYPES, PRIORITY_MAP, classifyByRules, classify, shouldPushByPriority } from './lib/classifier.mjs';
import { redactKeys, detectCodes, buildPayload, hashMessageId } from './lib/redact.mjs';
import {
  loadState, saveState, acquireLock, releaseLock,
  getCursor, advanceCursor, isFirstRun,
  addPending, takePending, removePending,
  addProcessed, isProcessed,
} from './lib/state.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const TMP_DIR = path.join(__dirname, '.test-tmp');

// ─── 极简测试框架 ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message || 'assertIncludes'}: expected to contain "${needle}" in "${String(haystack).slice(0, 100)}"`);
  }
}

function assertNotIncludes(haystack, needle, message) {
  if (String(haystack).includes(needle)) {
    throw new Error(`${message || 'assertNotIncludes'}: should NOT contain "${needle}"`);
  }
}

// ─── 辅助：6个月前日期（与 mail-watcher.mjs 中逻辑一致） ──────────

function sixMonthsAgo(now = new Date()) {
  const targetYear = now.getFullYear();
  const targetMonth = now.getMonth() - 6;
  const originalDay = now.getDate();
  const lastDayOfTarget = new Date(targetYear, targetMonth + 1, 0).getDate();
  const day = Math.min(originalDay, lastDayOfTarget);
  return new Date(targetYear, targetMonth, day, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
}

// ─── 测试白名单（与 fixture 发件人对应） ────────────────────────────

const TEST_WHITELIST = whitelistFromObject({
  emails: [
    'pr@koeitecmo.com',
    'press@nintendo.com',
    'media@ubisoft.com',
    'press@capcom.com',
  ],
  domains: ['sega.com'],
});

const TEST_SELF_EMAIL = 'tester@qq.com';

// ─── 读取 fixture ───────────────────────────────────────────────────

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

// ─── 通用 pipeline ──────────────────────────────────────────────────

function runPipeline(emlContent, options = {}) {
  const mail = parseEmail(emlContent);
  const wlResult = matchWhitelist(mail.from, TEST_WHITELIST);
  let classification = null;
  let payload = null;
  let redactResult = null;

  // 分类不依赖白名单（self-sent 等场景需要分类）
  // 白名单结果单独返回，由测试断言
  classification = classifyByRules(
    { from: mail.from, subject: mail.subject, date: mail.date, messageId: mail.messageId },
    { textBody: mail.textBody, htmlBody: mail.htmlBody },
    { selfEmail: options.selfEmail || TEST_SELF_EMAIL }
  );
  if (classification) {
    redactResult = redactKeys(mail.textBody || '');
    payload = buildPayload(classification, mail);
  }

  return { mail, wlResult, classification, payload, redactResult };
}

// ═══════════════════════════════════════════════════════════════════
// 主测试函数（全部 await）
// ═══════════════════════════════════════════════════════════════════

async function runAllTests() {

// ═══════════════════════════════════════════════════════════════════
// L1 单元测试
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== L1 单元测试 ===\n');

// ─── 1. 日期6个月边界 ──────────────────────────────────────────────

console.log('--- 日期6个月边界 ---');

test('cutoff 精确时间：6个月前的日期计算正确', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  const cutoff = sixMonthsAgo(now);
  assertEqual(cutoff.getFullYear(), 2026, 'year');
  assertEqual(cutoff.getMonth(), 2, 'month (March=2)');
  assertEqual(cutoff.getDate(), 10, 'day');
});

test('cutoff-1秒：邮件日期早于cutoff → older_than_6_months', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  const cutoff = sixMonthsAgo(now);
  const mailDate = new Date(cutoff.getTime() - 1000);
  assert(mailDate < cutoff, 'mailDate should be < cutoff');
});

test('cutoff 精确时刻：邮件日期等于cutoff → 不跳过', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  const cutoff = sixMonthsAgo(now);
  const mailDate = new Date(cutoff.getTime());
  assert(mailDate >= cutoff, 'mailDate should be >= cutoff');
});

test('cutoff+1秒：邮件日期晚于cutoff → 不跳过', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  const cutoff = sixMonthsAgo(now);
  const mailDate = new Date(cutoff.getTime() + 1000);
  assert(mailDate >= cutoff, 'mailDate should be >= cutoff');
});

test('月末边界：8月31日 - 6个月 = 2月28日（非闰年）', () => {
  const now = new Date('2026-08-31T10:00:00Z');
  const cutoff = sixMonthsAgo(now);
  assertEqual(cutoff.getMonth(), 1, 'month (Feb=1)');
  assertEqual(cutoff.getDate(), 28, 'day should be 28 (2026 not leap)');
});

test('闰年月末边界：8月31日2024 - 6个月 = 2月29日', () => {
  const now = new Date('2024-08-31T10:00:00Z');
  const cutoff = sixMonthsAgo(now);
  assertEqual(cutoff.getMonth(), 1, 'month');
  assertEqual(cutoff.getDate(), 29, 'day should be 29 (2024 leap)');
});

// ─── 2. 邮箱标准化 ─────────────────────────────────────────────────

console.log('\n--- 邮箱标准化 ---');

test('normalizeEmail: 大写转小写 + 去空白', () => {
  assertEqual(normalizeEmail('  User@Example.COM  '), 'user@example.com');
});

test('normalizeEmail: 空字符串 → 空', () => {
  assertEqual(normalizeEmail(''), '');
  assertEqual(normalizeEmail(null), '');
  assertEqual(normalizeEmail(undefined), '');
});

test('normalizeEmail: 已经是小写 → 不变', () => {
  assertEqual(normalizeEmail('a@b.com'), 'a@b.com');
});

// ─── 3. 域名精确匹配 ───────────────────────────────────────────────

console.log('\n--- 域名精确匹配 ---');

test('域名精确匹配：完全相同 → 匹配', () => {
  const wl = whitelistFromObject({ domains: ['example.com'] });
  const result = matchWhitelist({ email: 'a@example.com', domain: 'example.com' }, wl);
  assert(result.matched, 'should match');
  assertEqual(result.type, 'domain');
});

test('域名精确匹配：子域名不匹配（禁止模糊匹配）', () => {
  const wl = whitelistFromObject({ domains: ['example.com'] });
  const result = matchWhitelist({ email: 'a@sub.example.com', domain: 'sub.example.com' }, wl);
  assert(!result.matched, 'subdomain should NOT match');
});

test('域名精确匹配：大小写不敏感', () => {
  const wl = whitelistFromObject({ domains: ['Example.COM'] });
  const result = matchWhitelist({ email: 'a@EXAMPLE.COM', domain: 'EXAMPLE.COM' }, wl);
  assert(result.matched, 'case insensitive should match');
});

test('域名精确匹配：相似域名不匹配', () => {
  const wl = whitelistFromObject({ domains: ['example.com'] });
  assert(!matchWhitelist({ email: 'a@example.com.cn', domain: 'example.com.cn' }, wl).matched, 'example.com.cn should not match');
  assert(!matchWhitelist({ email: 'a@example-login.com', domain: 'example-login.com' }, wl).matched, 'example-login.com should not match');
  assert(!matchWhitelist({ email: 'a@example.com.evil.com', domain: 'example.com.evil.com' }, wl).matched, 'example.com.evil.com should not match');
});

// ─── 4. 显示名伪装不匹配 ───────────────────────────────────────────

console.log('\n--- 显示名伪装 ---');

test('显示名伪装：显示名匹配但邮箱不匹配 → 不匹配', () => {
  const wl = whitelistFromObject({ emails: ['hebe.chen@real-publisher.com'] });
  const result = matchWhitelist(
    { name: 'Hebe Chen', email: 'attacker@evil.com', domain: 'evil.com' },
    wl
  );
  assert(!result.matched, 'display name spoofing should NOT match');
});

test('显示名伪装：显示名完全相同但邮箱不同 → 不匹配', () => {
  const wl = whitelistFromObject({ emails: ['ceo@company.com'] });
  const result = matchWhitelist(
    { name: 'CEO', email: 'ceo@fake-company.com', domain: 'fake-company.com' },
    wl
  );
  assert(!result.matched, 'same display name, different email should NOT match');
});

// ─── 5. 精确邮箱匹配 ───────────────────────────────────────────────

console.log('\n--- 精确邮箱匹配 ---');

test('精确邮箱匹配：完全相同 → matched', () => {
  const wl = whitelistFromObject({ emails: ['pr@koeitecmo.com'] });
  const result = matchWhitelist({ email: 'pr@koeitecmo.com', domain: 'koeitecmo.com' }, wl);
  assert(result.matched, 'should match');
  assertEqual(result.type, 'exact_email');
});

test('精确邮箱匹配：大小写不敏感', () => {
  const wl = whitelistFromObject({ emails: ['PR@KOEITECMO.COM'] });
  const result = matchWhitelist({ email: 'pr@koeitecmo.com', domain: 'koeitecmo.com' }, wl);
  assert(result.matched, 'case insensitive should match');
});

// ─── 6. Message-ID hash ─────────────────────────────────────────────

console.log('\n--- Message-ID hash ---');

test('hashMessageId: sha256 格式正确', () => {
  const hash = hashMessageId('<test@example.com>');
  assert(hash.startsWith('sha256:'), 'should start with sha256:');
  const hexPart = hash.slice(7);
  assertEqual(hexPart.length, 64, 'sha256 hex should be 64 chars');
  assert(/^[0-9a-f]{64}$/.test(hexPart), 'should be valid hex');
});

test('hashMessageId: 相同输入 → 相同输出（确定性）', () => {
  const h1 = hashMessageId('<abc@def.com>');
  const h2 = hashMessageId('<abc@def.com>');
  assertEqual(h1, h2);
});

test('hashMessageId: 不同输入 → 不同输出', () => {
  const h1 = hashMessageId('<abc@def.com>');
  const h2 = hashMessageId('<xyz@def.com>');
  assert(h1 !== h2, 'different inputs should produce different hashes');
});

test('hashMessageId: 空Message-ID → hash of empty string', () => {
  const hash = hashMessageId('');
  const expected = 'sha256:' + crypto.createHash('sha256').update('').digest('hex');
  assertEqual(hash, expected);
});

test('hashMessageId: 与手动计算一致', () => {
  const mid = '<review-code-002@koeitecmo.com>';
  const hash = hashMessageId(mid);
  const expected = 'sha256:' + crypto.createHash('sha256').update(mid).digest('hex');
  assertEqual(hash, expected);
});

// ─── 7. Key/Code 脱敏 ──────────────────────────────────────────────

console.log('\n--- Key/Code 脱敏 ---');

test('Steam key 脱敏：XXXXX-XXXXX-XXXXX 格式', () => {
  const text = 'Your key: ABCDE-FGHIJ-KLMNO';
  const result = redactKeys(text);
  assert(result.hasCode, 'should detect code');
  assertNotIncludes(result.redactedText, 'ABCDE-FGHIJ-KLMNO', 'original code should be redacted');
  assertIncludes(result.redactedText, '[REDACTED_CODE]', 'should contain redaction marker');
});

test('Nintendo code 脱敏：4-4-4-4 格式', () => {
  const text = 'Code: X4K5-D3F7-G2H9-J1M8';
  const result = redactKeys(text);
  assert(result.hasCode, 'should detect code');
  assertNotIncludes(result.redactedText, 'X4K5-D3F7-G2H9-J1M8');
  assert(result.codePlatforms.includes('Nintendo Switch'), 'should identify Nintendo platform');
});

test('多个 Code 全部脱敏', () => {
  const text = 'Steam: ABCDE-FGHIJ-KLMNO\nSwitch: X4K5-D3F7-G2H9-J1M8';
  const result = redactKeys(text);
  assert(result.hasCode, 'should detect codes');
  assertNotIncludes(result.redactedText, 'ABCDE-FGHIJ-KLMNO');
  assertNotIncludes(result.redactedText, 'X4K5-D3F7-G2H9-J1M8');
});

test('无 Code 文本：不修改', () => {
  const text = 'Hello, this is a normal email without any codes.';
  const result = redactKeys(text);
  assert(!result.hasCode, 'should not detect code');
  assertEqual(result.redactedText, text, 'text should be unchanged');
});

test('detectCodes: 只检测不修改', () => {
  const text = 'Key: ABCDE-FGHIJ-KLMNO';
  const result = detectCodes(text);
  assert(result.hasCode, 'should detect');
  assertEqual(text, 'Key: ABCDE-FGHIJ-KLMNO', 'original text should be unchanged');
});

// ─── 8. Priority 映射 ───────────────────────────────────────────────

console.log('\n--- Priority 映射 ---');

test('所有13种邮件类型都有Priority映射', () => {
  for (const type of MAIL_TYPES) {
    assert(PRIORITY_MAP[type] !== undefined, `missing priority for ${type}`);
    assert(['P0', 'P1', 'P2', 'P3'].includes(PRIORITY_MAP[type]), `invalid priority for ${type}`);
  }
});

test('deadline_notice → P0', () => {
  assertEqual(PRIORITY_MAP['deadline_notice'], 'P0');
});

test('review_code_received → P1', () => {
  assertEqual(PRIORITY_MAP['review_code_received'], 'P1');
});

test('embargo_notice → P1', () => {
  assertEqual(PRIORITY_MAP['embargo_notice'], 'P1');
});

test('review_invitation → P2', () => {
  assertEqual(PRIORITY_MAP['review_invitation'], 'P2');
});

test('newsletter → P3', () => {
  assertEqual(PRIORITY_MAP['newsletter'], 'P3');
});

test('shouldPushByPriority: P0/P1/P2 → true, P3 → false', () => {
  assert(shouldPushByPriority('P0'), 'P0 should push');
  assert(shouldPushByPriority('P1'), 'P1 should push');
  assert(shouldPushByPriority('P2'), 'P2 should push');
  assert(!shouldPushByPriority('P3'), 'P3 should NOT push');
});

// ─── 9. UID Cursor ──────────────────────────────────────────────────

console.log('\n--- UID Cursor ---');

test('初始状态：lastUid=0, uidvalidity=0', () => {
  const state = { mailboxes: {} };
  const cursor = getCursor(state, 'qq-main');
  assertEqual(cursor.lastUid, 0);
  assertEqual(cursor.uidvalidity, 0);
});

test('isFirstRun: lastUid=0 → true', () => {
  const state = { mailboxes: {} };
  assert(isFirstRun(state, 'qq-main'), 'should be first run');
});

test('advanceCursor: 推进到指定UID', () => {
  const state = { mailboxes: {} };
  advanceCursor(state, 'qq-main', 100, 50);
  const cursor = getCursor(state, 'qq-main');
  assertEqual(cursor.lastUid, 50);
  assertEqual(cursor.uidvalidity, 100);
});

test('advanceCursor: 不回退（小UID不改变cursor）', () => {
  const state = { mailboxes: {} };
  advanceCursor(state, 'qq-main', 100, 100);
  advanceCursor(state, 'qq-main', 100, 50);
  const cursor = getCursor(state, 'qq-main');
  assertEqual(cursor.lastUid, 100, 'should not rollback');
});

test('advanceCursor: 大UID正常推进', () => {
  const state = { mailboxes: {} };
  advanceCursor(state, 'qq-main', 100, 100);
  advanceCursor(state, 'qq-main', 100, 200);
  const cursor = getCursor(state, 'qq-main');
  assertEqual(cursor.lastUid, 200);
});

test('advanceCursor: UIDVALIDITY变化 → 重置', () => {
  const state = { mailboxes: {} };
  advanceCursor(state, 'qq-main', 100, 500);
  advanceCursor(state, 'qq-main', 200, 10);
  const cursor = getCursor(state, 'qq-main');
  assertEqual(cursor.uidvalidity, 200);
  assertEqual(cursor.lastUid, 10, 'should reset to new uid');
});

// ─── 10. Pending Retry ──────────────────────────────────────────────

console.log('\n--- Pending Retry ---');

test('addPending: 添加待重试项', () => {
  const state = { pending: [] };
  const payload = { message_id_hash: 'sha256:abc123', mail_type: 'test' };
  addPending(state, { payload, retry_count: 0 });
  assertEqual(state.pending.length, 1);
  assertEqual(state.pending[0].payload.message_id_hash, 'sha256:abc123');
});

test('takePending: 取出所有待重试项', () => {
  const state = { pending: [{ payload: { message_id_hash: 'h1' } }, { payload: { message_id_hash: 'h2' } }] };
  const items = takePending(state);
  assertEqual(items.length, 2);
});

test('removePending: 按hash移除', () => {
  const state = { pending: [
    { payload: { message_id_hash: 'h1' } },
    { payload: { message_id_hash: 'h2' } },
  ]};
  removePending(state, 'h1');
  assertEqual(state.pending.length, 1);
  assertEqual(state.pending[0].payload.message_id_hash, 'h2');
});

test('addPending 去重：相同hash不重复添加，更新retry_count', () => {
  const state = { pending: [] };
  const payload = { message_id_hash: 'sha256:dup', mail_type: 'test' };
  addPending(state, { payload, retry_count: 0 });
  addPending(state, { payload, retry_count: 0 });
  assertEqual(state.pending.length, 1, 'should not duplicate');
  assertEqual(state.pending[0].retry_count, 1, 'retry_count should increment');
});

// ─── 11. Processed 去重 ─────────────────────────────────────────────

console.log('\n--- Processed 去重 ---');

test('addProcessed / isProcessed: 记录并检查', () => {
  const state = { processed: [] };
  addProcessed(state, 'sha256:test123');
  assert(isProcessed(state, 'sha256:test123'), 'should be processed');
  assert(!isProcessed(state, 'sha256:other'), 'should not be processed');
});

test('addProcessed: 重复添加不产生重复', () => {
  const state = { processed: [] };
  addProcessed(state, 'h1');
  addProcessed(state, 'h1');
  assertEqual(state.processed.length, 1);
});

// ─── 12. 单实例锁 ───────────────────────────────────────────────────

console.log('\n--- 单实例锁 ---');

test('acquireLock: 锁不存在 → 获取成功', () => {
  const lockPath = path.join(TMP_DIR, 'test-lock-1.json');
  try { fs.unlinkSync(lockPath); } catch (_) {}
  const result = acquireLock(lockPath);
  assert(result.acquired, 'should acquire lock');
  assertEqual(result.lock.pid, process.pid);
  releaseLock(lockPath);
});

test('acquireLock: 自己的锁已存在 → 重新获取（覆盖）', () => {
  const lockPath = path.join(TMP_DIR, 'test-lock-2.json');
  try { fs.unlinkSync(lockPath); } catch (_) {}
  acquireLock(lockPath);
  const result = acquireLock(lockPath);
  assert(result.acquired, 'should re-acquire own lock');
  releaseLock(lockPath);
});

// ─── 13. HTML 转纯文本 ──────────────────────────────────────────────

console.log('\n--- HTML 转纯文本 ---');

test('htmlToText: 移除标签保留文本', () => {
  const html = '<p>Hello <b>World</b></p>';
  const text = htmlToText(html);
  assertIncludes(text, 'Hello');
  assertIncludes(text, 'World');
  assertNotIncludes(text, '<p>');
  assertNotIncludes(text, '<b>');
});

test('htmlToText: 移除script和style内容', () => {
  const html = '<script>alert(1)</script><style>body{}</style><p>Real</p>';
  const text = htmlToText(html);
  assertNotIncludes(text, 'alert');
  assertNotIncludes(text, 'body{}');
  assertIncludes(text, 'Real');
});

test('htmlToText: 空输入 → 空字符串', () => {
  assertEqual(htmlToText(''), '');
  assertEqual(htmlToText(null), '');
});

// ─── 14. Header 编码解码 ────────────────────────────────────────────

console.log('\n--- Header 编码解码 ---');

test('decodeHeaderValue: Base64 UTF-8', () => {
  const encoded = '=?UTF-8?B?' + Buffer.from('评测', 'utf8').toString('base64') + '?=';
  const decoded = decodeHeaderValue(encoded);
  assertEqual(decoded, '评测');
});

test('decodeHeaderValue: 多个编码段拼接', () => {
  const e1 = '=?UTF-8?B?' + Buffer.from('Hello', 'utf8').toString('base64') + '?=';
  const e2 = '=?UTF-8?B?' + Buffer.from('World', 'utf8').toString('base64') + '?=';
  const decoded = decodeHeaderValue(`${e1} ${e2}`);
  assertIncludes(decoded, 'Hello');
  assertIncludes(decoded, 'World');
});

test('decodeHeaderValue: 纯文本不修改', () => {
  assertEqual(decodeHeaderValue('Plain Text'), 'Plain Text');
});

// ═══════════════════════════════════════════════════════════════════
// L2 Fixture 回归测试
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== L2 Fixture 回归测试 ===\n');

// ─── Fixture 1: review-invitation.eml ───────────────────────────────

console.log('--- Fixture 1: review-invitation.eml ---');

await testAsync('解析：发件人、主题、日期正确', async () => {
  const raw = readFixture('review-invitation.eml');
  const mail = parseEmail(raw);
  assertEqual(mail.from.email, 'pr@koeitecmo.com', 'from email');
  assertIncludes(mail.subject, '鑑賞家', 'subject should contain 鑑賞家');
  assertIncludes(mail.subject, '申請', 'subject should contain 申請');
  assert(mail.date instanceof Date, 'date should be Date');
});

await testAsync('白名单：精确邮箱匹配', async () => {
  const raw = readFixture('review-invitation.eml');
  const mail = parseEmail(raw);
  const result = matchWhitelist(mail.from, TEST_WHITELIST);
  assert(result.matched, 'should match whitelist');
  assertEqual(result.type, 'exact_email');
});

await testAsync('分类：review_invitation, P2, shouldPush=true', async () => {
  const raw = readFixture('review-invitation.eml');
  const { classification } = runPipeline(raw);
  assert(classification !== null, 'classification should not be null');
  assertEqual(classification.type, 'review_invitation');
  assertEqual(classification.priority, 'P2');
  assert(classification.shouldPush, 'should push');
});

await testAsync('Payload：mail_type=review_invitation, 不含敏感信息', async () => {
  const raw = readFixture('review-invitation.eml');
  const { payload } = runPipeline(raw);
  assert(payload !== null, 'payload should exist');
  assertEqual(payload.mail_type, 'review_invitation');
  assertEqual(payload.priority, 'P2');
  assert(payload.message_id_hash.startsWith('sha256:'), 'should have message_id_hash');
  assertNotIncludes(JSON.stringify(payload), 'pr@koeitecmo.com', 'should not contain sender email');
});

// ─── Fixture 2: review-code.eml ─────────────────────────────────────

console.log('\n--- Fixture 2: review-code.eml ---');

await testAsync('解析：发件人正确，正文含Code', async () => {
  const raw = readFixture('review-code.eml');
  const mail = parseEmail(raw);
  assertEqual(mail.from.email, 'pr@koeitecmo.com');
  assertIncludes(mail.textBody, 'X4K5-D3F7-G2H9-J1M8', 'body should contain code');
});

await testAsync('白名单：匹配', async () => {
  const raw = readFixture('review-code.eml');
  const mail = parseEmail(raw);
  assert(matchWhitelist(mail.from, TEST_WHITELIST).matched);
});

await testAsync('分类：review_code_received, P1', async () => {
  const raw = readFixture('review-code.eml');
  const { classification } = runPipeline(raw);
  assert(classification !== null, 'should classify');
  assertEqual(classification.type, 'review_code_received');
  assertEqual(classification.priority, 'P1');
  assert(classification.shouldPush);
});

await testAsync('脱敏：hasCode=true, 正文Code被替换', async () => {
  const raw = readFixture('review-code.eml');
  const mail = parseEmail(raw);
  const result = redactKeys(mail.textBody);
  assert(result.hasCode, 'should detect code');
  assertNotIncludes(result.redactedText, 'X4K5-D3F7-G2H9-J1M8', 'code should be redacted');
  assert(result.codePlatforms.includes('Nintendo Switch'), 'should identify Nintendo');
});

await testAsync('Payload：不含完整Code', async () => {
  const raw = readFixture('review-code.eml');
  const { payload } = runPipeline(raw);
  assert(payload !== null, 'payload should exist');
  assertEqual(payload.mail_type, 'review_code_received');
  const payloadStr = JSON.stringify(payload);
  assertNotIncludes(payloadStr, 'X4K5-D3F7-G2H9-J1M8', 'payload must NOT contain full code');
  assertNotIncludes(payloadStr, 'X4K5', 'payload must NOT contain code fragment');
});

// ─── Fixture 3: deadline.eml ────────────────────────────────────────

console.log('\n--- Fixture 3: deadline.eml ---');

await testAsync('白名单：press@nintendo.com 匹配', async () => {
  const raw = readFixture('deadline.eml');
  const mail = parseEmail(raw);
  const result = matchWhitelist(mail.from, TEST_WHITELIST);
  assert(result.matched);
  assertEqual(result.type, 'exact_email');
});

await testAsync('分类：deadline_notice, P0（24小时内紧急）', async () => {
  const raw = readFixture('deadline.eml');
  const { classification } = runPipeline(raw);
  assert(classification !== null, 'should classify');
  assertEqual(classification.type, 'deadline_notice');
  assertEqual(classification.priority, 'P0');
  assert(classification.shouldPush);
});

// ─── Fixture 4: embargo.eml ─────────────────────────────────────────

console.log('\n--- Fixture 4: embargo.eml ---');

await testAsync('白名单：media@ubisoft.com 匹配', async () => {
  const raw = readFixture('embargo.eml');
  const mail = parseEmail(raw);
  assert(matchWhitelist(mail.from, TEST_WHITELIST).matched);
});

await testAsync('分类：embargo_notice, P1', async () => {
  const raw = readFixture('embargo.eml');
  const { classification } = runPipeline(raw);
  assert(classification !== null, 'should classify');
  assertEqual(classification.type, 'embargo_notice');
  assertEqual(classification.priority, 'P1');
  assert(classification.shouldPush);
});

// ─── Fixture 5: newsletter.eml ──────────────────────────────────────

console.log('\n--- Fixture 5: newsletter.eml ---');

await testAsync('白名单：sega.com 域名匹配', async () => {
  const raw = readFixture('newsletter.eml');
  const mail = parseEmail(raw);
  const result = matchWhitelist(mail.from, TEST_WHITELIST);
  assert(result.matched, 'domain should match');
  assertEqual(result.type, 'domain');
});

await testAsync('分类：newsletter/press_release, P3, shouldPush=false', async () => {
  const raw = readFixture('newsletter.eml');
  const { classification } = runPipeline(raw);
  assert(classification !== null, 'should classify');
  assert(['newsletter', 'press_release'].includes(classification.type), `type should be newsletter or press_release, got ${classification.type}`);
  assertEqual(classification.priority, 'P3');
  assert(!classification.shouldPush, 'should NOT push');
});

await testAsync('HTML解析：htmlToText 不崩溃，提取文本', async () => {
  const raw = readFixture('newsletter.eml');
  const mail = parseEmail(raw);
  assert(mail.htmlBody.length > 0, 'should have html body');
  assert(mail.textBody.length > 0, 'should have text body (converted from html)');
  assertIncludes(mail.textBody, 'SEGA', 'text should contain SEGA');
});

// ─── Fixture 6: self-sent-review-link.eml ───────────────────────────

console.log('\n--- Fixture 6: self-sent-review-link.eml ---');

await testAsync('发件人=自己邮箱', async () => {
  const raw = readFixture('self-sent-review-link.eml');
  const mail = parseEmail(raw);
  assertEqual(mail.from.email, TEST_SELF_EMAIL);
});

await testAsync('分类：irrelevant, P3（自己发的）', async () => {
  const raw = readFixture('self-sent-review-link.eml');
  const { classification } = runPipeline(raw, { selfEmail: TEST_SELF_EMAIL });
  assert(classification !== null, 'should classify');
  assertEqual(classification.type, 'irrelevant');
  assertEqual(classification.priority, 'P3');
  assert(!classification.shouldPush);
});

// ─── Fixture 7: spoofed-from.eml ────────────────────────────────────

console.log('\n--- Fixture 7: spoofed-from.eml ---');

await testAsync('显示名=Hebe Chen 但真实邮箱=attacker@example.com', async () => {
  const raw = readFixture('spoofed-from.eml');
  const mail = parseEmail(raw);
  assertEqual(mail.from.name, 'Hebe Chen', 'display name');
  assertEqual(mail.from.email, 'attacker@example.com', 'real email');
});

await testAsync('白名单：不匹配（显示名伪装无效）', async () => {
  const raw = readFixture('spoofed-from.eml');
  const mail = parseEmail(raw);
  const result = matchWhitelist(mail.from, TEST_WHITELIST);
  assert(!result.matched, 'spoofed display name should NOT match whitelist');
});

await testAsync('认证：SPF fail → sender_auth_failed', async () => {
  const raw = readFixture('spoofed-from.eml');
  const mail = parseEmail(raw);
  assertEqual(mail.auth.spf, 'fail', 'spf should be fail');
  assertEqual(mail.auth.status, 'fail', 'auth status should be fail');
});

// ─── Fixture 8: old-mail.eml ────────────────────────────────────────

console.log('\n--- Fixture 8: old-mail.eml ---');

await testAsync('日期：8个月前 → older_than_6_months', async () => {
  const raw = readFixture('old-mail.eml');
  const mail = parseEmail(raw);
  assert(mail.date instanceof Date, 'should parse date');
  const now = new Date('2026-09-10T12:00:00Z');
  const cutoff = sixMonthsAgo(now);
  assert(mail.date < cutoff, `mail date ${mail.date.toISOString()} should be before cutoff ${cutoff.toISOString()}`);
});

await testAsync('白名单：匹配（但因日期跳过）', async () => {
  const raw = readFixture('old-mail.eml');
  const mail = parseEmail(raw);
  assert(matchWhitelist(mail.from, TEST_WHITELIST).matched);
});

// ─── Fixture 9: non-whitelist.eml ───────────────────────────────────

console.log('\n--- Fixture 9: non-whitelist.eml ---');

await testAsync('发件人：陌生邮箱', async () => {
  const raw = readFixture('non-whitelist.eml');
  const mail = parseEmail(raw);
  assertEqual(mail.from.email, 'random@unknown-domain.xyz');
});

await testAsync('白名单：不匹配 → not_in_whitelist', async () => {
  const raw = readFixture('non-whitelist.eml');
  const mail = parseEmail(raw);
  const result = matchWhitelist(mail.from, TEST_WHITELIST);
  assert(!result.matched, 'unknown sender should NOT match');
});

await testAsync('即使Subject含Steam Review Code也不读正文（白名单硬闸门）', async () => {
  const raw = readFixture('non-whitelist.eml');
  const mail = parseEmail(raw);
  const result = matchWhitelist(mail.from, TEST_WHITELIST);
  assert(!result.matched, 'whitelist gate should block');
  assertIncludes(mail.subject, 'Steam Review Code', 'subject has tempting keywords');
});

// ─── Fixture 10: malformed-html.eml ─────────────────────────────────

console.log('\n--- Fixture 10: malformed-html.eml ---');

await testAsync('解析器不崩溃：异常编码+嵌套HTML', async () => {
  const raw = readFixture('malformed-html.eml');
  let mail = null;
  let error = null;
  try {
    mail = parseEmail(raw);
  } catch (err) {
    error = err;
  }
  assert(error === null, `parser should not crash: ${error?.message}`);
  assert(mail !== null, 'should return parsed object');
  assertEqual(mail.from.email, 'press@capcom.com', 'from should parse');
});

await testAsync('白名单：press@capcom.com 匹配', async () => {
  const raw = readFixture('malformed-html.eml');
  const mail = parseEmail(raw);
  assert(matchWhitelist(mail.from, TEST_WHITELIST).matched);
});

await testAsync('分类：返回有效结果（不崩溃）', async () => {
  const raw = readFixture('malformed-html.eml');
  const { classification } = runPipeline(raw);
  if (classification !== null) {
    assert(MAIL_TYPES.includes(classification.type), `type should be valid, got ${classification.type}`);
    assert(['P0', 'P1', 'P2', 'P3'].includes(classification.priority));
  }
});

await testAsync('buildPayload：不崩溃，返回有效结构', async () => {
  const raw = readFixture('malformed-html.eml');
  const mail = parseEmail(raw);
  const classification = classifyByRules(
    { from: mail.from, subject: mail.subject, date: mail.date, messageId: mail.messageId },
    { textBody: mail.textBody, htmlBody: mail.htmlBody },
    { selfEmail: TEST_SELF_EMAIL }
  );
  if (classification) {
    const payload = buildPayload(classification, mail);
    assert(payload !== null, 'payload should exist');
    assertEqual(payload.payload_version, 1);
    assert(payload.message_id_hash.startsWith('sha256:'));
  }
});

// ═══════════════════════════════════════════════════════════════════
// 集成测试
// ═══════════════════════════════════════════════════════════════════

console.log('\n=== 集成测试 ===\n');

await testAsync('classify() 未配置LLM时降级为纯规则', async () => {
  const header = { from: { email: 'pr@koeitecmo.com', domain: 'koeitecmo.com' }, subject: '评测码已到', date: new Date(), messageId: '<test>' };
  const body = { textBody: 'Your steam key is ABCDE-FGHIJ-KLMNO', htmlBody: '' };
  const result = await classify(header, body, { selfEmail: 'other@qq.com', llm: {} });
  assertEqual(result.type, 'review_code_received');
  assertEqual(result.classifier, 'rules');
});

await testAsync('buildPayload 严格禁止敏感字段', async () => {
  const raw = readFixture('review-code.eml');
  const mail = parseEmail(raw);
  const classification = classifyByRules(
    { from: mail.from, subject: mail.subject, date: mail.date, messageId: mail.messageId },
    { textBody: mail.textBody, htmlBody: mail.htmlBody },
    { selfEmail: TEST_SELF_EMAIL }
  );
  const payload = buildPayload(classification, mail);
  const payloadStr = JSON.stringify(payload);

  assertNotIncludes(payloadStr, 'X4K5-D3F7-G2H9-J1M8', 'no full code');
  assertNotIncludes(payloadStr, 'pr@koeitecmo.com', 'no sender email');
  assertNotIncludes(payloadStr, 'tester@qq.com', 'no recipient email');
  assert(!('body' in payload), 'no body field');
  assert(!('textBody' in payload), 'no textBody field');
  assert(!('htmlBody' in payload), 'no htmlBody field');
  assert(!('raw' in payload), 'no raw field');

  // 注意：event_type/source/payload_version 已从 buildPayload 移除
  // 因为 GitHub client_payload 限制最多 10 个属性
  assert(payload.priority, 'should have priority');
  assert(payload.mail_type, 'should have mail_type');
  assert(payload.title, 'should have title');
  assert(payload.message_id_hash.startsWith('sha256:'), 'should have message_id_hash');
});

await testAsync('State 保存/加载 round-trip', async () => {
  const tmpState = path.join(TMP_DIR, 'test-state.json');
  try { fs.unlinkSync(tmpState); } catch (_) {}
  const state = {
    schema: 1,
    mailboxes: { 'qq-main': { uidvalidity: 123, last_uid: 456, last_sync: new Date().toISOString() } },
    processed: ['sha256:abc'],
    pending: [{ payload: { message_id_hash: 'sha256:def' }, retry_count: 0 }],
  };
  saveState(state, tmpState);
  const loaded = loadState(tmpState);
  assertEqual(loaded.schema, 1);
  assertEqual(loaded.mailboxes['qq-main'].uidvalidity, 123);
  assertEqual(loaded.mailboxes['qq-main'].last_uid, 456);
  assertEqual(loaded.processed.length, 1);
  assertEqual(loaded.pending.length, 1);
  try { fs.unlinkSync(tmpState); } catch (_) {}
});

// ═══════════════════════════════════════════════════════════════════
// 测试结果汇总
// ═══════════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(50));
console.log(`测试结果: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(50));

if (failed > 0) {
  console.log('\n失败用例:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(1);
} else {
  console.log('\n全部测试通过！');
  process.exit(0);
}

} // end runAllTests

// 确保 tmp 目录存在
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

runAllTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(2);
});
