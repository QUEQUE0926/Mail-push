/**
 * parser.mjs — MIME / HTML / 编码解析 + SPF/DKIM/DMARC 解析
 *
 * 零外部依赖，轻量 MIME 解析器。
 * 支持：
 *   - 多部分 (multipart/*) 递归解析
 *   - base64 / quoted-printable 解码
 *   - header 编码 (=?UTF-8?B?...?= / =?UTF-8?Q?...?=)
 *   - HTML 转纯文本（正则去标签）
 *   - Authentication-Results / Received-SPF 解析
 */

// ─── Header 编码解码 ───────────────────────────────────────────────

/**
 * 解码 RFC 2047 编码的 header 值。
 * 支持 =?UTF-8?B?base64?= 和 =?UTF-8?Q?quoted-printable?=
 * 多个编码段自动拼接。
 */
export function decodeHeaderValue(str) {
  if (!str) return '';
  // 匹配 =?charset?encoding?data?=
  const regex = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  let result = '';
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(str)) !== null) {
    // 编码段之间的空白（RFC 2047 允许折叠）
    const between = str.slice(lastIndex, match.index);
    if (between.trim() !== '') {
      result += between;
    }
    const charset = match[1].toUpperCase();
    const encoding = match[2].toUpperCase();
    const data = match[3];

    try {
      if (encoding === 'B') {
        const buf = Buffer.from(data, 'base64');
        result += decodeBuffer(buf, charset);
      } else {
        // Q encoding: _ = space, =XX = hex byte
        const qDecoded = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => {
          return String.fromCharCode(parseInt(hex, 16));
        });
        const buf = Buffer.from(qDecoded, 'binary');
        result += decodeBuffer(buf, charset);
      }
    } catch (_) {
      result += data; // 解码失败则保留原文
    }
    lastIndex = regex.lastIndex;
  }
  result += str.slice(lastIndex);
  return result;
}

/** 根据 charset 解码 Buffer */
function decodeBuffer(buf, charset) {
  const cs = charset.toUpperCase();
  if (cs === 'UTF-8' || cs === 'UTF8') return buf.toString('utf8');
  if (cs === 'ISO-8859-1' || cs === 'LATIN1' || cs === 'US-ASCII' || cs === 'ASCII') {
    return buf.toString('latin1');
  }
  // 其他编码尝试用 utf8 兜底
  try {
    return buf.toString('utf8');
  } catch (_) {
    return buf.toString('latin1');
  }
}

// ─── Quoted-Printable 解码 ─────────────────────────────────────────

function decodeQuotedPrintable(str, charset) {
  // 移除软换行（行末 =）
  let cleaned = str.replace(/=\r?\n/g, '');
  // 解码 =XX
  const binary = cleaned.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  const buf = Buffer.from(binary, 'binary');
  return decodeBuffer(buf, charset || 'UTF-8');
}

// ─── HTML 转纯文本 ─────────────────────────────────────────────────

/**
 * HTML 转纯文本（正则去标签）。
 * 处理：<script>/<style> 内容移除、块级元素换行、实体解码。
 */
export function htmlToText(html) {
  if (!html) return '';
  let text = html;

  // 移除 <script> 和 <style> 及其内容
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ');

  // 块级元素前后加换行
  const blockTags = ['p','div','br','li','tr','h1','h2','h3','h4','h5','h6','blockquote','pre','table','ul','ol','dl','dt','dd','header','footer','section','article','aside','nav','figure','figcaption','hr'];
  for (const tag of blockTags) {
    const re = new RegExp(`<\\/?${tag}[^>]*>`, 'gi');
    text = text.replace(re, '\n');
  }

  // <br> 特殊处理（上面已处理）
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // 移除剩余所有标签
  text = text.replace(/<[^>]+>/g, '');

  // 解码 HTML 实体
  text = decodeHtmlEntities(text);

  // 合并多余空白（保留换行）
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}

