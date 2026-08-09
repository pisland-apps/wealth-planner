# 💼 Wealth Planner (PWA)

一个纯前端、离线优先的个人财富管理工具：单位信托基金、Amanah Saham、KWSP 公积金、定期存款、房地产、外币持仓，以及多年期财富预测——全部在你自己的浏览器里运行，数据只存在本机 IndexedDB 中，永不上传到任何服务器。

## ✨ 功能特性

- **多模块管理**：单位信托 / Amanah Saham / KWSP / 定存 / 房地产 / 外币 / 收入预测 / 多年期规划
- **本地加密存储**：一键开启后，基金名称、金额、日期、备注等敏感字段使用 **AES-GCM** 加密后再写入 IndexedDB；密码只存在于当前标签页内存中，从不落盘、从不上传
- **全屏锁屏**：
  - 开启加密后，刷新页面会先看到全屏锁屏，需输入密码才能进入
  - 导航栏新增「🔒 Lock Now」按钮，可随时手动锁定
  - 切到后台 / 切换标签页会**立即自动锁定**
  - 空闲 5 分钟无操作也会自动锁定
- **PWA 离线使用**：
  - 提供 Web App Manifest，可「添加到主屏幕」，像原生 App 一样全屏启动
  - Service Worker 预缓存应用外壳与第三方库（Chart.js / Dexie / pdf.js），首次加载后**完全离线可用**
- **数据导入导出**：支持加密或明文备份文件的导出与导入

## 📁 项目结构

```
wealth-planner-pwa/
├── index.html          # 应用主文件（单文件应用逻辑）
├── manifest.json        # PWA Web App Manifest
├── service-worker.js    # 离线缓存 Service Worker
├── icons/                # 各尺寸应用图标
│   ├── icon-192.png
│   ├── icon-512.png
│   ├── icon-maskable-512.png
│   ├── apple-touch-icon.png
│   ├── favicon-32.png
│   └── favicon-16.png
└── README.md
```

## 🚀 部署方式

### 方式一：GitHub Pages（推荐）

1. 新建一个 GitHub 仓库，将本文件夹内容全部推送上去
2. 仓库 Settings → Pages → Source 选择 `main` 分支 / 根目录
3. 等待几分钟后，通过 `https://<你的用户名>.github.io/<仓库名>/` 访问

> ⚠️ Service Worker 需要 HTTPS（或 `localhost`）才能注册，GitHub Pages 默认是 HTTPS，天然满足条件。

### 方式二：本地预览

Service Worker 无法在 `file://` 协议下注册，本地调试请起一个静态服务器，例如：

```bash
cd wealth-planner-pwa
python3 -m http.server 8080
# 然后浏览器打开 http://localhost:8080
```

## 📲 安装为「App」

- **手机（iOS Safari / Android Chrome）**：打开网页后，通过浏览器菜单选择「添加到主屏幕 / 安装应用」
- **桌面（Chrome / Edge）**：地址栏右侧会出现安装图标，点击即可作为独立窗口应用打开

安装后即可像原生 App 一样全屏启动，并支持完全离线操作。

## 🔐 关于加密与安全的重要说明

- 加密密码（passcode）**只存在于当前浏览器标签页的内存中**，关闭标签页、刷新页面、锁定后都需要重新输入
- 忘记密码将**无法恢复**已加密的数据——请务必牢记密码，或定期导出一份你能记住密码的加密备份
- 所有数据都保存在**当前浏览器**的 IndexedDB 中，换设备、换浏览器、清除浏览数据都不会同步/保留数据，请使用「Export」功能定期备份

## 🛠️ 部署清单（每次发版都要做）

页面右下角有一个小小的版本角标（即使在锁屏、还没输入密码时也能看到），显示的是 `APP_VERSION · APP_VERSION_DATE`。这个角标只能告诉你**这次发布打包了什么代码**，不能告诉你**浏览器里实际在跑什么代码**——如果部署后角标显示的版本号跟你预期的对不上，说明是浏览器/Service Worker 还在用旧缓存，请强制刷新（Ctrl/Cmd+Shift+R）或去 devtools 里清掉该站点的 Service Worker / Cache，而不要误以为是部署没生效。

有两处版本号，分别在两个不同文件里，**不会自动同步**，每次发版请手动检查、按需同时更新：

- [ ] **`js/app.js`** 顶部的 `APP_VERSION` / `APP_VERSION_DATE` —— 纯展示用的角标文案，不影响缓存逻辑
- [ ] **`service-worker.js`** 顶部的 `CACHE_VERSION`（例如从 `v5` 改成 `v6`）—— 真正控制离线缓存是否失效，如果只改了 `APP_VERSION` 没改这个，已安装的用户可能继续读到旧的缓存版本
- [ ] 部署后实际打开页面（含锁屏界面）核对右下角角标是否显示了新版本号；如果不是，按上面说的强制刷新 / 清缓存后再核对一次

两个文件里各留了一条互相指向对方的提醒注释，方便下次发版时不会漏改其中一个。

## 📄 License

个人使用项目，未附加开源许可证；如需二次分发，请自行补充 LICENSE 文件。
