'use strict';

/* =====================================================================
   i18n.js — 中英双语（原生 JS，无构建）
   用法：
     window.t(key)                 取当前语言词条（缺失回退中文）
     window.applyI18n(root?)       扫描 [data-i18n] → textContent、[data-i18n-ph] → placeholder
     window.setLang('zh' | 'en')   切换语言并持久化（localStorage 'nas-lang'，默认 zh）
   词条覆盖常用 UI 串约 45 个；页面元素加 data-i18n="key" / data-i18n-ph="key" 即可接入
   ===================================================================== */

window.I18N = {
  zh: {
    login: '登录',
    register: '注册',
    logout: '退出登录',
    username: '用户名',
    password: '密码',
    guestBrowse: '游客浏览',
    upload: '上传',
    download: '下载',
    create: '新建',
    delete: '删除',
    rename: '改名',
    preview: '预览',
    info: '信息',
    share: '共享',
    recycle: '回收站',
    versions: '版本',
    tasks: '任务',
    health: '健康',
    search: '检索',
    dedup: '去重',
    audit: '审计',
    publicDisk: '公共盘',
    privateSpace: '私人空间',
    externalDisk: '外置硬盘',
    online: '在线',
    offline: '离线',
    readOnly: '只读',
    used: '已用',
    available: '可用',
    selectAll: '全选',
    cancel: '取消',
    confirm: '确认',
    ok: '确定',
    searchPlaceholder: '搜索文件…',
    grid: '网格',
    list: '列表',
    theme: '主题',
    language: '语言',
    settings: '设置',
    refresh: '刷新',
    scanDisks: '扫描硬盘',
    close: '关闭',
    packDownload: '打包下载',
    emptyDir: '这个目录还是空的',
    newFolder: '新建文件夹',
    storageLocation: '存储位置',
  },
  en: {
    login: 'Sign in',
    register: 'Sign up',
    logout: 'Sign out',
    username: 'Username',
    password: 'Password',
    guestBrowse: 'Browse as guest',
    upload: 'Upload',
    download: 'Download',
    create: 'New',
    delete: 'Delete',
    rename: 'Rename',
    preview: 'Preview',
    info: 'Info',
    share: 'Share',
    recycle: 'Trash',
    versions: 'Versions',
    tasks: 'Tasks',
    health: 'Health',
    search: 'Search',
    dedup: 'Dedup',
    audit: 'Audit',
    publicDisk: 'Public',
    privateSpace: 'Private',
    externalDisk: 'External drive',
    online: 'Online',
    offline: 'Offline',
    readOnly: 'Read-only',
    used: 'Used',
    available: 'Available',
    selectAll: 'Select all',
    cancel: 'Cancel',
    confirm: 'Confirm',
    ok: 'OK',
    searchPlaceholder: 'Search files…',
    grid: 'Grid',
    list: 'List',
    theme: 'Theme',
    language: 'Language',
    settings: 'Settings',
    refresh: 'Refresh',
    scanDisks: 'Scan drives',
    close: 'Close',
    packDownload: 'Download ZIP',
    emptyDir: 'This folder is empty',
    newFolder: 'New folder',
    storageLocation: 'Storage',
  },
};

/** 当前语言（localStorage 'nas-lang'，默认 zh） */
window.getLang = function () {
  const l = localStorage.getItem('nas-lang');
  return (l === 'en' || l === 'zh') ? l : 'zh';
};

/** 取词条：先当前语言，缺失回退中文，再缺失回退 key 本身 */
window.t = function (key) {
  const lang = window.getLang();
  return (window.I18N[lang] && window.I18N[lang][key])
    || (window.I18N.zh && window.I18N.zh[key])
    || key;
};

/** 应用到 DOM：[data-i18n] 替换 textContent，[data-i18n-ph] 替换 placeholder */
window.applyI18n = function (root) {
  const scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const s = window.t(el.getAttribute('data-i18n'));
    if (s !== undefined) el.textContent = s;
  });
  scope.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    const s = window.t(el.getAttribute('data-i18n-ph'));
    if (s !== undefined) el.setAttribute('placeholder', s);
  });
};

/** 切换语言并持久化，然后全页刷新文案 */
window.setLang = function (lang) {
  localStorage.setItem('nas-lang', lang === 'en' ? 'en' : 'zh');
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  window.applyI18n();
};
