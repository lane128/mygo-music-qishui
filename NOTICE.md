# 来源与许可

本插件的扫码协议、浏览器会话和逐跳请求检查参考并移植自用户本地项目 `mygo-cloudmusic`：

- `internal/qishui/client.go`
- `internal/qishui/passport.go`
- `internal/qishui/session.go`
- `internal/qishui/browser.mjs`
- `internal/qishui/browser_guard.mjs`
- `internal/qishui/catalog.go`、`pc.go`、`feed.go`、`stream.go`、`quality.go`、`audio_redirect.go`
- `internal/qishui/native.go`、`resource.cjs`

该项目提供的许可为 GNU AGPL v3。本插件按 AGPL-3.0-only 提供，完整文本见 `LICENSE`。保留原项目及相关贡献者的权利。

MyGO 插件规范来自 https://github.com/egoist/mygo-music 。本项目为独立插件，不代表汽水音乐或 MyGO 官方。

`sdk-glue.js`、`bdms.js` 为外部官方安全组件，不属于本项目 AGPL 授权范围，其权利归原权利人所有。完整 ZIP 从兼容环境中按固定哈希复制这两个未修改的文件，保留其内容及版权信息；Git 跟踪的源码不包含这些组件，也不复制官方客户端的账号凭据。

组件参考来源：`sodahub-org/libresoda` 的 `tools/qishui-signer/security`，版本 `5edd2ff3b825f0a16b1e281204822ee06842df9c`。其中 `bdms.js` 已与官方 CDN 的 `web/stable/1.0.0.41/bdms.js` 核对为相同文件；来源及哈希见原项目 `scripts/qishui-probe/README.md` 和本项目构建器。

播放使用未修改的官方 macOS arm64 3.7.0 `bdms.node`、`libMetaSecML.dylib`。它们不属于本项目 AGPL 授权范围，权利归原权利人所有。来源为官方发行包：

https://lf-luna-release.qishui.com/obj/luna-release/3.7.0/452316191/SodaMusic-v3.7.0-official-darwin_arm64.tgz

发行包 SHA-256：`40c6bc80aa32cd1d5c76ad1b05bccc67e5ec22cf779b6dc3617ee5432b88ee04`。构建器还校验两个原生文件各自的 SHA-256。组件只用于当前账号的请求签名，在禁止网络和持久写入的独立进程中运行；音频只读取服务器同次授权返回的资源和匹配授权信息。

`audio-convert` 由本项目 `helper/audio-convert.c` 编译，使用 macOS AudioToolbox 将已授权 AAC 转换为 MyGO 支持的 FLAC 容器，不将有损来源标记成无损音质。

完整 ZIP 附带 Node 可执行文件及 `bin/NODE-LICENSE`，其中包含 Node 及其第三方依赖的许可声明。Node 的权利归其贡献者及相关权利人所有。

Playwright Core 按其 Apache-2.0 许可使用；完整 ZIP 包含该发行包及其 `LICENSE`、`NOTICE` 等原有文件。不捆绑 Chrome，使用本机已安装的浏览器。
