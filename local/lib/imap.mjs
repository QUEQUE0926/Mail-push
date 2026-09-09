/**
 * imap.mjs — 手写 IMAP 客户端（零外部依赖）
 *
 * 使用 Node 内置 tls 模块连接 QQ IMAP (imap.qq.com:993 SSL)。
 * 所有 FETCH 使用 BODY.PEEK，绝不修改已读状态。
 * 所有搜索/拉取使用 UID 前缀。
 *
 * 导出：
 *   connectImap(config) → ImapClient
 *   ImapClient 类
 */

import tls from 'node:tls';

// ─── IMAP 响应解析器 ───────────────────────────────────────────────
/**
 * 从 socket 数据中解析完整的 IMAP 响应（含 literal）。
 * IMAP literal 格式：{<octets>}\r\n 后跟 exactly octets 字节。
 * 响应以 tagged 行（如 A001 OK ...）结束。
 */
class ImapResponseParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /** 追加数据 */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  /**
   * 尝试解析一个完整响应。
   * 返回 { lines: string[], done: boolean } 或 null（数据不足）。
   * lines 中的 literal 已展开为完整字符串。
   */
  tryParse() {
    let pos = 0;
    const lines = [];
    const buf = this.buffer;

    while (pos < buf.length) {
      // 查找行尾 \r\n
      const crlf = buf.indexOf('\r\n', pos);
      if (crlf === -1) break; // 数据不足，跳出循环，返回已解析的行

      let line = buf.slice(pos, crlf).toString('binary');
      const nextPos = crlf + 2;

      // 检测 literal：行末是否有 {N}
      const literalMatch = line.match(/\{(\d+)\}$/);
      if (literalMatch) {
        const octets = parseInt(literalMatch[1], 10);
        // 需要 octets 字节 + 后续 \r\n
        if (nextPos + octets > buf.length) break; // 数据不足，跳出
        const literalData = buf.slice(nextPos, nextPos + octets).toString('binary');
        pos = nextPos + octets;
        // literal 后通常跟 \r\n，但也可能直接接更多数据
        // 把 literal 附加到当前行
        line = line + literalData;
        // 跳过 literal 后的 \r\n（如果存在）
        if (pos + 1 < buf.length && buf[pos] === 0x0d && buf[pos + 1] === 0x0a) {
          pos += 2;
        }
      } else {
        pos = nextPos;
      }

      lines.push(line);

      // 检测 tagged 响应结束（A001 OK / A001 NO / A001 BAD / A001 BYE）
      if (/^A\d+\s+(OK|NO|BAD|BYE)\b/i.test(line)) {
        // 完整响应结束
        this.buffer = buf.slice(pos);
        return { lines, done: true };
      }
    }

    // 如果有完整的行，就返回（不需要等到 tagged 响应）
    // 这修复了 greeting（* OK）无法被解析的问题
    if (lines.length > 0) {
      this.buffer = buf.slice(pos);
      return { lines, done: false };
    }

    return null; // 还没有完整的行
  }
}

// ─── ImapClient ────────────────────────────────────────────────────

export class ImapClient {
  constructor(config) {
    this.host = config.host || 'imap.qq.com';
    this.port = config.port || 993;
    this.user = config.user;
    this.password = config.password; // QQ 邮箱授权码
    this.socket = null;
    this.tagCounter = 0;
    this.parser = new ImapResponseParser();
    this.responseQueue = [];
    this.waitingResolve = null;
    this.connected = false;
    this._onData = this._onData.bind(this);
  }

  /** 生成下一个命令标签 */
  _nextTag() {
    return 'A' + (++this.tagCounter).toString().padStart(3, '0');
  }