/** 解码常见 HTML 实体 */
function decodeHtmlEntities(str) {
  const entities = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&apos;': "'", '&nbsp;': ' ', '&copy;': '©', '&reg;': '®',
    '&trade;': '™', '&hellip;': '…', '&mdash;': '—', '&ndash;': '–',
    '&lsquo;': "'", '&rsquo;': "'", '&ldquo;': '"', '&rdquo;': '"',
    '&bull;': '•', '&middot;': '·', '&sect;': '§', '&para;': '¶',
    '&dagger;': '†', '&Dagger;': '‡', '&permil;': '‰', '&prime;': '′',
    '&Prime;': '″', '&lsaquo;': '‹', '&rsaquo;': '›', '&oline;': '‾',
    '&frasl;': '⁄', '&weierp;': '℘', '&image;': 'ℑ', '&real;': 'ℜ',
    '&alefsym;': 'ℵ', '&spades;': '♠', '&clubs;': '♣', '&hearts;': '♥',
    '&diams;': '♦', '&forall;': '∀', '&part;': '∂', '&exists;': '∃',
    '&empty;': '∅', '&nabla;': '∇', '&isin;': '∈', '&notin;': '∉',
    '&ni;': '∋', '&prod;': '∏', '&sum;': '∑', '&minus;': '−',
    '&lowast;': '∗', '&radic;': '√', '&prop;': '∝', '&infin;': '∞',
    '&ang;': '∠', '&and;': '∧', '&or;': '∨', '&cap;': '∩', '&cup;': '∪',
    '&int;': '∫', '&there4;': '∴', '&sim;': '∼', '&cong;': '≅',
    '&asymp;': '≈', '&ne;': '≠', '&equiv;': '≡', '&le;': '≤', '&ge;': '≥',
    '&sub;': '⊂', '&sup;': '⊃', '&nsub;': '⊄', '&sube;': '⊆',
    '&supe;': '⊇', '&oplus;': '⊕', '&otimes;': '⊗', '&perp;': '⊥',
    '&sdot;': '⋅', '&lceil;': '⌈', '&rceil;': '⌉', '&lfloor;': '⌊',
    '&rfloor;': '⌋', '&loz;': '◊', '&spades;': '♠',
  };
  let result = str;
  for (const [entity, char] of Object.entries(entities)) {
    result = result.split(entity).join(char);
    result = result.split(entity.toUpperCase()).join(char);
  }
  // 数字实体 &#NNN; 和 &#xHHHH;
  result = result.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
  result = result.replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  return result;
}

// ─── 邮件地址解析 ───────────────────────────────────────────────────

/**
 * 解析 From 等地址头。
 * 支持 "Name <email@domain>" 和 <email@domain> 和纯 email 格式。
 * 返回 {name, email, domain}
 */
export function parseAddress(headerValue) {
  if (!headerValue) return { name: '', email: '', domain: '' };
  const decoded = decodeHeaderValue(headerValue);

  // 匹配 <email>
  const angleMatch = decoded.match(/<([^>]+)>/);
  let email = '';
  let name = '';
  if (angleMatch) {
    email = angleMatch[1].trim();
    name = decoded.replace(/<[^>]+>/, '').trim().replace(/^["']|["']$/g, '');
  } else {
    // 纯 email
    const pureMatch = decoded.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/);
    if (pureMatch) {
      email = pureMatch[1].trim();
      name = '';
    } else {
      email = decoded.trim();
    }
  }

  const domain = email.includes('@') ? email.split('@')[1].toLowerCase() : '';
  return { name, email: email.toLowerCase(), domain };
}

// ─── MIME 解析 ──────────────────────────────────────────────────────

/**
 * 解析完整原始邮件（RFC822）。
 * 返回结构化对象。
 */
export function parseEmail(raw) {
  if (!raw) {
    return _emptyParsed();
  }

  // 分离 header 和 body（第一个空行）
  const headerEnd = raw.indexOf('\r\n\r\n');
  let headerText, bodyText;
  if (headerEnd === -1) {
    // 尝试 \n\n
    const headerEnd2 = raw.indexOf('\n\n');
    if (headerEnd2 === -1) {
      headerText = raw;
      bodyText = '';
    } else {
      headerText = raw.slice(0, headerEnd2);
      bodyText = raw.slice(headerEnd2 + 2);
    }
  } else {
    headerText = raw.slice(0, headerEnd);
    bodyText = raw.slice(headerEnd + 4);
  }

  // 解析 headers
  const headers = parseHeaders(headerText);

  // 解析 content-type
  const contentType = headers['content-type'] || 'text/plain; charset=utf-8';
  const { mimeType, boundary, charset } = parseContentType(contentType);

  // 解析 content-transfer-encoding
  const transferEncoding = (headers['content-transfer-encoding'] || '').toLowerCase().trim();

  let textBody = '';
  let htmlBody = '';
  let hasAttachment = false;

  if (mimeType.startsWith('multipart/')) {
    // 多部分：递归解析每个 part
    const parts = splitMultipart(bodyText, boundary);
    for (const part of parts) {
      const partResult = parseMimePart(part);
      if (partResult.mimeType === 'text/plain' && !textBody) {
        textBody = partResult.content;
      } else if (partResult.mimeType === 'text/html' && !htmlBody) {
        htmlBody = partResult.content;
      }
      if (partResult.isAttachment) hasAttachment = true;
    }
  } else {
    // 单部分
    const decoded = decodeContent(bodyText, transferEncoding, charset);
    if (mimeType === 'text/html') {
      htmlBody = decoded;
    } else {
      textBody = decoded;
    }
  }

  // 如果没有 textBody 但有 htmlBody，转换之
  if (!textBody && htmlBody) {
    textBody = htmlToText(htmlBody);
  }

  // 解析认证结果
  const auth = parseAuthResults(headers['authentication-results'], headers['received-spf']);

  // 解析日期
  const date = parseDate(headers['date']);

  // 解析 From
  const from = parseAddress(headers['from']);
  const to = parseAddressList(headers['to']);
  const cc = parseAddressList(headers['cc']);

  return {
    from,
    to,
    cc,
    subject: decodeHeaderValue(headers['subject'] || ''),
    date,
    dateRaw: headers['date'] || '',
    messageId: (headers['message-id'] || '').trim(),
    textBody,
    htmlBody,
    hasAttachment,
    mimeType,
    headers,
    auth,
  };
}

function _emptyParsed() {
  return {
    from: { name: '', email: '', domain: '' },
    to: [],
    cc: [],
    subject: '',
    date: null,
    dateRaw: '',
    messageId: '',
    textBody: '',
    htmlBody: '',
    hasAttachment: false,
    mimeType: 'text/plain',
    headers: {},
    auth: { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', status: 'unknown' },
  };
}

/** 解析 header 文本为对象（key 小写） */
function parseHeaders(headerText) {
  const headers = {};
  // 展开 folded headers
  const unfolded = headerText.replace(/\r\n[ \t]+/g, ' ').replace(/\n[ \t]+/g, ' ');
  const lines = unfolded.split(/\r?\n/);
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    // 同名 header 保留第一个（或拼接）
    if (!headers[key]) {
      headers[key] = value;
    } else {
      headers[key] += ', ' + value;
    }
  }
  return headers;
}

/** 解析 Content-Type */
function parseContentType(ct) {
  const result = { mimeType: 'text/plain', boundary: null, charset: 'utf-8' };
  if (!ct) return result;
  const semiIdx = ct.indexOf(';');
  if (semiIdx === -1) {
    result.mimeType = ct.trim().toLowerCase();
    return result;
  }
  result.mimeType = ct.slice(0, semiIdx).trim().toLowerCase();
  const params = ct.slice(semiIdx + 1);
  const boundaryMatch = params.match(/boundary\s*=\s*"?([^";]+)"?/i);
  if (boundaryMatch) result.boundary = boundaryMatch[1].trim();
  const charsetMatch = params.match(/charset\s*=\s*"?([^";]+)"?/i);
  if (charsetMatch) result.charset = charsetMatch[1].trim();
  return result;
}

