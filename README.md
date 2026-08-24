# 📺 Bilibili Resolver & Proxy Worker

> 专为 VRChat 优化的 Bilibili 视频播放兼容层与流媒体代理服务。
> 修复 VRChat 播放器因 Referer 校验机制导致无法播放 B 站视频的问题。
> 
> ***本项目的核心目的是帮助用户利用 Cloudflare 资源，构建私有、稳定且数据安全的 VRChat 视频兼容服务。***

![VRChat Ready](https://img.shields.io/badge/VRChat-Ready-pink?logo=vrchat)
![Cloudflare Workers](https://img.shields.io/badge/Deployed%20on-Cloudflare%20Workers-orange?logo=cloudflare)
![License](https://img.shields.io/badge/License-MIT-blue)

**Bili-Resolver-Worker** 是一个运行在 Cloudflare Workers 上的轻量级工具。

对于 **VRChat** 玩家而言，它是一个**协议适配器**。由于 Bilibili 的视频链接需要特定的 Referer 头才能访问，标准的 VRChat 播放器（Unity Video Player）通常会因为缺少该头部而报错（403 Forbidden）。本服务作为一个中间层，补全必要的请求头，实现视频流在 VR 环境下的正常加载。

## ⚠️ 网络连接重要提示 (必读)

> [!WARNING]
> **关于 workers.dev 域名的访问限制**
> Cloudflare 分配的默认域名（例如 `xxx.workers.dev`）在中国大陆通常无法直接访问。
> **为了确保服务可用，部署 Worker 后请务必在后台绑定自己的自定义域名。**

* **有域名：** 直接在 Cloudflare Worker 设置中绑定二级域名（如 `api.yourdomain.com`）。
* **无域名：** 可以尝试使用免费域名服务（如 `pp.ua`、`eu.org`、`dpdns.org`等）。
* **💡 购买提示：** 如果需要购买廉价域名（首年 $1 左右），可以参考 [TLD-List](https://zh-hans.tld-list.com/) 进行比价。

如果你在国内仅使用加速器游玩 VRChat，**必须绑定自定义域名 (Custom Domain)** 才能正常解析和播放。

- ❌ **错误用法**: `https://bili.你的名字.workers.dev/BV...` (国内无法连接)
- ✅ **正确用法**: `https://bili.你的域名.com/BV...` (直连速度通常不错)

## ✨ 核心特性

- 🎮 **VRChat 深度适配**: 专为 USharpVideo, ProTV, iwaSyncVideo 等播放器优化，解决黑屏与加载失败问题。
- 🕶️ **Quest 性能模式**: 提供 H.264 (720P) 兼容选项，完美解决 Quest 一体机解码兼容性问题。
- 🛡️ **智能容错**: 默认优先请求 1080P+，失败自动降级到 1080P/720P/480P，优先保证播放连通性；UI 展示 B 站实际返回画质。
- ⚡ **Seek 预取**: 内嵌预览使用 hls.js，拖动时从目标时间加载并预取目标后的 10 个分片，缓冲上限 90 秒。
- 🔄 **Referer 协议修正**: 自动补全 VRChat 缺失的请求头，修复 403 Forbidden 错误。
- ⚡ **万能链接识别**: 支持直接粘贴混杂文本（如 B 站分享文案），智能提取视频 ID。
- 📥 **本地缓存**: 支持提取 MP4 直链进行本地预览或缓存，优化弱网环境下的 VR 体验。
- 💾 **历史回溯**: 本地浏览器自动记录最近 5 次解析，方便快速重播。
- 🚀 **零成本部署**: 单文件架构，基于 Cloudflare Workers 免费版即可运行。

## 🎮 VRChat 使用指南

### 1. 基础用法
在 VRChat 世界的视频播放器（URL 输入栏）中，直接输入你的**自定义域名**加视频 BV 号或分享链接：

**格式：**
```text
https://你的自定义域名.com/BVxxxxxx
```
或者直接粘贴复制的 B 站分享文本（脚本会自动提取）：
```text
https://你的自定义域名.com/【视频标题】 https://b23.tv/xxx
```

### 2. 指定画质
如果世界内网络卡顿，可以强制指定画质。代码默认请求 116（1080P+），接口失败会降级到 1080P/720P/480P；最终画质以 B 站返回的 `quality` 为准：
- **720P**: `.../BVxxxxxx?qn=64`
- **480P**: `.../BVxxxxxx?qn=32`

---

## 🛠️ 部署指南

### 方法一：GitHub 集成部署 (推荐，支持自动更新)

最推荐的方式。通过连接 GitHub，当本项目更新时，你只需在 GitHub 点击 "Sync Fork"，Cloudflare 会自动更新你的服务。

1. **Fork 本仓库**:
   - 点击本项目页面右上角的 **Fork** 按钮，将其复制到你自己的 GitHub 账号下。

2. **创建 Worker**:
   - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
   - 在左侧菜单点击 **Workers & Pages** -> **Create Application**。
   - 点击 **Continue with GitHub**。
   - 选择你刚才 Fork 的仓库。
   - 保持默认设置 (Settings 均无需修改)，点击 **Save and Deploy**。

3. **绑定域名 (中国用户必做)**:
   - 部署完成后，进入该 Worker 的详情页。
   - 点击顶部的 **Settings** (设置) -> **域和路由**。
   - 点击 **Add Custom Domain**，输入你的二级域名并保存。

### 方法二：网页在线部署 (简单，无需 Git)

适合不想折腾 GitHub 账号的用户。

1. **创建 Worker**:
   - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
   - 点击 **Workers & Pages** -> **Create Application** -> **从 Hello World! 开始**。
   - 点击 **Deploy**。

2. **粘贴代码**:
   - 点击 **Edit code**。
   - 删除原有代码，将本项目 `index.js` 中的代码**全部复制粘贴**进去。
   - 点击 **Deploy** 保存。

3. **绑定域名**:
   - 同样在 **Settings** -> **域和路由** 中添加自定义域名。

### 方法三：使用 Wrangler CLI (开发者)

适合习惯使用命令行进行版本管理的用户。

1. **安装与登录**:
   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. **配置与发布**:
   - 下载代码到本地。
   - 运行 `wrangler deploy`。

---

## 🔗 API 接口文档

### 1. VRChat 直连 / 重定向 (万能路径)
最常用的接口，支持各种格式的路径。
- **URL**: `/<任意内容>`
- **说明**: 路径可以是 `BV号`、`b23.tv短链`，甚至是包含中文标题的脏文本。Worker 会自动提取链接并重定向到视频流。

### 2. 网页解析器 (Web UI)
在浏览器中直接访问域名，提供一个现代化的图形界面（Glassmorphism 风格）。
- **URL**: `/`
- **功能**: 支持解析预览、复制直链、本地缓存 MP4。

### 3. 万能流代理 (Proxy)
Worker 的核心代理端点，用于中转 Bilibili 的流量。
- **URL**: `/proxy?url=<ENCODED_URL>&dl=<0|1>`
- **参数**: `dl=1` 可触发浏览器附件保存行为（用于本地缓存）。

## ❓ 常见问题 (FAQ)

**Q: 为什么 VRChat 里还是显示 Loading Error?**
A: 
1. **域名问题**: 确认你是否使用了自定义域名？不要使用 `workers.dev`。
2. **播放器支持**: 只有视频流是 302 重定向的，请确保你的 VRChat 播放器支持重定向（目前主流的 ProTV 和 USharpVideo 都支持）。
**Q: 为什么下载的文件名是乱码或者没有 .mp4 后缀？**
A: 请使用我们提供的 Web UI 界面点击下载，或者手动在链接后加上 `&name=文件名`。Worker 会自动处理 `Content-Disposition` 头来保证文件名正确。

**Q: 会消耗 Cloudflare 额度吗？**
A: 会。Cloudflare Workers 免费版每天有 100,000 次请求限制。视频流代理会消耗 Worker 的 CPU 时间，建议仅供个人或小规模好友使用。

## 当前部署

```text
https://bili-resolver.yamadaryo.workers.dev
```

当前线上测试结果：B 站接口请求 1080P+、1080P、720P 均成功，但测试视频实际返回 `quality=64`（720P）。实际画质由 B 站视频权限、视频编码和游客接口返回决定；本项目会优先请求 1080P+，失败后自动降级，不能把接口没有提供的画质强行变成 1080P。

内嵌播放器支持 Range、90 秒缓冲、目标时间 seek 和 10 个分片预取。测试视频实际播放时，Range 代理返回 HTTP 206；如果 B 站 CDN 持续传输完整 MP4，拖动速度仍受上游 CDN 限制。

## 📄 License

MIT License
