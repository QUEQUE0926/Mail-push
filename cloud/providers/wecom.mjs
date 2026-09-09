/**
 * providers/wecom.mjs — 企业微信群机器人
 *
 * 使用 text 格式（不用 markdown），POST JSON 到 webhook。
 * 未配置 WECOM_WEBHOOK 时返回 skipped，不抛异常。
 */
import https from 'node:https';
import { URL } from 'node:url';

/**
 * 发送企业微信消息。
 * @param {string} title - 消息标题
 * @param {string} content - 消息正文
 * @param {string} priority - P0/P1/P2/P3（当前不影响企业微信格式）
 * @returns {Promise<{success:boolean, skipped?:boolean, error?:string}>}
 */
export async function sendWeCom(title, content, priority) {
  const webhook = process.env.WECOM_WEBHOOK;

  // 未配置则跳过
  if (!webhook || webhook.trim().length === 0) {
    return { skipped: true };
  }

  try {
    const body = JSON.stringify({
      msgtype: 'text',
      text: {
        content: `${title}\n\n${content}`,
      },
    });

    const result = await httpsPost(webhook, body, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });

    // 企业微信返回 errcode=0 表示成功
    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch {
      parsed = {};
    }

    if (parsed.errcode === 0) {
      return { success: true };
    }
    return {
      success: false,
      error: `企业微信返回 errcode=${parsed.errcode}, errmsg=${parsed.errmsg || 'unknown'}`,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 内置 https POST（零外部依赖）。
 * @param {string} urlStr
 * @param {string} body
 * @param {object} headers
 * @returns {Promise<string>}
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
