'use strict';

/* =====================================================================
   hashindex.js — 上传秒传哈希索引
   记录「文件 sha256 → 已存在的物理路径」，上传前命中则直接复制，跳过传输。

   索引落盘：<dataDir>/hash-index.json
   结构：{ version: 1, entries: { "<sha256>": { abs, size, mtime, disk, rel } } }
   ===================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HEAD_BYTES = 128 * 1024;   // 头部采样长度（快速预筛）
const MAX_INDEX = 20000;         // 索引条目上限，超出按 mtime 淘汰

class HashIndex {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'hash-index.json');
    this.entries = Object.create(null);
    this.dirty = false;
    this._timer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && obj.entries) this.entries = obj.entries;
    } catch (e) {
      this.entries = Object.create(null);
    }
  }

  /** 延迟批量落盘（2s 合并写，避免频繁 IO） */
  scheduleSave() {
    this.dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.save();
    }, 2000);
    if (this._timer.unref) this._timer.unref();
  }

  save() {
    if (!this.dirty) return;
    try {
      const keys = Object.keys(this.entries);
      // 超出上限：按 mtime 升序淘汰最旧的一半
      if (keys.length > MAX_INDEX) {
        keys.sort((a, b) => (this.entries[a].mtime || 0) - (this.entries[b].mtime || 0));
        for (const k of keys.slice(0, keys.length - MAX_INDEX)) delete this.entries[k];
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries }));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) {
      /* 落盘失败不影响主流程 */
    }
  }

  /** 记录一个已完成的文件（上传完成 / 秒传复制后调用） */
  record(sha256, abs, size, disk, rel) {
    if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) return;
    this.entries[String(sha256).toLowerCase()] = {
      abs, size, disk: disk || '', rel: rel || '',
      mtime: Date.now(),
    };
    this.scheduleSave();
  }

  /** 查询命中：返回可用条目或 null（会校验物理文件仍存在且大小一致） */
  lookup(sha256, size) {
    if (!sha256) return null;
    const e = this.entries[String(sha256).toLowerCase()];
    if (!e) return null;
    if (size != null && e.size !== size) return null;
    try {
      const st = fs.statSync(e.abs);
      if (!st.isFile() || st.size !== e.size) {
        delete this.entries[String(sha256).toLowerCase()];
        this.scheduleSave();
        return null;
      }
      return e;
    } catch (err) {
      delete this.entries[String(sha256).toLowerCase()];
      this.scheduleSave();
      return null;
    }
  }

  /** 移除某个物理路径对应的索引（删除文件时调用） */
  forget(abs) {
    let changed = false;
    for (const k of Object.keys(this.entries)) {
      if (this.entries[k].abs === abs) { delete this.entries[k]; changed = true; }
    }
    if (changed) this.scheduleSave();
  }

  /** 计算文件 sha256（流式，可限制读取字节数用于快速预筛） */
  static hashFile(abs, limit) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const opts = { highWaterMark: 1 << 20 };
      if (limit) opts.end = limit - 1;
      fs.createReadStream(abs, opts)
        .on('data', (d) => h.update(d))
        .on('end', () => resolve(h.digest('hex')))
        .on('error', reject);
    });
  }

  /** 统计 */
  stats() {
    return { count: Object.keys(this.entries).length, file: this.file };
  }
}

module.exports = { HashIndex, HEAD_BYTES };
