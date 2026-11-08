# 来源与许可

本插件的扫码协议、会话解析和音乐接口参考并移植自用户本地项目 `mygo-cloudmusic`：

- `internal/qishui/client.go`
- `internal/qishui/passport.go`
- `internal/qishui/session.go`
- `internal/qishui/catalog.go`、`pc.go`、`feed.go`、`stream.go`、`quality.go`、`audio_redirect.go`
- `internal/qishui/native.go`、`resource.cjs`

该项目提供的许可为 GNU AGPL v3。本插件按 AGPL-3.0-only 提供，完整文本见 `LICENSE`。保留原项目及相关贡献者的权利。

MyGO 插件规范来自 https://github.com/egoist/mygo-music 。本项目为独立插件，不代表汽水音乐或 MyGO 官方。

扫码登录、目录网络请求和目录数据处理通过 MyGO JavaScript 沙箱与宿主 HTTP 接口执行。开发构建使用 MIT 许可的 esbuild 生成独立 `index.js`；安装后的插件不加载 esbuild，也不附带其可执行文件。当前源码与完整 ZIP 不包含 Chromium、Playwright、`sdk-glue.js` 或浏览器版 `bdms.js`，不复制官方客户端的账号凭据。

播放使用未修改的官方 macOS arm64 3.7.0 `bdms.node`、`libMetaSecML.dylib`。它们不属于本项目 AGPL 授权范围，权利归原权利人所有。来源为官方发行包：

https://lf-luna-release.qishui.com/obj/luna-release/3.7.0/452316191/SodaMusic-v3.7.0-official-darwin_arm64.tgz

发行包 SHA-256：`40c6bc80aa32cd1d5c76ad1b05bccc67e5ec22cf779b6dc3617ee5432b88ee04`。构建器还校验两个原生文件各自的 SHA-256。组件只用于当前账号的请求签名，在禁止网络和持久写入的独立进程中运行；音频只读取服务器同次授权返回的资源和匹配授权信息。

插件不附带封面图片，不下载后重新着色或按分类替换官方图片。歌曲、歌单、歌手和听歌模式直接向 MyGO 提供官方接口返回的 HTTPS 图片 URL，图片权利归原权利人。歌手主页参考官方 `GetArtistDetail`：公开 GET `/luna/pc/artists/{artist_id}`，不携带账号 Cookie、不调用签名辅助程序，读取 `artist_info`，并通过公开 `/tracks`、`/albums` 列表读取完整分页单曲和专辑，不请求用户关系或改动账号关注。历史详情页使用最近历史列表第一首歌曲的官方封面 URL，不生成或附带图片；历史为空或第一首歌缺图时交给宿主默认显示，侧栏入口保持默认图标且不额外读取历史。成功播放后的最近历史追加接口参考官方客户端 `AppendRecentlyPlayedMedia` 调用，只提交当前歌曲的类型和 ID，不上传虚构收听时长或完成率；不复制官方 JavaScript 实现，协议依据见 `PLAYBACK-HISTORY.md`。

当前未发布的 macOS 测试构建改用随包附带的精简 FFmpeg，将已授权 AAC 转换为 24 位 FLAC，替代存在满幅样本溢出问题的 AudioToolbox 转换器。插件继续返回实际来源音质等级；AAC 转为 FLAC 不会恢复有损压缩已丢失的信息。单音轨 M4A 仅在无编辑列表且 `iTunSMPB` 与媒体时钟信息完整一致时，显式处理编码延迟和尾部填充，不按歌曲标称时长裁剪。

自 1.0.8 起，安装包使用本项目 Go 辅助程序与 C++ 签名器，不包含 Node 可执行文件或 JavaScript 引擎。签名器仅实现官方组件本次调用所需的 N-API 子集，不是通用 Node/N-API 运行环境。构建使用的四份官方 N-API 头文件及来源校验记录保存在 `native/signer/include`，其中 `NODE-LICENSE` 保留 Node 项目与相关贡献者的许可声明。Go 辅助程序仅使用标准库，Go 运行库许可保留为 `runtime/native/GO-LICENSE`。Windows 签名器静态链接的 C++ 标准库使用 Zig 0.15.2 工具链中的 LLVM libc++/libc++abi/展开支持；相关完整许可及固定校验记录保留在 `native/signer/licenses`，包括 Apache-2.0 with LLVM Exceptions 和历史许可声明。两个原生程序的来源与哈希记录在 `NATIVE-BUILD.json`，源码和构建配方随包提供。macOS 签名器使用本地 ad hoc 签名，不宣称 Apple 公证；官方 SDK 文件保持原样。

