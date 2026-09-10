/**
 * push.mjs — 云端 Push 主逻辑
 *
 * 流程：
 * 1. 从 process.env 读取 payload（MAIL_PAYLOAD 或 TEST_PAYLOAD）
 * 2. validatePayload 校验，失败 exit 1
 * 3. 加载/创建 state/push-state.json（云端去重状态）
 * 4. isDuplicate 检查，重复则跳过并 exit 0
 * 5. 判断是否需要测试打标
 * 6. 渲染 Push 内容（按 mail_type 选择模板）
 * 7. Promise.allSettled 并行调用 4 个 provider
 * 8. addToPushState 并保存
 * 9. 输出每路结果
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePayload, isDuplicate, addToPushState } from './validate.mjs';
import { sendWeCom } from './providers/wecom.mjs';
import { sendWxPusher } from './providers/wxpusher.mjs';
import { sendBark } from './providers/bark.mjs';
import { sendNtfy } from './providers/ntfy.mjs';

// ── 路径常量 ─────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(PROJECT_ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'push-state.json');

// ── 工具函数 ─────────────────────────────────────────────────────

/**
 * 从环境变量读取并解析 payload JSON。
 * 优先 MAIL_PAYLOAD（repository_dispatch），其次 TEST_PAYLOAD（workflow_dispatch）。
 */
function loadPayload() {
  const raw = process.env.MAIL_PAYLOAD || process.env.TEST_PAYLOAD;

  if (!raw || raw.trim().length === 0) {
    console.error('[ERROR] 未找到 MAIL_PAYLOAD 或 TEST_PAYLOAD 环境变量');
    process.exit(1);
  }

  // GitHub Actions 的 toJson 可能输出空对象字符串 "{}"
  if (raw.trim() === '{}') {
    console.error('[ERROR] payload 为空对象');
    process.exit(1);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[ERROR] payload JSON 解析失败:', err.message);
    process.exit(1);
  }
}

/**
 * 加载去重状态文件。不存在则返回空 state。
 */
function loadPushState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const content = fs.readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (err) {
    console.warn('[WARN] 读取 push-state.json 失败，将使用空状态:', err.message);
  }
  return { recent_pushes: [] };
}

/**
 * 保存去重状态文件。
 */
function savePushState(state) {
  try {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('[ERROR] 保存 push-state.json 失败:', err.message);
  }
}

/**
 * 判断是否需要测试打标。
 * 条件（任一成立）：
 *   - GITHUB_REF != refs/heads/main
 *   - PUSH_TEST == "1"
 *   - APP_ENV != "production"
 */
function shouldMarkTest() {
  const ref = process.env.GITHUB_REF || '';
  const pushTest = process.env.PUSH_TEST === '1';
  const appEnv = process.env.APP_ENV;

  const notMain = ref !== 'refs/heads/main';
  const notProd = appEnv !== 'production';

  return notMain || pushTest || notProd;
}

// ── Push 内容模板 ────────────────────────────────────────────────

/**
 * 按 mail_type 渲染 Push 内容（纯文本）。
 * @param {object} payload
 * @returns {{title:string, content:string}}
 */
function renderPushContent(payload) {
  const { mail_type, game, platform, company, summary, action, title } = payload;
  const platformStr = Array.isArray(platform) ? platform.join(' / ') : (platform || '');

  switch (mail_type) {
    case 'review_code_received':
      return {
        title: '【评测码已到】',
        content: [
          `《${game || '未知游戏'}》`,
          platformStr ? `平台：${platformStr}` : '',
          '',
          '状态：厂商已发送评测 Code',
          `需要你：${action || '打开原邮件查看 Code'}`,
          company ? `来源：${company}` : '',
        ].filter(Boolean).join('\n'),
      };

    case 'review_invitation':
      return {
        title: '【新评测邀请】',
        content: [
          `《${game || '未知游戏'}》`,
          platformStr ? `平台：${platformStr}` : '',
          '',
          `需要你：${action || '查看邮件详情'}`,
          company ? `来源：${company}` : '',
        ].filter(Boolean).join('\n'),
      };

    case 'deadline_notice':
      return {
        title: '【合作 Deadline】',
        content: [
          `《${game || '未知游戏'}》`,
          '',
          `需要你：${action || '查看邮件详情'}`,
        ].filter(Boolean).join('\n'),
      };

    case 'deadline_reminder':
      return {
        title: '【截止提醒】',
        content: [
          `《${game || '未知游戏'}》`,
          platformStr ? `平台：${platformStr}` : '',
          '',
          summary || '',
          `需要你：${action || '尽快处理'}`,
          company ? `来源：${company}` : '',
        ].filter(Boolean).join('\n'),
      };

    case 'embargo_notice':
    case 'nda_notice': {
      const label = mail_type === 'embargo_notice' ? 'Embargo' : 'NDA';
      return {
        title: `【${label} 通知】`,
        content: [
          `《${game || '未知游戏'}》`,
          summary || '',
          '',
          `需要你：${action || '查看邮件详情'}`,
        ].filter(Boolean).join('\n'),
      };
    }

    default:
      // 通用模板
      return {
        title: title || '【合作邮件提醒】',
        content: [
          summary || '',
          summary ? '' : '',
          `需要你：${action || '查看邮件详情'}`,
        ].filter((line, idx, arr) => {
          // 过滤掉连续空行
          if (line === '' && idx > 0 && arr[idx - 1] === '') return false;
          return true;
        }).join('\n'),
      };
  }
}

