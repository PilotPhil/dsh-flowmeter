# dsh-flowmeter · 模型流速

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的输入框统计行（`conversation.composer.dock`）加一枚实时读数：**输出速度（tok/s）· 最近十秒速度柱状图 · 首字延迟（TTFT）**。

它**接管官方那枚「输出速度」统计格**（同 id `activity`、同 `order: 0`、更低 `priority: -1`），因此：

- 读数排在整行最前面，在「缓存命中」与上下文占用之前；
- 官方那枚「整步平均速度」不再重复显示，一行里只有一个速度数；
- 「缓存命中」与上下文占用两枚保持原样。

> 代价：详细模式（`ui-chat.performanceUsage: detailed`）下，原 `activity` 格里的轮次/步骤计数与「模型耗时/工具耗时/首字」浮层会一并被替换；简洁模式（本机默认）本来就只看速度，没有损失。

## 显示什么

```
▁▂▄▆▇▅▃▂  实时 42.6 tok/s  · 首字 0.62s  · 均速 38.1 tok/s
```

柱状图打头，实时速度紧随其后并冠以「实时」二字；不加图标，整枚读数为单一品牌蓝。

| 读数 | 含义 |
|---|---|
| 实时速度 | 最近 1.2 秒滑动窗口的 tok/s，来自真实的 `agent/assistant-stream` 分片，不是整步平均 |
| 柱状图 | 每桶 400ms、共 24 桶（约 9.6 秒），最新一桶按时长折算，右侧不会假装掉速 |
| 首字 | 本步 `step/start` → 第一个 token 的墙钟时间；还没出字时显示已等待的秒数并带省略号 |
| 均速 | 本步解码速度 = 累计 token ÷ 首字后时长（口径同 [dsh-tps-ttft](https://github.com/oldzhang82/dsh-tps-ttft) 的 `decodeTokens / (decodeMs / 1000)`）；生成期间用估算值累加，`assistant/message` 落到精确 `outputTokens` 后收敛为精确值，**等首字与空闲时沿用最近一步，一直显示** |

均速只要跑过一步就一直挂着：生成中是这一步的滚动均速，落盘后是该步精确值，空档里保留上一次的读数 —— 不会"生成一停就消失"。

一轮结束后读数留在原地并变淡：实时速度归 0（这一拍确实没有在出字），首字与均速保持该步的值。悬停可看完整读数（实时、本步 token 数、整步计速提示）。

没有在解码、也没有可回看的一步时不占位，所以新会话的输入框不会多出一个 0。

## 设置

在「插件」页里打开本插件的那一页，描述下方就是它的设置面板（`plugins.bundle.config`，按包名 keyed）：

| 项 | 可选值 | 说明 |
|---|---|---|
| 配色 | 默认 / 蓝 / 青 / 紫 / 橙 / 绿 / 灰 / 自定义 | 数字、标签、图表、分隔符统一用一种颜色；「默认」跟随主题的品牌色，自定义是系统取色器 |
| 图表 | 柱状图 / 曲线图 | 两者用同一组 400ms 分桶与同一套归一化，只是画法不同 |

偏好存在浏览器 `localStorage`（键 `dsh-flowmeter:settings`），**改完立即生效，不需要重启**：读数与设置面板订阅同一个内存 store，任一窗口改动会同时刷新两处。换机器不同步 —— 这是纯显示偏好，没有写进 profile。

## 工作方式

- **Host**（`index.js`）：订阅 `agent/assistant-stream`（实时分片，带高精度时间戳）与 `session/event`（`step/start`、`assistant/message`、`tool/call`、`turn/end`），为每个会话维护**有界**的滑动窗口 + 环形桶，并通过 `ctx.webServer` 注册只读端点 `/dsh-flowmeter/state.json`。
- **Client**（`client.js`）：在 `conversation.composer.dock` 注册一个 React 组件，同源轮询该端点。等首字/出字时 500ms 一次，其余 2.5s 一次，页面不可见时退到慢速；请求失败保留上一帧，不闪。

收尾式串流（整段回复一次性到达）没有可观察的解码窗口，此时读数退回「整步墙钟」计速，并在悬停提示里标注「整步计速」，而不是一直停在 0。

只读观测：不注册投影、不写会话日志、不改模型请求，卸载即净。

## 安装

```sh
dsh plugin --profile <你的 profile> add <本目录的绝对路径>
```

或在「插件」页里以本地目录安装。装完重启 DSH，输入框下方多出一枚读数。

## 兼容性

- DSH `0.2.2-rc.1` 实测可用。
- 纯 JS、无构建步骤、无运行时依赖（Host 只用 `ctx.webServer`，Client 只用 React）。

## License

MIT
