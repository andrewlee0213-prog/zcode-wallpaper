#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
zcode-wallpaper-mac.py — ZCode 桌面端(macOS)随机壁纸切换引擎
移植自 andrewlee0213-prog/zcode-wallpaper 的 scripts/zcode-wallpaper.cjs (v3.9, Windows)。

与 Windows 版的差异:
  - 零依赖纯 Python 3(macOS 自带 python3),asar 解析/重打包全部自实现
  - 路径按 macOS 探测(/Applications/ZCode.app 等),清单目录在
    ~/Library/Application Support/zcode-wallpaper-pool
  - 不自动杀/重启 ZCode:替换 asar 用原子 rename,运行中的旧进程不受影响,
    完全退出并重开 ZCode 后生效(--apply 见下)
  - --apply: osascript 退出 ZCode → 替换 → open 重开(终端里运行, 勿在 ZCode 内跑)

用法:
  python3 zcode-wallpaper-mac.py [图片目录] [视频目录] [--rebuild]
  日常换素材(已注入过, 秒级重扫, 无需重启 ZCode):
    python3 zcode-wallpaper-mac.py
  首次/结构重建(需重开 ZCode 生效):
    python3 zcode-wallpaper-mac.py --rebuild

热键(与 Windows 版一致, 全部为【左】Ctrl):
  左Ctrl+.   循环壁纸    左Ctrl+1/2  代码框/输入框透明度
  左Ctrl+3/4 视频减速/加速  左Ctrl+5/6  蒙版加深/减淡
