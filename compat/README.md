# 可选绝对余额走势

本目录包含 Magpie 宿主补丁 `magpie-balance-telemetry.patch`，基于官方提交
`e66fa165930ff0693d1ee8065727c29c7631d8f4`。普通窗口的百分比走势和路由
无需此补丁；绝对积分曲线及预计用完时间需要宿主接收下列扩展：

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

`amount` 必须是有限数值，`unit` 必须是非空文本；`kind` 可省略或为
`replenishing`，`refillPerHour` 可省略或为有限非负数。无效扩展被忽略，
不影响普通窗口和余额文本；缺失或 `null` 的余额不会变成零。

补丁复用官方余额曲线、主题、范围选择和点击放大，保留超额积分、零值及负值。
历史从接入后的有效读数开始积累，按供应商、账户、单位和余额类型分别保存
在 `balance-history.json`；失败、缓存及旧读数不新增历史点。
结构化余额按 45 天及 64801 点上限保留，支持正常每分钟采样的完整保留期；
更高频采样超过点数上限时删除最旧点。传统余额保留原有采样规则和 4000 点上限。

走势图显示最近 14 天，预测使用最近一次余额上涨后、最近 7 天内的净下降读数。
至少需要 3 点且跨度不少于 1 小时；持平、增长或样本不足时不显示预测，
零或负余额显示“当前已耗尽”。小时补充已计入实际余额，不再额外加减速率。
预测只用于显示，不参与路由，也不代表累计消费。

## 集成

在与基准提交对应的 Magpie 源码副本中检查并应用补丁：

```sh
git apply --check /absolute/path/to/magpie-gaccode/compat/magpie-balance-telemetry.patch
git apply /absolute/path/to/magpie-gaccode/compat/magpie-balance-telemetry.patch
```

其他版本需先核对差异。构建和安装按目标版本的官方说明执行。
插件不会自动应用补丁、替换或重启 Magpie。

## 验证

在插件源码目录运行普通协议复验，参数为未修改的 Magpie 源码目录：

```sh
bun --no-env-file run compat/verify-native.mjs /absolute/path/to/unmodified/magpie
```

脚本使用合成响应和隔离 HOME，检查 7 次余额变化、网站与 key 来源隔离、
未知路由用量共 9 次调用，不安装补丁。插件测试使用 `bun --no-env-file test`。

应用补丁后，在 Magpie 源码副本中运行宿主及余额历史的相关测试：

```sh
go test -tags nogui ./internal/provider ./internal/plugin -run 'TestPluginBalance|TestHostBalance|TestBalanceHistory|TestBalanceTrend' -count=1 -timeout=120s
```
