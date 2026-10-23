'use strict';

/* =====================================================================
 * lib/dlna.js — 零依赖 DLNA 媒体服务器宣告 + 内容目录（MediaServer:1）
 * ---------------------------------------------------------------------
 * 设计取舍（重要）：
 *   Android Termux 无 root，无法绑定 <1024 的特权端口，因此**无法监听**
 *   标准 SSDP 组播端口 1900（UDP）。本模块采用「周期性 ssdp:alive NOTIFY
 *   组播推送」方案替代「响应 M-SEARCH」：
 *     - 从临时源端口（>1024，由 dgram 自动分配，发送时无需 bind 1900）
 *       向 239.255.255.250:1900 周期发送 NOTIFY 报文，控制点即可发现设备。
 *     - 代价：部分严格校验「源端口必须等于 1900」的控制点可能收不到；
 *       但 VLC / Kodi / Windows 资源管理器 / 主流路由器等主流设备均可正常发现。
 *     - 完整的设备描述、SCPD、ContentDirectory SOAP Browse 仍由主 HTTP
 *       服务（8081）的 /dlna/ 前缀提供，发现后可正常浏览与串流。
 * ===================================================================== */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dgram = require('dgram');

/* ----------------------------- 小工具 ----------------------------- */

/** XML 转义（用于 DIDL / 设备描述里的文本与属性值） */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 枚举本机非 internal 的 IPv4 地址 */
function localIPv4s() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}
function firstIPv4() {
  const list = localIPv4s();
  return list.length ? list[0] : '127.0.0.1';
}

