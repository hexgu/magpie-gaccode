# Magpie 可选绝对余额走势与预计用完时间兼容补丁

本目录提供可选的 Magpie 宿主增强补丁，用于绝对积分余额走势与预计用完时间。
官方原版已支持普通 `windows` 的百分比走势和路由，无须为这些功能安装补丁。
插件本身不替换官方界面，也不读取或修改宿主凭证。
补丁基于官方提交 `e66fa165930ff0693d1ee8065727c29c7631d8f4`，文件为
`magpie-balance-telemetry.patch`。当前安装版本没有被自动修改。

## 原版能力与补丁用途

官方插件协议支持 `balance` 文本和 `windows` 额度窗口。有效窗口无需
`span`、`resetsAt` 或其他重置字段，即可记录百分比历史、显示原生走势并参与路由。
原版历史保存裁剪到 0..100 的剩余比例 `100 - used`。
22000 积分相对 12000 积分补充基准的超额细节，以及负余额，
均无法保留在这条百分比曲线中；余额文本仍可显示实测数值。

官方基准宿主会丢弃未知的 `balanceTelemetry` 字段，
插件查询也没有接入传统 API 的绝对余额历史。因此，仅在需要绝对积分余额走势
与预计用完时间时才需此补丁。它不负责启用普通窗口的百分比走势或路由。

补丁增加可选的 `balanceTelemetry`，复用官方传统 API 的余额历史和 `balanceCurve`。
没有这个字段的插件及官方供应商继续走原来的路径。不通过新增额度周期模拟积分。

## WorkBuddy 参考与数据语义

参考源码为 `magpie-community/plugins` 仓库的 `packages/workbuddy/index.mjs`，
提交 `d21d10f0da63992c03c62f9e412ab4c3503f55ef`。
`packages/workbuddy/index.mjs` 的 `_internal.usageOf` 汇总
`CycleUsedCapacity` / `CycleTotalCapacity`，作为周期已用量和总量；
窗口返回 `amount`、`limit`、`unit: "credits"` 及已用百分比。

GACCode 的窗口 `used` 表示相对补充基准的余额缺口，
`creditCap` 不是累计消费上限。不能直接套用 WorkBuddy 的
`amount/limit/unit` 来生成消费数据。余额下降是净变化，不等于总消费。
官方基准的 `credits_daily` 仅接入 WorkBuddy Provider，不支持 `gaccode`。
本补丁记录实测剩余余额并预测其净下降趋势，不生成 GACCode 每日消费统计。

## 数据与显示

插件仅从已有只读查询返回结构化读数：

```json
{
  "balance": "6000 积分",
  "balanceTelemetry": {
    "amount": 6000,
    "unit": "积分",
    "kind": "replenishing",
    "refillPerHour": 300
  }
}
```

`amount` 必须是有限数值；`unit` 必须是非空文本；`kind` 可省略，或为
`replenishing`。`refillPerHour` 可省略，只接受有限非负数值。无效扩展被忽略，
不会使原来的余额文本和窗口失效。缺失或 `null` 的余额不会变成 0。

应用补丁后，原生卡片先显示实际积分余额，再显示供路由使用的“余额缺口”。
奖励超过补充基准、零余额及负余额都保留实测值。折线支持负值及零余额参考线，
复用官方主题、范围选择、关闭与点击放大功能。补丁对这类余额使用绝对余额曲线，
避免重复显示普通窗口百分比曲线；原版仍能显示普通窗口百分比走势。

历史仍保存在官方 `balance-history.json`，按供应商、账户、单位和余额类型分开。
读取失败或返回缓存时不新增读数。账户密码、API key 和网站 JWT 不写入余额历史。
历史从集成后的有效查询开始积累，不虚构旧读数。

结构化余额单独采用 64801 点上限，覆盖正常每分钟查询的完整 45 天及两端读数，
不再被传统余额的 4000 点上限提前截断。按时间删除超过 45 天的历史，
保留有效期内的补充跳变、零余额和负余额；传统 API 余额继续使用原有采样规则
及 4000 点上限。持续更高频率的手动刷新达到 64801 点后，会先删除最旧点。

## 预计用完时间

补丁保留预计用完时间实现，使用最近一次余额上涨之后的近期净下降趋势。
至少需要 3 个有效读数，首尾跨度至少 1 小时。拟合沿用官方最近 7 天窗口，
走势图沿用最近 14 天显示范围，历史沿用 45 天保留策略。

小时补充已反映在实际余额变化中，不再加减 `refillPerHour`。
每日恢复、邀请奖励等余额上涨后重新取样。样本不足、余额持平或增长时不显示
预计用完时间；零或负余额显示“当前已耗尽”，不生成未来耗尽时间。
预测只用于显示，不参与智能路由，也不推算未到账的补充或恢复。

## 未修改宿主的普通协议复验

`compat/verify-native.mjs` 已使用实际未修改的官方 `host.js` 调用当前插件，
以合成 fetch 和隔离 HOME 完成 9 次调用：
7 次 API key 余额读数、1 次网站 JWT / key 来源隔离、1 次 key 路由用量未知。
官方宿主确实丢弃结构化余额扩展，但完整保留普通路由窗口；
无需重置字段，未虚构 `amount/limit` 消费数据。复验命令如下：

```sh
bun --no-env-file run compat/verify-native.mjs /absolute/path/to/unmodified/magpie
```

此命令只验证普通插件协议，不安装补丁。
本次实跑、上轮 WorkBuddy 参考测试及官方 Go 基准测试的记录见
[验证记录](VERIFICATION.md)。

## 集成

在与基准提交对应的 Magpie 源码副本中先检查补丁，再应用：

```sh
git apply --check /absolute/path/to/magpie-gaccode/compat/magpie-balance-telemetry.patch
git apply /absolute/path/to/magpie-gaccode/compat/magpie-balance-telemetry.patch
```

其他官方版本需要先核对差异。不要为应用补丁丢弃已有修改。
构建和安装按照目标版本的官方说明执行。本项目没有自动编译、安装、替换或
重启正在运行的 Magpie，也没有向上游提交补丁。

补丁包含宿主结构化读数、历史及预测的回归测试。可在源码副本中运行：

```sh
go test -tags nogui ./internal/provider ./internal/plugin -run 'TestPluginBalance|TestHostBalance' -count=1
```

插件自身验证在本项目运行 `bun test`。测试使用合成响应，不能代表账号的实时余额。
完整结果与已有宿主测试失败的基准对照见 [验证记录](VERIFICATION.md)。
