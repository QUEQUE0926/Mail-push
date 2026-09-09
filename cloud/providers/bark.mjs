/**
 * providers/bark.mjs — Bark
 *
 * GET 请求到 {BARK_SERVER}/{BARK_KEY}/{title}/{content}?group=...&level=...
 * 环境变量：BARK_SERVER（如 https://api.day.app）, BARK_KEY
 */
import https from 'node:https';
import { URL } from 'node:url';

/**
 * 优先级到 Bark level 的映射。
 * P0→active, P1→active, P2→active, P3→passive
 */
function priorityToBarkLevel(priority) {
  if (priority === 'P3') return 'passive';
  return 'active'; // P0, P1, P2
}

/**
 * 发送 Bark 消息。
 * @param {string} title
 * @param {string} content
 * @param {string} priority
 * @returns {Promise<{success:boolean, skipped?:boolean, error?:string}>}
 */
export async function sendBark(title, content, priority) {
  const server = process.env.BARK_SERVER;
  const key = process.env.BARK_KEY;

  // 未配置则跳过
  if (!server || !key || server.trim().length === 0 || key.trim().length === 0) {
    return { skipped: true };
  }

  try {
    // 判断是否测试消息（标题以【测试】开头）
    const isTest = title.startsWith('【测试】');
    const group = isTest ? 'QQ邮箱合作提醒·测试' : 'QQ邮箱合作提醒';
    const level = priorityToBarkLevel(priority);

    // URL 编码 title 和 content
    const encodedTitle = encodeURIComponent(title);
    const encodedContent = encodeURIComponent(content);

    // 去掉 server 末尾的 /
    const base = server.replace(/\/+$/, '');
    const urlStr = `${base}/${key}/${encodedTitle}/${encodedContent}?group=${encodeURIComponent(group)}&level=${level}`;

    const result = await httpsGet(urlStr);

    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch {
      parsed = {};
    }

    // Bark 返回 code=200 表示成功
    if (parsed.code === 200) {
      return { success: true };
    }
    return {
      success: false,
      error: `Bark 返回 code=${parsed.code}, message=${parsed.message || 'unknown'}`,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 内置 https GET（零外部依赖）。
 */
function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'GET',
      timeout: 15000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('请求超时（15s）'));
    });

    req.end();
  });
}
