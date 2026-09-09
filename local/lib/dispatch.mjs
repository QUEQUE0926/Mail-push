/**
 * dispatch.mjs — GitHub repository_dispatch
 *
 * 硬约束：
 *   - 重试3次（2s/5s/15s）
 *   - POST 到 https://api.github.com/repos/{owner}/{repo}/dispatches
 *   - 禁止任意 redirect，URL 必须精确匹配 api.github.com
 *   - 请求头：Authorization: token ${GITHUB_TOKEN}, Accept: application/vnd.github+json
 *   - 请求体：{"event_type":"mail-push","client_payload": payload}
 */

import https from 'node:https';

const RETRY_DELAYS = [2000, 5000, 15000]; // 2s, 5s, 15s
const GITHUB_API_HOST = 'api.github.com';

/**
 * 发送 repository_dispatch。
 * @param {object} payload — buildPayload() 的结果
 * @param {{token:string, repo:string}} config — {token: GITHUB_TOKEN, repo: 'owner/repo'}
 * @returns {Promise<{success:boolean, status:number, error?:string}>}
 */
export async function sendDispatch(payload, config) {
  const token = config.token || process.env.GITHUB_TOKEN;
  const repo = config.repo || process.env.GITHUB_REPO;

  if (!token) {
    return { success: false, status: 0, error: 'GITHUB_TOKEN not configured' };
  }
  if (!repo) {
    return { success: false, status: 0, error: 'GITHUB_REPO not configured' };
  }

  // 验证 repo 格式
  const repoMatch = repo.match(/^([^/]+)\/([^/]+)$/);
  if (!repoMatch) {
    return { success: false, status: 0, error: `Invalid GITHUB_REPO format: ${repo}` };
  }
  const owner = repoMatch[1];
  const repoName = repoMatch[2];

  const url = `https://${GITHUB_API_HOST}/repos/${owner}/${repoName}/dispatches`;

  const body = JSON.stringify({
    event_type: 'mail-push',
    client_payload: payload,
  });

  let lastError = null;
  let lastStatus = 0;

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const result = await _doRequest(url, token, body);
      if (result.success) {
        return { success: true, status: result.status };
      }
      lastStatus = result.status;
      lastError = result.error;

      // 4xx 错误（除 429 外）不重试
      if (result.status >= 400 && result.status < 500 && result.status !== 429) {
        break;
      }
    } catch (err) {
      lastError = err.message;
    }

    // 等待后重试
    if (attempt < RETRY_DELAYS.length) {
      await _sleep(RETRY_DELAYS[attempt]);
    }
  }

  return { success: false, status: lastStatus, error: lastError || 'All retries failed' };
}

/**
 * 执行 HTTP 请求（使用 Node 内置 https，禁止 redirect）。
 */
async function _doRequest(url, token, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);

    // 安全检查：URL 必须精确匹配 api.github.com
    if (urlObj.hostname !== GITHUB_API_HOST) {
      reject(new Error(`Refusing to dispatch to non-GitHub host: ${urlObj.hostname}`));
      return;
    }

    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'qq-mail-push/1.0',
      },
      // 禁止 redirect
      maxRedirects: 0,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true, status: res.statusCode });
        } else {
          resolve({
            success: false,
            status: res.statusCode,
            error: `HTTP ${res.statusCode}: ${data.slice(0, 500)}`,
          });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timeout'));
    });

    req.write(body);
    req.end();
  });
}

/** sleep 辅助 */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
