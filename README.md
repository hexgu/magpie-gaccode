# GACCode for magpie and OpenCode

**Unofficial plugin.** Independently maintained; not reviewed or endorsed by
magpie, GACCode or OpenCode. Package: `magpie-gaccode`, version **0.1.2**.
Provider ID: `gaccode`.

Claude uses Anthropic Messages; Codex uses OpenAI Responses. Quota queries
are read-only. Automatic refill applications are enabled by default;
set `autoRequestRefill: false` to disable them. An original explicit
`autoDailyReset` off setting is also respected when no plugin option overrides it.
Direct Gemini GenAI is experimental; the original Gemini entries remain
available unless `experimentalGemini` is explicitly set to `false`.

## Install

Requires magpie with GitHub plugin installation support. The GitHub discovery
entry is available in magpie 0.1.1099 or later under
**Plugins → Discover → Unofficial plugins · GitHub**.

```sh
magpie plugin add github:SadWood/magpie-gaccode
magpie plugin login gaccode
magpie quota gaccode
```

This package is distributed from GitHub; it has not been published to npm.
The repository contains its runnable entry files and requires no build step
or install scripts. Review the code before installing. To update later:

```sh
magpie plugin update
```

That command checks all installed plugins. If you already load another local
copy of GACCode, replace its source rather than adding a second copy with the
same provider ID. Keep your existing credentials and configuration backed up.

For local development:

```sh
git clone https://github.com/SadWood/magpie-gaccode.git
cd magpie-gaccode
bun test
magpie plugin add .
```

OpenCode can load a local checkout in `opencode.json`:

```json
{ "plugin": ["file:///absolute/path/to/magpie-gaccode/index.mjs"] }
```

Then use `opencode auth login`. See the tested host versions and limitations
below before enabling tools or custom token limits.

## Sign in