/** 极简 MIME 表（仅覆盖媒体与常见类型，足够 DLNA 使用） */
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
};
function mimeOf(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/** 扩展名 → upnp:class；非媒体返回 null（不输出该项） */
function mediaClass(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'object.item.imageItem';
  if (['.mp4', '.mkv', '.mov', '.avi', '.webm'].includes(ext)) return 'object.item.videoItem';
  if (['.mp3', '.flac', '.wav', '.m4a', '.ogg'].includes(ext)) return 'object.item.audioItem';
  return null;
}

/** 读取请求体（带上限，避免恶意超大 body） */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ----------------------- ObjectID 编解码 ----------------------- */
// 方案（与需求一致）：
//   0                  = 根容器（公共盘 / 外置盘列表）
//   disk:<diskId>      = 盘根（diskId 可为 public / ext:<UUID>）
//   dir:<diskId>:<rel> = 目录容器
//   item:<diskId>:<rel>= 媒体文件
// 解析时盘符可能含 ':'（ext:<UUID>），故先剥离前缀再按规则切分。

function parseObjectID(id) {
  if (id === '0') return { type: 'root' };
  if (id.startsWith('disk:')) return { type: 'disk', disk: id.slice(5) };
  if (id.startsWith('dir:') || id.startsWith('item:')) {
    const kind = id.startsWith('dir:') ? 'dir' : 'item';
    const rest = id.slice(kind.length + 1);
    return Object.assign({ type: kind }, splitDiskRel(rest));
  }
  return null;
}
function splitDiskRel(s) {
  let disk, rel;
  if (s.startsWith('ext:')) {
    // ext:UUID 中 UUID 仅含连字符，不含冒号 → 找 ext: 之后的第一个冒号切分
    const sep = s.indexOf(':', 4);
    if (sep < 0) { disk = s; rel = ''; }
    else { disk = s.slice(0, sep); rel = s.slice(sep + 1); }
  } else {
    const sep = s.indexOf(':');
    if (sep < 0) { disk = s; rel = ''; }
    else { disk = s.slice(0, sep); rel = s.slice(sep + 1); }
  }
  return { disk, rel };
}

/** 计算某 ObjectID 的父 ID（用于 DIDL parentID） */
function parentOf(objectID) {
  if (objectID === '0') return '-1';
  const p = parseObjectID(objectID);
  if (!p) return '-1';
  if (p.type === 'disk') return '0';
  // dir / item：看 rel 是否含 '/'
  if (p.rel && p.rel.includes('/')) {
    const up = p.rel.slice(0, p.rel.lastIndexOf('/'));
    return (p.type === 'dir' ? 'dir:' : 'item:') + p.disk + ':' + up;
  }
  return 'disk:' + p.disk;
}

/** 构造 dav 直链（游客对公共盘/外置盘只读，天然可被播放器 GET，并支持 Range 流式） */
function davUrl(disk, rel, ip, port) {
  const segs = rel.split('/').map(encodeURIComponent);
  return `http://${ip}:${port}/dav/${encodeURIComponent(disk)}/${segs.join('/')}`;
}

const DIDL_NS = 'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
  'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"';

/* ------------------------------ 类 ------------------------------ */
class Dlna {
  /**
   * @param {object} srv FileServer 实例（需要 resolveTarget / listDisks / scanExternal / cfg）
   */
  constructor(srv) {
    this.srv = srv;
    this.friendlyName = 'K50-NAS';
    this.intervalMs = 30000;
    this.timer = null;
    this.sock = null;       // SSDP NOTIFY 发送用的 UDP socket
    this.running = false;
    this.port = (srv && srv.cfg && srv.cfg.port) || 8081;
    this.uuid = this._loadUuid();   // 持久化 UDN，避免每次重启设备身份变化
  }

  /** 启动时生成并持久化 UDN 到 dataDir/dlna-uuid.txt */
  _loadUuid() {
    const file = path.join(this.srv.cfg.dataDir, 'dlna-uuid.txt');
    try {
      const v = fs.readFileSync(file, 'utf8').trim();
      if (v) return v;
    } catch { /* 首次启动 */ }
    const v = crypto.randomUUID();
    try { fs.writeFileSync(file, v); } catch { /* 写失败也可运行（仅本次会话 UDN） */ }
    return v;
  }
  get udn() { return 'uuid:' + this.uuid; }

  /* ============================ 启动 / 停止 ============================ */

  /**
   * 启动 DLNA 宣告（仅发送 ssdp:alive NOTIFY，不监听 1900）。
   * @param {{intervalMs?:number, friendlyName?:string}} [opts]
   */
  start(opts = {}) {
    if (this.running) return;
    this.intervalMs = opts.intervalMs || 30000;
    this.friendlyName = opts.friendlyName || 'K50-NAS';
    this.running = true;

    // 仅用于发送的 UDP socket（临时源端口，无需 bind 1900）
    this.sock = dgram.createSocket('udp4');
    this.sock.on('error', () => { /* 静默：发现推送失败不影响主服务 */ });

    // 立即推送一轮，随后按 interval 周期推送
    this._notify(true);
    this.timer = setInterval(() => this._notify(true), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // 发送 ssdp:byebye 礼貌下线
    if (this.sock) {
      try { this._notify(false); } catch { /* ignore */ }
      try { this.sock.close(); } catch { /* ignore */ }
      this.sock = null;
    }
  }

  /* ============================ SSDP NOTIFY ============================ */

  /** 发送一组 NOTIFY（alive 或 byebye） */
  _notify(alive) {
    if (!this.sock) return;
    const ip = firstIPv4();
    const location = `http://${ip}:${this.port}/dlna/description.xml`;
    const server = `node.js/${process.version} UPnP/1.0 K50-NAS/1.0`;
    // 四类 NT（NTS=ssdp:alive / ssdp:byebye），USN 按规范拼接
    const ntList = [
      'upnp:rootdevice',
      this.udn,
      'urn:schemas-upnp-org:device:MediaServer:1',
      'urn:schemas-upnp-org:service:ContentDirectory:1',
    ];
    for (const nt of ntList) {
      let usn;
      if (nt === 'upnp:rootdevice') usn = this.udn + '::upnp:rootdevice';
      else if (nt === this.udn) usn = this.udn;
      else usn = this.udn + '::' + nt;
      const lines = [
        'NOTIFY * HTTP/1.1',
        'HOST: 239.255.255.250:1900',
        'CACHE-CONTROL: max-age=120',
        'LOCATION: ' + location,
        'NT: ' + nt,
        'NTS: ' + (alive ? 'ssdp:alive' : 'ssdp:byebye'),
        'SERVER: ' + server,
        'USN: ' + usn,
        '',
        '',
      ];
      const buf = Buffer.from(lines.join('\r\n'));
      try {
        this.sock.send(buf, 0, buf.length, 1900, '239.255.255.250', () => {});
      } catch { /* ignore */ }
    }
  }

  /* ============================ HTTP 处理 ============================ */
  // 挂主服务 /dlna/ 前缀：
  //   GET  /dlna/description.xml  → 设备描述
  //   GET  /dlna/cds-scpd.xml     → ContentDirectory SCPD
  //   GET  /dlna/cms-scpd.xml     → ConnectionManager SCPD（最小实现，避免 404）
  //   POST /dlna/cds               → ContentDirectory SOAP（Browse 等）
  //   POST /dlna/cms               → ConnectionManager SOAP（GetProtocolInfo 等）
  // 返回 true 表示已处理（主服务不应再走其它路由）。

  async handle(req, res, pathname) {
    if (!pathname.startsWith('/dlna/')) return false;

    const m = (req.method || 'GET').toUpperCase();
    if (m === 'GET' || m === 'HEAD') {
      if (pathname === '/dlna/description.xml') return this._sendDescription(res), true;
      if (pathname === '/dlna/cds-scpd.xml') return this._sendCdsScpd(res), true;
      if (pathname === '/dlna/cms-scpd.xml') return this._sendCmsScpd(res), true;
      this._send404(res, '未找到该 DLNA 资源');
      return true;
    }
    if (m === 'POST') {
      if (pathname === '/dlna/cds') { await this._handleCds(req, res); return true; }
      if (pathname === '/dlna/cms') { await this._handleCms(req, res); return true; }
      this._send404(res, '未找到该 DLNA 服务');
      return true;
    }
    this._sendText(res, 405, '仅支持 GET / POST');
    return true;
  }

  _sendXml(res, xml) {
    const buf = Buffer.from(xml, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
      'Server': 'K50-NAS/1.0 UPnP/1.0',
    });
    res.end(buf);
  }
  _send404(res, msg) {
    const buf = Buffer.from('<?xml version="1.0"?><error>' + xmlEscape(msg || '') + '</error>', 'utf8');
    res.writeHead(404, { 'Content-Type': 'text/xml; charset="utf-8"', 'Content-Length': buf.length });
    res.end(buf);
  }
  _sendText(res, code, msg) {
    const buf = Buffer.from(msg || '', 'utf8');
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
  }

  /* ------------------------- 设备描述 ------------------------- */
  _sendDescription(res) {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<root xmlns="urn:schemas-upnp-org:device-1-0">\n' +
      '  <specVersion><major>1</major><minor>0</minor></specVersion>\n' +
      '  <device>\n' +
      '    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>\n' +
      '    <friendlyName>' + xmlEscape(this.friendlyName) + '</friendlyName>\n' +
      '    <manufacturer>K50-NAS</manufacturer>\n' +
      '    <manufacturerURL>https://example.local/</manufacturerURL>\n' +
      '    <modelName>K50-NAS FileServer</modelName>\n' +
      '    <modelNumber>1.0</modelNumber>\n' +
      '    <UDN>' + xmlEscape(this.udn) + '</UDN>\n' +
      '    <serviceList>\n' +
      '      <service>\n' +
      '        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>\n' +
      '        <serviceId>urn:upnp-org:serviceId:ContentDirectory</serviceId>\n' +
      '        <controlURL>/dlna/cds</controlURL>\n' +
      '        <eventSubURL>/dlna/eds</eventSubURL>\n' +
      '        <SCPDURL>/dlna/cds-scpd.xml</SCPDURL>\n' +
      '      </service>\n' +
      '      <service>\n' +
      '        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>\n' +
      '        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>\n' +
      '        <controlURL>/dlna/cms</controlURL>\n' +
      '        <eventSubURL>/dlna/ems</eventSubURL>\n' +
      '        <SCPDURL>/dlna/cms-scpd.xml</SCPDURL>\n' +
      '      </service>\n' +
      '    </serviceList>\n' +
      '  </device>\n' +
      '</root>\n';
    this._sendXml(res, xml);
  }

  /* ------------------------- ContentDirectory SCPD ------------------------- */
  _sendCdsScpd(res) {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<scpd xmlns="urn:schemas-upnp-org:service-1-0">\n' +
      '  <specVersion><major>1</major><minor>0</minor></specVersion>\n' +
      '  <actionList>\n' +
      '    <action><name>GetSearchCapabilities</name><argumentList>' +
      '<argument><name>SearchCapabilities</name><direction>out</direction><relatedStateVariable>SearchCapabilities</relatedStateVariable></argument>' +
      '</argumentList></action>\n' +
      '    <action><name>GetSortCapabilities</name><argumentList>' +
      '<argument><name>SortCapabilities</name><direction>out</direction><relatedStateVariable>SortCapabilities</relatedStateVariable></argument>' +
      '</argumentList></action>\n' +
      '    <action><name>GetSystemUpdateID</name><argumentList>' +
      '<argument><name>Id</name><direction>out</direction><relatedStateVariable>SystemUpdateID</relatedStateVariable></argument>' +
      '</argumentList></action>\n' +
      '    <action><name>Search</name><argumentList>' +
      '<argument><name>ContainerID</name><direction>in</direction></argument>' +
      '<argument><name>SearchCriteria</name><direction>in</direction></argument>' +
      '<argument><name>Filter</name><direction>in</direction></argument>' +
      '<argument><name>StartingIndex</name><direction>in</direction></argument>' +
      '<argument><name>RequestedCount</name><direction>in</direction></argument>' +
      '<argument><name>SortCriteria</name><direction>in</direction></argument>' +
      '<argument><name>Result</name><direction>out</direction></argument>' +
      '<argument><name>NumberReturned</name><direction>out</direction></argument>' +
      '<argument><name>TotalMatches</name><direction>out</direction></argument>' +
      '<argument><name>UpdateID</name><direction>out</direction></argument>' +
      '</argumentList></action>\n' +
      '    <action><name>Browse</name><argumentList>' +
      '<argument><name>ObjectID</name><direction>in</direction></argument>' +
      '<argument><name>BrowseFlag</name><direction>in</direction></argument>' +
      '<argument><name>Filter</name><direction>in</direction></argument>' +
      '<argument><name>StartingIndex</name><direction>in</direction></argument>' +
      '<argument><name>RequestedCount</name><direction>in</direction></argument>' +
      '<argument><name>SortCriteria</name><direction>in</direction></argument>' +
      '<argument><name>Result</name><direction>out</direction></argument>' +
      '<argument><name>NumberReturned</name><direction>out</direction></argument>' +
      '<argument><name>TotalMatches</name><direction>out</direction></argument>' +
      '<argument><name>UpdateID</name><direction>out</direction></argument>' +
      '</argumentList></action>\n' +
      '  </actionList>\n' +
      '  <serviceStateTable>\n' +
      '    <stateVariable sendEvents="no"><name>SearchCapabilities</name><dataType>string</dataType></stateVariable>\n' +
      '    <stateVariable sendEvents="no"><name>SortCapabilities</name><dataType>string</dataType></stateVariable>\n' +
      '    <stateVariable sendEvents="yes"><name>SystemUpdateID</name><dataType>ui4</dataType></stateVariable>\n' +
      '    <stateVariable sendEvents="no"><name>ContainerUpdateIDs</name><dataType>string</dataType></stateVariable>\n' +
      '    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ObjectID</name><dataType>string</dataType></stateVariable>\n' +
      '    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Result</name><dataType>string</dataType></stateVariable>\n' +
      '  </serviceStateTable>\n' +
      '</scpd>\n';
    this._sendXml(res, xml);
  }

  /* ------------------------- ConnectionManager SCPD（最小） ------------------------- */
  _sendCmsScpd(res) {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<scpd xmlns="urn:schemas-upnp-org:service-1-0">\n' +
      '  <specVersion><major>1</major><minor>0</minor></specVersion>\n' +
      '  <actionList>\n' +
      '    <action><name>GetProtocolInfo</name><argumentList>' +
      '<argument><name>SourceProtocolInfo</name><direction>out</direction></argument>' +
      '<argument><name>SinkProtocolInfo</name><direction>out</direction></argument>' +
      '</argumentList></action>\n' +
      '    <action><name>GetCurrentConnectionIDs</name><argumentList>' +
      '<argument><name>ConnectionIDs</name><direction>out</direction></argument>' +
      '</argumentList></action>\n' +
      '    <action><name>GetCurrentConnectionInfo</name><argumentList>' +
      '<argument><name>ConnectionID</name><direction>in</direction></argument>' +
      '<argument><name>RcsID</name><direction>out</direction></argument>' +
      '<argument><name>AVTransportID</name><direction>out</direction></argument>' +
      '<argument><name>ProtocolInfo</name><direction>out</direction></argument>' +
      '<argument><name>Status</name><direction>out</direction></argument>' +
      '</argumentList></action>\n' +
      '  </actionList>\n' +
      '  <serviceStateTable>\n' +
      '    <stateVariable sendEvents="no"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>\n' +
      '    <stateVariable sendEvents="no"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>\n' +
      '    <stateVariable sendEvents="no"><name>CurrentConnectionIDs</name><dataType>string</dataType></stateVariable>\n' +
      '  </serviceStateTable>\n' +
      '</scpd>\n';
    this._sendXml(res, xml);
  }

  /* ------------------------- SOAP 处理 ------------------------- */
  async _handleCds(req, res) {
    let body;
    try { body = (await readBody(req, 1024 * 1024)).toString('utf8'); }
    catch { return this._sendSoap(res, 'Browse', '<Result></Result><NumberReturned>0</NumberReturned><TotalMatches>0</TotalMatches><UpdateID>1</UpdateID>', 500); }

    const act = /<u:(\w+)/.exec(body);
    const action = act ? act[1] : '';
    let inner = '';
    switch (action) {
      case 'Browse': {
        const objectID = soapArg(body, 'ObjectID') || '0';
        const flag = soapArg(body, 'BrowseFlag') || 'BrowseDirectChildren';
        const start = parseInt(soapArg(body, 'StartingIndex') || '0', 10) || 0;
        const count = parseInt(soapArg(body, 'RequestedCount') || '0', 10) || 0;
        const r = this._browse(objectID, flag, start, count);
        inner = '<Result>' + xmlEscape(r.result) + '</Result>' +
          '<NumberReturned>' + r.numberReturned + '</NumberReturned>' +
          '<TotalMatches>' + r.totalMatches + '</TotalMatches>' +
          '<UpdateID>1</UpdateID>';
        break;
      }
      case 'Search':
        inner = '<Result></Result><NumberReturned>0</NumberReturned><TotalMatches>0</TotalMatches><UpdateID>1</UpdateID>';
        break;
      case 'GetSearchCapabilities':
        inner = '<SearchCapabilities></SearchCapabilities>';
        break;
      case 'GetSortCapabilities':
        inner = '<SortCapabilities></SortCapabilities>';
        break;
      case 'GetSystemUpdateID':
        inner = '<Id>1</Id>';
        break;
      default:
        return this._sendSoap(res, action || 'Browse', '<Result></Result>', 404);
    }
    this._sendSoap(res, action, inner, 200);
  }

  async _handleCms(req, res) {
    let body = '';
    try { body = (await readBody(req, 256 * 1024)).toString('utf8'); } catch { body = ''; }
    const act = /<u:(\w+)/.exec(body);
    const action = act ? act[1] : '';
    let inner = '';
    switch (action) {
      case 'GetProtocolInfo':
        inner = '<SourceProtocolInfo>http-get:*:*:DLNA.ORG_OP=01</SourceProtocolInfo><SinkProtocolInfo></SinkProtocolInfo>';
        break;
      case 'GetCurrentConnectionIDs':
        inner = '<ConnectionIDs></ConnectionIDs>';
        break;
      case 'GetCurrentConnectionInfo':
        inner = '<RcsID>-1</RcsID><AVTransportID>-1</AVTransportID><ProtocolInfo></ProtocolInfo><Status>OK</Status>';
        break;
      default:
        inner = '<ConnectionIDs></ConnectionIDs>';
        break;
    }
    this._sendSoap(res, action || 'GetProtocolInfo', inner, 200);
  }

  _sendSoap(res, action, inner, code) {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>\r\n' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\r\n' +
      '<s:Body>\r\n' +
      '<u:' + action + 'Response xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">\r\n' +
      inner + '\r\n' +
      '</u:' + action + 'Response>\r\n' +
      '</s:Body>\r\n</s:Envelope>';
    const buf = Buffer.from(xml, 'utf8');
    res.writeHead(code, {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': buf.length,
      'Server': 'K50-NAS/1.0 UPnP/1.0',
    });
    res.end(buf);
  }

  /* ------------------------- 内容目录 Browse ------------------------- */

  _browse(objectID, flag, start, count) {
    const ip = firstIPv4();
    const port = this.port;

    // 收集该容器下的所有子项（容器 + 媒体项）
    const children = this._collectChildren(objectID, ip, port);

    if (flag === 'BrowseMetadata') {
      // 返回该对象自身的元数据
      const el = this._metadataElement(objectID, ip, port);
      const didl = '<DIDL-Lite ' + DIDL_NS + '>' + el + '</DIDL-Lite>';
      return { result: didl, numberReturned: el ? 1 : 0, totalMatches: el ? 1 : 0 };
    }

    // BrowseDirectChildren：分页
    const total = children.length;
    const slice = (count > 0) ? children.slice(start, start + count) : children.slice(start);
    const body = slice.join('');
    const didl = '<DIDL-Lite ' + DIDL_NS + '>' + body + '</DIDL-Lite>';
    return { result: didl, numberReturned: slice.length, totalMatches: total };
  }

  /** 返回某对象自身的 DIDL 元素（metadata 用） */
  _metadataElement(objectID, ip, port) {
    if (objectID === '0') {
      const disks = this._mediaDisks();
      return containerEl('0', '-1', this.friendlyName + ' 媒体库', disks.length);
    }
    const p = parseObjectID(objectID);
    if (!p) return '';
    if (p.type === 'disk') {
      const d = this.srv.listDisks(null).find((x) => x.id === p.disk);
      const t = this.srv.resolveTarget({ disk: p.disk, path: '' }, null);
      const childCount = t.error ? 0 : this._dirChildCount(t.abs);
      return containerEl(objectID, '0', d ? d.name : p.disk, childCount);
    }
    if (p.type === 'dir') {
      const t = this.srv.resolveTarget({ disk: p.disk, path: p.rel }, null);
      if (t.error) return '';
      const name = path.basename(t.abs) || p.rel;
      return containerEl(objectID, parentOf(objectID), name, this._dirChildCount(t.abs));
    }
    if (p.type === 'item') {
      const t = this.srv.resolveTarget({ disk: p.disk, path: p.rel }, null);
      if (t.error) return '';
      let st; try { st = fs.statSync(t.abs); } catch { return ''; }
      const cls = mediaClass(t.abs);
      if (!cls) return '';
      return itemEl(objectID, parentOf(objectID), path.basename(t.abs), cls,
        mimeOf(t.abs), st.size, davUrl(p.disk, p.rel, ip, port));
    }
    return '';
  }

  /** 收集某容器下的全部子 DIDL 元素 */
  _collectChildren(objectID, ip, port) {
    const out = [];
    if (objectID === '0') {
      // 根：列出公共盘 + 在线外置盘（游客可只读访问）
      const disks = this._mediaDisks();
      for (const d of disks) {
        const t = this.srv.resolveTarget({ disk: d.id, path: '' }, null);
        const childCount = t.error ? 0 : this._dirChildCount(t.abs);
        out.push(containerEl('disk:' + d.id, '0', d.name, childCount));
      }
      return out;
    }
    const p = parseObjectID(objectID);
    if (!p) return out;

    if (p.type === 'item') return out; // 文件无可列子项

    // disk / dir：读取目录
    const t = this.srv.resolveTarget({ disk: p.disk, path: p.rel || '' }, null);
    if (t.error) return out;
    let names;
    try { names = fs.readdirSync(t.abs); } catch { return out; }

    const containers = [];
    const items = [];
    for (const name of names) {
      // 隐藏系统目录不暴露
      if (name === '.recycle' || name === '.versions' || name === '.snapshots') continue;
      const full = path.join(t.abs, name);
      let st; try { st = fs.statSync(full); } catch { continue; }
      const childRel = p.rel ? p.rel + '/' + name : name;
      if (st.isDirectory()) {
        const id = 'dir:' + p.disk + ':' + childRel;
        containers.push(containerEl(id, parentOf(id), name, this._dirChildCount(full)));
      } else if (st.isFile()) {
        const cls = mediaClass(name);
        if (!cls) continue; // 非媒体不输出
        const id = 'item:' + p.disk + ':' + childRel;
        items.push(itemEl(id, parentOf(id), name, cls, mimeOf(name), st.size,
          davUrl(p.disk, childRel, ip, port)));
      }
    }
    // 容器在前，媒体在后（符合多数播放器展示习惯）
    return containers.concat(items);
  }

  /** 列出「媒体可用」盘：公共盘 + 外置盘（不在线则不出现在 listDisks 中，自然排除） */
  _mediaDisks() {
    return this.srv.listDisks(null).filter((d) => d.id === 'public' || d.id.startsWith('ext:'));
  }

  /** 统计目录下的子容器 + 媒体文件数量（用于 childCount） */
  _dirChildCount(abs) {
    let names;
    try { names = fs.readdirSync(abs); } catch { return 0; }
    let n = 0;
    for (const name of names) {
      if (name === '.recycle' || name === '.versions' || name === '.snapshots') continue;
      const full = path.join(abs, name);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { n++; continue; }
      if (st.isFile() && mediaClass(name)) n++;
    }
    return n;
  }
}

/* ------------------------- DIDL 元素构造 ------------------------- */
function containerEl(id, parentID, title, childCount) {
  return '<container id="' + xmlEscape(id) + '" parentID="' + xmlEscape(parentID) +
    '" restricted="1">' +
    '<dc:title>' + xmlEscape(title) + '</dc:title>' +
    '<upnp:class>object.container.storageFolder</upnp:class>' +
    '<childCount>' + (childCount || 0) + '</childCount>' +
    '</container>';
}
function itemEl(id, parentID, title, cls, mime, size, url) {
  return '<item id="' + xmlEscape(id) + '" parentID="' + xmlEscape(parentID) +
    '" restricted="1">' +
    '<dc:title>' + xmlEscape(title) + '</dc:title>' +
    '<upnp:class>' + xmlEscape(cls) + '</upnp:class>' +
    '<res protocolInfo="http-get:*:' + xmlEscape(mime) + ':DLNA.ORG_OP=01" size="' + (size || 0) + '">' +
    xmlEscape(url) + '</res>' +
    '</item>';
}

/** 从 SOAP body 提取某个参数标签的文本 */
function soapArg(body, tag) {
  const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(body);
  return m ? m[1].trim() : '';
}

module.exports = { Dlna };
