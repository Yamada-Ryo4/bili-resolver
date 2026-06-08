# Vercel Proxy

这是一个用于突破 Bilibili API IP 风控的轻量级代理服务，专门设计为部署在 Vercel 免费版上。

## 部署步骤

1. 安装 Vercel CLI (如果你还没有安装):
   ```bash
   npm i -g vercel
   ```

2. 在本目录下运行部署命令：
   ```bash
   vercel
   ```

3. 部署完成后，Vercel 会给你一个域名（例如 `https://bili-proxy.vercel.app`）。

4. 将这个域名配置到 Cloudflare Worker 的 `index.js` 中的 `VERCEL_PROXY` 变量中：
   ```javascript
   const VERCEL_PROXY = "https://你的vercel域名/api/proxy?url=";
   ```
