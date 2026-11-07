# MyGO 汽水音乐插件

为 [MyGO Music](https://github.com/egoist/mygo-music) 接入汽水音乐，使用汽水音乐 App 扫码登录，支持搜索、歌单、推荐、电台、播放历史与歌手主页。

**1.0.8** 将扫码登录、音乐目录和播放授权请求迁入 MyGO 插件沙箱，以原生辅助程序替代 Node。安装包不再包含 Node，也无需 Chrome、Edge 或自行安装 FFmpeg 等运行环境。

## 安装与升级

需要 **MyGO 0.1.20 或更新版本**。

| 系统 | Release 安装包 | 验证情况 |
| --- | --- | --- |
| macOS Apple Silicon | `plugin-darwin-arm64.zip` | 已完成 macOS 本机原生组件、音频夹具及宿主自动化验证 |
| Windows 10/11 x64 | `plugin-windows-amd64.zip` | 实验性支持；已交叉构建、静态检查和验证宿主安装 |

[一键安装](mygo-music://install-plugin?repo=lane128/mygo-music-qishui)，或在 MyGO「设置 → 插件 → +」中输入仓库地址：

```text
https://github.com/lane128/mygo-music-qishui
```

**通过仓库链接安装或检查更新时，MyGO 会根据系统和 CPU 架构自动选择对应 ZIP，无需手动选择。** 也可以从 [Releases](https://github.com/lane128/mygo-music-qishui/releases/latest) 下载上表对应的运行包，再从 MyGO 插件设置导入 ZIP。GitHub 自动生成的 `Source code` 归档不包含完整运行组件，请勿作为安装包导入。

已通过仓库安装的用户，可在插件菜单中「检查更新」。ZIP 导入显示「来自本机」，无法通过仓库检查更新；如需切换为仓库安装，可先移除插件再输入仓库地址，MyGO 会保留插件数据。1.0.8 保持原插件 ID 和登录态格式；会话过期时重新扫码即可。

暂不提供 Intel Mac、Windows ARM64 或 x32/386 包。官方 MyGO 没有 32 位 Windows 宿主，Windows ARM64 的签名组件尚未适配。

也可以在 [MyGO 插件目录](https://music.egoist.dev/zh/plugins) 查找此插件，目录更新可能有索引延迟。

## 1.0.8 更新

- **无需浏览器登录**：扫码申请、确认、登录态恢复和退出由 MyGO 插件沙箱处理，无需填写 Cookie 或程序路径。
- **移除 Node 运行依赖**：目录处理与请求迁入沙箱，包内 Go 辅助程序和小型 C++ 签名器处理原生任务；同时移除内置封面图片，精简 Windows 音频组件。
- **新增 Windows x64 实验包**：与 macOS 分别打包，依赖和许可证随包提供；不要求使用者另装运行环境。
- **补齐播放历史上报**：歌曲成功开始播放后，向汽水追加最近播放记录；宿主缓存命中后的播放也会记录，预加载不记录。历史详情页使用第一首歌曲的官方封面，侧栏保持默认图标。
- **新增歌手主页**：点击歌曲列表或正在播放页的歌手名，可查看官方头像、名称和热门单曲；合唱中的各位歌手可分别跳转。

## 登录与权限

点击「登录」，用汽水音乐 App 扫码并在手机上确认。登录态保存在 MyGO 插件存储中，兼容此前版本。

扫码、搜索、个人歌单列表、普通歌单内容、歌手主页和公开歌词不启动辅助程序。部分首页、推荐、电台、历史及播放请求需要调用包内原生签名器；授权音频处理和本机播放服务也由辅助程序执行，因此 MyGO 会显示启动辅助程序的权限申请，这是正常播放所需的权限。歌手资料与公开歌词请求不携带账号 Cookie。

退出、换号或取消会停止相关任务。遇到汽水限流或额外验证时会停止并提示，不自动绕过，也不切回浏览器登录。

## 功能

- 扫码登录、账号资料、登录态恢复和退出；已确认的会员等级显示为 `VIP · 昵称` 或 `SVIP · 昵称`。
- 首页展示最多 15 张官方图片探索卡片，通过「查看全部」进入听歌模式页；个人歌单保留在侧栏，支持完整歌曲列表与空歌单。
- 歌曲搜索、歌词、歌手主页；歌手页展示官方热门单曲，无歌手 ID 的署名保持普通文字。
- 「推荐」提供播放推荐、熟悉、新鲜三个选项，支持持续续歌和切换下一首。
- 「听歌模式」使用官方图片、名称与介绍；电台持续取歌，歌单打开真实歌曲列表。常用模式默认显示 8 个，「查看全部」浏览更多场景；探索区底部「换一批」打开下一批页面，支持前进、后退。
- 侧栏「历史播放」展示账号最近播放记录，最多 1000 首；成功开始播放后通过官方接口追加历史。
- 播放当前账号获准的音频，支持音质选择与进度拖动。AAC 会转换为 MyGO 支持的格式，保留来源音质等级。

## 使用说明与限制

播放历史只记录歌曲开始播放，不提交收听时长、完成率或听歌次数统计。暂停后继续由宿主去重，重新播放可以再次记录；上报失败不会中断音频，不自动重试。**历史详情不是实时刷新**：通常需距上次加载超过 30 秒后重新进入页面。尚未用真实账号确认官方服务端历史入库，协议、验证与边界见 [播放历史说明](PLAYBACK-HISTORY.md)。

本插件遵循当前账号的试听、会员和地区授权；仅获准试听的歌曲会提示播放不可用。暂不支持歌曲点赞、歌单编辑、专辑页、歌手搜索或关注歌手。歌手主页的热门单曲不代表完整曲库。

歌曲、歌单、歌手和听歌模式直接使用官方 HTTPS 图片 URL，插件不内置或重新着色封面。历史详情使用第一首歌的封面，空历史或首歌缺图时由宿主默认显示；侧栏入口保持默认图标。部分官方模式图标为白色透明图，在 MyGO 浅色主题中对比度较低。卡片布局、比例、字体及列表缓存由 MyGO 统一管理；本项目只实现插件功能，不修改宿主。

Windows 原生签名、AppContainer 隔离、音频转换和实际播放仍待 Windows 实机验证。macOS 真实下载后的 Gatekeeper 行为、手机确认、真实账号授权播放和音频设备出声同样需要人工验收；自动化夹具通过不代表这些步骤均已完成。验证范围见 [验证记录](VALIDATION.md)。

## 开发与验证

开发需要 Node 20+、npm 和 Go 1.27+；Node、esbuild 与 fflate 仅用于开发构建和测试，安装后不需要。

```sh
npm ci
npm run build
npm test
npm run test:native
```

修改 `src/plugin.mjs` 与共享模块后运行构建，生成宿主入口 `index.js`。`npm test` 检查入口与源码同步，执行 JavaScript 回归、实际原生进程 IPC 和 Go 单元测试；`test:native` 执行 Go race 检查。

### 运行包与验证包

每次打包生成运行 ZIP 和独立的 `-validation.zip`。运行包包含完整运行组件、许可证、对应源码和构建输入，不带图片、测试程序或验证工具。验证包包含相同运行代码，并增加测试与夹具，可独立解压验证。

**正式 Release 仅上传两个平台的运行 ZIP。** MyGO 按文件名中的平台与架构选择附件，不排除 `-validation.zip`，因此验证 ZIP 保留作开发验证，不能与运行 ZIP 混放在用于自动安装的 Release 中。公开源码保留验证工具和构建方式。

源码测试会明确跳过缺少官方原生组件的检查。完整原生回归先构建并解压对应验证包，将 `QISHUI_NATIVE_ROOT` 设为解压目录的绝对路径。macOS 可直接运行 `test/native-worker.test -test.v -test.timeout=5m`，无需 Node 或 Go 工具链。`bdms.node` 是官方原生动态组件的文件名，不表示安装包包含 Node 解释器。

### 构建安装包

macOS arm64 需要 Xcode 命令行工具。设置 `QISHUI_NATIVE_DIR` 指向已核验的官方 3.7.0 原生组件目录，再运行 `npm run package`。macOS AAC 转换使用系统 AudioToolbox。

Windows x64 交叉打包固定使用 macOS arm64、Xcode 命令行工具、`xz` 和 Zig 0.15.2。按 `scripts/ffmpeg-config.mjs` 下载固定源码和工具链归档，运行：

```sh
npm run build:ffmpeg -- /absolute/new/audio /absolute/source.tar.gz /absolute/zig.tar.xz
npm run prepare:windows -- /absolute/new/runtime-directory /absolute/new/audio
```

设置 `QISHUI_WINDOWS_ASSETS` 指向准备好的运行组件目录，`QISHUI_ZIG` 指向 Zig 0.15.2 可执行文件，再运行 `npm run package -- --target windows-amd64`。所有外部输入先校验哈希。音频源码也可使用包内 `FFMPEG-SOURCE.tar.xz` 离线重建；精简 FFmpeg 只保留 AAC/FLAC、必要 PCM 与重采样，不含网络、视频和设备支持，完整对应源码及许可证随包提供。这些路径和工具只用于开发，插件使用者无需配置。

### Windows 验证

在 Windows 上将自行构建的 `-validation.zip` 解压到新目录，运行 `scripts/verify-windows.cmd`。它使用包内独立 Go 测试程序和 FFmpeg，不需要 Node 或 Go，检查隔离、进程生命周期、签名和音频夹具；不读取账号存储，不替代手机扫码、真实账号授权播放和音频设备出声验收。

开发者也可运行 `node scripts/verify-windows.mjs` 生成验证报告；其他系统可用 `node scripts/verify-windows.mjs --check /extracted/package` 静态检查 Windows 包，静态检查不等同于 Windows 执行。

Windows 临时目录必须位于支持 ACL 的本地 NTFS 卷，隔离不可用时失败，不降级普通执行。正常取消或退出会终止子进程并清理目录与 AppContainer；直接强杀启动器时该次 profile 可能残留，详见 [启动器说明](native/windows-runner/README)。

## 许可

插件源码采用 AGPL-3.0-only；本项目为独立插件，不代表汽水音乐或 MyGO 官方。运行组件、协议和图片的来源与许可见 [NOTICE.md](NOTICE.md)。
