# GACCode for magpie and OpenCode

**Unofficial plugin.** Independently maintained; not reviewed or endorsed by
magpie, GACCode or OpenCode. Package: `magpie-gaccode`, version **0.1.0**.
Provider ID: `gaccode`.

Claude uses Anthropic Messages; Codex uses OpenAI Responses. Quota queries
are read-only. Automatic refill applications are optional and disabled by
default. Direct Gemini GenAI is experimental and also disabled by default.

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
on gaccode.com; leave it blank to skip the website details.

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
When a required catalog fails, the plugin marks the **whole** list as a
fallback. magpie may keep its last successful complete list; this is not
independent refresh of each family. Successful empty catalogs do not add
bundled models. Explicit user model definitions remain listed even when
their IDs are absent from a live catalog; this is configuration, not proof
of availability. Duplicate IDs across protocol families cause whole-list
fallback instead of silently choosing one protocol.

The public catalogs confirm IDs, not token limits, image input, tools or
reasoning levels. The plugin leaves unconfirmed capabilities unknown. A
token limit of `0` is magpie's unknown value, not a GACCode limit of zero.
magpie can fill in limits from its own catalog or models.dev; a displayed
limit such as `1M` is not confirmation of this GACCode endpoint's limit.
No uniform credit price or free-model flag is inferred.

Explicit model configuration is preserved in live and fallback lists:
name, API id, limit, variants, options, headers and provider endpoint.
If your client needs a token budget or reasoning levels, configure values
you have checked for that model and endpoint. These are your configuration,
not a server capability guarantee. In magpie this is the OpenCode-shaped
`config.provider.gaccode.models` in `plugins.json`; in OpenCode it is
`provider.gaccode.models` in `opencode.json`.

Internal evidence records keep the catalog source, check time, family and
user-overridden fields separate from capability and authentication claims.
Bundled fallback entries have no successful live-check timestamp, and a
catalog response does not establish inference access. These records are
not serialized as SDK model fields and do not store credential values.

Unknown tools and reasoning capabilities use `false` in the host's boolean
fields as an undeclared capability, not an execution-permission boundary.
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

## Read-only quota reporting (magpie)

