# video-resolve-anticrawl-fix Bugfix Design

## Overview

Bilibili 解析 Worker（`index.js`）的视频解析链路（`/api/video`）在向 B 站上游接口取数据时存在两类缺陷：

1. **缺少响应防御**：`signWbi`（`nav`）、`getPlayUrlWithFallback`（`player/wbi/playurl`）、`resolveVideo`（`web-interface/view`）三处都直接 `await res.json()`，既不检查 `res.ok`，也不检查 `Content-Type`，更不检查业务 `code`。当 Cloudflare 数据中心 IP 触发 B 站风控时，上游返回的是一张 HTML 风控页（`<!DOCTYPE html>...`）或 `code:-352`（风控校验失败）。对 HTML 调 `.json()` 会抛出 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`。
2. **缺少反爬 Cookie**：视频链路所有请求只带 `User-Agent`（部分带 `Referer`），不携带任何 `buvid3`/`buvid4`/`bili_ticket`，使数据中心 IP 极易触发风控。

这条原始英文报错经由 `getPlayUrlWithFallback` 的 `lastError` 冒泡，最终被 `/api/video` 的 catch 块原样作为 `e.message` 返回，前端 toast 直接显示给用户。

修复策略（最小、定向、可回归验证）：

- 新增一个**安全 JSON 抓取助手** `fetchBiliJson(url, options)`，集中完成「状态码检查 → Content-Type / body 嗅探 → JSON 解析 → `code:-352` 识别」，识别到反爬时抛出**带哨兵标记的 `AntiCrawlError`**（中文消息「B 站风控拦截，请稍后重试」）。视频链路的 `nav`、`playurl`、`view` 三处全部改走该助手。
- 新增**反爬 Cookie 采集** `getAntiCrawlCookie()`，复用并扩展现有 `getBuvid()`（finger/spi → `b_3`/`b_4`），可选叠加 `bili_ticket`（WebCrypto HMAC-SHA256），在**单次 `resolveVideo` 调用内只采集一次**并通过共享 Cookie 头注入三个请求。
- **错误传播映射**：让 `AntiCrawlError` 一路保留到 `/api/video` 的 catch，返回 `status:"error"` + 中文反爬消息，绝不泄漏 `Unexpected token` / `is not valid JSON`。

`/api/live`、`/proxy`、缓存命中、无效 BV 号、`ERROR_MAP` 业务码、happy path 视频响应结构均保持不变。

## Glossary

- **Bug_Condition (C)**：触发该 bug 的条件 —— 视频解析链路中任一上游接口（`nav` / `playurl` / `view`）返回反爬响应：状态码非 2xx、或 `Content-Type` 非 JSON（HTML 风控页）、或 JSON 中 `code === -352`。
- **Property (P)**：期望行为 —— 修复后不抛出/不返回原始 JSON 解析错误，而是返回 `status:"error"` 且消息为可读中文反爬提示。
- **Preservation**：未触发风控的输入（正常视频、直播、无效 BV、已知业务码、缓存命中、代理）行为与修复前完全一致。
- **F / F'**：`resolveVideo`（修复前）/ `resolveVideo'`（修复后，含响应类型检测、反爬 Cookie 注入与中文错误提示）。
- **`fetchBiliJson(url, options)`**：拟新增于 `index.js` 的安全 JSON 抓取助手，封装状态码 / Content-Type / 业务码检查与 JSON 解析，反爬时抛出 `AntiCrawlError`。
- **`AntiCrawlError`**：拟新增的哨兵错误类型，`message` 为中文「B 站风控拦截，请稍后重试」，供上层在不依赖字符串匹配的前提下识别反爬失败。
- **`getBuvid()`**：现有函数，请求 `finger/spi` 取 `data.b_3`（buvid3），失败时回退到硬编码常量；内部 try/catch 回退行为保持不变。
- **`getAntiCrawlCookie()`**：拟新增函数，扩展 `getBuvid()` 以同时获取 `buvid3`/`buvid4`，可选叠加 `bili_ticket`，构造共享 Cookie 头。
- **`bili_ticket`**：JWT 令牌，可降低风控概率，通过 HMAC-SHA256（密钥 `XgwSnGZ1p`，消息 `"ts" + timestamp`）+ `GenWebTicket` 接口生成，有效期 3 天。