/** 分割 multipart 为各部分 */
function splitMultipart(body, boundary) {
  if (!boundary) return [];
  const delimiter = '--' + boundary;
  const parts = [];
  // 按 delimiter 分割
  const segments = body.split(delimiter);
  // 第一个 segment 是 preamble（忽略），最后一个是 --（结束标记，忽略）
  for (let i = 1; i < segments.length; i++) {
    let seg = segments[i];
    // 去掉开头的 \r\n
    if (seg.startsWith('\r\n')) seg = seg.slice(2);
    else if (seg.startsWith('\n')) seg = seg.slice(1);
    // 去掉结尾的 \r\n
    if (seg.endsWith('\r\n')) seg = seg.slice(0, -2);
    else if (seg.endsWith('\n')) seg = seg.slice(0, -1);
    // 结束标记
    if (seg.trim() === '--') continue;
    if (seg.trim() === '') continue;
    parts.push(seg);
  }
  return parts;
}

/** 解析单个 MIME part */
function parseMimePart(partRaw) {
  const headerEnd = partRaw.indexOf('\r\n\r\n');
  let headerText, bodyText;
  if (headerEnd === -1) {
    const headerEnd2 = partRaw.indexOf('\n\n');
    if (headerEnd2 === -1) {
      headerText = partRaw;
      bodyText = '';
    } else {
      headerText = partRaw.slice(0, headerEnd2);
      bodyText = partRaw.slice(headerEnd2 + 2);
    }
  } else {
    headerText = partRaw.slice(0, headerEnd);
    bodyText = partRaw.slice(headerEnd + 4);
  }

  const headers = parseHeaders(headerText);
  const contentType = headers['content-type'] || 'text/plain; charset=utf-8';
  const { mimeType, charset } = parseContentType(contentType);
  const transferEncoding = (headers['content-transfer-encoding'] || '').toLowerCase().trim();
  const contentDisposition = (headers['content-disposition'] || '').toLowerCase();
  const isAttachment = contentDisposition.includes('attachment') ||
    (mimeType !== 'text/plain' && mimeType !== 'text/html' && !mimeType.startsWith('multipart/'));

  // 递归处理嵌套 multipart
  if (mimeType.startsWith('multipart/')) {
    const { boundary } = parseContentType(contentType);
    const subParts = splitMultipart(bodyText, boundary);
    let content = '';
    for (const sp of subParts) {
      const r = parseMimePart(sp);
      if (r.mimeType === 'text/plain' && !content) content = r.content;
    }
    return { mimeType: 'text/plain', content, isAttachment: false };
  }

  const content = decodeContent(bodyText, transferEncoding, charset);
  return { mimeType, content, isAttachment };
}

