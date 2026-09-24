# zcode-wallpaper-macOS

ZCode 桌面端壁纸注入工具的 **macOS 移植版**,与本仓库 Windows 版(`scripts/zcode-wallpaper.cjs`)功能一致。

给 [ZCode](https://zcode.dev) Desktop 换上随机壁纸(图片+视频混排),并支持**代码框 / 输入框透明度调节**,让聊天界面透出你自己的壁纸。

> 零依赖:纯 Python 3(macOS 系统自带),无需安装 Node.js

## 功能

- 🖼 **随机壁纸**:图片和视频混合清单、随机顺序循环,`file://` 原地引用不占双份磁盘
- 🫥 **面板透明度**:代码框、输入框可循环调节透明度(100→85→70→55→40%),透出底层壁纸
- 🎬 **视频壁纸**:全屏静音循环垫底 + 可调倍速
- 🌗 **蒙版调节**:压暗蒙版可调,保证前景可读
- 💾 **状态记忆**:壁纸位置、蒙版深浅、面板透明度、倍速全部 localStorage 记忆

## 热键(全部为【左】Ctrl,与 Windows 版一致)

| 按键 | 功能 |
|---|---|
| `左Ctrl + .` | 循环切换壁纸(图片/视频) |
| `左Ctrl + 1` | 代码框透明度循环 |
| `左Ctrl + 2` | 输入框透明度循环 |
| `左Ctrl + 3 / 4` | 视频壁纸减速 / 加速(±0.25x) |
| `左Ctrl + 5 / 6` | 壁纸蒙版加深 / 减淡(±5%) |

## 使用

### 环境要求

- macOS(开发验证于 Apple Silicon,ZCode Desktop 安装在 `/Applications`)
- 已安装 ZCode 桌面版
- 系统自带 `python3`(命令行输入 `python3 --version` 可用即可)

### 首次注入(ZCode 升级后同样)

```bash
python3 scripts/zcode-wallpaper-mac.py --rebuild
# 完成后完全退出 ZCode(Cmd+Q)再重开即生效
```

### 日常换素材(秒级,不用重启 ZCode)

把图片/视频放进 `~/Pictures/zcode-wallpaper/`,然后:

```bash
python3 scripts/zcode-wallpaper-mac.py
# 在 ZCode 里按 左Ctrl+. 即可看到新素材
```

支持格式:图片 `png / jpg / jpeg / webp / bmp / gif`,视频 `mp4 / webm / m4v / mov`。

### 一键模式(自动退出/重启 ZCode)

```bash
python3 scripts/zcode-wallpaper-mac.py --apply   # 需在终端运行,勿在 ZCode 内部执行
```

## 路径

| 目标 | 默认 | 覆盖方式 |
|---|---|---|
| app.asar | `/Applications/ZCode.app/Contents/Resources/app.asar` | 环境变量 `ZCODE_ASAR` 或 `--asar` |
| 媒体目录 | `~/Pictures/zcode-wallpaper`(其次仓库目录内 `zcode-wallpaper-media`) | 环境变量 `ZCODE_WALLPAPER_DIR` |
| 壁纸清单 | `~/Library/Application Support/zcode-wallpaper-pool` | 环境变量 `ZCODE_POOL` |

## 原理与安全

与 Windows 版同一套思路,针对 macOS 适配:

1. 解析 `app.asar` → 分析 renderer 真实样式表(Tailwind v4 感知,穿透 `@layer`),自动收集页面级背景选择器
2. 注入壁纸叠加 CSS + 运行时脚本 → 重打包(纯 Python 实现的 asar 读写,保留 unpacked 集合与 SHA256/4MB 分块完整性)
3. 重打包前做三重完整性校验(文件数 / unpacked 集合 / 标记),失败不落盘
4. 原包自动备份为 `app.asar.pre-wall.bak`(只在首次生成,始终是最初原版),随时可回滚
5. 替换用原子 rename,**运行中的 ZCode 不受影响**,重开后生效

macOS 附注:注入要求 ZCode 的 Electron asar 完整性 fuse(`EnableEmbeddedAsarIntegrityValidation`)处于关闭状态(当前官方版本默认关闭);若未来版本开启,需改用其他方案。

## 回滚

```bash
cd /Applications/ZCode.app/Contents/Resources/
cp app.asar.pre-wall.bak app.asar   # 先完全退出 ZCode
```

## 已知边界

- 壁纸素材不随本仓库分发(`.gitignore` 已排除)——请自行放入拥有合法使用权的图片/视频,尊重素材版权
- ZCode 大版本升级会覆盖 `app.asar`,重新跑一次 `--rebuild` 即恢复
- ZCode 大版本更新导致 renderer 结构变化时,CSS 分析会主动中止并报错(不会写入坏包),此时需要适配新版本