## Bug Details

### Bug Condition

该 bug 在视频解析链路（`/api/video` → `resolveVideo` → `signWbi`/`getPlayUrlWithFallback`/`view` 请求）中，当任一上游 B 站接口返回反爬响应时触发。当前这三处都直接调用 `res.json()`，既未校验响应状态码，也未校验 `Content-Type`，更未识别 `code:-352`。在 Cloudflare 数据中心 IP 上、未携带反爬 Cookie 时，B 站返回 HTML 风控页或 `code:-352`，导致 `.json()` 抛出无法理解的英文解析错误。

**Formal Specification:**

```
FUNCTION isBugCondition(input)
  INPUT: input of type VideoResolveRequest   // 携带有效 BV 号的 /api/video 请求
  OUTPUT: boolean

  // 视频解析链路中任一上游接口 (nav / playurl / view) 返回反爬响应
  RETURN hasValidBvid(input)
         AND (
              upstreamStatusNot2xx(input)            // res.ok === false
              OR upstreamContentTypeNotJson(input)   // Content-Type 非 application/json (HTML 风控页)
              OR upstreamBodyStartsWith(input, '<')   // body 以 '<' 开头 (DOCTYPE/html)
              OR upstreamJsonCode(input) == -352      // 风控校验失败
         )
END FUNCTION
```

### Examples

- **HTML 风控页（nav）**：`signWbi` 请求 `web-interface/nav`，上游返回 `<!DOCTYPE html>...`。期望：识别为反爬，返回中文提示。实际：`await res.json()` 抛出 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`，原样返回前端。
- **HTML 风控页（playurl）**：`getPlayUrlWithFallback` 请求 `player/wbi/playurl`，上游返回 HTML。期望：识别为反爬。实际：抛 JSON 解析错误，经 `lastError` 冒泡，循环耗尽后 `throw new Error(lastError)`，前端显示英文错误。
- **`code:-352`（任一接口）**：上游返回 `{"code":-352,"message":"风控校验失败","data":{"v_voucher":"voucher_..."}}`。期望：识别为反爬并按反爬失败处理。实际：`view` 走 `ERROR_MAP[-352]`（未定义）→ `vData.message`「风控校验失败」；`playurl` 走 `pData.message` 进 `lastError`，提示不统一也不可操作。
- **非 2xx 状态（边界）**：上游返回 `412`/`403` 且 body 可能为空或 HTML。期望：识别为反爬。实际：当前不检查 `res.ok`，对非 JSON body 调 `.json()` 抛解析错误。

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- happy path 视频解析：正常返回 `title`、`pic`、`bvid`、`author`、`playableUrl`、`downloadUrl`、`quality`、`isLive:false`（响应结构与字段不变）。
- 直播解析 `/api/live` 与 `/live/{roomId}`：Legacy / V2 API、CN/OV 节点检测、`getBuvid()` 构造 `Cookie: buvid3=...` 的逻辑完全不变。
- 无效 BV 号（不匹配 `BV[a-zA-Z0-9]{10}`）：返回「无效的 BV 号」。
- 已知业务错误码（`-400`/`-403`/`-404`/`-10403`/`62002`/`62004` 等）：按 `ERROR_MAP` 返回对应中文提示。
- 视频解析缓存（`caches.default`）命中：直接返回缓存的成功响应。
- `/proxy` 代理：域名白名单校验、Range 透传、m3u8 重写不变。

**Scope:**

所有未触发风控的输入（`¬C(X)`）必须完全不受本次修复影响，包括：

- 上游返回有效 JSON 且可解析的视频请求。
- 所有 `/api/live`、`/live/{id}`、`/proxy`、`/`（UI）请求。
- 无效 BV 号请求与命中 `ERROR_MAP` 的业务错误码请求。

> 注：期望的「正确反爬行为」定义在下文 Correctness Properties 的 Property 1，本节聚焦于「必须保持不变」的部分。

## Hypothesized Root Cause

根据 bug 描述与代码审查，根因明确，主要由两点叠加构成：

1. **无响应防御的 `.json()` 调用（直接根因）**：三处上游调用直接 `await res.json()`，没有 `res.ok` 检查、没有 `Content-Type` 检查、没有 body 嗅探。对 HTML 风控页调 `.json()` 必然抛 `Unexpected token '<'`。
   - `signWbi`：`const json = await res.json(); const { img_url, sub_url } = json.data.wbi_img;` —— 解析失败或 `json.data` 缺失都会抛错。
   - `getPlayUrlWithFallback`：`const pData = await pRes.json();` 在 try 内，错误被 `catch (e) { lastError = e.message; }` 捕获并最终冒泡。
   - `resolveVideo`：`const vData = await vRes.json();` 无 try，直接抛到 `/api/video` 的 catch。

2. **缺少反爬 Cookie（触发根因）**：视频链路请求不带 `buvid3`/`buvid4`/`bili_ticket`，数据中心 IP 极易被风控判定，从而返回 HTML / `code:-352`。直播链路已通过 `getBuvid()` 带了 `buvid3`，相对更稳。

3. **错误信息未映射（表现根因）**：`-352` 不在 `ERROR_MAP` 中，且 JSON 解析异常的英文 `e.message` 被 `/api/video` 的 catch 原样返回，缺少统一的反爬识别与中文映射。

4. **fallback 循环内重复取 nav（性能/风控放大）**：`getPlayUrlWithFallback` 对每个 quality 都调用一次 `signWbi`，而 `signWbi` 每次都重新请求 `nav`。一次解析可能对 `nav` 发起多达 4 次请求，短时高频反而放大风控概率。修复时应将 nav（wbi_img）在单次解析内缓存。

## Correctness Properties

Property 1: Bug Condition - 反爬响应返回可读中文错误

_For any_ input where the bug condition holds（`isBugCondition` 返回 true，即视频链路上游返回非 2xx / HTML / `code:-352`），修复后的 `resolveVideo'` SHALL 不抛出且不返回任何包含 `"Unexpected token"` 或 `"is not valid JSON"` 的消息，而是使 `/api/video` 返回 `status:"error"` 且 `message` 为可读中文反爬提示（如「B 站风控拦截，请稍后重试」）。

