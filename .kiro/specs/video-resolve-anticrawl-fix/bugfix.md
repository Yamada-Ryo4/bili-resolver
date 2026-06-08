# Bugfix Requirements Document

## Introduction

Bilibili 解析 Worker (`index.js`) 在解析视频 (`/api/video`) 时，会向多个 B 站接口（`nav`、`player/wbi/playurl`、`web-interface/view`）直接调用 `fetch().json()`，但没有检查响应状态码或 `Content-Type`。当 Worker 运行在 Cloudflare 数据中心 IP 上、且未携带有效的反爬 Cookie（`buvid3`/`buvid4`/`bili_ticket`）时，B 站风控会返回 HTML 页面（`<!DOCTYPE html>...`）或 `code:-352`（风控校验失败），而非预期的 JSON。

此时 `.json()` 解析 HTML 抛出 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`，该错误经由 `getPlayUrlWithFallback` 的 `lastError` 一路冒泡，最终被 `/api/video` 的 catch 块原样作为 `e.message` 返回给前端。用户看到的是一条无意义的英文 JSON 解析错误，而不是可理解的中文提示，也没有任何反爬缓解措施。

本次修复的目标是：在视频解析链路中检测非 JSON / 反爬响应、为请求附加可降低风控概率的 Cookie（复用并扩展现有 `getBuvid()`），并在仍无法解析时返回清晰可读的中文错误提示；同时不改变正常视频解析（happy path）与直播解析（`/api/live`）的现有行为。

## Bug Analysis

### Current Behavior (Defect)

当 B 站接口在视频解析链路中返回反爬响应（HTML 页面或 `code:-352`）时，系统当前的行为如下：

1.1 WHEN 视频解析链路中 `nav` 接口（`signWbi`）返回 HTML 页面而非 JSON THEN 系统对 HTML 调用 `.json()` 抛出 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`，并将该原始英文错误返回给前端

1.2 WHEN 视频解析链路中 `player/wbi/playurl` 接口返回 HTML 页面而非 JSON THEN 系统抛出 JSON 解析错误，该错误经 `getPlayUrlWithFallback` 的 `lastError` 冒泡后被原样返回给前端

1.3 WHEN 视频解析链路中任一 B 站接口返回 `code:-352`（风控校验失败）THEN 系统未识别该风控码，导致解析失败并返回无意义提示

1.4 WHEN 视频解析的所有请求（`nav`、`playurl`、`view`）发出时 THEN 系统不附带任何反爬 Cookie（`buvid3`/`buvid4`/`bili_ticket`），使得数据中心 IP 极易触发风控

1.5 WHEN 视频解析因风控失败时 THEN 前端 toast 显示原始英文错误 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`，用户无法理解发生了什么

### Expected Behavior (Correct)

针对相同的触发条件，系统应当表现为：

2.1 WHEN 视频解析链路中 `nav` 接口（`signWbi`）返回非 JSON / HTML 响应 THEN 系统 SHALL 在调用 `.json()` 之前检测响应状态码与 `Content-Type`，识别为反爬响应而不抛出原始 JSON 解析错误

2.2 WHEN 视频解析链路中 `player/wbi/playurl` 接口返回非 JSON / HTML 响应 THEN 系统 SHALL 在解析前检测响应类型，识别为反爬响应而不抛出原始 JSON 解析错误

2.3 WHEN 视频解析链路中任一 B 站接口返回 `code:-352`（风控校验失败）THEN 系统 SHALL 将其识别为反爬拦截并按反爬失败处理

2.4 WHEN 发起视频解析请求（`nav`、`playurl`、`view`）时 THEN 系统 SHALL 为请求附加可降低风控概率的 Cookie（至少 `buvid3`，尽可能包含 `buvid4`/`bili_ticket`），复用或扩展现有 `getBuvid()`

2.5 WHEN 附加反爬 Cookie 后视频解析仍因风控无法成功 THEN 系统 SHALL 返回清晰、可操作的中文错误提示（例如 “B 站风控拦截，请稍后重试”），而非原始英文 JSON 解析错误

### Unchanged Behavior (Regression Prevention)

以下不触发该 bug 的场景必须保持原有行为不变：

3.1 WHEN B 站接口正常返回有效 JSON 且视频可解析（happy path）THEN 系统 SHALL CONTINUE TO 正常返回视频标题、封面、作者、可播放链接、下载链接与清晰度

3.2 WHEN 请求 `/api/live` 解析直播 THEN 系统 SHALL CONTINUE TO 按现有逻辑（Legacy / V2 API、CN/OV 节点检测、`getBuvid()` 构造 Cookie）正常解析直播流

3.3 WHEN 输入的 BV 号无效（不匹配 `BV[a-zA-Z0-9]{10}`）THEN 系统 SHALL CONTINUE TO 返回 “无效的 BV 号” 提示

3.4 WHEN B 站接口返回已知业务错误码（如 `-404`、`-403`、`62002` 等）THEN 系统 SHALL CONTINUE TO 按 `ERROR_MAP` 返回对应的中文错误提示

3.5 WHEN 命中视频解析缓存（`caches.default`）时 THEN 系统 SHALL CONTINUE TO 直接返回缓存的成功响应

3.6 WHEN 请求 `/proxy` 代理视频或直播流 THEN 系统 SHALL CONTINUE TO 按现有逻辑进行域名白名单校验、Range 透传与 m3u8 重写

## Bug Condition Specification

以下使用结构化伪代码定义 bug 条件与属性，用于后续的修复检查（Fix Checking）与保留检查（Preservation Checking）。

### Bug Condition Function

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type VideoResolveRequest   // 携带有效 BV 号的 /api/video 请求
  OUTPUT: boolean

  // 当视频解析链路中任一上游 B 站接口 (nav / playurl / view)
  // 返回反爬响应时, 即满足 bug 条件:
  //   - 响应状态码非 2xx, 或
  //   - 响应 Content-Type 非 JSON (例如 HTML 页面 <!DOCTYPE ...>), 或
  //   - 响应 JSON 的 code 为 -352 (风控校验失败)
  RETURN upstreamReturnsNonJson(X)
      OR upstreamReturnsHtml(X)
      OR upstreamReturnsCode(X, -352)
END FUNCTION
```

### Property Specification (Fix Checking)

```pascal
// Property: Fix Checking - 反爬响应处理
FOR ALL X WHERE isBugCondition(X) DO
  result <- resolveVideo'(X)
  // 修复后不得抛出 / 返回原始 JSON 解析错误
  ASSERT NOT contains(result.message, "Unexpected token")
  ASSERT NOT contains(result.message, "is not valid JSON")
  // 应返回清晰的中文风控错误提示
  ASSERT result.status = "error" AND isChineseAntiCrawlMessage(result.message)
END FOR
```

其中：
- **F** = `resolveVideo`（修复前的原始函数）
- **F'** = `resolveVideo'`（修复后的函数，含响应类型检测、反爬 Cookie 注入与中文错误提示）

### Preservation Goal (Preservation Checking)

```pascal
// Property: Preservation Checking - 保留非 bug 输入的现有行为
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)
END FOR
```

即：对于所有未触发风控的输入（正常视频、直播、无效 BV 号、已知业务错误码、缓存命中、代理请求），修复后的行为与修复前完全一致。
