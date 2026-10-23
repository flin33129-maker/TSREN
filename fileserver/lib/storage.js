'use strict';

const fs = require('fs');
const path = require('path');

/** 文件名中的非法字符（Windows 保留字符 + 路径分隔符 + 控制字符） */
const ILLEGAL_NAME = /[\/\\:*?"<>|\x00-\x1f]/;

class Storage {
  /**
   * @param {string} root 存储根目录（可配置）
   */
  constructor(root) {
    this.root = path.resolve(root);
    this.publicDir = path.join(this.root, 'public');
    this.usersDir = path.join(this.root, 'users');
    fs.mkdirSync(this.publicDir, { recursive: true });
    fs.mkdirSync(this.usersDir, { recursive: true });
  }

  /**
   * 取得某个作用域的根目录
   * @param {'public'|'private'} scope
   * @param {object|null} user 当前用户；private 时必填
   * @returns {string|null}
   */
  scopeRoot(scope, user) {
    if (scope === 'public') return this.publicDir;
    if (!user) return null;
    const dir = path.join(this.usersDir, user.id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 将用户传入的相对路径安全解析为绝对路径。
   * 拒绝任何逃出 baseDir 的尝试（路径穿越）。
   * @returns {string|null} 非法时返回 null
   */
  safeResolve(baseDir, relPath) {
    if (relPath === undefined || relPath === null || relPath === '') return baseDir;
    let p = String(relPath).replace(/\\/g, '/');
    p = p.replace(/^\/+/, '');
    if (p === '' || p === '.') return baseDir;

    const segs = p.split('/').filter((s) => s !== '' && s !== '.');
    if (segs.some((s) => s === '..')) return null;           // 显式拒绝 ..
    if (segs.some((s) => !this.validateName(s))) return null; // 逐段校验文件名

    const full = path.resolve(baseDir, ...segs);
    const base = path.resolve(baseDir);
    if (full !== base && !full.startsWith(base + path.sep)) return null;
    return full;
  }

  /** 校验单层文件/目录名是否合法 */
  validateName(name) {
    if (typeof name !== 'string' || name === '') return false;
    if (name === '.' || name === '..') return false;
    if (name.length > 255) return false;
    if (ILLEGAL_NAME.test(name)) return false;
    if (/^\s|\s$/.test(name)) return false; // 首尾空格
    if (/\.$/.test(name)) return false;     // 以点结尾（Windows 不允许）
    return true;
  }

  /** 列出目录内容：目录在前，其次文件，各自按名称排序（隐藏系统目录可选过滤） */
  list(dir, { showHidden = false } = {}) {
    const entries = [];
    for (const name of fs.readdirSync(dir)) {
      if (!showHidden && (name === '.recycle' || name === '.versions' || name === '.snapshots')) continue;
      let st;
      try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
      entries.push({
        name,
        isDir: st.isDirectory(),
        size: st.isDirectory() ? 0 : st.size,
        mtime: st.mtimeMs,
      });
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    return entries;
  }

  /** 递归搜索文件名（区分大小写忽略），限制结果数量与深度 */
  search(baseDir, keyword, { maxResults = 200, maxDepth = 8 } = {}) {
    const results = [];
    const kw = String(keyword || '').toLowerCase().trim();
    if (!kw) return results;

    const walk = (dir, relPrefix, depth) => {
      if (results.length >= maxResults || depth > maxDepth) return;
      let names;
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (results.length >= maxResults) return;
        const full = path.join(dir, name);
        const rel = relPrefix ? relPrefix + '/' + name : name;
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (name.toLowerCase().includes(kw)) {
          results.push({ path: rel, name, isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
        }
        if (st.isDirectory()) walk(full, rel, depth + 1);
      }
    };
    walk(baseDir, '', 0);
    return results;
  }

  /** 递归删除文件或目录 */
  remove(target) {
    const st = fs.lstatSync(target);
    if (st.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else fs.unlinkSync(target);
  }

  /**
   * 复制文件或目录到目标相对路径（目标须在 baseDir 内）。
   * 目标已存在时报错，避免静默覆盖。
   */
  copy(baseDir, relFrom, relTo) {
    const from = this.safeResolve(baseDir, relFrom);
    const to = this.safeResolve(baseDir, relTo);
    if (!from || !to) return { ok: false, error: '非法路径' };
    if (!fs.existsSync(from)) return { ok: false, error: '源不存在' };
    if (path.resolve(from) === path.resolve(to)) return { ok: false, error: '源与目标相同' };
    if (fs.existsSync(to)) return { ok: false, error: '目标已存在：' + relTo };
    /* 禁止把目录复制进自身子树（无限递归） */
    if (fs.statSync(from).isDirectory() && path.resolve(to).startsWith(path.resolve(from) + path.sep)) {
      return { ok: false, error: '不能复制到自身子目录' };
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
    return { ok: true };
  }

  /** 移动：优先同设备 rename（瞬时），跨设备自动降级为 copy + remove */
  move(baseDir, relFrom, relTo) {
    const from = this.safeResolve(baseDir, relFrom);
    const to = this.safeResolve(baseDir, relTo);
    if (!from || !to) return { ok: false, error: '非法路径' };
    if (!fs.existsSync(from)) return { ok: false, error: '源不存在' };
    if (path.resolve(from) === path.resolve(to)) return { ok: true };
    if (fs.existsSync(to)) return { ok: false, error: '目标已存在：' + relTo };
    if (fs.statSync(from).isDirectory() && path.resolve(to).startsWith(path.resolve(from) + path.sep)) {
      return { ok: false, error: '不能移动到自身子目录' };
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch (e) {
      if (e.code !== 'EXDEV') return { ok: false, error: e.message };
      fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
      this.remove(from);
    }
    return { ok: true };
  }

  /** 重命名 / 移动，目标必须仍在 baseDir 内 */
  rename(baseDir, relFrom, newName) {
    if (!this.validateName(newName)) return { ok: false, error: '非法文件名' };
    const from = this.safeResolve(baseDir, relFrom);
    if (!from) return { ok: false, error: '非法源路径' };
    if (!fs.existsSync(from)) return { ok: false, error: '源不存在' };
    const parent = path.dirname(from);
    const to = path.join(parent, newName);
    if (path.resolve(to) === path.resolve(from)) return { ok: true };
    if (fs.existsSync(to)) return { ok: false, error: '目标名称已存在' };
    fs.renameSync(from, to);
    return { ok: true };
  }

  /** 创建单层目录（父目录必须已存在） */
  mkdir(baseDir, relParent, newName) {
    if (!this.validateName(newName)) return { ok: false, error: '非法目录名' };
    const parent = this.safeResolve(baseDir, relParent);
    if (!parent) return { ok: false, error: '非法父目录' };
    const target = path.join(parent, newName);
    if (fs.existsSync(target)) return { ok: false, error: '目录已存在' };
    fs.mkdirSync(target, { recursive: false });
    return { ok: true };
  }
}

module.exports = { Storage };