**Validates: Requirements 2.1, 2.2, 2.3, 2.5**

Property 2: Preservation - 非反爬输入行为不变

_For any_ input where the bug condition does NOT hold（`isBugCondition` 返回 false），修复后的代码 SHALL 产生与修复前完全相同的结果，保留 happy path 视频解析、直播解析、无效 BV 号、`ERROR_MAP` 业务码、缓存命中与 `/proxy` 代理的全部既有行为。

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

Property 3: Anti-Crawl Cookie - 视频请求附带反爬 Cookie

_For any_ 视频解析请求（`nav` / `playurl` / `view`），修复后的代码 SHALL 为这些请求附加可降低风控概率的 Cookie（至少 `buvid3`，尽可能包含 `buvid4` / `bili_ticket`），且该 Cookie 在单次 `resolveVideo` 调用内只采集一次。

**Validates: Requirements 2.4**

## Fix Implementation

### Changes Required

假设上述根因分析正确，所有改动集中在 `index.js`，且以新增 + 替换三处调用点为主，保持其余逻辑不动。

**File**: `index.js`

1. **新增 `AntiCrawlError` 哨兵错误类型**
   - 定义一个继承 `Error` 的类（或带 `name === 'AntiCrawlError'` / `isAntiCrawl === true` 标记的 Error），默认 `message` 为常量 `ANTI_CRAWL_MSG = 'B 站风控拦截，请稍后重试'`。
   - 上层据此识别反爬，而非依赖脆弱的字符串匹配。

