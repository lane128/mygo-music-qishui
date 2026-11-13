# 来源与许可

本插件的扫码协议、会话解析和音乐接口参考并移植自用户本地项目 `mygo-cloudmusic`：

- `internal/qishui/client.go`
- `internal/qishui/passport.go`
- `internal/qishui/session.go`
- `internal/qishui/catalog.go`、`pc.go`、`feed.go`、`stream.go`、`quality.go`、`audio_redirect.go`、`commerce.go`
- `internal/qishui/native.go`、`resource.cjs`

该项目提供的许可为 GNU AGPL v3。本插件按 AGPL-3.0-only 提供，完整文本见 `LICENSE`。保留原项目及相关贡献者的权利。

MyGO 插件规范来自 https://github.com/egoist/mygo-music 。本项目为独立插件，不代表汽水音乐或 MyGO 官方。

扫码登录、目录网络请求和目录数据处理通过 MyGO JavaScript 沙箱与宿主 HTTP 接口执行。开发构建使用 MIT 许可的 esbuild 生成独立 `index.js`；安装后的插件不加载 esbuild，也不附带其可执行文件。当前源码与完整 ZIP 不包含 Chromium、Playwright、`sdk-glue.js` 或浏览器版 `bdms.js`，不复制官方客户端的账号凭据。

播放使用未修改的官方 macOS arm64 3.7.0 `bdms.node`、`libMetaSecML.dylib`。它们不属于本项目 AGPL 授权范围，权利归原权利人所有。来源为官方发行包：

https://lf-luna-release.qishui.com/obj/luna-release/3.7.0/452316191/SodaMusic-v3.7.0-official-darwin_arm64.tgz

发行包 SHA-256：`40c6bc80aa32cd1d5c76ad1b05bccc67e5ec22cf779b6dc3617ee5432b88ee04`。构建器还校验两个原生文件各自的 SHA-256。组件只用于当前账号的请求签名，在禁止网络和持久写入的独立进程中运行；音频只读取服务器同次授权返回的资源和匹配授权信息。

Intel macOS 构建使用官方 3.7.0 x64 更新包中未修改的 `bdms.node` 和 `libMetaSecML.dylib`：https://lf-luna-release.qishui.com/obj/luna-release/3.7.0/452316191/SodaMusic-v3.7.0-official-darwin_x64.tgz 。归档 SHA-256：`6da004452e20ba719fac5f393d70f09073d3fa908f536ca0c9877d823bac328b`；两个文件各自的校验值见 `scripts/runtime-assets.mjs`，来源随包记录在 `runtime/native/SOURCES.json`。`bdms.node` 为 x86_64，动态库保留官方 universal 内容；不修改官方签名。适用同样的组件权利、账号授权和进程隔离边界。

插件不附带封面图片，不下载后重新着色或按分类替换官方图片。歌曲、歌单、歌手和听歌模式直接向 MyGO 提供官方接口返回的 HTTPS 图片 URL，图片权利归原权利人。歌手主页参考官方 `GetArtistDetail`：公开 GET `/luna/pc/artists/{artist_id}`，不携带账号 Cookie、不调用签名辅助程序，读取 `artist_info`，并通过公开 `/tracks`、`/albums` 列表读取完整分页单曲和专辑，不请求用户关系或改动账号关注。历史详情页使用最近历史列表第一首歌曲的官方封面 URL，不生成或附带图片；历史为空或第一首歌缺图时交给宿主默认显示，侧栏入口保持默认图标且不额外读取历史。成功播放后的最近历史追加接口参考官方客户端 `AppendRecentlyPlayedMedia` 调用，只提交当前歌曲的类型和 ID，不上传虚构收听时长或完成率；不复制官方 JavaScript 实现，协议依据见 `PLAYBACK-HISTORY.md`。

会员资料与评论等级的协议字段只读核对官方客户端公开程序资源：账号使用 commerce 的 `membership.is_membership` / `membership_type`，评论使用 `user.vip_stage`。插件自行实现等级解析并使用名称文字前缀，不复制官方会员徽标、客户端 JavaScript 或私人账号数据。

当前源码的运行时不再随包附带 FFmpeg，也不再调用 AAC 转 FLAC 转换。M4A 由共享便携解析器 `helper/m4a.mjs` 与原生 `native/worker/m4a.go` 校验后按原字节传递；插件继续返回实际来源音质等级，不把有损来源标成无损。离线 FFmpeg 音频构建、参考工具、测试和夹具仍保留在源码或验证包中，仅用于诊断与对照，不进入运行包，也不是插件运行依赖。

