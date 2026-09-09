/**
 * providers/ntfy.mjs — ntfy
 *
 * POST 到 {NTFY_SERVER}/{NTFY_TOPIC}
 * Header: Title={title}, Priority={4|5}
 * 环境变量：NTFY_SERVER（默认 https://ntfy.sh）, NTFY_TOPIC
 */
import https from 'node:https';
import { URL } from 'node:url';

/**
 * 优先级到 ntfy priority 的映射。
 * P0/P1→5, P2→4, P3→3（默认）
 */
function priorityToNtfy(priority) {
  if (priority === 'P0' || priority === 'P1') return 5;
  if (priority === 'P2') return 4;
  return 3; // P3
}

/**
 * 发送 ntfy 消息。
 * @param {string} title
 * @param {string} content
 * @param {string} priority
 * @returns {Promise<{success:boolean, skipped?:boolean, error?:string}>}
 */
export async function sendNtfy(title, content, priority) {
  const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
  const topic = process.env.NTFY_TOPIC;

  // 未配置 topic 则跳过
  if (!topic || topic.trim().length === 0) {
    return { skipped: true };
  }

  try {
    const base = server.replace(/\/+$/, '');
    const urlStr = `${base}/${topic}`;
    const ntfyPriority = priorityToNtfy(priority);

    const result = await httpsPost(urlStr, content, {
      Title: title,
      Priority: String(ntfyPriority),
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(content),
    });

    // ntfy 成功返回 JSON 含 id 字段，HTTP 200
    // 这里简单判断返回内容非空即可（ntfy 返回 JSON）
    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch {
      parsed = null;
    }

    if (parsed && parsed.id) {
      return { success: true };
    }
    return {
      success: false,
      error: `ntfy 返回异常: ${result.substring(0, 200)}`,
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