2. **新增安全 JSON 抓取助手 `fetchBiliJson(url, options)`**
   - 执行 `fetch(url, options)`。
   - 若 `!res.ok` → 抛 `AntiCrawlError`（非 2xx 视为反爬/异常）。
   - 读取 `Content-Type`；若不含 `application/json`，则将 body 作为文本读取，若以 `<` 开头（HTML/DOCTYPE）→ 抛 `AntiCrawlError`。为避免重复消费 body，统一先 `await res.text()` 再 `JSON.parse`，解析失败（catch SyntaxError）→ 抛 `AntiCrawlError`。
   - 解析成功后，若 `json.code === -352` → 抛 `AntiCrawlError`（风控校验失败）。
   - 返回解析后的 JSON 对象。
   - 注意：业务错误码（`-404` 等非 `-352`）**不**在此助手内处理，仍交由各调用点的既有 `ERROR_MAP` 逻辑，以保证 Preservation。

3. **新增反爬 Cookie 采集 `getAntiCrawlCookie()`**
   - 复用/扩展 `getBuvid()`：请求 `finger/spi`，取 `data.b_3`（buvid3）与 `data.b_4`（buvid4）。
   - 可选叠加 `bili_ticket`：用 WebCrypto `crypto.subtle` 计算 HMAC-SHA256（key `XgwSnGZ1p`，msg `"ts" + ts`）得 `hexsign`，POST `GenWebTicket`（`key_id=ec02&hexsign=...&context[ts]=...&csrf=`）取 `data.ticket`。该步骤包裹 try/catch，失败时降级为仅 `buvid3`/`buvid4`，不阻断主流程。
   - 返回拼接好的 Cookie 字符串，如 `buvid3=...; buvid4=...; bili_ticket=...`（缺失项跳过）。
   - 保留 `getBuvid()` 原签名与内部回退常量不变，供直播链路继续使用（最小改动，直播路径行为完全保留）。

4. **改造 `signWbi(params, cookie)` 走 `fetchBiliJson` 并支持注入 Cookie + 缓存 nav**
   - 将 `nav` 请求改为 `await fetchBiliJson(navUrl, { headers: { 'User-Agent': UA, 'Referer': REFERER, 'Cookie': cookie } })`。
   - 为避免 fallback 循环内重复取 nav：将 wbi_img（mixin_key）在单次解析内缓存。实现方式：由 `getPlayUrlWithFallback` 先取一次 nav/mixin_key 并传入，或将 `signWbi` 拆为「取 mixin_key（缓存）」+「用 mixin_key 签名」两步。

5. **改造 `getPlayUrlWithFallback(bvid, cid, targetQn, cookie, mixinKey)` 走 `fetchBiliJson`**
   - `player/wbi/playurl` 请求改为 `await fetchBiliJson(url, { headers: { 'User-Agent': UA, 'Referer': REFERER, 'Cookie': cookie } })`。
   - 关键：`AntiCrawlError` **不应**被 quality 循环内的 `catch` 吞掉后只存进 `lastError`。需在 catch 中判断：若是 `AntiCrawlError`，立即 `throw`（终止 fallback，无意义重试只会放大风控）；非反爬的业务失败仍按原逻辑记录 `lastError` 继续下一档。

6. **改造 `resolveVideo(bvid, qn, host)` 一次性采集 Cookie 并下传**
   - 函数开头 `const cookie = await getAntiCrawlCookie();`（每次调用仅一次）。
   - `web-interface/view` 请求改为 `await fetchBiliJson(viewUrl, { headers: { 'User-Agent': UA, 'Referer': REFERER, 'Cookie': cookie } })`。
   - 既有 `if (vData.code !== 0) throw new Error(ERROR_MAP[vData.code] || vData.message);` 保持不变（业务码语义不变）。
   - 将 `cookie`（及缓存的 mixinKey）下传给 `getPlayUrlWithFallback`。

7. **错误传播 / 消息映射（`/api/video` catch）**
   - `/api/video` 的 catch 块逻辑可保持「返回 `status:"error", message: e.message`」不变 —— 因为 `AntiCrawlError.message` 本身已是中文提示。由于 `fetchBiliJson` 已在源头拦截，`e.message` 不再可能是 `Unexpected token...`。
   - 可选增强：catch 中显式判断 `if (e instanceof AntiCrawlError || e.name === 'AntiCrawlError')` 以保证消息为 `ANTI_CRAWL_MSG`，对其它异常保留原 `e.message`。

