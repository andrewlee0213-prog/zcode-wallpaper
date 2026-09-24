#!/usr/bin/env node
/**
 * zcode-wallpaper.cjs — ZCode 桌面端随机壁纸切换引擎 (v3.9 便携版, 支持视频+面板透明度)
 *
 * 用法: node zcode-wallpaper.cjs [图片目录] [视频目录]
 *   未传用默认值; 传空串("")表示跳过该类别; 目录允许不存在或为空。
 *   两类别均无媒体时清单为空, 保留包内兜底壁纸。
 *
 * 架构(v3.8 图片+视频混合清单+面板透明度):
 *  - 图片与视频均原地引用(file:// URL), 不复制、不占额外磁盘
 *  - 引擎生成 D:\zcode\wallpaper-pool\manifest.js(全量地址+随机顺序, 图片视频混合)
 *  - 页面内嵌脚本:
 *      · 左Ctrl+.      在全部条目间循环
 *      · 左Ctrl+1      代码框透明度循环(100→85→70→55→40→100)
 *      · 左Ctrl+2      输入框透明度循环(同上)
 *      · 左Ctrl+3/4    视频减速/加速
 *      · 左Ctrl+5/6    壁纸蒙版加深/减淡(原1/2, v3.8起让位给面板透明度)
 *      · 图片条目 → background-image 叠加(蒙版防闪烁)
 *      · 视频条目 → 表面背景透明 + 固定全屏静音循环 <video> 垫底 + 蒙版
 *  - 面板透明度(v3.8): 运行时从 <pre>/可见<textarea> 向上找圆角不透明面板,
 *    以其原底色生成 rgba 内联样式; 后代同色块一并处理; MutationObserver
 *    自动覆盖新出现的面板; localStorage 记忆; HUD 提示当前档位
 *  - 位置记忆 localStorage; 缺失/损坏条目自动跳过
 *
 * 历史教训:
 *  - v1: 手写主题类名猜测失败 → 解析真实 CSS 自动收集选择器
 *  - v2: !important 改写 CSS 变量破坏消息渲染 → 只叠加 background-image;
 *        视频模式的表面透明同样只改 background 属性, 不碰任何变量
 *  - v3.2: asar 文件协议把 ?v= 查询串当文件名 → 加载失败, 弃用查询串
 *  - v3.3: 双槽同图(打包器去重)热键无视觉变化 → 外部池
 *  - v3.4: 池复制文件占磁盘 → v3.5 全量清单原地引用
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

// ─────────────────────────── 配置(便携自动探测, v3.9) ───────────────────────────
// 优先级: 环境变量 > 命令行(--asar) > 工具包内置 > 本机默认 > 旧机遗留路径
const SCRIPT_DIR = __dirname;                          // ...\zcode背景设置\scripts
const PKG_DIR = path.dirname(SCRIPT_DIR);              // 工具包根目录(便携包解压处)
function firstExisting(list) {
  for (const p of list) { if (p && fs.existsSync(p)) return p; }
  return null;
}
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}
const HOME_PICS = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, 'Pictures', 'zcode-wallpaper') : null;
// 媒体目录: 包内 zcode-wallpaper-media 优先(便携), 其次本机图片库
const MEDIA_DIR = firstExisting([
  process.env.ZCODE_WALLPAPER_DIR,
  path.join(PKG_DIR, 'zcode-wallpaper-media'),
  HOME_PICS,
  'C:\\Users\\XC\\Pictures\\zcode-wallpaper',          // 旧机遗留
]) || HOME_PICS;
// ZCode 主程序包
const ASAR_PATH = firstExisting([
  process.env.ZCODE_ASAR,
  argValue('--asar'),
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'app.asar') : null,
  'C:\\Program Files\\ZCode\\resources\\app.asar',
  'C:\\Program Files (x86)\\ZCode\\resources\\app.asar',
  'D:\\Users\\XC\\AppData\\Local\\Programs\\ZCode\\resources\\app.asar', // 旧机遗留
]);
const REL_ENTRY = 'out/renderer/assets/app-wallpaper.png';     // 包内兜底图(单张)
const REL_ENTRY_B = 'out/renderer/assets/app-wallpaper-b.png'; // 旧版遗留, 重建时清除
const SLOT_SIZE = 32 * 1024 * 1024;                    // 32MB 槽位(仅包内兜底图)
const WORK_DIR = path.join(require('os').tmpdir(), 'zw-theme');
const IMG_EXT_RE = /\.(png|jpe?g|webp|bmp|gif)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|m4v|mov)$/i;
const MASK = 'rgba(8, 10, 16, 0.80)';                  // 壁纸压暗蒙版, 保证前景可读
const MARKER = 'zcode-wallpaper-v3.8';
// 清单目录: 环境变量 ZCODE_POOL > 旧机遗留 D:\zcode(存在则沿用,兼容已注入的旧包) > 本机应用数据
const POOL_DIR = process.env.ZCODE_POOL
  || firstExisting(['D:\\zcode\\wallpaper-pool'])
  || (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'zcode', 'wallpaper-pool')
    : path.join(require('os').homedir(), '.zcode-wallpaper-pool'));
const MANIFEST_PATH = path.join(POOL_DIR, 'manifest.js');
const MANIFEST_URL = 'file:///' + MANIFEST_PATH.replace(/\\/g, '/');
// 备份/打包库路径依赖 ASAR 位置, 用函数取
function backupPath() { return path.join(path.dirname(ASAR_PATH), 'app.asar.pre-wall.bak'); }
function installDir() { return path.dirname(path.dirname(ASAR_PATH)); }   // resources\.. = ZCode 根
function exePath() { return path.join(installDir(), 'ZCode.exe'); }
// 打包内置的 @electron/asar(runtime\asar-lib), 存在则免联网
const BUNDLED_ASAR_LIB = path.join(PKG_DIR, 'runtime', 'asar-lib', 'node_modules', '@electron', 'asar');
const ASAR_LIB_DIR = path.join(WORK_DIR, 'asar-lib'); // @electron/asar 联网安装处(兜底)
// 仅页面级背景变量叠加壁纸; 弹层/菜单/输入框/卡片等小元素保持原色
const TARGET_VARS = [
  '--color-background', '--color-background-alt', '--color-background-win-alt',
];
// ────────────────────────────────────────────────────────────

// unpacked 清单不再写死: 回包时从原包动态读取(写死会随版本变化失效,
// 09-20 升级新增 ssh2/sshcrypto.node, 旧清单漏掉导致回包校验失败)

function log(msg) { console.log('[wallpaper] ' + msg); }
function die(msg) { console.error('[wallpaper][错误] ' + msg); process.exit(1); }

/* ───────────────────── 媒体清单 ───────────────────── */