Create a key on [API Keys](https://gaccode.com/api-keys). The API-key method
asks for an inference endpoint (the main site or relay05) and an optional
website JWT, then asks for the key itself. It lets the host save the key;
there is no password sign-in method.

magpie stores plugin credentials in
`~/.config/magpie/plugin-auth.json` (or its XDG config directory).
OpenCode uses its own authentication store. The website JWT, when supplied,
is stored in the credential metadata. Obtain it from your signed-in browser
on gaccode.com from **DevTools → Application → Local Storage → token**.
It reads website credits and account details. Without it, the plugin only
attempts the API-key statusline query for basic credits.

Each request reads the current account's credentials and endpoint. This
keeps an account on relay05 when another account, or an older cached model
list, names the main site. Model-specific endpoint overrides are honored.
A custom endpoint reserves its matching origin/path in the fetch layer:
all models using that same URL keep the caller's host and credentials.
Use distinct endpoint URLs when you need different routing per model.
A relay's availability must be checked for each API; its presence in the
official relay selector does not guarantee every API works there.

## Models and configuration

Claude and Codex IDs come from their public model catalogs:

| Family | SDK | Base URL |
|---|---|---|
| Claude | `@ai-sdk/anthropic` | `<account host>/claudecode/v1` |
| Codex | `@ai-sdk/openai` | `<account host>/codex/v1` |
| Experimental Gemini | `@ai-sdk/google` | `<account host>/gemini/v1beta` |

Examples: `gaccode/claude-sonnet-5-5`, `gaccode/gpt-5.5`.
When a required Claude/Codex catalog fails, the plugin marks the **whole**
list as a fallback and magpie may keep its last successful complete list.
Gemini authentication or catalog failures use its bundled entries without
discarding readable Claude/Codex catalogs; their internal evidence records
remain marked as bundled rather than live. Successful empty catalogs do not add
bundled models. Explicit user model definitions remain listed even when
their IDs are absent from a live catalog; this is configuration, not proof
of availability. Duplicate IDs across protocol families cause whole-list
fallback instead of silently choosing one protocol.

The public catalogs confirm IDs, not token limits, image input, tools or
reasoning levels. Known models preserve the original plugin's configurable
tools, reasoning, image input, variants and token-budget declarations.
These bundled defaults are configuration, not endpoint capability guarantees.
New unknown IDs retain unknown capabilities and budgets. A token limit of
`0` is magpie's unknown value, not a GACCode limit of zero.
magpie can fill in limits from its own catalog or models.dev; a displayed
limit such as `1M` is not confirmation of this GACCode endpoint's limit.
No uniform credit price or free-model flag is inferred.

Explicit model configuration is preserved in live and fallback lists:
name, API id, limit, variants, options, headers and provider endpoint.
Override bundled token budgets or reasoning levels with values
you have checked for that model and endpoint. These are your configuration,
not a server capability guarantee. In magpie this is the OpenCode-shaped
`config.provider.gaccode.models` in `plugins.json`; in OpenCode it is
`provider.gaccode.models` in `opencode.json`.

Internal evidence records keep the catalog source, check time, family and
user-overridden fields and bundled declarations separate from capability and authentication claims.
Bundled fallback entries have no successful live-check timestamp, and a
catalog response does not establish inference access. These records are
not serialized as SDK model fields and do not store credential values.

Unknown models use `false` for undeclared tools and reasoning capabilities
in the host's boolean fields. Known models retain the original declarations.
These fields are not an execution-permission boundary.
OpenCode 1.18.34 still sends and executes tools with `tool_call:false`;
control tool execution with the host's agent permissions. After checking
tool support for your model and endpoint, this magpie configuration declares
that support:

```json
{
  "config": {
    "provider": {
      "gaccode": {
        "models": { "claude-sonnet-5-5": { "tool_call": true } }
      }
    }
  }
}
```

In OpenCode, place the same `provider` object at the top level. Set `limit`,
`reasoning` and `variants` only to values you have verified.

### OpenCode 1.18.34 compatibility

The tested CLI loads this plugin and saves API-key prompts correctly.
Mixed Anthropic/OpenAI SDKs and streaming tool-result round trips were
exercised against both a local stand-in and GACCode. The live Claude run
needed recovery from an upstream tool-name mismatch; see Validation below.

For a newly added provider, this version uses the bundled config models and
does not call the dynamic catalog hook. Live refresh and whole-list cache
fallback described above apply to magpie, not this OpenCode configuration.
Explicit model configuration remains available in OpenCode's static list.
To hide a model in this version, use `provider.gaccode.blacklist`, for example
`["claude-opus-4-5"]`. Its configuration schema removes a model's `disabled`
field before this plugin receives it, so `models.<id>.disabled` cannot hide it.

An output limit of `0` uses this OpenCode version's default request budget
of 32,000; it does not send zero. Set a verified `limit.output` explicitly
when the endpoint needs a different budget. Source inspection also shows
that `context:0` skips automatic overflow checks; long-conversation behavior
has not been exercised. Neither default is a verified GACCode limit.

To disable tools in this tested OpenCode version, set the relevant agent's
`permission` to `"deny"`. The local request then contains no tools. A model's
`tool_call:false` alone does not provide that guarantee.

## 持续补充的积分余额与路由（Magpie）

GACCode 没有 Codex 那样的固定重置周期。卡片主余额显示实测剩余积分，
奖励余额超过补充基准、零余额和负余额都保留原值。USD 余额另列附注，
不会替代积分余额。插件不按套餐名称硬编码价格、初始积分或补充速率。
`creditCap` 在这里称作“补充基准”，不是累计消费上限。

### 原版百分比走势与可选绝对余额走势

官方原版已支持 `windows` 的百分比历史、原生走势和智能路由。
有效窗口不需要 `span`、`resetsAt` 或其他重置字段即可接入；
使用本插件的普通窗口协议即可启用这些功能，无须安装宿主兼容补丁。
原版历史记录的是裁剪到 0..100 的剩余比例 `100 - used`，
不是绝对积分余额。余额为 22000、补充基准为 12000 时，路由缺口为 0%，
走势剩余比例为 100%，无法保留这组超额数值的细节；零余额与负余额
的剩余比例均为 0%，负值也不能保留在百分比曲线中。

插件返回可选的 `balanceTelemetry`：`amount` 是实测余额，`unit` 是“积分”，
`kind` 是 `replenishing`，`refillPerHour` 仅在接口提供有效非负补充速率时存在。
官方基准插件宿主不接收这个扩展，插件读取路径也没有接入传统 API 的
绝对余额历史。因此，需要绝对积分余额走势和预计用完时间时，才需选择
宿主兼容补丁。补丁见
`compat/magpie-balance-telemetry.patch`，集成说明见 `compat/README.md`。
它复用官方传统 API 的余额记录、折线、主题、范围选择和点击放大。
未安装补丁时，余额文本、查询状态、原版百分比走势和积分余量路由仍可使用。

### 预计用完时间（可选宿主补丁）

兼容补丁保留预计用完时间实现，使用最近一次余额上涨后、
近期连续读数的净下降速度。
至少需要 3 个有效读数，首尾跨度至少 1 小时；余额持平、增长或样本不足
时不显示预测。小时补充已反映在实际余额内，不再额外加减补充速率。
每日恢复、邀请奖励或其他余额上涨后重新取样，避免沿用补充前的预测。
预测是近期净余额变化的提示，不保证未来消耗速度不变，也不参与路由。
余额下降不等于总消费，期间的补充、奖励和其他余额变化都会影响净变化。
绝对余额历史从接入补丁后的有效读数开始积累，
不能从已有百分比历史还原未记录的绝对余额。

### 智能路由

路由始终使用 API key 状态接口的实测余额和补充基准；网站 JWT 的余额
不替代 key 的余额，即使两边邮箱一致。网站与 key 不同或身份未知时，
网站信息窗口使用 `aside: true`，独立的“积分余量”窗口参与路由。
路由窗口名称保持稳定，身份接口暂时缺少邮箱不会拆开额度恢复记录。

Magpie 当前按 `used` 比例选择账户。插件的普通窗口实现使用
`clamp((1 - balance / creditCap) * 100, 0, 100)` 表示当前余额相对补充基准的缺口，
**不表示累计消费比例**。余额恢复会降低该数值；奖励余额超过基准时为 0%，
零或负余额为 100%。缺少有效余额、基准或非有限比例时不创建路由窗口，
显示“路由用量未知”。未知读数仍由 Magpie 的原生未知额度策略处理。

不生成 `span`、`resetsAt`、每小时重置倒计时或月度消费额度。
不把每日可申请恢复机会视作已经到账，也不将 USD、加油包或申请状态
转换为可用积分。附注使用括号，保留原生界面追加百分比的位置。
实现依据为 [Magpie 插件文档](https://usemagpie.ai/docs/plugins#usage)
和 [官方源码](https://github.com/yetone/magpie/tree/e66fa165930ff0693d1ee8065727c29c7631d8f4)。

### WorkBuddy 参考与消费统计边界

参考版本为 `magpie-community` 提交
`d21d10f0da63992c03c62f9e412ab4c3503f55ef` 的
`packages/workbuddy/index.mjs`。其 `_internal.usageOf` 汇总各套餐的
`CycleUsedCapacity` 和 `CycleTotalCapacity`，分别返回窗口的 `amount` 和
`limit`，并用 `unit: "credits"` 标注单位；`used` 为已用量占周期总量的百分比。
这些字段有周期消费来源。

GACCode 的 `creditCap` 是补充基准，`used` 是相对该基准的余额缺口。
不能机械添加 WorkBuddy 的 `amount/limit/unit`，将余额缺口伪装成累计消费。
可选 `balanceTelemetry.amount` 表示实测剩余余额，与窗口消费字段含义不同。
官方基准的 `credits_daily` 仅适用于 WorkBuddy Provider，不支持 `gaccode`；
普通窗口接入不会自动产生 GACCode 的每日消费统计或绝对余额预测。

未修改官方 JS 宿主的普通协议复验已实跑通过，共 9 次插件调用：
7 次 API key 余额序列、1 次网站 JWT / key 来源隔离、1 次 key 路由用量未知。
官方 `host.js` 丢弃结构化余额扩展，但完整保留普通路由窗口；
窗口无需重置字段，也未虚构 `amount/limit` 消费数据。
复验使用合成响应与隔离 HOME，命令如下，不安装兼容补丁：

```sh
bun --no-env-file run compat/verify-native.mjs /absolute/path/to/unmodified/magpie
```

实际结果、来源及历史验证记录见 `compat/VERIFICATION.md`。

## Read-only quota reporting (magpie)

With a website JWT, credits retain the original source:
`GET https://gaccode.com/api/credits/balance` with `Authorization: Bearer <JWT>`.
The returned balance/cap and `refillRate` (or `creditsPerHour`) describe that
website account. `/api/me` names the card; `/api/subscriptions` provides its
plan, end date and renewal setting. None of these depend on API-key statusline
success, so a statusline 401 does not hide readable website credits.

Without a JWT, the basic query follows GACCode's
[official statusline plugin](https://gaccode.com/claudecode/install/statusline-plugin):
`GET <account host>/claudecode/v1/cc-status-line` with `x-api-key`.
This card uses only that response's account identity.

When website credits are shown, an optional statusline query can supply
`timeMultiplier.value` only when its account email matches the website's.
The credit response's own multiplier is also accepted. Only non-1x values
are displayed.
Missing fields or failed queries show unknown/error or are left out; no
clock schedule or old usage record is used to invent a current multiplier. The time multiplier is only one
cost factor, so it is not copied into every model's `rate` or `rateWas`.

积分窗口是否参与路由及其账户边界见“持续补充的积分余额与路由”。
不推断 API key 的单独消费限额或 CREDIT / USD 模式之间的支付切换。

With a website JWT, the plugin also reads the main site's
`/api/subscriptions`, `/api/me`, `/api/usd-account`,
`/api/credits/booster-packs` and the first page of `/api/tickets`.
Website credentials remain on gaccode.com even if inference uses a relay.

The website plan heads the website credit card and its email is not repeated
in the notes. A readable different API-key identity is listed separately.
卡片的余额数值为实测积分，网站 USD 金额放在附注。积分行用括号显示
补充速度、非 1x 倍率、加油包数量、今日补充工单和账户说明，使用“，”连接。
“ · ”留给原生百分比。缺少有效补充基准时，这些信息显示在余额文本中。
When the credit query fails or its balance is unknown,
the card shows the query error; website details never replace it as a balance.
A missing USD
account, no booster packs and no ticket found are left out. Zero, unreadable
and unknown states are still shown, and used/expired booster packs are
labeled as such.
A matching ticket ("今日已申请") means an application was found, not that credits arrived;
no match on the first page does not prove no application was made today.
The website's documented workflow states are shown as waiting for support,
waiting for the user, or closed; other values are unknown. Closed does not
mean approved, rejected or credited. Those financial outcomes are not
inferred from the ticket state.

For a matching ticket, the plugin reads `/api/credits/history` between the
ticket's creation time and a fixed query cutoff. It confirms a reset only
from a positive numeric `refill` record whose `details` exactly matches the
observed `Automatic refill via support ticket #<complete ID>` format,
with a valid `balanceAfter` and timestamp in that interval. A conflicting
account ID is rejected. The card then shows `今日已重置（+12484 积分）`, for
example; the current balance need not remain full after subsequent use.
Hourly refills, other tickets, malformed or unrecognized records never
confirm it. Lookup is limited to five validated 100-row pages with a shared
six-second timeout. Failures or incomplete pagination keep the application
status and show a small history-read notice without hiding readable credits.

All quota queries are GETs. Automatic refill below can create a
ticket only after an inference error. The plugin never buys or uses booster
packs, or changes an API key's allowance. A website JWT failure, or
a status-query 401, leaves the inference account's sign-in state unchanged.
Inference errors keep the upstream response body, status and headers;
magpie's own inference-401 handling still applies.

OpenCode ignores magpie's quota hook.

## Automatic credit-refill application

When enabled (the default), request a credit refill after a managed inference request
reports exhausted credits. The plugin submits a support ticket using your
website JWT, subject to the account checks and daily deduplication below.
It displays “已申请”; the credit balance continues to show the latest reading.
Approval and credit delivery remain controlled by GACCode.

In magpie 0.1.1100, provider rows have no Options button; the native options
editor is for middleware. Set provider plugin options through the CLI:

```sh
magpie plugin options 'github:SadWood/magpie-gaccode' '{"autoRequestRefill":false}'
```

If you installed using a different source or pinned ref, use its exact spec from
`magpie plugin --json`. Include any other options you want to keep in the JSON
object. Set `autoRequestRefill` to `false` to disable automatic applications.
An isolated preview page may call this CLI, but is not a native provider toggle.

The default is `true`; explicit boolean `false` disables it. Use boolean
values for this option; other explicitly provided values do not authorize
requests. Automatic requests require
`metadata.loginToken` (website JWT) and an existing host-provided `directory`.
It runs only after a managed GACCode inference POST returns a 402 JSON error
explicitly saying credits are exhausted, or a 429 JSON error with an explicit
`error.code` of `insufficient_credits`, `credits_exhausted` or
`credit_balance_exhausted`. A 429 message or generic `insufficient_quota` type
alone cannot trigger it. Other statuses, including 400, 401, 403 and all 5xx,
are excluded regardless of their response text or code. Generic 429 errors,
successful responses, catalog reads, quota reads and explicit custom
endpoints cannot trigger it. Inference is never automatically retried, and
the original Response object, headers and body are returned unchanged.

The website API is fixed to `https://gaccode.com/api`, with redirects refused.
`/me` must contain `user.id` and `user.email`; the API key's statusline must
contain a matching `email` (or `user.email`). If statusline supplies `userId`
or `user.id`, it must also match. Missing or mismatched identity stops the
application. Category ids are discovered using `REQUEST_TO_REFILL_CREDIT`.
The same statusline response must report `balance` as a finite JSON number
at or below zero. If `effectiveBalance` is present, it must also be a finite
JSON number at or below zero. Missing balance, numeric strings, null, booleans,
unknown formats or either positive balance stop the application. This avoids
applying on a key-specific error when account credits are still available.
Only `requiresRecaptcha === false` permits a POST; all other CAPTCHA results
require the website. Complete validated ticket pagination is required; an
existing same-day or pending refill ticket blocks another application.

Each website account id gets one permanent, exclusively created 0600 ledger
per GMT+8 day under `directory/.gaccode-refill` (0700). Multiple keys, plugin
instances and processes sharing that directory share the same lock. A synced
`attempt` record precedes POST. Failed checks after account identification,
interrupted attempts and unknown POST outcomes cannot retry that day.
Failures before an account id is available stop the current instance for
that credential/day; a fresh instance may repeat identity GETs, never submit
without the account lock. An interrupted or corrupt ledger is not reclaimed.
Different host directories do not share local deduplication; server ticket
checks cannot provide an atomic lock between different directories/machines.

An explicit plugin `autoRequestRefill` option takes precedence. If it is
absent, the original saved `metadata.autoDailyReset` off values (`"off"`,
`"false"`, `"0"`, or their boolean/numeric equivalents) leave requests disabled;
otherwise they are enabled by default. They use the persistent checks
described above after an exhausted-credit inference response.

Quota text shows missing JWT, waiting, application or failure. Disabled
options and a redundant waiting state beside today's ticket are omitted.
A failed `/me` read shows “网站身份读取失败，暂停申请”, including in a
fresh quota process; a 401 also asks to update the JWT. It cannot be displayed
as waiting to trigger when website identity could not be read. This uses the
current read result without persisting any key-to-account mapping.
“已申请” confirms a ticket response only. The plugin does
not infer approval from a ticket state. Correlated credit-history records are
checked separately during read-only quota refreshes. All request checks use a shared
12-second deadline; error-body inspection has a 1-second/64-KiB bound. These
are request bounds, not performance measurements or delivery guarantees.

## Experimental Gemini

The [official Gemini launcher](https://gaccode.com/gemini/install) uses
Code Assist. It does not establish compatibility with the direct GenAI
endpoint above. Authentication, generation, streaming, tools and cancellation
still need endpoint-specific verification. The original model entries remain
listed; their presence does not establish current account access.

To explicitly disable Gemini in magpie, use your installed plugin spec:

```sh
magpie plugin options '<installed-plugin-spec>' '{"experimentalGemini":false}'
```

In OpenCode:

```json
{ "plugin": [["file:///absolute/path/to/magpie-gaccode/index.mjs", { "experimentalGemini": false }]] }
```

The five bundled experimental IDs preserve the original plugin's model
configuration. Their names do not prove current account access or protocol support.
Old cached Gemini entries cannot send managed requests with the experiment
off; explicitly configured custom endpoints remain user configuration.

## Validation and release

The automated tests use fake credentials and mocked requests. Isolated
magpie 0.1.1074/0.1.1076 sandbox checks and OpenCode 1.18.34 CLI checks used
local stand-ins. Separately authorized main-site checks on 2026-10-06 used
one existing key, short synthetic prompts and outputs capped at 128 tokens:

- Public catalogs and API-key statusline returned the expected response shape.
- Direct plugin-fetch checks passed text and streaming for `gpt-5.5` and
  `claude-sonnet-5-5`; GPT-5.5 also completed tool/result and client-abort checks.
- Real isolated magpie 0.1.1076 provider tests passed both protocols. Its
  gateway completed both tool/result round trips with a declared `ProbeEcho`
  tool, plus a Claude client abort after receiving streamed text.
- Real isolated OpenCode 1.18.34 completed a GPT-5.5 streaming tool/result
  round trip even though the upstream SSE response lacked Content-Type.
- Claude in OpenCode returned `ProbeEcho` when `probe_echo` was declared.
  One bounded run failed; a later run received the same first-call error,
  then called the correct tool after error feedback and completed the result
  round trip. This is recovery success, not reliable first-call tool behavior.

The Claude endpoint also rejected forced `tool_choice` with HTTP 400,
instructing use of `auto` or `none`. The plugin preserves upstream tool names
and errors; it does not guess aliases or silently change tool-choice semantics.
Bundled tool declarations remain configuration defaults rather than guarantees
of reliable first-call behavior.

These are bounded checks for two models, one key and the host versions above,
not a guarantee for every account or model. Client abort does not establish
server-side cancellation or stopped billing. Accurate total charges were not
measured. Relay availability, other models, long conversations and individual
limits/efforts remain unverified.

This is an independent public repository, not a magpie-community package.
The `magpie-plugin` GitHub topic enables unofficial discovery; it does not
mean that magpie has audited the code. npm publication is not required.

Run `bun test` from the repository root. The offline tests cover the
provider and automatic refill behavior, including account identity,
persistent cross-process deduplication and keeping quota reads read-only.

## 中文速览

- 网站 JWT 按原版方式读取网站积分、账号和套餐；API key 用于推理，无 JWT 时也可尝试基础积分查询。
- 本仓库为非官方插件，未获 magpie / GACCode 审核或背书；从 GitHub 安装，尚未发布 npm。
- `autoRequestRefill` 默认开启；显式设为 `false` 可关闭，未设置时仍保留旧配置的关闭状态。仅在托管推理明确积分耗尽时申请一次工单。额度刷新只读匹配对应工单的补充流水，确认后显示“今日已重置（+积分）”。
- 不保存网站密码，不购买或使用加油包。
- 网站余额与 API key 消费额度分别看待；额度读取失败不会停用推理。
- relay 按账号选择；已知模型沿用原版配置声明，未知模型保持未知，用户显式配置优先。
- Gemini 原版列表默认保留；`experimentalGemini:false` 可关闭，实际直接 GenAI 能力仍需核验。
- 独立 Magpie/OpenCode 已完成有限主站真实链路测试。Magpie 两族工具往返及 Claude 客户端取消通过；OpenCode Codex 直接通过，Claude 有首轮工具名大小写错误后恢复成功的限制；强制工具选择不受该 Claude 端点支持。relay、其他模型及计费停止仍未证实。
- OpenCode 1.18.34 CLI 已用本地替身验收；动态目录未调用，工具权限须通过 Agent 权限控制。

## License

MIT