Windows x64 实验性安装包使用官方 3.7.0 更新包中的未修改 `bdms.node` 和 `metasecml.dll`，来源为 https://lf-luna-release.qishui.com/obj/luna-release/3.7.0/452316191/SodaMusic-v3.7.0-official-win32_x64.tgz ，归档 SHA-256 为 `30fe7762ccdb3c978cd51f8ca4696aed5e8cad876d7bfc20b25168d4cd2d40ac`。原生组件权利仍归原权利人，不属于本项目 AGPL 授权。Windows 组件分别校验哈希，调用约定经官方发行包的源码映射核对；不使用官方客户端的账号、Cookie、注册表账号存储或设备序列号。

macOS 测试包与 Windows 包均附带本项目从固定源码构建的 FFmpeg 8.1.2 音频专用版本。macOS 使用 Apple clang 构建，Windows 使用下述固定交叉工具链，不使用 Gyan 通用构建。FFmpeg 来源为官方提交 https://github.com/FFmpeg/FFmpeg/commit/38b88335f99e76ed89ff3c93f877fdefce736c13 ，构建启用 GPLv3 或更新版本授权。包内 `runtime/native/FFMPEG-LICENSE`、`FFMPEG-README.txt` 和 `FFMPEG-BUILD.json` 保留许可证、完整配置、固定源码及工具链输入与输出校验值；完整对应源码随包保存在 `FFMPEG-SOURCE.tar.xz`，构建配方为 `scripts/build-ffmpeg.mjs` 与 `scripts/ffmpeg-config.mjs`。GitHub 源码归档缺少的 `VERSION` 由配方生成，编解码源码不修改。Windows 使用 Zig 0.15.2 的 MinGW 工具链交叉编译，相关许可保留为 `MINGW-LICENSE`、`ZIG-LICENSE`，对应 CRT 源码、头文件及逐文件许可完整保留在 `WINDOWS-CRT-SOURCE.tar.xz`。FFmpeg 不含第三方编解码库、视频编解码、网络或音频设备支持；仅将获准 AAC（含 HE-AAC/HE-AACv2）解码为 24 位 FLAC，并保留独立验证所需的 PCM 输出，不将有损来源标成无损，也不新增有损编码。固定资产校验值见 `scripts/runtime-assets.mjs`。

Windows 隔离启动器由本项目 `native/windows-runner` 编译，使用 Go 标准库及 BSD-3-Clause 许可的 `golang.org/x/sys v0.48.0`；包内保留 `runtime/native/GO-LICENSE` 与 `X-SYS-LICENSE`，以及启动器对应源码和模块锁定文件。可独立执行的测试程序和测试源码仅进入独立验证包。每次任务创建无网络 capability 的 AppContainer，临时目录以外的私有账号文件不授予访问，Job Object 管理子进程；不降低为未隔离执行。静态交叉编译和源码审查不等同于 Windows 隔离实测。

构建另外使用 MIT 许可的 `fflate 0.8.3` 处理 ZIP；与 esbuild 一样，它只用于开发构建，不是插件运行依赖。验证包中的 `test/fixtures/aac-lc.m4a` 为 48kHz 单声道短正弦波；新增 AAC-LC/HE-AAC/HE-AACv2 的 M4A、ADTS 夹具由 `scripts/build-audio-fixtures.mjs` 将 44.1kHz 双声道短正弦波编码而来。满幅与瞬态回归夹具由 `test/fixtures/audio-signals.mjs` 生成的双声道多频信号编码，覆盖解码正峰超过满幅的边界。它们均不含歌曲或账号数据，只进入验证包。