"""
import hashlib
import json
import os
import random
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import zlib
from urllib.parse import quote

# ─────────────────────────── 配置(macOS 自动探测) ───────────────────────────
SCRIPT_PATH = os.path.abspath(__file__)
PKG_DIR = os.path.dirname(SCRIPT_PATH)


def first_existing(paths):
    for p in paths:
        if p and os.path.exists(p):
            return p
    return None


def arg_value(flag):
    argv = sys.argv
    return argv[argv.index(flag) + 1] if flag in argv else None


HOME_PICS = os.path.join(os.path.expanduser('~'), 'Pictures', 'zcode-wallpaper')
MEDIA_DIR = first_existing([
    os.environ.get('ZCODE_WALLPAPER_DIR'),
    os.path.join(PKG_DIR, 'zcode-wallpaper-media'),
    HOME_PICS,
]) or HOME_PICS

ASAR_PATH = first_existing([
    os.environ.get('ZCODE_ASAR'),
    arg_value('--asar'),
    '/Applications/ZCode.app/Contents/Resources/app.asar',
    os.path.expanduser('~/Applications/ZCode.app/Contents/Resources/app.asar'),
])

REL_ENTRY = 'out/renderer/assets/app-wallpaper.png'      # 包内兜底图(单张)
REL_ENTRY_B = 'out/renderer/assets/app-wallpaper-b.png'  # 旧版遗留, 重建时清除
SLOT_SIZE = 32 * 1024 * 1024                             # 32MB 槽位(仅包内兜底图)
WORK_DIR = os.path.join(tempfile.gettempdir(), 'zw-theme-mac')
IMG_EXT_RE = re.compile(r'\.(png|jpe?g|webp|bmp|gif)$', re.I)
VIDEO_EXT_RE = re.compile(r'\.(mp4|webm|m4v|mov)$', re.I)
MASK = 'rgba(8, 10, 16, 0.80)'                           # 壁纸压暗蒙版, 保证前景可读
MARKER = 'zcode-wallpaper-mac-v2'

POOL_DIR = (os.environ.get('ZCODE_POOL')
            or os.path.join(os.path.expanduser('~'),
                            'Library', 'Application Support', 'zcode-wallpaper-pool'))
MANIFEST_PATH = os.path.join(POOL_DIR, 'manifest.js')
MANIFEST_URL = 'file://' + quote(os.path.abspath(MANIFEST_PATH), safe='/')

# 仅页面级背景变量叠加壁纸; 弹层/菜单/输入框/卡片等小元素保持原色
TARGET_VARS = [
    '--color-background', '--color-background-alt', '--color-background-win-alt',
]
# ────────────────────────────────────────────────────────────


def log(msg):
    print('[wallpaper] ' + msg, flush=True)


def die(msg):
    print('[wallpaper][错误] ' + msg, file=sys.stderr, flush=True)
    sys.exit(1)


# ───────────────────── 媒体清单 ─────────────────────

def make_solid_png(w, h, rgb):
    """兜底图: 程序化生成的纯色 PNG(cover 拉伸铺满)"""
    def crc32(buf):
        table = []
        for n in range(256):
            c = n
            for _ in range(8):
                c = (0xedb88320 ^ (c >> 1)) if (c & 1) else (c >> 1)
            table.append(c & 0xffffffff)
        c = 0xffffffff
        for b in buf:
            c = table[(c ^ b) & 0xff] ^ (c >> 8)
        return (c ^ 0xffffffff) & 0xffffffff

    def chunk(typ, data):
        return (struct.pack('>I', len(data)) + typ + data
                + struct.pack('>I', crc32(typ + data)))

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    row = b'\x00' + bytes(rgb) * w
    raw = row * h
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


PLACEHOLDER_PNG = make_solid_png(64, 64, (0, 0, 0))


def list_media(dir_path, ext_re, kind):
    if not dir_path:
        return []
    if not os.path.isdir(dir_path):
        log(f'{kind}目录不存在({dir_path}), 跳过')
        return []
    files = [os.path.join(dir_path, f) for f in sorted(os.listdir(dir_path))
             if ext_re.search(f) and os.path.isfile(os.path.join(dir_path, f))]
    if not files:
        log(f'{kind}目录为空({dir_path}), 跳过')
    return files


def shuffled_media(img_dir, vid_dir):
    entries = ([{'p': p, 'v': 0} for p in list_media(img_dir, IMG_EXT_RE, '图片')]
               + [{'p': p, 'v': 1} for p in list_media(vid_dir, VIDEO_EXT_RE, '视频')])
    random.shuffle(entries)
    return entries


def to_file_url(p):
    return 'file://' + quote(os.path.abspath(p), safe='/._-~')


# ───────────────────── asar 头解析 ─────────────────────

class Asar:
    def __init__(self, path):
        self.path = path
        self.fd = open(path, 'rb')
        pre = self.fd.read(16)
        self.header_size = struct.unpack_from('<I', pre, 4)[0]
        json_len = struct.unpack_from('<I', pre, 12)[0]
        self.header = json.loads(self.fd.read(json_len).decode('utf-8'))
        self.files_start = 8 + self.header_size

    def close(self):
        self.fd.close()

    def find_entry(self, rel):
        node = self.header
        for part in rel.split('/'):
            node = node.get('files', {}).get(part) if isinstance(node, dict) else None
            if node is None:
                return None
        return None if 'files' in node else node

    def read_entry(self, rel):
        e = self.find_entry(rel)
        if e is None or e.get('unpacked'):
            return None
        self.fd.seek(self.files_start + int(e['offset']))
        return self.fd.read(e['size'])


def walk_files(node, prefix='', out=None):
    if out is None:
        out = []
    for name, ch in node.get('files', {}).items():
        fp = prefix + '/' + name if prefix else name
        if 'files' in ch:
            walk_files(ch, fp, out)
        else:
            out.append((fp, ch))
    return out


def integrity_of(data):
    h = hashlib.sha256(data).hexdigest()
    blocks, off = [], 0
    while off < len(data):
        blocks.append(hashlib.sha256(data[off:off + 4194304]).hexdigest())
        off += 4194304
    return {'algorithm': 'SHA256', 'hash': h, 'blockSize': 4194304, 'blocks': blocks}


# ───────────────────── CSS 分析与样式生成 ─────────────────────

def split_top_level(s, sep):
    out, depth, cur, q = [], 0, '', None
    for ch in s:
        if q:
            cur += ch
            if ch == q:
                q = None
            continue
        if ch in ('"', "'"):
            q = ch
            cur += ch
            continue
        if ch in ('(', '['):
            depth += 1
            cur += ch
            continue
        if ch in (')', ']'):
            depth -= 1
            cur += ch
            continue
        if ch == sep and depth == 0:
            out.append(cur)
            cur = ''
            continue
        cur += ch
    if cur.strip():
        out.append(cur)
    return [x.strip() for x in out if x.strip()]


def collect_rules(css):
    """递归收集样式规则, 展开 @media/@layer; 跳过 @keyframes/@font-face 等
    (Tailwind v4 把工具类全部包在 @layer 中, 必须穿透)"""
    rules = []
    css = re.sub(r'/\*[\s\S]*?\*/', '', css)

    def parse(text, media_cond):
        i = 0
        while i < len(text):
            b = text.find('{', i)
            if b == -1:
                break
            prelude = text[i:b].strip()
            depth, j, q = 0, b, None
            while j < len(text):
                ch = text[j]
                if q:
                    if ch == q:
                        q = None
                elif ch in ('"', "'"):
                    q = ch
                elif ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            if j >= len(text):
                break
            body = text[b + 1:j]
            if prelude.startswith('@'):
                m = re.match(r'^@([a-z-]+)\b\s*(.*)', prelude, re.S)
                kind = m.group(1) if m else ''
                if kind in ('layer', 'scope'):
                    parse(body, media_cond)              # 透明容器, 条件不变
                elif kind == 'media':
                    cond = m.group(2).strip()
                    parse(body, media_cond + ' and ' + cond if media_cond else cond)
                elif kind in ('supports', 'container') and not media_cond:
                    parse(body, m.group(2).strip())
                # 其他 @ 规则(keyframes/font-face/property 等)整块跳过
            elif prelude:
                rules.append({'media': media_cond, 'prelude': prelude, 'body': body})
            i = j + 1

    parse(css, '')
    return rules


def parse_decls(body):
    out = {}
    for d in split_top_level(body, ';'):
        c = d.find(':')
        if c > 0:
            out[d[:c].strip()] = d[c + 1:].strip()
    return out


def var_re(t):
    return re.compile(r'var\(\s*' + t.replace('-', r'\-') + r'\s*[,)]')


PSEUDO_RE = re.compile(
    r':(hover|active|focus|focus-within|focus-visible|visited|checked|disabled'
    r'|placeholder-shown)|::')
ATTR_RE = re.compile(r'data-active|aria-expanded')


def build_wallpaper_css(css_text, baked_items):
    """分析真实样式表: 找出"以页面背景色为背景"的选择器, 生成叠加式壁纸 CSS"""
    rules = collect_rules(css_text)
    targets = list(TARGET_VARS)
    groups = {}   # mediaCond -> [selectors]
    rule_hits = 0
    for r in rules:
        d = parse_decls(r['body'])
        if any(p.startswith('--color-') for p in d):
            continue
        ok = False
        for p, v in d.items():
            if p not in ('background', 'background-color'):
                continue
            if re.search(r'gradient\(|url\(', v):
                continue
            if any(var_re(t).search(v) for t in targets):
                ok = True
                break
        if not ok:
            continue
        sels = [s for s in split_top_level(r['prelude'], ',')
                if s and not s.startswith('@')
                and not PSEUDO_RE.search(s)
                and not ATTR_RE.search(s)]
        if not sels:
            continue
        rule_hits += 1
        groups.setdefault(r['media'], [])
        for s in sels:
            if s not in groups[r['media']]:
                groups[r['media']].append(s)

    all_sels = sum(len(v) for v in groups.values())
    log(f'CSS 分析: 命中 {rule_hits} 条规则 / {all_sels} 个选择器')
    if all_sels < 3:
        raise RuntimeError(f'CSS 分析命中过少({all_sels}), 疑似版本结构变化, 已中止')

    # 静态兜底样式(引用包内单张图)
    wall = "url('./assets/app-wallpaper.png')"
    body_decl = ';'.join([
        f'background-image:linear-gradient({MASK},{MASK}),{wall} !important',
        'background-size:cover !important',
        'background-position:center !important',
        'background-attachment:fixed !important',
        'background-repeat:no-repeat !important',
    ])

    css = f'<style id="zcode-custom-wallpaper">\n'
    css += f'/* {MARKER} auto-generated: {all_sels} selectors */\n'
    css += f"html{{background:#0b0e14 {wall} center/cover no-repeat fixed !important;}}\n"
    for media, sels in groups.items():
        for i in range(0, len(sels), 150):
            chunk = ',\n'.join(sels[i:i + 150])
            css += (f'@media {media}{{{chunk}{{{body_decl};}}}}\n' if media
                    else f'{chunk}{{{body_decl};}}\n')
    css += '</style>'

    script = build_runtime_script(groups, baked_items)
    sample = groups.get('', [])[:6]
    return css, script, all_sels, sample


def build_runtime_script(groups, baked_items):
    """页面运行时脚本 — 与 Windows 版逐字一致(占位符替换)"""
    groups_plain = {m: list(s) for m, s in groups.items()}
    default_alpha = float(re.sub(r'^rgba\([^)]*,\s*([\d.]+)\)$', r'\1', MASK)) or 0.8
    ring_base = MANIFEST_URL.replace('manifest.js', 'manifest-')
    items = [{'u': to_file_url(x['p']), 'v': x['v']} for x in baked_items]
    js = lambda o: json.dumps(o, ensure_ascii=False, separators=(',', ':'))

    s = r"""<script id="zcode-wallpaper-live">