8. **（可选）Worker isolate 内缓存 buvid/ticket**
   - 可用模块级变量缓存 `getAntiCrawlCookie()` 结果（带过期时间，如 buvid 缓存数分钟、ticket 按 3 天 TTL）以降低请求频率。
   - 权衡：isolate 生命周期不确定、跨 isolate 不共享，收益有限且增加状态复杂度；建议作为后续优化，首版仅做「单次解析采集一次」。

## Testing Strategy

### Validation Approach

采用两阶段策略：先在「未修复」代码上重现反爬场景以确认根因（暴露反例），再验证修复同时满足 Fix Checking 与 Preservation Checking。由于本项目是调用真实外部 API 的 Cloudflare Worker，且仓库当前**无任何测试设置**，核心做法是**将 `fetchBiliJson` / 反爬检测与网络解耦**：对 `global.fetch` 进行 mock/stub，喂入四类确定性响应（HTML body、`code:-352` JSON、非 2xx、合法 JSON），使断言完全可重复、不依赖外网。

**测试环境与运行器建议**：Workers 代码可在 Node 下用 [vitest](https://vitest.dev/) 运行，通过 `vi.stubGlobal('fetch', mockFn)` 注入 mock fetch；`crypto.subtle`（MD5 / HMAC-SHA256）在 Node 18+ 与 Workers 运行时均可用。为可测性，建议将 `fetchBiliJson`、`getAntiCrawlCookie`、`AntiCrawlError`、`resolveVideo` 等导出（或抽到可被测试 import 的模块）。属性测试可选用 [fast-check](https://github.com/dubzzz/fast-check) 与 vitest 集成。

### Exploratory Bug Condition Checking

**Goal**: 在实现修复前，先用 mock fetch 重现 bug，确认根因（直接 `.json()` 解析 HTML 抛 `Unexpected token`、`-352` 未被识别），若结果与假设不符则需重新假设。

**Test Plan**: 用 mock fetch 让 `nav`/`playurl`/`view` 分别返回 HTML 风控页或 `code:-352`，在**未修复**的 `resolveVideo` 上运行，观察抛出的错误消息。

**Test Cases**:
1. **nav 返回 HTML**：mock `web-interface/nav` 返回 `<!DOCTYPE html>...`（Content-Type `text/html`）。预期未修复代码抛 `Unexpected token '<'...`（will fail / 暴露反例）。
2. **playurl 返回 HTML**：mock `player/wbi/playurl` 返回 HTML，nav 返回合法 JSON。预期 `getPlayUrlWithFallback` 的 `lastError` 变为 JSON 解析错误并冒泡（will fail）。
3. **view 返回 code:-352**：mock `web-interface/view` 返回 `{"code":-352,"message":"风控校验失败",...}`。预期未修复代码返回「风控校验失败」而非统一可操作中文提示（may fail / 行为不一致）。
4. **非 2xx 边界**：mock 上游返回 `412` + HTML body。预期未修复代码对非 JSON body 调 `.json()` 抛解析错误（may fail）。

**Expected Counterexamples**:
- 错误消息包含 `Unexpected token` / `is not valid JSON`，且被原样返回前端。
- 可能成因：直接 `.json()` 无 Content-Type/状态码守卫、缺少反爬 Cookie、`-352` 未映射。

### Fix Checking

**Goal**: 验证对所有满足 bug 条件的输入，修复后的函数产生期望行为（无英文解析错误，返回中文反爬提示）。

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := resolveVideo_fixed(input)   // 经 /api/video 包装
  ASSERT NOT contains(result.message, "Unexpected token")
  ASSERT NOT contains(result.message, "is not valid JSON")
  ASSERT result.status = "error" AND isChineseAntiCrawlMessage(result.message)
END FOR
```

**Test Plan（mock fetch 确定性化）**: 用属性测试生成「哪个接口（nav/playurl/view）× 哪种反爬响应（HTML / `code:-352` / 非 2xx）」的组合，断言修复后 `/api/video` 始终返回 `status:"error"` 且消息为 `ANTI_CRAWL_MSG`，且消息不含 `Unexpected token` / `is not valid JSON`。

### Preservation Checking

**Goal**: 验证对所有不满足 bug 条件的输入，修复后的函数与修复前结果一致。

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT resolveVideo_original(input) = resolveVideo_fixed(input)
END FOR
```

**Testing Approach**: 推荐属性测试做保留检查，因为它能在输入域内自动生成大量用例、覆盖手写单测易漏的边界，并对「非 bug 输入行为不变」给出更强保证。具体做法：用同一组 mock fetch（返回合法 JSON）分别驱动原始函数与修复函数，断言两者输出（成功响应对象 / 业务错误消息）逐字段相等。

**Test Plan**: 先在未修复代码上观察 happy path、直播、无效 BV、`ERROR_MAP` 业务码、缓存命中、`/proxy` 的行为，再写属性测试固化这些行为在修复后不变。

**Test Cases**:
1. **Happy path 视频**：观察合法 JSON 输入下原函数返回的 `{title, pic, bvid, author, playableUrl, downloadUrl, quality, isLive:false}`，验证修复后逐字段一致。
2. **直播解析**：观察 `/api/live`（Legacy/V2、CN/OV 检测）在未修复代码上的行为，验证修复后完全一致（直播路径不接入新助手，行为天然保留）。
3. **无效 BV 号 / 业务错误码**：观察「无效的 BV 号」与 `ERROR_MAP[-404]` 等输出，验证修复后不变（`fetchBiliJson` 不拦截非 `-352` 业务码）。
4. **缓存命中 / 代理**：验证 `caches.default` 命中直接返回、`/proxy` 白名单/Range/m3u8 重写不变。

### Unit Tests

- `fetchBiliJson`：合法 JSON → 返回对象；HTML body（含 Content-Type `text/html` 与 `application/json` 但 body 以 `<` 开头两种）→ 抛 `AntiCrawlError`；非 2xx → 抛 `AntiCrawlError`；`code:-352` → 抛 `AntiCrawlError`；其它 `code`（如 `-404`）→ 正常返回对象（不拦截）。
- `getAntiCrawlCookie`：`finger/spi` 正常 → 返回含 `buvid3`/`buvid4` 的 Cookie；`bili_ticket` 接口失败 → 降级为仅 `buvid3`/`buvid4` 不抛错；`finger/spi` 失败 → 复用 `getBuvid()` 回退常量。
- `getPlayUrlWithFallback`：遇 `AntiCrawlError` 立即终止 fallback 并抛出；遇普通业务失败按原逻辑记录 `lastError` 并继续下一档。
- `getBuvid`：内部 try/catch 回退行为保持不变（回归保护）。

### Property-Based Tests

- **Fix Checking 属性**：在「接口 × 反爬响应类型」的笛卡尔积上随机生成输入，断言 `/api/video` 始终返回中文反爬错误且不含英文解析错误。
- **Preservation 属性**：随机生成合法 JSON 上游响应（随机 title/cid/quality/durl），断言原函数与修复函数输出逐字段相等。
- **Cookie 注入属性**：随机化 `getAntiCrawlCookie` 的可用字段组合（仅 buvid3 / +buvid4 / +ticket），断言 nav/playurl/view 三个请求收到的 `Cookie` 头始终包含 `buvid3`，且在单次 `resolveVideo` 内 `finger/spi` 仅被调用一次。

### Integration Tests

- 端到端：mock fetch 串起 `nav → playurl → view`，验证完整 happy path 返回成功响应结构。
- 反爬端到端：在链路任意一环注入反爬响应，验证 `/api/video` 最终返回中文反爬提示（status `200`、body `status:"error"`）。
- 上下文隔离：验证视频路径接入新助手后，`/api/live`、`/proxy` 行为无任何变化。