// ── 主流程 ───────────────────────────────────────────────────────

async function main() {
  console.log('=== QQ 邮箱合作邮件 Push 云端模块 ===');
  console.log(`[INFO] GITHUB_REF=${process.env.GITHUB_REF || '(local)'}`);
  console.log(`[INFO] APP_ENV=${process.env.APP_ENV || '(not set)'}`);
  console.log(`[INFO] PUSH_TEST=${process.env.PUSH_TEST || '0'}`);

  // 1. 读取 payload
  const payload = loadPayload();
  console.log(`[INFO] mail_type=${payload.mail_type}, priority=${payload.priority}`);
  console.log(`[INFO] title=${payload.title}`);

  // 2. 校验
  const { valid, errors } = validatePayload(payload);
  if (!valid) {
    console.error('[ERROR] payload 校验失败:');
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
  console.log('[INFO] payload 校验通过');

  // 3. 加载去重状态
  const pushState = loadPushState();

  // 4. 去重检查
  if (isDuplicate(payload, pushState)) {
    console.log('[INFO] 检测到重复 Push（message_id_hash + mail_type），跳过');
    process.exit(0);
  }

  // 5. 测试打标
  const isTest = shouldMarkTest();
  let { title, content } = renderPushContent(payload);

  if (isTest) {
    title = `【测试】${title}`;
    console.log('[INFO] 测试模式：标题已添加【测试】标记');
  }

  console.log('--- Push 内容 ---');
  console.log(title);
  console.log(content);
  console.log('------------------');

  // 6. P3 通常不 Push，但仍记录
  if (payload.priority === 'P3') {
    console.log('[INFO] P3 优先级，不执行 Push（仅记录）');
    const updated = addToPushState(payload, pushState);
    savePushState(updated);
    process.exit(0);
  }

  // 7. 并行调用 4 个 provider（每路独立 try/catch，未配置则 skip）
  console.log('[INFO] 开始并行 Push...');

  const providers = [
    { name: '企业微信', fn: () => sendWeCom(title, content, payload.priority) },
    { name: 'WxPusher', fn: () => sendWxPusher(title, content, payload.priority) },
    { name: 'Bark', fn: () => sendBark(title, content, payload.priority) },
    { name: 'ntfy', fn: () => sendNtfy(title, content, payload.priority) },
  ];

  const results = await Promise.allSettled(
    providers.map((p) => p.fn().catch((err) => ({ success: false, error: err.message })))
  );

  // 8. 输出每路结果
  console.log('--- Push 结果 ---');
  let anySuccess = false;
  let anySkipped = false;

  results.forEach((result, idx) => {
    const providerName = providers[idx].name;
    if (result.status === 'fulfilled') {
      const r = result.value;
      if (r.skipped) {
        anySkipped = true;
        console.log(`  [SKIP] ${providerName}: 未配置`);
      } else if (r.success) {
        anySuccess = true;
        console.log(`  [OK]   ${providerName}: 发送成功`);
      } else {
        console.log(`  [FAIL] ${providerName}: ${r.error || '未知错误'}`);
      }
    } else {
      console.log(`  [FAIL] ${providerName}: ${result.reason?.message || '异常'}`);
    }
  });

  // 9. 记录到去重状态（无论成功失败都记录，避免无限重试）
  const updated = addToPushState(payload, pushState);
  savePushState(updated);
  console.log('[INFO] 已更新 push-state.json');

  // 总结
  if (anySuccess) {
    console.log('[DONE] Push 完成（至少一路成功）');
  } else if (anySkipped && !results.some((r) => r.status === 'fulfilled' && r.value && !r.value.skipped && r.value.success === false)) {
    console.log('[DONE] 所有 provider 均未配置，流程正常结束（skip）');
  } else {
    console.log('[WARN] 没有任何 provider 成功发送');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[FATAL] 未捕获异常:', err);
  process.exit(1);
});