// 兜底图: 程序化生成的纯黑 64x64 PNG(cover 拉伸铺满)
function makeSolidPng(w, h, rgb) {
  const zlib = require('zlib');
  function crc32(buf) {
    if (!crc32.table) {
      crc32.table = [];
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc32.table[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (const b of buf) c = crc32.table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit, RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = rgb[0]; row[2 + x * 3] = rgb[1]; row[3 + x * 3] = rgb[2]; }
  const raw = Buffer.concat(Array(h).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PLACEHOLDER_PNG = makeSolidPng(64, 64, [0, 0, 0]);

function listImages(dir) {
  if (!dir) return [];
  if (!fs.existsSync(dir)) { log(`图片目录不存在(${dir}), 跳过图片`); return []; }
  const files = fs.readdirSync(dir)
    .filter(f => IMG_EXT_RE.test(f))
    .map(f => path.join(dir, f))
    .filter(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  if (files.length === 0) log(`图片目录为空(${dir}), 跳过图片`);
  return files;
}

function listVideos(dir) {
  if (!dir) return [];
  if (!fs.existsSync(dir)) { log(`视频目录不存在(${dir}), 跳过视频`); return []; }
  const files = fs.readdirSync(dir)
    .filter(f => VIDEO_EXT_RE.test(f))
    .map(f => path.join(dir, f))
    .filter(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
  if (files.length === 0) log(`视频目录为空(${dir}), 跳过视频`);
  return files;
}

// 图片+视频混合条目, 全量随机打乱(每次刷新都是新的循环顺序); 允许为空
function shuffledMedia(imgDir, vidDir) {
  const entries = [
    ...listImages(imgDir).map(p => ({ p, v: 0 })),
    ...listVideos(vidDir).map(p => ({ p, v: 1 })),
  ];
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  return entries;
}

function toFileUrl(p) {
  return encodeURI('file:///' + p.replace(/\\/g, '/'));
}

function sniffFormat(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  return null;
}

/* ───────────────────── asar 头解析 ───────────────────── */

function parseHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const pre = Buffer.alloc(16);
  fs.readSync(fd, pre, 0, 16, 0);
  const headerSize = pre.readUInt32LE(4);
  const jsonLen = pre.readUInt32LE(12);
  const jb = Buffer.alloc(jsonLen);
  fs.readSync(fd, jb, 0, jsonLen, 16);
  const header = JSON.parse(jb.toString('utf8'));
  return { fd, header, FILES_START: 8 + headerSize };
}

function findEntry(header, rel) {
  let node = header;
  for (const part of rel.split('/')) {
    node = node && node.files && node.files[part];
    if (!node) return null;
  }
  return node.files ? null : node;
}

function readEntry(fd, header, FILES_START, rel) {
  const e = findEntry(header, rel);
  if (!e || e.unpacked) return null;
  const b = Buffer.alloc(e.size);
  fs.readSync(fd, b, 0, e.size, FILES_START + Number(e.offset));
  return b;
}

function walkCollect(node, prefix, out) {
  for (const [name, ch] of Object.entries(node.files || {})) {
    const fp = prefix ? prefix + '/' + name : name;
    if (ch.files) walkCollect(ch, fp, out);
    else out.push({ path: fp, unpacked: !!ch.unpacked });
  }
}

/* ───────────────────── @electron/asar ───────────────────── */

function ensureAsarLib() {
  if (fs.existsSync(BUNDLED_ASAR_LIB)) return BUNDLED_ASAR_LIB;   // 便携包内置, 免联网
  const dest = path.join(ASAR_LIB_DIR, 'node_modules', '@electron', 'asar');
  if (fs.existsSync(dest)) return dest;
  log('首次运行，安装 @electron/asar …（仅需一次联网）');
  fs.mkdirSync(ASAR_LIB_DIR, { recursive: true });
  const pkgFile = path.join(ASAR_LIB_DIR, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    fs.writeFileSync(pkgFile, JSON.stringify({ name: 'zw-wallpaper-tool', version: '1.0.0', private: true }));
  }
  const r = spawnSync('npm',
    ['i', '@electron/asar', '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: ASAR_LIB_DIR, stdio: 'inherit', shell: true });
  if (r.status !== 0 || !fs.existsSync(dest)) die('@electron/asar 安装失败，请检查网络后重试');
  return dest;
}

async function loadAsarLib() {
  const libDir = ensureAsarLib();
  return await import(pathToFileURL(path.join(libDir, 'lib', 'asar.js')).href);
}

/* ───────────────────── CSS 分析与样式生成 ───────────────────── */

// 按分隔符切分, 忽略括号/引号内的分隔符
function splitTopLevel(str, sep) {
  const out = []; let depth = 0, cur = '', q = null;
  for (const ch of str) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') { depth++; cur += ch; continue; }
    if (ch === ')' || ch === ']') { depth--; cur += ch; continue; }
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

// 递归收集样式规则, 展开 @media/@layer; 跳过 @keyframes/@font-face 等
// (Tailwind v4 把工具类全部包在 @layer 中, 必须穿透)
function collectRules(css) {
  const rules = [];
  function parse(text, mediaCond) {
    let i = 0;
    while (i < text.length) {
      const b = text.indexOf('{', i);
      if (b === -1) break;
      const prelude = text.slice(i, b).trim();
      let d = 0, j = b, q = null;
      for (; j < text.length; j++) {
        const ch = text[j];
        if (q) { if (ch === q) q = null; continue; }
        if (ch === '"' || ch === "'") q = ch;
        else if (ch === '{') d++;
        else if (ch === '}') { d--; if (d === 0) break; }
      }
      if (j >= text.length) break;
      const body = text.slice(b + 1, j);
      if (prelude.startsWith('@')) {
        const m = prelude.match(/^@([a-z-]+)\b\s*(.*)$/s);
        const kind = m && m[1];
        if (kind === 'layer' || kind === 'scope') {
          parse(body, mediaCond);                    // 透明容器, 条件不变
        } else if (kind === 'media') {
          const cond = m[2].trim();
          parse(body, mediaCond ? mediaCond + ' and ' + cond : cond);
        } else if ((kind === 'supports' || kind === 'container') && !mediaCond) {
          parse(body, m[2].trim());
        }
        // 其他 @ 规则(keyframes/font-face/property 等)整块跳过
      } else if (prelude) {
        rules.push({ media: mediaCond || '', prelude, body });
      }
      i = j + 1;
    }
  }
  parse(css.replace(/\/\*[\s\S]*?\*\//g, ''), '');
  return rules;
}

function parseDecls(body) {
  const map = {};
  for (const d of splitTopLevel(body, ';')) {
    const c = d.indexOf(':');
    if (c > 0) map[d.slice(0, c).trim()] = d.slice(c + 1).trim();
  }
  return map;
}

const varRe = t => new RegExp('var\\(\\s*' + t.replace(/-/g, '\\-') + '\\s*[,)]');

// 分析真实样式表: 找出"以页面背景色为背景"的选择器, 生成叠加式壁纸 CSS
function buildWallpaperCss(cssText, bakedItems) {
  const rules = collectRules(cssText);
  const targets = new Set(TARGET_VARS);

  const groups = new Map();   // mediaCond -> Set<selectors>
  let ruleHits = 0;
  for (const r of rules) {
    const d = parseDecls(r.body);
    if (Object.keys(d).some(p => p.startsWith('--color-'))) continue;
    let ok = false;
    for (const [p, v] of Object.entries(d)) {
      if (p !== 'background' && p !== 'background-color') continue;
      if (/gradient\(|url\(/.test(v)) continue;
      for (const t of targets) { if (varRe(t).test(v)) { ok = true; break; } }
      if (ok) break;
    }
    if (!ok) continue;
    const sels = splitTopLevel(r.prelude, ',')
      .filter(s => s && !s.startsWith('@'))
      .filter(s => !/:(hover|active|focus|focus-within|focus-visible|visited|checked|disabled|placeholder-shown)|::/.test(s))
      .filter(s => !/data-active|aria-expanded/.test(s));
    if (!sels.length) continue;
    ruleHits++;
    if (!groups.has(r.media)) groups.set(r.media, new Set());
    for (const s of sels) groups.get(r.media).add(s);
  }

  const allSels = [...groups.values()].reduce((a, s) => a + s.size, 0);
  log(`CSS 分析: 命中 ${ruleHits} 条规则 / ${allSels} 个选择器`);
  if (allSels < 3) throw new Error('CSS 分析命中过少(' + allSels + '), 疑似版本结构变化, 已中止');

  // 静态兜底样式(引用包内单张图)
  const WALL = "url('./assets/app-wallpaper.png')";
  const BODY_DECL = [
    `background-image:linear-gradient(${MASK},${MASK}),${WALL} !important`,
    'background-size:cover !important',
    'background-position:center !important',
    'background-attachment:fixed !important',
    'background-repeat:no-repeat !important',
  ].join(';');

  let css = `<style id="zcode-custom-wallpaper">\n`;
  css += `/* ${MARKER} auto-generated: ${allSels} selectors */\n`;
  css += `html{background:#0b0e14 ${WALL} center/cover no-repeat fixed !important;}\n`;
  for (const [media, set] of groups) {
    const arr = [...set];
    for (let i = 0; i < arr.length; i += 150) {
      const chunk = arr.slice(i, i + 150).join(',\n');
      css += media ? `@media ${media}{${chunk}{${BODY_DECL};}}\n` : `${chunk}{${BODY_DECL};}\n`;
    }
  }
  css += `</style>`;

  // 运行时脚本: 开机载入外部清单(失败用内嵌清单), 左Ctrl+. 全量循环;
  // 图片条目→背景叠加; 视频条目→表面透明+全屏静音循环视频垫底+蒙版
  const groupsPlain = {};
  for (const [media, set] of groups) groupsPlain[media] = [...set];
  const script = `<script id="zcode-wallpaper-live">
(function () {
  try {
    var groups = ${JSON.stringify(groupsPlain)};
    var MASK_RGB = '8, 10, 16';
    var DEFAULT_ALPHA = ${JSON.stringify(parseFloat(MASK.replace(/^rgba\([^)]*,\s*([\d.]+)\)$/, '$1')) || 0.8)};
    var alpha = DEFAULT_ALPHA;
    try {
      alpha = parseFloat(localStorage.getItem('zw-wall-alpha'));
      if (!(alpha >= 0 && alpha <= 0.95)) alpha = DEFAULT_ALPHA;
    } catch (e) { alpha = DEFAULT_ALPHA; }
    function maskCss() { return 'rgba(' + MASK_RGB + ',' + alpha + ')'; }
    var rate = 1;
    try {
      rate = parseFloat(localStorage.getItem('zw-wall-rate'));
      if (!(rate >= 0.25 && rate <= 4)) rate = 1;
    } catch (e) { rate = 1; }
    var MANIFEST_URL = ${JSON.stringify(MANIFEST_URL)};
    var RING_BASE = ${JSON.stringify(MANIFEST_URL.replace('manifest.js', 'manifest-'))};
    var curGen = 0, curSlot = -1;
    var items = ${JSON.stringify(bakedItems)};
    var idx = 0;
    try { idx = parseInt(localStorage.getItem('zw-wall-idx') || '0', 10) || 0; } catch (e) {}
    if (!items.length || idx >= items.length) idx = items.length ? idx % items.length : 0;
    var vid = null, maskDiv = null;
    function liveStyle() {
      var el = document.getElementById('zcode-wallpaper-live-style');
      if (!el) { el = document.createElement('style'); el.id = 'zcode-wallpaper-live-style'; document.head.appendChild(el); }
      return el;
    }
    function allSels() {
      var out = [];
      for (var m in groups) out = out.concat(groups[m]);
      return out.join(',');
    }
    function applyImageCss(u) {
      var css = 'html{background:#0b0e14 url("' + u + '") center/cover no-repeat fixed !important;}';
      for (var media in groups) {
        var body = groups[media].join(',') + '{background-image:linear-gradient(' + maskCss() + ',' + maskCss() + '),url("' + u + '") !important;background-size:cover !important;background-position:center !important;background-attachment:fixed !important;background-repeat:no-repeat !important;}';
        css += media ? ('@media ' + media + '{' + body + '}') : body;
      }
      liveStyle().textContent = css;
    }
    function applyVideoCss() {
      var css = 'html{background:#0b0e14 !important;}';
      css += allSels() + '{background-image:none !important;background-color:transparent !important;}';
      liveStyle().textContent = css;
    }
    function applyEntry(i) {
      var e = items[i];
      if (!e) return;
      idx = i;
      try { localStorage.setItem('zw-wall-idx', String(i)); } catch (err) {}
      if (e.v) {
        if (vid) {
          vid.style.display = 'block';
          if (vid.getAttribute('src') !== e.u) { vid.src = e.u; var pr = vid.play(); if (pr && pr.catch) pr.catch(function () {}); }
          try { vid.playbackRate = rate; } catch (e2) {}
        }
        if (maskDiv) maskDiv.style.display = 'block';
        applyVideoCss();
      } else {
        if (vid) { vid.pause(); vid.style.display = 'none'; }
        if (maskDiv) maskDiv.style.display = 'none';
        applyImageCss(e.u);
      }
    }
    function probeEntry(e, ok, fail) {
      if (e.v) {
        var t = document.createElement('video');
        t.preload = 'metadata'; t.muted = true;
        t.onloadeddata = function () { ok(); };
        t.onerror = fail;
        t.src = e.u;
      } else {
        var im = new Image();
        im.onload = ok;
        im.onerror = fail;
        im.src = e.u;
      }
    }
    function restoreCurrent() {
      var e = items[idx];
      if (!e) return;
      probeEntry(e, function () { applyEntry(idx); }, function () {});
    }
    function adopt(m) {
      if (!m || !m.items || !m.items.length) return false;
      if (m.gen <= curGen) return false;
      items = m.items;
      curGen = m.gen;
      if (typeof m.slot === 'number') curSlot = m.slot;
      if (idx >= items.length) idx = idx % items.length;
      return true;
    }
    function loadScript(url, ok, fail2) {
      var sc = document.createElement('script');
      sc.src = url;
      sc.onload = function () { ok(); };
      sc.onerror = function () { fail2(); };
      document.head.appendChild(sc);
    }
    // 热刷新: 轮转文件名探测新清单(不同文件名绕过脚本缓存), bat 运行后无需重启即纳入新媒体
    function refresh(done) {
      if (curSlot < 0) { done(); return; }
      var tries = 0;
      function next() {
        if (tries >= 10) { done(); return; }
        var cand = (curSlot + 1 + tries) % 10;
        tries++;
        loadScript(RING_BASE + cand + '.js', function () {
          if (adopt(window.__ZW_POOL__)) { done(); } else { next(); }
        }, next);
      }
      next();
    }
    function swap() {
      refresh(function () {
        if (!items.length) return;
        var i = idx, fails = 0;
        function attempt() {
          i = i + 1;
          if (i >= items.length) i = 0;
          if (i === idx) return;
          probeEntry(items[i], function () { applyEntry(i); }, function () { fails++; if (fails <= 20) attempt(); });
        }
        attempt();
      });
    }
    function setRate(d) {
      rate = Math.round((rate + d) * 100) / 100;
      if (rate < 0.25) rate = 0.25;
      if (rate > 4) rate = 4;
      try { localStorage.setItem('zw-wall-rate', String(rate)); } catch (err) {}
      if (vid) { try { vid.playbackRate = rate; } catch (e2) {} }
    }
    function setAlpha(d) {
      alpha = Math.round((alpha + d) * 100) / 100;
      if (alpha < 0) alpha = 0;
      if (alpha > 0.95) alpha = 0.95;
      try { localStorage.setItem('zw-wall-alpha', String(alpha)); } catch (err) {}
      if (maskDiv) maskDiv.style.background = maskCss();
      var cur = items[idx];
      if (cur) { if (cur.v) applyVideoCss(); else applyImageCss(cur.u); }
    }
    // ── 面板透明度(左Ctrl+1 代码框 / 左Ctrl+2 输入框) ──
    var PANEL_LEVELS = [1, 0.85, 0.7, 0.55, 0.4];
    var codeAlpha = loadLevel('zw-code-alpha');
    var inputAlpha = loadLevel('zw-input-alpha');
    var codeBase = null, inputBase = null, toastEl = null, toastTimer = null, moLast = 0, mo = null;
    function loadLevel(key) {
      try { var v = parseFloat(localStorage.getItem(key)); if (v >= 0.3 && v <= 1) return v; } catch (e) {}
      return 1;
    }
    function saveLevel(key, v) { try { localStorage.setItem(key, String(v)); } catch (e) {} }
    function toast(msg) {
      if (!toastEl || !toastEl.isConnected) {
        toastEl = document.createElement('div');
        toastEl.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;background:rgba(10,14,22,.9);color:#dfe7f5;font:600 13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:10px;border:1px solid rgba(120,150,220,.35);pointer-events:none;transition:opacity .4s;opacity:0';
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.style.opacity = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { if (toastEl) toastEl.style.opacity = '0'; }, 1500);
    }
    function rgbOf(color) {
      var m = /rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)/.exec(color || '');
      return m ? (m[1] + ',' + m[2] + ',' + m[3]) : null;
    }
    function bgAlpha(color) {
      if (!color || color === 'transparent') return 0;
      var m = /rgba?\\(([^)]*)\\)/.exec(color);
      if (!m) return 0;
      var parts = m[1].split(/[,\\s\\/]+/).filter(function (x) { return x !== ''; });
      if (parts.length >= 4) { var v = parseFloat(parts[3]); return isNaN(v) ? 1 : (v > 1 ? v / 255 : v); }
      return 1;
    }
    function panelOf(el, maxUp) {
      var e = el, up = 0, i;
      for (i = 0; i < 2; i++) {
        e = el; up = 0;
        while (e && e !== document.body && up < maxUp) {
          var cs = getComputedStyle(e);
          var bg = cs.backgroundColor;
          var r = parseFloat(cs.borderTopLeftRadius) || 0;
          if (bgAlpha(bg) >= 0.1 && rgbOf(bg) && (i === 1 || r >= 8)) return e;
          e = e.parentElement; up++;
        }
      }
      return null;
    }
    function collectPanels(kind) {
      var out = [], i;
      if (kind === 'code') {
        var pres = document.querySelectorAll('pre');
        for (i = 0; i < pres.length; i++) {
          var p = panelOf(pres[i], 8);
          if (p && out.indexOf(p) < 0) out.push(p);
        }
      } else {
        var tas = document.querySelectorAll('textarea');
        var best = null, bestTop = -1;
        for (i = 0; i < tas.length; i++) {
          var ta = tas[i];
          if (!ta.offsetParent) continue;
          var rr = ta.getBoundingClientRect();
          if (rr.width < 60 || rr.height < 18) continue;
          if (rr.top > bestTop) { bestTop = rr.top; best = ta; }
        }
        if (best) {
          var pp = panelOf(best, 8);
          if (pp) out.push(pp);
        }
      }
      return out;
    }
    function closeRgb(color, base) {
      var v = rgbOf(color);
      if (!v || !base) return false;
      var a = v.split(','), b = base.split(',');
      for (var i = 0; i < 3; i++) if (Math.abs(parseFloat(a[i]) - parseFloat(b[i])) > 10) return false;
      return true;
    }
    function applyPanels(kind, els, base, a) {
      var target = 'rgba(' + base + ',' + a + ')';
      for (var i = 0; i < els.length; i++) {
        var list = [els[i]].concat([].slice.call(els[i].querySelectorAll('*')));
        for (var j = 0; j < list.length; j++) {
          var n = list[j];
          if (a < 1) {
            if (n === els[i] || closeRgb(getComputedStyle(n).backgroundColor, base)) {
              if (n.style.backgroundColor !== target) n.style.backgroundColor = target;
            }
          } else if (n.style.backgroundColor) {
            n.style.backgroundColor = '';
          }
        }
      }
    }
    function cyclePanel(kind) {
      var els = collectPanels(kind), base, a;
      if (kind === 'code') {
        if (!codeBase && els[0]) codeBase = rgbOf(getComputedStyle(els[0]).backgroundColor);
        if (!codeBase) { toast('未找到代码框'); return; }
        codeAlpha = PANEL_LEVELS[(PANEL_LEVELS.indexOf(codeAlpha) + 1) % PANEL_LEVELS.length];
        a = codeAlpha; saveLevel('zw-code-alpha', a);
        applyPanels('code', els, codeBase, a);
        toast('代码框透明度 ' + Math.round(a * 100) + '%');
      } else {
        if (!inputBase && els[0]) inputBase = rgbOf(getComputedStyle(els[0]).backgroundColor);
        if (!inputBase) { toast('未找到输入框'); return; }
        inputAlpha = PANEL_LEVELS[(PANEL_LEVELS.indexOf(inputAlpha) + 1) % PANEL_LEVELS.length];
        a = inputAlpha; saveLevel('zw-input-alpha', a);
        applyPanels('input', els, inputBase, a);
        toast('输入框透明度 ' + Math.round(a * 100) + '%');
      }
    }
    function refreshPanels() {
      if (codeAlpha < 1) {
        var e1 = collectPanels('code');
        if (!codeBase && e1[0]) codeBase = rgbOf(getComputedStyle(e1[0]).backgroundColor);
        if (codeBase) applyPanels('code', e1, codeBase, codeAlpha);
      }
      if (inputAlpha < 1) {
        var e2 = collectPanels('input');
        if (!inputBase && e2[0]) inputBase = rgbOf(getComputedStyle(e2[0]).backgroundColor);
        if (inputBase) applyPanels('input', e2, inputBase, inputAlpha);
      }
    }
    function boot() {
      vid = document.createElement('video');
      vid.id = 'zcode-wallpaper-video';
      vid.muted = true; vid.loop = true; vid.autoplay = true;
      vid.setAttribute('playsinline', '');
      try { vid.playbackRate = rate; } catch (e) {}
      vid.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;object-fit:cover;z-index:-2;display:none;pointer-events:none;background:#000;';
      document.body.appendChild(vid);
      maskDiv = document.createElement('div');
      maskDiv.id = 'zcode-wallpaper-mask';
      maskDiv.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;z-index:-1;display:none;pointer-events:none;background:' + maskCss() + ';';
      document.body.appendChild(maskDiv);
      restoreCurrent();
      loadScript(MANIFEST_URL, function () {
        if (adopt(window.__ZW_POOL__)) restoreCurrent();
      }, function () { /* 清单缺失时使用内嵌清单 */ });
      setTimeout(refreshPanels, 1200);
      if (!mo) {
        try {
          mo = new MutationObserver(function () {
            var now = Date.now();
            if (now - moLast < 800) return;
            moLast = now;
            setTimeout(function () { if (codeAlpha < 1 || inputAlpha < 1) refreshPanels(); }, 200);
          });
          mo.observe(document.body, { childList: true, subtree: true });
        } catch (e) {}
      }
    }
    var leftCtrl = false;
    function onKey(e) {
      if (e.__zwSeen) return;          // window/document 双层只处理一次
      e.__zwSeen = true;
      if (e.key === 'Control') { leftCtrl = (e.location === 1); return; }
      if (!e.ctrlKey || !leftCtrl || e.shiftKey || e.altKey || e.metaKey) return;
      var k = e.key, c = e.code;
      if (k === '.' || c === 'Period') { e.preventDefault(); e.stopPropagation(); swap(); return; }
      if (k === '1' || c === 'Digit1') { e.preventDefault(); e.stopPropagation(); cyclePanel('code'); return; }
      if (k === '2' || c === 'Digit2') { e.preventDefault(); e.stopPropagation(); cyclePanel('input'); return; }
      if (k === '3' || c === 'Digit3') { e.preventDefault(); e.stopPropagation(); setRate(-0.25); return; }
      if (k === '4' || c === 'Digit4') { e.preventDefault(); e.stopPropagation(); setRate(0.25); return; }
      if (k === '5' || c === 'Digit5') { e.preventDefault(); e.stopPropagation(); setAlpha(0.05); return; }
      if (k === '6' || c === 'Digit6') { e.preventDefault(); e.stopPropagation(); setAlpha(-0.05); return; }
    }
    function onKeyUp(e) {
      if (e.__zwUp) return;
      e.__zwUp = true;
      if (e.key === 'Control') leftCtrl = false;
    }
    function bindHotkeys() {
      window.addEventListener('keydown', onKey, true);      // 捕获链最早环节, 优先于应用处理器
      window.addEventListener('keyup', onKeyUp, true);
      document.addEventListener('keydown', onKey, true);    // 兜底: window 被拦截时仍可触达
      document.addEventListener('keyup', onKeyUp, true);
    }
    bindHotkeys();
    setInterval(bindHotkeys, 30000);                        // 自愈: 同引用重复绑定被浏览器去重, 无副作用
    window.addEventListener('blur', function () { leftCtrl = false; });
    window.addEventListener('focus', function () { leftCtrl = false; });
    document.addEventListener('visibilitychange', function () { if (document.hidden) leftCtrl = false; });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  } catch (err) { /* 静态样式兜底, 失败无害 */ }
})();
</script>`;
  return { css, script, selectorCount: allSels, sample: [...(groups.get('') || new Set())].slice(0, 6) };
}

/* ───────────────────── 样式注入 ───────────────────── */

function injectStyle(indexPath, css, script) {
  let html = fs.readFileSync(indexPath, 'utf8');
  if (!html.includes('</head>')) throw new Error('index.html 缺少 </head>');
  const reStyle = /<style id="zcode-custom-wallpaper">[\s\S]*?<\/style>/;
  const reScript = /<script id="zcode-wallpaper-live">[\s\S]*?<\/script>/;
  html = html.replace(reScript, '');
  html = reStyle.test(html)
    ? html.replace(reStyle, () => css + '\n' + script)
    : html.replace('</head>', () => css + '\n' + script + '\n  </head>');
  fs.writeFileSync(indexPath, html);
  if (!html.includes(MARKER) || !html.includes('zcode-wallpaper-live') ||
      !html.includes('./assets/app-wallpaper.png')) {
    throw new Error('样式注入校验失败');
  }
}

/* ───────────────────── 清单写入 ───────────────────── */

// 全量清单写入 manifest.js; 清理旧版遗留的池图片
function writeManifest(entries) {
  fs.mkdirSync(POOL_DIR, { recursive: true });
  const items = entries.map(x => ({ u: toFileUrl(x.p), v: x.v }));
  // 找现有轮转清单中 gen 最新的槽号, 新清单写到下一槽(页面按槽号探测热刷新)
  let prevSlot = -1, prevGen = -1;
  for (const f of fs.readdirSync(POOL_DIR)) {
    if (!/^manifest-\d\.js$/.test(f)) continue;
    try {
      const t = fs.readFileSync(path.join(POOL_DIR, f), 'utf8');
      const g = Number((t.match(/gen:(\d+)/) || [0, 0])[1]);
      if (g > prevGen) { prevGen = g; prevSlot = Number(f.match(/manifest-(\d)\.js$/)[1]); }
    } catch {}
  }
  const slot = (prevSlot + 1) % 10;
  const js = 'window.__ZW_POOL__ = {gen:' + Date.now() + ',slot:' + slot + ',items:' + JSON.stringify(items) + '};\n';
  fs.writeFileSync(MANIFEST_PATH, js, 'utf8');                                     // 页面启动加载
  fs.writeFileSync(path.join(POOL_DIR, 'manifest-' + slot + '.js'), js, 'utf8');   // 会话内热刷新
  for (const f of fs.readdirSync(POOL_DIR)) {
    const del = /^w\d+\.png$/.test(f) || (/^manifest-\d\.js$/.test(f) && f !== 'manifest-' + slot + '.js');
    if (del) { try { fs.unlinkSync(path.join(POOL_DIR, f)); } catch {} }
  }
  return items;
}

/* ───────────────────── Mode A：重扫目录刷新清单(不动 asar) ───────────────────── */

function fastMode(imgDir, vidDir) {
  const { fd, header, FILES_START } = parseHeader(ASAR_PATH);
  try {
    const entry = findEntry(header, REL_ENTRY);
    if (!entry || entry.unpacked || Number(entry.size) !== SLOT_SIZE) return null;
    const idx = readEntry(fd, header, FILES_START, 'out/renderer/index.html');
    if (!idx || !idx.toString('utf8').includes(MARKER)) return null; // 旧版结构 → 重建
  } finally { fs.closeSync(fd); }
  const n = writeManifest(shuffledMedia(imgDir, vidDir)).length;
  return n;
}

/* ───────────────────── Mode B：开槽重建 ───────────────────── */

async function rebuild(imgDir, vidDir) {
  const base = parseHeader(ASAR_PATH);
  const baseOut = [];
  walkCollect(base.header, '', baseOut);
  fs.closeSync(base.fd);
  const baseHasWall = !!findEntry(base.header, REL_ENTRY);
  const baseHasWallB = !!findEntry(base.header, REL_ENTRY_B);
  const expectedTotal = baseOut.length + (baseHasWall ? 0 : 1) - (baseHasWallB ? 1 : 0);

  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });

  const t0 = Date.now();
  log('解包（约 30-60 秒）…');
  const asarLib = await loadAsarLib();
  const workRoot = path.join(WORK_DIR, 'work');
  await asarLib.extractAll(ASAR_PATH, workRoot);

  // 清除旧版遗留 B 槽
  const slotBPath = path.join(workRoot, ...REL_ENTRY_B.split('/'));
  if (fs.existsSync(slotBPath)) { fs.unlinkSync(slotBPath); log('已移除旧版 B 槽位'); }

  // 全量清单: 外部 manifest + asar 内嵌兜底副本
  const shuffled = shuffledMedia(imgDir, vidDir);
  const items = writeManifest(shuffled);
  const vCount = items.filter(x => x.v).length;
  log(`清单: ${items.length} 个条目(图片 ${items.length - vCount} / 视频 ${vCount}) → ${MANIFEST_PATH}`);

  const assetsDir = path.join(workRoot, 'out', 'renderer', 'assets');
  const cssCandidates = fs.readdirSync(assetsDir)
    .filter(f => /^styles-.*\.css$/.test(f))
    .sort((a, b) => fs.statSync(path.join(assetsDir, b)).size - fs.statSync(path.join(assetsDir, a)).size);
  if (!cssCandidates.length) throw new Error('未找到 styles-*.css, 疑似版本结构变化');
  log('样式表: ' + cssCandidates[0]);
  const gen = buildWallpaperCss(fs.readFileSync(path.join(assetsDir, cssCandidates[0]), 'utf8'), items);
  if (gen.sample.length) log('选择器示例: ' + gen.sample.join(' | ').slice(0, 200));

  injectStyle(path.join(workRoot, 'out', 'renderer', 'index.html'), gen.css, gen.script);

  // 包内兜底图: 固定纯黑(64x64 #000, CSS cover 拉伸铺满)
  const slotWorkPath = path.join(workRoot, ...REL_ENTRY.split('/'));
  {
    const slot = Buffer.alloc(SLOT_SIZE);
    PLACEHOLDER_PNG.copy(slot, 0);
    Buffer.from('ZWALLSLOTEND', 'latin1').copy(slot, SLOT_SIZE - 12);
    fs.writeFileSync(slotWorkPath, slot);
    log(`兜底图: 纯黑 ${PLACEHOLDER_PNG.length}B`);
  }

  log('打包新 asar（约 20-40 秒）…');
  const dest = path.join(WORK_DIR, 'app.asar.new');
  const unpackGlob = '{**/' + baseOut.filter(f => f.unpacked).map(f => f.path).join(',**/') + '}';
  await asarLib.createPackageWithOptions(workRoot, dest, { unpack: unpackGlob });

  // ── 三重校验 ──
  const nw = parseHeader(dest);
  const nwOut = [];
  walkCollect(nw.header, '', nwOut);
  if (nwOut.length !== expectedTotal) throw new Error(`文件数异常 ${nwOut.length}/${expectedTotal}`);
  const uset = a => JSON.stringify(a.filter(f => f.unpacked).map(f => f.path).sort());
  if (uset(nwOut) !== uset(baseOut)) throw new Error('unpacked 集合与原包不一致');
  const entryA = findEntry(nw.header, REL_ENTRY);
  if (!entryA || Number(entryA.size) !== SLOT_SIZE) throw new Error('壁纸兜底槽位异常');
  if (findEntry(nw.header, REL_ENTRY_B)) throw new Error('旧版 B 槽位未清除');
  let idxNode = nw.header;
  for (const p of 'out/renderer/index.html'.split('/')) idxNode = idxNode.files[p];
  const idxBuf = Buffer.alloc(idxNode.size);
  fs.readSync(nw.fd, idxBuf, 0, idxNode.size, nw.FILES_START + Number(idxNode.offset));
  const idxText = idxBuf.toString('utf8');
  if (!idxText.includes(MARKER) || !idxText.includes(MANIFEST_URL) || !idxText.includes('zcode-wallpaper-video')) {
    throw new Error('样式/脚本标记缺失');
  }
  fs.closeSync(nw.fd);

  // ── 覆盖正式包 ──
  const BACKUP = backupPath();
  log('备份当前包 → ' + BACKUP);
  fs.copyFileSync(ASAR_PATH, BACKUP);
  log('写入正式包 …');
  fs.copyFileSync(dest, ASAR_PATH);

  const live = parseHeader(ASAR_PATH);
  const liveEntry = findEntry(live.header, REL_ENTRY);
  fs.closeSync(live.fd);
  if (!liveEntry || Number(liveEntry.size) !== SLOT_SIZE) throw new Error('回读校验失败');

  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  log(`完成 ✓ 共 ${items.length} 个条目可用(视频 ${vCount}), 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  log(`按 左Ctrl+. 循环全部条目; 左Ctrl+1/2 代码框/输入框透明度; 左Ctrl+5/6 蒙版深浅; 左Ctrl+3/4 视频速度。运行本工具重扫目录。`);
}

/* ───────────────────── Mode C：一键应用(关 ZCode→重建→重启) ───────────────────── */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function applyMode(imgDir, vidDir) {
  if (process.platform !== 'win32') die('--apply 仅支持 Windows');
  log('关闭 ZCode …');
  spawnSync('taskkill', ['/IM', 'ZCode.exe'], { stdio: 'ignore', shell: true });
  await sleep(3000);
  spawnSync('taskkill', ['/F', '/IM', 'ZCode.exe'], { stdio: 'ignore', shell: true });
  await sleep(1500);
  log('重建注入包 …');
  await rebuild(imgDir, vidDir);
  const exe = exePath();
  if (fs.existsSync(exe)) {
    log('重启 ZCode …');
    const { spawn } = require('child_process');
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  } else {
    log('未找到 ' + exe + ' , 请手动启动 ZCode');
  }
  log('完成 ✓ 按键: 左Ctrl+. 换壁纸 | 左Ctrl+1/2 代码框/输入框透明度 | 左Ctrl+5/6 蒙版深浅 | 左Ctrl+3/4 视频速度');
}

/* ───────────────────── 主流程 ───────────────────── */

async function main() {
  // 参数: [图片目录] [视频目录]; 未传用自动探测(包内media→图片库); 传空串("")表示跳过该类别
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const imgDir = args.length > 0 ? args[0] : MEDIA_DIR;
  const vidDir = args.length > 1 ? args[1] : MEDIA_DIR;

  if (!ASAR_PATH) {
    die('未找到 ZCode 安装。已尝试: %LOCALAPPDATA%\\Programs\\ZCode、Program Files、' +
        '旧机遗留路径。请设环境变量 ZCODE_ASAR 指向 app.asar, 或加参数 --asar <路径>');
  }
  if (!fs.existsSync(ASAR_PATH)) die('ZCode 主程序包不存在: ' + ASAR_PATH);

  try {
    if (process.argv.includes('--apply')) {
      log('一键应用模式(自动关闭/重启 ZCode) …');
      await applyMode(imgDir, vidDir);
      return;
    }
    const forceRebuild = process.argv.includes('--rebuild');
    const imgs = listImages(imgDir);
    const vids = listVideos(vidDir);
    log(`图片目录: ${imgDir || '(未指定)'} (${imgs.length} 张) | 视频目录: ${vidDir || '(未指定)'} (${vids.length} 个)`);
    if (imgs.length + vids.length === 0) log('两个目录均无可用媒体, 清单为空(仅保留兜底壁纸)');
    const fast = forceRebuild ? null : fastMode(imgDir, vidDir);
    if (fast !== null) {
      log(`完成 ✓ 清单已刷新(${fast} 个条目)。在 ZCode 中按 左Ctrl+. 切换。`);
      return;
    }
    log(forceRebuild ? '强制重建模式 …' : '检测到未初始化/旧版结构，进入一次性重建模式 …');
    await rebuild(imgDir, vidDir);
  } catch (err) {
    die(err && err.message ? err.message : String(err));
  }
}

// 可被其他脚本 require 复用, 不自动执行主流程
module.exports = { makeSolidPng, parseHeader, findEntry, ASAR_PATH, REL_ENTRY, SLOT_SIZE, buildWallpaperCss };
if (require.main === module) main();
