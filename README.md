# zcode-wallpaper

ZCode 桌面端壁纸注入工具 —— 给 [ZCode](https://zcode.dev) Desktop 换上随机壁纸（图片+视频混排），并支持**代码框 / 输入框透明度调节**，让聊天界面透出你自己的壁纸。

> v3.10 · Windows + macOS · 零依赖便携设计（Windows 自带 Node 运行时方案 / macOS 用系统自带 Python 3）

## 🍎 macOS 版

本仓库现提供 macOS 移植版 **`scripts/zcode-wallpaper-mac.py`**——纯 Python 3 零依赖（macOS 系统自带），功能与热键和 Windows 版完全一致，并针对 macOS 适配了路径探测（`/Applications/ZCode.app`）、原子替换（运行中的 ZCode 不受影响，重开即生效）。

```bash
# 首次注入（ZCode 升级后同样）：完成后重开 ZCode 生效
python3 scripts/zcode-wallpaper-mac.py --rebuild

# 日常换素材（秒级，不用重启 ZCode）
python3 scripts/zcode-wallpaper-mac.py
```

详见 **[README-macOS.md](README-macOS.md)**。

## 功能

- 🖼 **随机壁纸**：图片和视频混合清单、随机顺序循环，`file://` 原地引用不占双份磁盘
- 🫥 **面板透明度**：代码框、输入框可循环调节透明度（100→85→70→55→40%），透出底层壁纸
- 🎬 **视频壁纸**：全屏静音循环垫底 + 可调倍速
- 🌗 **蒙版调节**：压暗蒙版可调，保证前景可读
- 💾 **状态记忆**：壁纸位置、蒙版深浅、面板透明度、倍速全部 localStorage 记忆
- 🧳 **便携自动探测**：自动寻找 ZCode 安装位置（环境变量 / 常见路径 / 命令行参数均可覆盖）
- 🩹 **自愈**：热键绑定定时重挂；新出现的代码块自动应用当前透明度；ZCode 升级冲掉注入后重跑 bat 即恢复

## 热键（全部为【左】Ctrl）

| 按键 | 功能 |
|---|---|
| `左Ctrl + .` | 循环切换壁纸（图片/视频） |
| `左Ctrl + 1` | 代码框透明度循环（100→85→70→55→40%） |
| `左Ctrl + 2` | 输入框（对话框）透明度循环（同上） |
| `左Ctrl + 3 / 4` | 视频壁纸减速 / 加速（±0.25x） |
| `左Ctrl + 5 / 6` | 壁纸蒙版加深 / 减淡（±5%） |

## 原理

ZCode 桌面版是 Electron 应用。工具对 `app.asar` 做一次性重建：

1. 解包 → 分析 renderer 的真实样式表，自动收集"页面级背景"选择器（Tailwind v4 感知，穿透 `@layer`）
2. 注入壁纸叠加 CSS + 运行时脚本（清单加载、热键、蒙版、视频垫底、面板透明度）
3. 重新打包并做三重完整性校验（文件数 / unpacked 集合 / 标记），失败不落盘
4. 原包自动备份为 `app.asar.pre-wall.bak`，随时可回滚

壁纸清单本身放在 asar 外部（本地 manifest.js），改素材**不需要**重新注入——重扫一下 bat 即可，页面内热刷新加载。

## 使用

### 环境要求

- Windows 10/11
- 已安装 ZCode 桌面版
- Node.js（或直接用 Releases 里的便携包，自带 node.exe，无需安装）

### 首次注入

```bat
双击 zcode-面板透明度补丁.bat
:: 自动: 关闭 ZCode → 重建 app.asar → 重启 ZCode
```

### 日常换素材

把图片/视频放进媒体目录（默认 `%USERPROFILE%\Pictures\zcode-wallpaper`，或与脚本同级的 `zcode-wallpaper-media`），然后：

```bat
双击 zcode-wallpaper.bat
```

秒级重扫，不用重启 ZCode（页面内热刷新）。

### ZCode 升级后

升级会覆盖 `app.asar`，注入失效 —— 重新跑一次 `zcode-面板透明度补丁.bat` 即恢复。

## 路径探测优先级

| 目标 | 优先级 |
|---|---|
| app.asar | 环境变量 `ZCODE_ASAR` > 命令行 `--asar` > `%LOCALAPPDATA%\Programs\ZCode` > Program Files > 旧版遗留路径 |
| 媒体目录 | 环境变量 `ZCODE_WALLPAPER_DIR` > 包内 `zcode-wallpaper-media` > `%USERPROFILE%\Pictures\zcode-wallpaper` |
| 清单目录 | 环境变量 `ZCODE_POOL` > 旧版 `D:\zcode\wallpaper-pool`（存在则沿用）> `%LOCALAPPDATA%\zcode\wallpaper-pool` |

## 回滚

ZCode 安装目录 `resources\app.asar.pre-wall.bak` 覆盖回 `app.asar`（先完全退出 ZCode）。

## 已知边界

- 仅支持 Windows（热键判定、taskkill、路径探测均按 Windows 实现）
- ZCode 大版本更新导致 renderer 结构变化时，CSS 分析会主动中止并报错（不会写入坏包），此时需要适配新版本
- **壁纸素材不随本仓库分发**（`zcode-wallpaper-media/` 已在 .gitignore 中）——请自行放入拥有合法使用权的图片/视频，尊重素材版权

## License

[MIT](LICENSE)