The basic state query follows GACCode's
[official statusline plugin](https://gaccode.com/claudecode/install/statusline-plugin):
`GET <account host>/claudecode/v1/cc-status-line` with `x-api-key`.
When that response supplies an account email, it identifies the key's
quota card; a website JWT's email is never substituted for it.

It reads the returned credit balance/cap and current
`timeMultiplier.value`; the multiplier is shown only when it is not 1x.
Missing fields or failed queries show unknown/error or are left out; no
clock schedule or old usage record is used to invent a current multiplier. The time multiplier is only one
cost factor, so it is not copied into every model's `rate` or `rateWas`.

Any credit progress bar is informational (`aside: true`). There is no
invented hourly reset countdown or automatic account stop based on it.
An account balance is not the same as an API key's spending allowance;
CREDIT and USD modes may have different limits. The status endpoint's
actual permissions and response contract still need a real test account.

With an optional website JWT, the plugin also reads the main site's
`/api/subscriptions`, `/api/me`, `/api/usd-account`,
`/api/credits/booster-packs` and the first page of `/api/tickets`.
Website credentials remain on gaccode.com even if inference uses a relay.

When the website email matches the API key's, its plan replaces the card's
"GACCode" label and the email is not repeated. Otherwise the website email and
plan are listed after the other website items, since they may belong to a
different account. The card's balance is the website USD amount alone, a
figure like other cards'. The credit line follows the count with the refill
rate, a non-1x multiplier, booster counts, today's refill ticket and the
website details, joined by "，" (magpie shows a display up to its second
" · " part). Without a credit cap they all go in the balance. A missing USD
account, no booster packs and no ticket found are left out. Zero, unreadable
and unknown states are still shown, and used/expired booster packs are
labeled as such.
A matching ticket ("今日已申请") means an application was found, not that credits arrived;
no match on the first page does not prove no application was made today.
The website's documented workflow states are shown as waiting for support,
waiting for the user, or closed; other values are unknown. Closed does not
mean approved, rejected or credited. Those financial outcomes are not
inferred from the ticket state.

All quota queries are GETs. The opt-in automatic refill below can create a
ticket only after an inference error. The plugin never buys or uses booster
packs, or changes an API key's allowance. A website JWT failure, or
a status-query 401, leaves the inference account's sign-in state unchanged.
Inference errors keep the upstream response body, status and headers;
magpie's own inference-401 handling still applies.

OpenCode ignores magpie's quota hook.

## Optional automatic credit-refill application

Enable this option to request a credit refill after a managed inference request
reports exhausted credits. The plugin submits a support ticket using your
website JWT, subject to the account checks and daily deduplication below.
It displays “已申请”; the credit balance continues to show the latest reading.
Approval and credit delivery remain controlled by GACCode.

In magpie 0.1.1100, provider rows have no Options button; the native options
editor is for middleware. Set provider plugin options through the CLI:

```sh
magpie plugin options 'github:SadWood/magpie-gaccode' '{"autoRequestRefill":true}'
```

If you installed using a different source or pinned ref, use its exact spec from
`magpie plugin --json`. Include any other options you want to keep in the JSON
object. Set `autoRequestRefill` to `false` to disable automatic applications.
An isolated preview page may call this CLI, but is not a native provider toggle.

The default is `false`; only boolean `true` enables it. This option requires
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

Quota text shows the option state, missing JWT, waiting, application or
failure. A failed `/me` read shows “网站身份读取失败，暂停申请”, including in a
fresh quota process; a 401 also asks to update the JWT. It cannot be displayed
as waiting to trigger when website identity could not be read. This uses the
current read result without persisting any key-to-account mapping.
“已申请” confirms a ticket response only. The plugin does
not infer approval or credited balance. All checks and requests use a shared
12-second deadline; error-body inspection has a 1-second/64-KiB bound. These
are request bounds, not performance measurements or delivery guarantees.

## Experimental Gemini

The [official Gemini launcher](https://gaccode.com/gemini/install) uses
Code Assist. It does not establish compatibility with the direct GenAI
endpoint above. Until authentication, generation, streaming, tools and
cancellation have been checked against GACCode, enable this only to test it.

In magpie, use the same CLI options command with your installed plugin spec:

```sh
magpie plugin options '<installed-plugin-spec>' '{"experimentalGemini":true}'
```

In OpenCode:

```json
{ "plugin": [["file:///absolute/path/to/magpie-gaccode/index.mjs", { "experimentalGemini": true }]] }
```

The four bundled experimental IDs are listed in GACCode's installation
guide. Their names do not prove current account access or protocol support.
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
Unknown tool capabilities remain unconfirmed by default.

These are bounded checks for two models, one key and the host versions above,
not a guarantee for every account or model. Client abort does not establish
server-side cancellation or stopped billing. Accurate total charges were not
measured. Relay availability, other models, long conversations and individual
limits/efforts remain unverified.

This is an independent public repository, not a magpie-community package.
The `magpie-plugin` GitHub topic enables unofficial discovery; it does not
mean that magpie has audited the code. npm publication is not required.

Run `bun test` from the repository root. The 223 offline tests cover the
provider and automatic refill behavior, including account identity,
persistent cross-process deduplication and keeping quota reads read-only.

## 中文速览

- API key 用于推理及基础积分查询；网站 JWT 用于可选扩展信息和显式开启的自动申请。
- 本仓库为非官方插件，未获 magpie / GACCode 审核或背书；从 GitHub 安装，尚未发布 npm。
- `autoRequestRefill` 默认关闭；开启后仅在托管推理明确积分耗尽时申请一次工单，显示“已申请”；实际积分以最新余额为准。额度查询保持 GET-only。
- 不保存网站密码，不购买或使用加油包。
- 网站余额与 API key 消费额度分别看待；额度读取失败不会停用推理。
- relay 按账号选择；模型能力未确认时显示未知，保留用户显式配置。
- Gemini 默认关闭，启用 `experimentalGemini` 只表示接受实验性直接 GenAI 路径。
- 独立 Magpie/OpenCode 已完成有限主站真实链路测试。Magpie 两族工具往返及 Claude 客户端取消通过；OpenCode Codex 直接通过，Claude 有首轮工具名大小写错误后恢复成功的限制；强制工具选择不受该 Claude 端点支持。relay、其他模型及计费停止仍未证实。
- OpenCode 1.18.34 CLI 已用本地替身验收；动态目录未调用，工具权限须通过 Agent 权限控制。

## License

MIT
