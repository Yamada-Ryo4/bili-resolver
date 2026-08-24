# Bilibili 1080p/720p Seek 优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化现有 bili-resolver，使公开 B 站视频优先获取 1080P、至少保证 720P，并按 missav/Pornhub 版本的标准实现目标时间 seek、10 分片并发预取和持续播放缓冲。

**Architecture:** 保留现有 B 站 WBI + APP/TV 多线路解析。对取流结果中的 DASH 音视频轨道生成本 Worker 的 `/proxy` 或独立流代理 URL；前端 hls.js/原生播放器在 seek 时停止旧请求、从目标时间加载并预热连续分片。保持现有直播双模式和历史记录兼容，不改 Vercel 鉴权语义。

**Tech Stack:** Cloudflare Workers、原生 Fetch、WebCrypto、hls.js、Vitest、Wrangler。

## Global Constraints

- 工作目录是 `C:/Users/lengf/ZCodeProject/bili_resolver_temp`，不新建另一个 B 站项目。
- 公开游客视频优先 1080P/1080P+，失败自动降到 720P，再到 480P。
- 风控或权限校验失败时返回清晰中文错误。
- VRChat 代理必须保留 Referer、Range、206、Content-Range、Accept-Ranges 和真实 Content-Type。
- 失败响应不能进入缓存；成功媒体可以缓存。
- 每个 seek 调度目标及后续 9 个连续分片，同时维持滑动预取窗口。
- 必须运行现有全量测试以及真实公开视频端到端验证。
- 当前目录有 Git 仓库，但不提交/推送，除非用户另行要求。

---

### Task 1: 盘点当前取流结果和前端媒体入口

**Files:**
- Inspect: `index.js`
- Inspect: `test/*.test.js`
- Modify: `test/smoke.test.js`

- [ ] 增加测试 fixture，明确 `resolveVideo` 成功结果需要包含：`quality`、`playableUrl`、`downloadUrl`、真实画质文本。
- [ ] 运行现有 smoke/preservation 测试，记录当前基线和失败。
- [ ] 从现有 `getPlayUrlWithFallback` 确认 116→80→64→32 的降级顺序，确认 web/app/tv 三条线路都参与。

---

### Task 2: 统一 B 站媒体代理的 Range/缓存/重试

**Files:**
- Modify: `index.js` 的 `/proxy` handler
- Modify: `vercel-proxy/api/proxy.js`
- Add: `test/media-proxy.test.js`

- [ ] 写失败测试：上游返回 206 时代理必须保留 `Content-Range`、`Accept-Ranges` 和请求 `Range`；403 后重试；最终错误 `no-store`。
- [ ] 在 Worker/Vercel 代理中统一使用真实请求的 `Range`、`Referer`、`Origin`、`User-Agent`，限制只允许 B 站 CDN 域名：`*.bilivideo.com`、`*.akamaized.net`、`*.biliapi.net`。
- [ ] 对 403/429/5xx 短重试 3 次，第二次起用 `Cache-Control: no-cache`；成功 200/206 才设置长期缓存。
- [ ] 运行媒体代理测试并确认通过。

---

### Task 3: B 站前端 1080p/720p 和十片 seek 预取

**Files:**
- Modify: `index.js` UI 字符串区域
- Add: `test/ui-quality-seek.test.js`

- [ ] 写失败测试，要求 UI 包含：`qn=116`、`qn=80`、`qn=64`、`startLevel`、`PREFETCH_WINDOW_SIZE = 10`、`AbortController`、`LEVEL_LOADED`、`Promise.allSettled`、`seeking`。
- [ ] UI 根据后端返回 `quality` 显示真实质量；1080P+ 请求失败显示实际降级质量，不伪称 1080P。
- [ ] hls.js 配置：`startLevel = 0`、`maxBufferLength = 45`、`maxMaxBufferLength = 90`、`fragLoadingMaxRetry = 4`。
- [ ] 监听 `LEVEL_LOADED` 建立 fragment 时间索引。
- [ ] seek 时取消旧 AbortController、`stopLoad()`、设置最低清晰度、`startLoad(video.currentTime)`，并调度目标和后续 9 个分片；每完成一个补下一个。
- [ ] 连续播放每 20 秒补下一组 10 个分片。
- [ ] 运行 UI 测试。

---

### Task 4: 解析结果画质和错误处理

**Files:**
- Modify: `index.js`
- Modify: `test/preservation.test.js`
- Modify: `test/bug-condition.test.js`

- [ ] 对 `videoStream.quality` 与请求 `qn` 分离，响应中返回真实质量。
- [ ] 保持现有 APP/TV/web fallback 顺序，不因 web 风控失败而阻断 APP/TV 成功。
- [ ] 1080P+、1080P 不可用时继续尝试 720P；所有线路失败时返回现有中文风控/业务错误。
- [ ] 保留 Quest 模式对 720P/H.264 的兼容行为。
- [ ] 运行 preservation/bug-condition 测试。

---

### Task 5: 真实公开视频验证和部署

**Files:**
- Modify: `README.md`
- Modify: `wrangler.toml`（仅必要配置）

- [ ] 运行 `npm test`，要求全部测试通过。
- [ ] 用目标账户的 Wrangler 配置执行 `npx wrangler deploy --dry-run`。
- [ ] 选择一个当前公开 BV 视频，实际测试解析 API、返回质量、代理 Range、首个分片。
- [ ] 在浏览器打开 UI，验证 1080P/720P 选项、seek 三个位置、每个位置至少观察 60 秒。
- [ ] 若 B 站当前出口风控导致无法获取 1080P，报告实际返回状态和最终可用画质，不伪造成功。
- [ ] `npx wrangler deploy` 部署正式版本。
- [ ] README 更新实际部署地址、画质降级说明和 seek 预取行为。