(function () {
  try {
    var groups = @@GROUPS@@;
    var MASK_RGB = '8, 10, 16';
    var DEFAULT_ALPHA = @@ALPHA@@;
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
    var MANIFEST_URL = @@MANIFEST@@;
    var RING_BASE = @@RING@@;
    var curGen = 0, curSlot = -1;
    var items = @@ITEMS@@;
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
    // 热刷新: 轮转文件名探测新清单(不同文件名绕过脚本缓存), 重跑本工具后无需重启即纳入新媒体
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
      var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color || '');
      return m ? (m[1] + ',' + m[2] + ',' + m[3]) : null;
    }
    function bgAlpha(color) {
      if (!color || color === 'transparent') return 0;
      var m = /rgba?\(([^)]*)\)/.exec(color);
      if (!m) return 0;
      var parts = m[1].split(/[,\s\/]+/).filter(function (x) { return x !== ''; });
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
        var cands = document.querySelectorAll('pre, .hljs, [class*="code-block"]');
        for (i = 0; i < cands.length; i++) {
          var p = panelOf(cands[i], 12);
          if (p && out.indexOf(p) < 0) out.push(p);
        }
      } else {
        var el = bottomMost(document.querySelectorAll('textarea'), 60, 18);
        if (!el) el = bottomMost(document.querySelectorAll('[contenteditable="true"],[contenteditable=""]'), 100, 24);
        if (el) {
          var pp = panelOf(el, 12);
          if (pp) out.push(pp);
        }
      }
      return out;
    }
    function bottomMost(list, minW, minH) {
      var best = null, bestTop = -1;
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (!el.offsetParent) continue;
        var rr = el.getBoundingClientRect();
        if (rr.width < minW || rr.height < minH) continue;
        if (rr.top > bestTop) { bestTop = rr.top; best = el; }
      }
      return best;
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
        if (!codeBase) { toast('未找到代码框(pre×' + document.querySelectorAll('pre').length + ')'); return; }
        codeAlpha = PANEL_LEVELS[(PANEL_LEVELS.indexOf(codeAlpha) + 1) % PANEL_LEVELS.length];
        a = codeAlpha; saveLevel('zw-code-alpha', a);
        applyPanels('code', els, codeBase, a);
        toast('代码框×' + els.length + ' · 透明度 ' + Math.round(a * 100) + '%');
      } else {
        if (!inputBase && els[0]) inputBase = rgbOf(getComputedStyle(els[0]).backgroundColor);
        if (!inputBase) { toast('未找到输入框(ta×' + document.querySelectorAll('textarea').length + ',ce×' + document.querySelectorAll('[contenteditable]').length + ')'); return; }
        inputAlpha = PANEL_LEVELS[(PANEL_LEVELS.indexOf(inputAlpha) + 1) % PANEL_LEVELS.length];
        a = inputAlpha; saveLevel('zw-input-alpha', a);
        applyPanels('input', els, inputBase, a);
        toast('输入框×' + els.length + ' · 透明度 ' + Math.round(a * 100) + '%');
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
</script>"""
    items_json = json.dumps(
        [{'u': to_file_url(x['p']), 'v': x['v']} for x in baked_items],
        ensure_ascii=False, separators=(',', ':'))
    return (s.replace('@@GROUPS@@', js(groups_plain))
             .replace('@@ALPHA@@', js(default_alpha))
             .replace('@@MANIFEST@@', js(MANIFEST_URL))
             .replace('@@RING@@', js(ring_base))
             .replace('@@ITEMS@@', items_json))


# ───────────────────── 样式注入 ─────────────────────

def inject_style(html, css, script):
    if '</head>' not in html:
        raise RuntimeError('index.html 缺少 </head>')
    re_style = re.compile(r'<style id="zcode-custom-wallpaper">[\s\S]*?</style>')
    re_script = re.compile(r'<script id="zcode-wallpaper-live">[\s\S]*?</script>')
    html = re_script.sub('', html)
    addition = css + '\n' + script
    if re_style.search(html):
        html = re_style.sub(lambda _: addition, html, count=1)
    else:
        html = html.replace('</head>', addition + '\n  </head>', 1)
    if (MARKER not in html or 'zcode-wallpaper-live' not in html
            or './assets/app-wallpaper.png' not in html):
        raise RuntimeError('样式注入校验失败')
    return html


# ───────────────────── 清单写入 ─────────────────────

def write_manifest(entries):
    os.makedirs(POOL_DIR, exist_ok=True)
    items = [{'u': to_file_url(x['p']), 'v': x['v']} for x in entries]
    # 找现有轮转清单中 gen 最新的槽号, 新清单写到下一槽(页面按槽号探测热刷新)
    prev_slot, prev_gen = -1, -1
    for f in os.listdir(POOL_DIR) if os.path.isdir(POOL_DIR) else []:
        if not re.fullmatch(r'manifest-\d\.js', f):
            continue
        try:
            with open(os.path.join(POOL_DIR, f), encoding='utf-8') as fh:
                t = fh.read()
            g = int((re.search(r'gen:(\d+)', t) or [None, '0'])[1])
            if g > prev_gen:
                prev_gen, prev_slot = g, int(re.search(r'manifest-(\d)\.js$', f).group(1))
        except Exception:
            pass
    slot = (prev_slot + 1) % 10
    js = ('window.__ZW_POOL__ = {gen:' + str(int(time.time() * 1000))
          + ',slot:' + str(slot) + ',items:'
          + json.dumps(items, ensure_ascii=False, separators=(',', ':')) + '};\n')
    with open(MANIFEST_PATH, 'w', encoding='utf-8') as fh:
        fh.write(js)
    with open(os.path.join(POOL_DIR, f'manifest-{slot}.js'), 'w', encoding='utf-8') as fh:
        fh.write(js)
    if os.path.isdir(POOL_DIR):
        for f in os.listdir(POOL_DIR):
            if re.fullmatch(r'w\d+\.png', f) or (
                    re.fullmatch(r'manifest-\d\.js', f) and f != f'manifest-{slot}.js'):
                try:
                    os.unlink(os.path.join(POOL_DIR, f))
                except OSError:
                    pass
    return items


# ───────────────────── Mode A: 重扫目录刷新清单(不动 asar) ─────────────────────

def fast_mode(img_dir, vid_dir):
    a = Asar(ASAR_PATH)
    try:
        e = a.find_entry(REL_ENTRY)
        if not e or e.get('unpacked') or e.get('size') != SLOT_SIZE:
            return None
        idx = a.read_entry('out/renderer/index.html')
        if idx is None or MARKER.encode() not in idx:
            return None  # 未注入/旧版结构 → 重建
    finally:
        a.close()
    return len(write_manifest(shuffled_media(img_dir, vid_dir)))


# ───────────────────── Mode B: 重建 asar(纯 Python 重打包) ─────────────────────

def repack(base, idx_html_bytes, slot_bytes):
    """重建 asar: 替换 index.html 与兜底图槽位, 其余条目从原包字节原样流式拷贝。
    两遍流式: 先按 4MB 边界算 integrity(定长), 再按最终头部一次性写盘。"""
    t0 = time.time()
    base_files = walk_files(base.header)
    base_has_wall_b = base.find_entry(REL_ENTRY_B) is not None

    new_header = json.loads(json.dumps(base.header))  # 深拷贝, 保序
    assets = new_header['files']['out']['files']['renderer']['files']['assets']['files']
    if base_has_wall_b:
        del assets['app-wallpaper-b.png']
    assets['app-wallpaper.png'] = {}   # 新建条目(顺序在 assets 末尾, 无碍)

    # 待写条目: rel -> 内容来源
    sources = {}
    for rel, old in base_files:
        if rel == REL_ENTRY_B:
            continue
        if rel == 'out/renderer/index.html':
            sources[rel] = ('bytes', idx_html_bytes)
        elif rel == REL_ENTRY:
            sources[rel] = ('bytes', bytes(slot_bytes))
        elif old.get('unpacked'):
            continue                      # unpacked 不入包, 头部条目原样保留
        else:
            sources[rel] = ('asar', int(old['offset']), old['size'])
    if REL_ENTRY not in sources:
        sources[REL_ENTRY] = ('bytes', bytes(slot_bytes))

    # 第一遍: 计算 integrity(asar 内 SHA256 + 4MB 分块; bytes 内容直接算)
    integrity = {}
    for rel, src in sources.items():
        if src[0] == 'bytes':
            integrity[rel] = integrity_of(src[1])
            continue
        h = hashlib.sha256()
        blocks = []
        base.fd.seek(base.files_start + src[1])
        remaining = src[2]
        while remaining > 0:
            n = min(4194304, remaining)
            chunk = base.fd.read(n)
            if len(chunk) != n:
                raise RuntimeError(f'原包读取提前结束: {rel}')
            h.update(chunk)
            blocks.append(hashlib.sha256(chunk).hexdigest())
            remaining -= n
        integrity[rel] = {'algorithm': 'SHA256', 'hash': h.hexdigest(),
                          'blockSize': 4194304, 'blocks': blocks}

    # 分配偏移 + 填头部
    offset = 0
    order = []          # (rel, src, data_len)
    for rel, src in sources.items():
        data_len = len(src[1]) if src[0] == 'bytes' else src[2]
        node = new_header
        parts = rel.split('/')
        for p in parts[:-1]:
            node = node['files'][p]
        entry = node['files'][parts[-1]]
        entry['size'] = data_len
        entry['offset'] = str(offset)
        entry['integrity'] = integrity[rel]
        order.append((rel, src, data_len))
        offset += data_len

    header_bytes = json.dumps(new_header, ensure_ascii=False,
                              separators=(',', ':')).encode('utf-8')
    padded = (len(header_bytes) + 3) & ~3
    header_pickle = (struct.pack('<I', 4 + padded)
                     + struct.pack('<I', len(header_bytes)) + header_bytes
                     + b'\x00' * (padded - len(header_bytes)))
    header_block = (struct.pack('<I', 4)
                    + struct.pack('<I', len(header_pickle)) + header_pickle)
    files_start = 8 + len(header_pickle)

    tmp = ASAR_PATH + '.new-wallpaper.tmp'
    with open(tmp, 'wb') as out:
        out.write(header_block)
        for rel, src, data_len in order:
            if src[0] == 'bytes':
                out.write(src[1])
            else:
                base.fd.seek(base.files_start + src[1])
                remaining = data_len
                while remaining > 0:
                    chunk = base.fd.read(min(1 << 20, remaining))
                    if not chunk:
                        raise RuntimeError(f'原包读取提前结束: {rel}')
                    out.write(chunk)
                    remaining -= len(chunk)

    base_has_wall = base.find_entry(REL_ENTRY) is not None
    expected_total = (len(base_files) + (0 if base_has_wall else 1)
                      - (1 if base_has_wall_b else 0))
    log(f'重打包完成: {len(order)} 个打包条目, 总 {os.path.getsize(tmp):,}B, '
        f'耗时 {time.time() - t0:.0f}s')
    return tmp, expected_total, t0


def rebuild(img_dir, vid_dir):
    t0 = time.time()
    base = Asar(ASAR_PATH)

    # 1. 取最大的 styles-*.css 做选择器分析
    assets_node = base.header
    for p in 'out/renderer/assets'.split('/'):
        assets_node = assets_node['files'][p]
    css_candidates = [n for n in assets_node['files']
                      if re.fullmatch(r'styles-.*\.css', n)]
    if not css_candidates:
        raise RuntimeError('未找到 styles-*.css, 疑似版本结构变化')
    css_name = max(css_candidates,
                   key=lambda n: assets_node['files'][n]['size'])
    log('样式表: ' + css_name)
    css_text = base.read_entry('out/renderer/assets/' + css_name).decode('utf-8', 'replace')

    shuffled = shuffled_media(img_dir, vid_dir)
    items = write_manifest(shuffled)
    v_count = sum(1 for x in items if x['v'])
    log(f'清单: {len(items)} 个条目(图片 {len(items) - v_count} / 视频 {v_count}) → {MANIFEST_PATH}')

    # 2. 生成样式并注入 index.html
    css, script, sel_count, sample = build_wallpaper_css(css_text, shuffled)
    if sample:
        log('选择器示例: ' + ' | '.join(sample)[:200])
    idx_html = base.read_entry('out/renderer/index.html').decode('utf-8')
    idx_new = inject_style(idx_html, css, script)
    log(f'注入 index.html: {len(idx_html):,}B → {len(idx_new):,}B ({sel_count} 个选择器)')

    # 3. 重打包 + 校验
    slot = bytearray(SLOT_SIZE)
    slot[:len(PLACEHOLDER_PNG)] = PLACEHOLDER_PNG
    slot[-12:] = b'ZWALLSLOTEND'
    tmp, expected_total, t0 = repack(base, idx_new.encode('utf-8'), slot)

    # 三重校验(直接按最终格式重新解析 tmp)
    nw = Asar(tmp)
    try:
        nw_files = walk_files(nw.header)
        if len(nw_files) != expected_total:
            raise RuntimeError(f'文件数异常 {len(nw_files)}/{expected_total}')
        base_unpacked = sorted(f for f, e in walk_files(base.header) if e.get('unpacked'))
        nw_unpacked = sorted(f for f, e in nw_files if e.get('unpacked'))
        if nw_unpacked != base_unpacked:
            raise RuntimeError('unpacked 集合与原包不一致')
        e = nw.find_entry(REL_ENTRY)
        if not e or e.get('size') != SLOT_SIZE:
            raise RuntimeError('壁纸兜底槽位异常')
        if nw.find_entry(REL_ENTRY_B):
            raise RuntimeError('旧版 B 槽位未清除')
        idx_check = nw.read_entry('out/renderer/index.html').decode('utf-8')
        if (MARKER not in idx_check or MANIFEST_URL not in idx_check
                or 'zcode-wallpaper-video' not in idx_check):
            raise RuntimeError('样式/脚本标记缺失')
    finally:
        nw.close()
    base.close()
    log('三重校验通过 ✓ (文件数 / unpacked 集合 / 标记)')

    # 4. 备份并原子替换(运行中的 ZCode 不受影响, 重开后生效)
    backup = os.path.join(os.path.dirname(ASAR_PATH), 'app.asar.pre-wall.bak')
    if not os.path.exists(backup):
        shutil.copy2(ASAR_PATH, backup)
        log('备份原包 → ' + backup)
    else:
        log('已存在备份(保留最初原包): ' + backup)
    os.chmod(tmp, 0o644)
    os.replace(tmp, ASAR_PATH)
    # 回读校验
    live = Asar(ASAR_PATH)
    e = live.find_entry(REL_ENTRY)
    ok = e and e.get('size') == SLOT_SIZE
    live.close()
    if not ok:
        raise RuntimeError('回读校验失败')
    shutil.rmtree(WORK_DIR, ignore_errors=True)
    log(f'完成 ✓ 共 {len(items)} 个条目可用(视频 {v_count}), 耗时 {time.time() - t0:.0f}s')
    log('完全退出并重开 ZCode 后生效。左Ctrl+. 循环壁纸; 左Ctrl+1/2 面板透明度; 左Ctrl+5/6 蒙版; 左Ctrl+3/4 视频速度。')


def apply_mode(img_dir, vid_dir):
    if sys.platform != 'darwin':
        die('--apply 仅支持 macOS')
    log('退出 ZCode …')
    subprocess.run(['osascript', '-e', 'tell application "ZCode" to quit'],
                   capture_output=True)
    time.sleep(3)
    log('重建注入包 …')
    rebuild(img_dir, vid_dir)
    log('重启 ZCode …')
    subprocess.run(['open', '-a', 'ZCode'], capture_output=True)


def main():
    if not ASAR_PATH:
        die('未找到 ZCode 安装。请设环境变量 ZCODE_ASAR 指向 app.asar, 或加参数 --asar <路径>')
    if not os.path.exists(ASAR_PATH):
        die('ZCode 主程序包不存在: ' + ASAR_PATH)

    argv = [a for a in sys.argv[1:] if not a.startswith('--')]
    img_dir = argv[0] if len(argv) > 0 else MEDIA_DIR
    vid_dir = argv[1] if len(argv) > 1 else MEDIA_DIR
    force = '--rebuild' in sys.argv

    try:
        if '--apply' in sys.argv:
            log('一键应用模式(自动退出/重启 ZCode; 勿在 ZCode 内部运行) …')
            apply_mode(img_dir, vid_dir)
            return
        imgs = list_media(img_dir, IMG_EXT_RE, '图片')
        vids = list_media(vid_dir, VIDEO_EXT_RE, '视频')
        log(f'图片目录: {img_dir or "(未指定)"} ({len(imgs)} 张) | '
            f'视频目录: {vid_dir or "(未指定)"} ({len(vids)} 个)')
        if len(imgs) + len(vids) == 0:
            log('两个目录均无可用媒体, 清单为空(仅保留兜底壁纸)')
        fast = None if force else fast_mode(img_dir, vid_dir)
        if fast is not None:
            log(f'完成 ✓ 清单已刷新({fast} 个条目)。在 ZCode 中按 左Ctrl+. 切换。')
            return
        log('检测到未注入/旧版结构, 进入一次性重建模式 …')
        rebuild(img_dir, vid_dir)
    except Exception as err:
        die(str(err))


if __name__ == '__main__':
    main()
