/**
 * providers/wxpusher.mjs — WxPusher
 *
 * POST 到 https://wxpusher.zjiecode.com/api/send/message
 * 环境变量：WXPUSHER_APP_TOKEN, WXPUSHER_UIDS（逗号分隔）
 */
import https from 'node:https';

const WXPUSHER_API = 'https://wxpusher.zjiecode.com/api/send/message';

/**
 * 发送 WxPusher 消息。
 * @param {string} title
 * @param {string} content
 * @param {string} priority
 * @returns {Promise<{success:boolean, skipped?:boolean, error?:string}>}
 */
export async function sendWxPusher(title, content, priority) {
  const appToken = process.env.WXPUSHER_APP_TOKEN;
  const uidsRaw = process.env.WXPUSHER_UIDS;

  // 未配置则跳过
  if (!appToken || !uidsRaw || uidsRaw.trim().length === 0) {
    return { skipped: true };
  }

  try {
    const uids = uidsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (uids.length === 0) {
      return { skipped: true };
    }

    const body = JSON.stringify({
      appToken,
      content: `${title}\n\n${content}`,
      contentType: 1, // 1 = 文本
      uids,
    });

    const result = await httpsPost(WXPUSHER_API, body, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });

    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch {
      parsed = {};
    }

    // WxPusher code=1000 表示成功
    if (parsed.code === 1000) {
      return { success: true };
    }
    return {
      success: false,
      error: `WxPusher 返回 code=${parsed.code}, msg=${parsed.msg || 'unknown'}`,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 内置 https POST（零外部依赖）。
 */
function httpsPost(urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers,
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

    req.write(body);
    req.end();
  });
}
