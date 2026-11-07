# 播放历史上报

自 1.0.8 起，插件在 MyGO 成功开始播放歌曲后，调用汽水官方追加最近历史接口。这里只补齐最近播放，不上传收听时长、完成率、推荐反馈或听歌次数统计。尚未进行真实账号写入验收，不能把接口模拟或原生签名成功当作官方服务端实际入库的证明。

## 协议依据

研究对象为已核验官方汽水桌面客户端 3.7.0 的静态代码。发行包 URL 与 SHA-256 见 `NOTICE.md`。没有执行提取出的 JavaScript，也没有读取官方客户端账号存储。

官方契约名为 `AppendRecentlyPlayedMedia`：

```http
POST https://api.qishui.com/luna/pc/me/recently-played-media
Content-Type: application/json; charset=utf-8
```

请求体仅包含：

```json
{"media":[{"type":"track","id":"歌曲 ID"}]}
```

与读取历史的 GET 共用路径，但 POST 不带历史分页参数。登录 Cookie、通用设备和版本参数、正文 MD5 摘要以及官方原生签名沿用现有沙箱传输层；登录用户的 `X-Luna-Is-Local-User` 为 `1`。不会为了上报调用播放授权接口或下载音频。

静态定位：已提取 `regular/main.asar` 的客户端模块 `src/idl/goapi/contract/me.ts` 中，`AppendRecentlyPlayedMediaRequestToRequestData` 仅序列化 `media`；`src/idl/goapi/main.ts` 的同名函数声明 POST 路径。队列的 `reportRecentlyPlayed(key)` 先检查已登录和媒体存在，再提交 `playable.media_type`、`playable.id`。当前媒体 key 变化触发此调用，无收听时长条件。共享请求层解析 JSON；非零 `status_code` 属于失败，不将原始上游错误写入日志。

本轮本地解码证据在 `main-static.js` 的 25742（序列化）、26279（路径）、27540（选择 PC 路径）、27773（登录头）、110056（触发）及 110401（调用）行。提取目录仅为研究输入，不是插件依赖。

## MyGO 接入边界

MyGO 0.1.20 已提供 `played({ id })`，无需修改宿主。宿主在音频成功打开、开始播放后通知插件；从音频缓存开始播放同样会通知，不依赖再次执行 `stream()`。预加载音频不触发它。宿主对同次播放的暂停/继续去重，重新加载播放同一歌曲则可再次通知。

插件沿用当前播放授权支持的 `media_type: track`，校验歌曲 ID 为 1–32 位数字并保持字符串精度。当前插件未支持其他媒体类型的播放；此实现不宣称支持 `ugc_clip` 或视频历史上报。

每个回调只发一次请求，没有自动重试。上报出错会返回经过清理的错误给宿主的后台回调日志，不关闭已保留的音频服务，也不改动播放器队列。退出或换号会取消签名与 HTTP 请求、拒绝旧账号迟到的结果。已经送达服务端的请求无法撤销，客户端不会拿新账号重试旧请求。

官方部分特殊队列会抑制历史追加；MyGO 的回调仅含歌曲 ID，不提供队列来源，因此这里按成功开始播放记录，不复刻官方历史页的队列抑制。宿主也没有向该回调提供进度、结束原因或已收听时长，不能据此实现完整收听统计。

侧栏仍保持默认图标，无额外历史请求。历史详情仍按返回列表第一首歌设置封面；宿主会缓存歌单详情，在距上次加载超过 30 秒后重新进入页面或重新激活窗口时刷新，不保证留在页面时实时变化。

## 自动化验证入口

- `npm test`：包含成功回调与缓存播放模拟、签名 POST 正文/MD5、int64 ID、服务端响应变化后重读、重复播放、预加载无上报、非法 ID、错误清理、限流/验证不重试、退出和换号取消。
- `QISHUI_NATIVE_ROOT=/absolute/extracted/validation node --experimental-vm-modules --test test/worker.test.mjs`：实际包内 Go/C++/官方 SDK 在隔离中生成历史 POST 所需的签名，不输出签名材料，不向官方接口发送请求。
- 将 `test/host_integration_test.go` 复制到隔离官方 MyGO 源码的 `internal/plugin/qishui_external_test.go`，设置 `QISHUI_PLUGIN_DIR`，运行 `go test ./internal/plugin -run '^TestQishuiPluginRuntime$' -count=1`：由真实宿主发现并调用 `played`，通过实际沙箱 HTTP 和原生 IPC 边界验证历史 POST，之后读取变化后的记录。仅替换远端服务与原生签名边界为测试夹具。

Windows 包可进行相同沙箱和安装器检查；macOS 上的交叉编译与安装检查不等同于 Windows 原生执行。各阶段验证结果见 `VALIDATION.md` 以及本地 `dist` 报告。真实账号历史在官方客户端出现、真实播放出声和 Windows 执行仍需实机验收。
