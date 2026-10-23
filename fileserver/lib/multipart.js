'use strict';

/**
 * 零依赖 multipart/form-data 解析器（二进制安全）
 * 支持多文件、多字段、UTF-8 文件名（含 RFC 5987 filename*）
 */

const CRLF = '\r\n';

/** 从 Content-Type 中提取 boundary */
function getBoundary(contentType) {
  if (!contentType) return null;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  return (m[1] || m[2] || '').trim() || null;
}

/**
 * @param {Buffer} buf 请求体
 * @param {string} boundary
 * @returns {{fields:Object, files:Array<{field:string,filename:string,mime:string,data:Buffer}>}}
 */
function parseMultipart(buf, boundary) {
  const result = { fields: Object.create(null), files: [] };
  if (!Buffer.isBuffer(buf) || !boundary) return result;

  const bStart = Buffer.from('--' + boundary, 'latin1');
  const delim = Buffer.from(CRLF + '--' + boundary, 'latin1');
  const headerSep = Buffer.from(CRLF + CRLF, 'latin1');

  let pos = buf.indexOf(bStart);
  if (pos < 0) return result;
  pos += bStart.length;

  while (pos < buf.length) {
    if (buf.slice(pos, pos + 2).toString('latin1') === '--') break; // 结束标记
    if (buf.slice(pos, pos + 2).toString('latin1') === CRLF) pos += 2;

    const hEnd = buf.indexOf(headerSep, pos);
    if (hEnd < 0) break;
    const headersRaw = buf.slice(pos, hEnd).toString('utf8');
    const bodyStart = hEnd + 4;

    const nextDelim = buf.indexOf(delim, bodyStart);
    if (nextDelim < 0) break;
    const body = buf.slice(bodyStart, nextDelim);

    const headers = Object.create(null);
    for (const line of headersRaw.split(CRLF)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }

    const cd = headers['content-disposition'] || '';
    const nameM = /name="([^"]*)"/.exec(cd) || /name=([^;]+)/.exec(cd);
    const fieldName = nameM ? nameM[1] : '';

    // 优先 RFC 5987 filename*，其次普通 filename
    const starM = /filename\*=[^']*''([^;]+)/i.exec(cd);
    const plainM = /filename="([^"]*)"/.exec(cd) || /filename=([^;]+)/.exec(cd);
    let filename = null;
    if (starM) {
      try { filename = decodeURIComponent(starM[1].trim()); } catch { filename = starM[1]; }
    } else if (plainM) {
      filename = plainM[1];
    }

    if (filename !== null && filename !== '') {
      // 去掉旧浏览器可能带上的路径，并剥离首尾空白
      filename = filename.replace(/\\/g, '/').split('/').pop().trim();
      if (filename) {
        result.files.push({
          field: fieldName,
          filename,
          mime: headers['content-type'] || 'application/octet-stream',
          data: body,
        });
        pos = nextDelim + delim.length;
        continue;
      }
    }

    result.fields[fieldName] = body.toString('utf8');
    pos = nextDelim + delim.length;
  }

  return result;
}

module.exports = { getBoundary, parseMultipart };