/** 根据 transfer-encoding 解码内容 */
function decodeContent(bodyText, transferEncoding, charset) {
  try {
    if (transferEncoding === 'base64') {
      // 移除空白后解码
      const cleaned = bodyText.replace(/\s/g, '');
      const buf = Buffer.from(cleaned, 'base64');
      return decodeBuffer(buf, charset);
    } else if (transferEncoding === 'quoted-printable') {
      return decodeQuotedPrintable(bodyText, charset);
    } else {
      // 7bit / 8bit / binary: bodyText 已经是正确的 JS 字符串
      // （从 UTF-8 文件读取，或从 IMAP literal 读取）
      // 仅当 charset 不是 UTF-8 时尝试转换
      const cs = (charset || 'utf-8').toUpperCase();
      if (cs !== 'UTF-8' && cs !== 'UTF8' && cs !== 'US-ASCII' && cs !== 'ASCII') {
        try {
          // 用 latin1 取字节再按目标 charset 解码
          const buf = Buffer.from(bodyText, 'binary');
          return decodeBuffer(buf, charset);
        } catch (_) {
          return bodyText;
        }
      }
      return bodyText;
    }
  } catch (_) {
    return bodyText; // 解码失败返回原文
  }
}

// ─── 日期解析 ───────────────────────────────────────────────────────

/**
 * 解析 RFC 2822 日期。
 * 返回 Date 对象或 null。
 */
export function parseDate(dateStr) {
  if (!dateStr) return null;
  try {
    // 移除注释和多余空白
    const cleaned = dateStr.replace(/\([^)]*\)/g, '').trim();
    const d = new Date(cleaned);
    if (isNaN(d.getTime())) return null;
    return d;
  } catch (_) {
    return null;
  }
}

// ─── 地址列表解析 ───────────────────────────────────────────────────

function parseAddressList(headerValue) {
  if (!headerValue) return [];
  const decoded = decodeHeaderValue(headerValue);
  // 按逗号分割（但要注意引号内的逗号）
  const addresses = [];
  let current = '';
  let inQuotes = false;
  for (const ch of decoded) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) {
      if (current.trim()) addresses.push(parseAddress(current.trim()));
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) addresses.push(parseAddress(current.trim()));
  return addresses;
}

// ─── SPF / DKIM / DMARC 解析 ────────────────────────────────────────

/**
 * 解析 Authentication-Results 和 Received-SPF header。
 * 返回 {spf, dkim, dmarc, status}
 * status: pass | fail | unknown
 */
export function parseAuthResults(authResultsHeader, receivedSpfHeader) {
  const result = { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', status: 'unknown' };

  // 解析 Authentication-Results
  if (authResultsHeader) {
    const decoded = decodeHeaderValue(authResultsHeader);
    // spf=pass / spf=fail / spf=softfail / spf=neutral / spf=none / spf=temperror / spf=permerror
    const spfMatch = decoded.match(/\bspf\s*=\s*(pass|fail|softfail|neutral|none|temperror|permerror)\b/i);
    if (spfMatch) result.spf = spfMatch[1].toLowerCase();

    // dkim=pass / dkim=fail / dkim=none
    const dkimMatch = decoded.match(/\bdkim\s*=\s*(pass|fail|none|policy|neutral)\b/i);
    if (dkimMatch) result.dkim = dkimMatch[1].toLowerCase();

    // dmarc=pass / dmarc=fail / dmarc=none
    const dmarcMatch = decoded.match(/\bdmarc\s*=\s*(pass|fail|none|bestguesspass)\b/i);
    if (dmarcMatch) result.dmarc = dmarcMatch[1].toLowerCase();
  }

  // 解析 Received-SPF（如果 Authentication-Results 没有 spf）
  if (result.spf === 'unknown' && receivedSpfHeader) {
    const decoded = decodeHeaderValue(receivedSpfHeader);
    // Received-SPF: pass (...) 或 Received-SPF: fail (...)
    const spfMatch = decoded.match(/^\s*(pass|fail|softfail|neutral|none|temperror|permerror)\b/i);
    if (spfMatch) result.spf = spfMatch[1].toLowerCase();
  }

  // 综合状态
  if (result.spf === 'fail' || result.dkim === 'fail' || result.dmarc === 'fail') {
    result.status = 'fail';
  } else if (result.spf === 'pass' || result.dkim === 'pass' || result.dmarc === 'pass') {
    result.status = 'pass';
  } else {
    result.status = 'unknown';
  }

  return result;
}