  /** 连接并登录 */
  async connect() {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: this.host,
        port: this.port,
        servername: this.host,
      });

      socket.setEncoding('binary');
      this.socket = socket;

      const timeout = setTimeout(() => {
        reject(new Error('IMAP connection timeout'));
        socket.destroy();
      }, 15000);

      socket.once('secureConnect', () => {
        clearTimeout(timeout);
      });

      socket.on('data', this._onData);
      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      // 等待服务器 greeting（* OK ...）
      this._waitResponse().then(() => {
        this.connected = true;
        // 登录
        return this._command(`LOGIN "${this._escape(this.user)}" "${this._escape(this.password)}"`);
      }).then(() => {
        resolve(this);
      }).catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /** 转义 IMAP 字符串中的双引号和反斜杠 */
  _escape(str) {
    return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /** 数据到达回调 */
  _onData(chunk) {
    this.parser.push(Buffer.from(chunk, 'binary'));
    // 尝试解析所有完整响应
    while (true) {
      const result = this.parser.tryParse();
      if (!result) break;
      if (this.waitingResolve) {
        const resolve = this.waitingResolve;
        this.waitingResolve = null;
        resolve(result.lines);
      } else {
        this.responseQueue.push(result.lines);
      }
    }
  }

  /** 等待下一个完整响应 */
  _waitResponse() {
    return new Promise((resolve) => {
      if (this.responseQueue.length > 0) {
        resolve(this.responseQueue.shift());
      } else {
        this.waitingResolve = resolve;
      }
    });
  }

  /**
   * 发送命令并等待 tagged 响应。
   * 返回所有响应行（含 untagged）。
   */
  async _command(cmd) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('IMAP socket not connected');
    }
    const tag = this._nextTag();
    const fullCmd = `${tag} ${cmd}\r\n`;
    this.socket.write(fullCmd, 'binary');

    // 收集所有响应行直到匹配该 tag 的结束行
    const allLines = [];
    while (true) {
      const lines = await this._waitResponse();
      allLines.push(...lines);
      // 检查是否有该 tag 的结束
      const tagRegex = new RegExp(`^${tag}\\s+(OK|NO|BAD|BYE)`, 'i');
      const endLine = lines.find((l) => tagRegex.test(l));
      if (endLine) {
        if (/^A\d+\s+(NO|BAD)/i.test(endLine)) {
          throw new Error(`IMAP command failed: ${endLine}`);
        }
        break;
      }
    }
    return allLines;
  }

  /**
   * SELECT 邮箱
   * 返回 { uidvalidity, exists }
   */
  async select(mailbox) {
    const lines = await this._command(`SELECT "${this._escape(mailbox)}"`);
    let uidvalidity = 0;
    let exists = 0;
    for (const line of lines) {
      const m1 = line.match(/\[UIDVALIDITY (\d+)\]/i);
      if (m1) uidvalidity = parseInt(m1[1], 10);
      const m2 = line.match(/^\* (\d+) EXISTS/i);
      if (m2) exists = parseInt(m2[1], 10);
    }
    return { uidvalidity, exists };
  }

  /**
   * UID SEARCH SINCE <date>
   * date: Date 对象
   * 返回 UID[]
   */
  async searchSince(date) {
    const imapDate = this._formatImapDate(date);
    const lines = await this._command(`UID SEARCH SINCE ${imapDate}`);
    const uids = [];
    for (const line of lines) {
      const m = line.match(/^\* SEARCH (.*)$/i);
      if (m) {
        const parts = m[1].trim().split(/\s+/).filter(Boolean);
        for (const p of parts) {
          const n = parseInt(p, 10);
          if (!isNaN(n)) uids.push(n);
        }
      }
    }
    return uids;
  }

  /**
   * UID SEARCH ALL — 获取所有 UID
   */
  async searchAll() {
    const lines = await this._command('UID SEARCH ALL');
    const uids = [];
    for (const line of lines) {
      const m = line.match(/^\* SEARCH (.*)$/i);
      if (m) {
        const parts = m[1].trim().split(/\s+/).filter(Boolean);
        for (const p of parts) {
          const n = parseInt(p, 10);
          if (!isNaN(n)) uids.push(n);
        }
      }
    }
    return uids;
  }

  /**
   * 两阶段读取第一阶段：FETCH BODY.PEEK[HEADER.FIELDS (...)]
   * 返回 [{uid, from, date, subject, messageId, authResults, rawHeaders}]
   */
  async fetchHeaders(uids) {
    if (uids.length === 0) return [];
    const uidSet = this._uidSet(uids);
    const lines = await this._command(
      `UID FETCH ${uidSet} (UID BODY.PEEK[HEADER.FIELDS (FROM DATE SUBJECT MESSAGE-ID AUTHENTICATION-RESULTS RECEIVED-SPF)])`
    );
    return this._parseFetchHeaders(lines);
  }

  /**
   * 两阶段读取第二阶段：FETCH BODY.PEEK[] 读完整正文
   * 返回 raw RFC822 string
   */
  async fetchBody(uid) {
    const lines = await this._command(`UID FETCH ${uid} (BODY.PEEK[])`);
    // 从响应中提取完整邮件内容
    for (const line of lines) {
      // BODY[] 响应格式：* 123 FETCH (BODY[] {N}\r\n<content>\r\n)
      const m = line.match(/BODY\[\]\s*\{(\d+)\}/i);
      if (m) {
        // literal 数据已被 parser 展开，提取 {N} 之后的内容
        const idx = line.indexOf('{' + m[1] + '}') + m[1].length + 2;
        let content = line.slice(idx);
        // 去掉末尾的 ) 和 \r\n
        content = content.replace(/\)\s*$/, '').replace(/\r\n$/, '');
        return content;
      }
    }
    // 备选：有些服务器返回 BODY[]<literal> 不带空格
    for (const line of lines) {
      const m = line.match(/BODY\[\]\{(\d+)\}/i);
      if (m) {
        const idx = line.indexOf('{' + m[1] + '}') + m[1].length + 2;
        let content = line.slice(idx);
        content = content.replace(/\)\s*$/, '').replace(/\r\n$/, '');
        return content;
      }
    }
    throw new Error(`Could not extract body for UID ${uid}`);
  }

  /** 解析 FETCH HEADER 响应 */
  _parseFetchHeaders(lines) {
    const results = [];
    let current = null;

    for (const line of lines) {
      // 新 FETCH 响应开始：* 123 FETCH (UID 456 BODY.PEEK[HEADER.FIELDS (...)] {N}\r\n<headers>
      const fetchMatch = line.match(/^\* (\d+) FETCH \(UID (\d+)/i);
      if (fetchMatch) {
        if (current) results.push(current);
        current = {
          seq: parseInt(fetchMatch[1], 10),
          uid: parseInt(fetchMatch[2], 10),
          rawHeaders: '',
        };
        // 检查本行是否包含 header literal
        const headerMatch = line.match(/BODY\.PEEK\[HEADER\.FIELDS[^\]]*\]\s*\{(\d+)\}/i);
        if (headerMatch) {
          const idx = line.indexOf('{' + headerMatch[1] + '}') + headerMatch[1].length + 2;
          current.rawHeaders = line.slice(idx);
        } else {
          const headerMatch2 = line.match(/BODY\.PEEK\[HEADER\.FIELDS[^\]]*\]\{(\d+)\}/i);
          if (headerMatch2) {
            const idx = line.indexOf('{' + headerMatch2[1] + '}') + headerMatch2[1].length + 2;
            current.rawHeaders = line.slice(idx);
          }
        }
      } else if (current) {
        // 续行（literal 数据跨多行时已被合并，但保险起见追加）
        if (!/^A\d+\s+OK/i.test(line)) {
          current.rawHeaders += (current.rawHeaders ? '\r\n' : '') + line;
        }
      }
    }
    if (current) results.push(current);

    // 解析每个 header 块
    return results.map((r) => {
      const parsed = this._parseHeaderBlock(r.rawHeaders);
      return {
        uid: r.uid,
        from: parsed.from,
        date: parsed.date,
        subject: parsed.subject,
        messageId: parsed.messageId,
        authResults: parsed.authResults,
        receivedSpf: parsed.receivedSpf,
      };
    });
  }

  /** 解析 header 文本块 */
  _parseHeaderBlock(raw) {
    const result = { from: '', date: '', subject: '', messageId: '', authResults: '', receivedSpf: '' };
    if (!raw) return result;

    // 展开 folded headers（行首空白表示续行）
    const unfolded = raw.replace(/\r\n[ \t]+/g, ' ');
    const lines = unfolded.split(/\r\n/);

    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      if (key === 'from') result.from = value;
      else if (key === 'date') result.date = value;
      else if (key === 'subject') result.subject = value;
      else if (key === 'message-id') result.messageId = value;
      else if (key === 'authentication-results') result.authResults = value;
      else if (key === 'received-spf') result.receivedSpf = value;
    }
    return result;
  }

  /** 格式化 IMAP 日期：DD-Mon-YYYY */
  _formatImapDate(date) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const d = date.getDate();
    const m = months[date.getMonth()];
    const y = date.getFullYear();
    return `${d}-${m}-${y}`;
  }

  /** 构建 UID 集合字符串（如 1,2,3 或 1:5） */
  _uidSet(uids) {
    if (uids.length === 1) return String(uids[0]);
    // 简单起见用逗号分隔（QQ IMAP 支持）
    return uids.join(',');
  }

  /** LOGOUT 并关闭连接 */
  async logout() {
    try {
      await this._command('LOGOUT');
    } catch (_) {
      // LOGOUT 可能直接断开，忽略错误
    }
    if (this.socket) {
      this.socket.removeListener('data', this._onData);
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }
}

/**
 * 连接 IMAP 服务器
 * @param {{host?:string, port?:number, user:string, password:string}} config
 * @returns {Promise<ImapClient>}
 */
export async function connectImap(config) {
  const client = new ImapClient(config);
  await client.connect();
  return client;
}