自 1.0.8 起，安装包使用本项目 Go 辅助程序与 C++ 签名器，不包含 Node 可执行文件或 JavaScript 引擎。签名器仅实现官方组件本次调用所需的 N-API 子集，不是通用 Node/N-API 运行环境。构建使用的四份官方 N-API 头文件及来源校验记录保存在 `native/signer/include`，其中 `NODE-LICENSE` 保留 Node 项目与相关贡献者的许可声明。Go 辅助程序仅使用标准库，Go 运行库许可保留为 `runtime/native/GO-LICENSE`。Windows 签名器静态链接的 C++ 标准库使用 Zig 0.15.2 工具链中的 LLVM libc++/libc++abi/展开支持；相关完整许可及固定校验记录保留在 `native/signer/licenses`，包括 Apache-2.0 with LLVM Exceptions 和历史许可声明。两个原生程序的来源与哈希记录在 `NATIVE-BUILD.json`，源码和构建配方随包提供。macOS 签名器使用本地 ad hoc 签名，不宣称 Apple 公证；官方 SDK 文件保持原样。

Windows x64 实验性安装包使用官方 3.7.0 更新包中的未修改 `bdms.node` 和 `metasecml.dll`，来源为 https://lf-luna-release.qishui.com/obj/luna-release/3.7.0/452316191/SodaMusic-v3.7.0-official-win32_x64.tgz ，归档 SHA-256 为 `30fe7762ccdb3c978cd51f8ca4696aed5e8cad876d7bfc20b25168d4cd2d40ac`。原生组件权利仍归原权利人，不属于本项目 AGPL 授权。Windows 组件分别校验哈希，调用约定经官方发行包的源码映射核对；不使用官方客户端的账号、Cookie、注册表账号存储或设备序列号。

Windows ARM64 构建使用 ARM64 Go worker 和 ARM64 AppContainer 启动器，官方签名组件和 C++ 签名器保持 x64，在独立子进程中通过 Windows 11 x64 转译执行；不在 ARM64 进程中加载 x64 DLL。组件来源与上面的 Windows x64 构建相同，仍逐文件固定哈希，隔离不可用时失败，不降级普通执行。此组合尚需 Windows 11 ARM64 实机验收。

运行包不再附带 FFmpeg 可执行文件、其许可证或对应源码。源码中保留可选的离线 FFmpeg 构建/参考工具 `scripts/build-ffmpeg.mjs`、`scripts/ffmpeg-config.mjs` 及诊断测试夹具；这些内容如进入交付物，只放在验证包，不属于插件运行依赖。若离线构建，FFmpeg 来源仍为官方提交 https://github.com/FFmpeg/FFmpeg/commit/38b88335f99e76ed89ff3c93f877fdefce736c13 ，构建启用 GPLv3 或更新版本授权。Windows 交叉构建使用 Zig 0.15.2 的 MinGW 工具链。运行包不包含 `FFMPEG-*`、`MINGW-LICENSE`、`ZIG-LICENSE` 或 `WINDOWS-CRT-SOURCE.tar.xz`。

Windows 隔离启动器由本项目 `native/windows-runner` 编译，使用 Go 标准库及 BSD-3-Clause 许可的 `golang.org/x/sys v0.48.0`；包内保留 `runtime/native/GO-LICENSE` 与 `X-SYS-LICENSE`，以及启动器对应源码和模块锁定文件。可独立执行的测试程序和测试源码仅进入独立验证包。每次任务创建无网络 capability 的 AppContainer，临时目录以外的私有账号文件不授予访问，Job Object 管理子进程；不降低为未隔离执行。静态交叉编译和源码审查不等同于 Windows 隔离实测。

构建另外使用 MIT 许可的 `fflate 0.8.3` 处理 ZIP；与 esbuild 一样，它只用于开发构建，不是插件运行依赖。验证包中的 `test/fixtures/aac-lc.m4a` 为 48kHz 单声道短正弦波；新增 AAC-LC/HE-AAC/HE-AACv2 的 M4A、ADTS 夹具由 `scripts/build-audio-fixtures.mjs` 将 44.1kHz 双声道短正弦波编码而来。满幅与瞬态回归夹具由 `test/fixtures/audio-signals.mjs` 生成的双声道多频信号编码，覆盖解码正峰超过满幅的边界。它们均不含歌曲或账号数据，只进入验证包。
# macOS 登录验证窗口

`native/login` 的窗口、临时会话及官方验证衔接改编自 https://github.com/yiyiSmallti/mygo-qishui/tree/53ef5fef00df1422f8f58eceeabc820efce8741f 的 `login-helper` 与 `qishui-account` 登录实现（AGPL v3；原来源声明随源码保留）。页面资源嵌入对应架构的独立可执行文件，使用 UTF-8 初始化文档，并要求明确确认后才接受新会话。浏览器环境收集器的汽水官方组件来源说明保留在文件头。

本组件使用 MyGo（MIT）、purego（Apache-2.0）、Go x/* 与 rsc.io/qr（BSD），以及官方 npm React/ReactDOM 18.3.1 未修改的 production UMD（MIT）；相关许可证随 `native/login` 源码保留。仅加载官方验证组件，由使用者完成验证，不跳过服务端检查。
