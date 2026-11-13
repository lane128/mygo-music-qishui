# MyGo Music 汽水音乐插件

简体中文 | [English](README.en.md)

在 [MyGo Music](https://github.com/egoist/mygo-music) 中使用汽水音乐，搜索和播放歌曲，浏览推荐、歌手与专辑，管理自己的音乐库。

使用汽水音乐 App 扫码登录，提供 macOS 与 Windows 安装包。

[下载安装](https://github.com/lane128/mygo-music-qishui/releases/latest) · [版本更新](https://github.com/lane128/mygo-music-qishui/releases) · [问题反馈](https://github.com/lane128/mygo-music-qishui/issues)

如果这个插件对你有帮助，欢迎给[本项目](https://github.com/lane128/mygo-music-qishui)点个 ⭐ Star，支持后续更新，也让更多人发现它。

## 功能

| 功能 | 支持内容 |
| --- | --- |
| 账号 | 扫码登录、登录态恢复、退出登录、账号资料与 VIP / SVIP 等级显示、我的主页 |
| 搜索 | 歌曲、歌手、专辑、歌单分类搜索，以及搜索建议 |
| 歌单 | 浏览歌单详情与歌曲列表，显示歌单创建者 |
| 音乐发现 | 首页探索、个性化推荐、熟悉 / 新鲜推荐、听歌模式与电台续播 |
| 播放与下载 | 标准 / 高音质 / 无损选择、进度拖动，通过 MyGo Music 下载可播放的歌曲；M4A / FLAC 直出 |
| 歌词 | 行歌词、官方逐字歌词与中文翻译；没有逐字时间时显示行歌词 |
| 歌手与专辑 | 歌手完整单曲与专辑列表、歌手关注 / 取消关注、专辑详情与收藏 / 取消收藏 |
| 我的音乐库 | 歌曲喜欢 / 取消喜欢、我喜欢的歌曲、收藏歌单、收藏专辑、最近播放 |
| 歌单管理 | 创建、改名和删除自己的普通歌单，添加 / 移除歌曲，上移 / 下移歌曲顺序 |
| 评论 | 查看评论与分页、点赞 / 取消点赞、发送一级评论 |
| 分享 | 从歌曲菜单复制汽水音乐官方分享链接 |

关注、喜欢、收藏及歌单编辑使用当前登录的汽水账号。歌单管理仅适用于自己拥有且允许编辑的普通歌单。

## 安装

需要 **MyGo Music 0.1.20 或更新版本**。

### 通过仓库安装

在已安装 MyGo Music 的电脑上，把下面的链接粘贴到浏览器地址栏并回车，会唤起 MyGo Music，打开插件设置并开始下载，确认后完成安装：

```text
mygo-music://install-plugin?repo=lane128/mygo-music-qishui
```

也可以直接在 MyGo Music「设置 → 插件 → +」中输入仓库地址：

```text
https://github.com/lane128/mygo-music-qishui
```

GitHub 会去掉自定义协议（`mygo-music://`）的链接，所以上面以文本提供，复制后使用；浏览器可能先询问是否允许打开 MyGo Music。MyGo Music 会根据系统与 CPU 架构自动选择安装包。后续可在插件菜单中「检查更新」。

> **网络提示**：安装和更新时 MyGo Music 会直接从 GitHub 下载安装包。网络访问 GitHub 较慢或超时时，可能长时间停在「更新中」或最终失败；这种情况建议让 MyGo Music 走全局代理（例如 TUN 模式），或从 [最新 Release](https://github.com/lane128/mygo-music-qishui/releases/latest) 手动下载 ZIP 导入。

### 手动导入 ZIP

从 [最新 Release](https://github.com/lane128/mygo-music-qishui/releases/latest) 下载对应安装包，在 MyGo Music 插件设置中导入：

| 设备 | 安装包 | 系统要求 |
| --- | --- | --- |
| Apple Silicon Mac（M 系列） | `plugin-darwin-arm64.zip` | macOS 13+ |
| Intel Mac | `plugin-darwin-amd64.zip` | macOS 13+ |
| Intel / AMD Windows 电脑 | `plugin-windows-amd64.zip` | Windows 10 / 11 x64 |
| ARM Windows 电脑 | `plugin-windows-arm64.zip` | Windows 11 ARM64，支持 x64 转译 |

## 登录与使用

扫码遇到额外验证（2046）时，macOS 与 Windows 都会打开独立的临时验证窗口。请在新窗口重新扫码，并手动完成官方安全验证。验证窗口使用 UTF-8 文档加载官方组件；账号接口确认新会话有效后才保存登录态，关闭窗口或验证失败会保留原账号。

验证窗口源码在 `native/login`，macOS 使用系统 WebKit，Windows 使用 WebView2（MyGo Music 界面本身运行在 WebView2 上，无需另装），均无需另装 Node 或浏览器。构建会将对应架构的验证程序一并打包。

安装后点击「登录」，使用汽水音乐 App 扫码，并在手机上确认。登录态由 MyGo Music 插件存储保存，失效后重新扫码即可。

- 从「首页」「推荐」和「听歌模式」发现音乐，也可以直接搜索歌曲、歌手、专辑或歌单。
- 点击歌曲的歌手署名进入歌手页，查看单曲与专辑，或关注歌手。
- 在侧栏查看自己的歌单、收藏专辑和历史播放；通过账号菜单打开「我的主页」。
- 在歌曲、专辑和歌单的菜单中使用喜欢、收藏、下载、分享及歌单编辑功能。

部分请求和播放需要包内辅助程序，MyGo Music 提示运行权限时请按需允许。遇到会话失效、限流或额外验证时，插件会提示并停止相关操作。

## 音质与播放

插件按 MyGo Music 的三个音质档位选择汽水音源：

| MyGo Music 音质 | 音源选择顺序 | 播放格式 |
| --- | --- | --- |
| 标准 | `higher` | AAC-LC M4A |
| 高音质 | `highest` → `higher` | AAC-LC M4A |
| 无损 | `lossless` → `highest` → `higher` | 原生 FLAC，回退时为 M4A |

AAC-LC 解密后以 M4A 直接交给 MyGo Music，原生 FLAC 保持直出，不再通过 FFmpeg 转换。M4A 不代表无损；发生音源回退时，按实际来源音质交给宿主。

所有档位均排除 `medium`。歌曲能否播放取决于当前账号的会员、地区与官方授权；仅有试听授权、没有可用音源或格式尚不支持时，会提示播放不可用。选择「无损」不保证每首歌曲都提供无损音源。

## 使用说明

- **歌词与翻译**：仅显示官方提供的内容，没有可靠逐字时间时保留行歌词，没有翻译时不生成翻译。
- **历史播放**：记录歌曲开始播放，不统计完整收听时长；列表最多展示 1000 首，重新进入页面后可能需要等待缓存刷新。
- **评论与音乐库编辑**：操作会影响真实汽水账号。发送评论或编辑超时后，先刷新确认结果，再决定是否重试。
- **歌单排序**：修改前会核对当前顺序；如果其他客户端正在编辑同一歌单，建议刷新后再操作。
- **功能边界**：暂不支持播客、远程设备控制、评论回复与删除，以及音源增益 / 峰值元数据。

新增账号写入的真实服务端行为、完整试听及部分平台实机仍有待验收项目，具体范围见 [验证记录](VALIDATION.md)。功能进展见 [功能待办](TODO.md)。

## 问题反馈

遇到问题可在 [Issues](https://github.com/lane128/mygo-music-qishui/issues) 提供：

- 系统版本、CPU 架构、MyGo Music 与插件版本。
- 复现步骤；歌曲或页面问题可附汽水音乐分享链接。
- 必要的截图或已脱敏错误信息。

请勿提交 Cookie、二维码令牌或其他登录凭据。需要回退时，可从 [历史版本](https://github.com/lane128/mygo-music-qishui/releases) 下载对应架构的运行包重新导入；回退不会撤销已经写入汽水账号的操作。

## 开发

需要 Node 20+、npm 和 Go 1.27+：

```sh
npm ci
npm run build
npm test
npm run test:native
```

原生构建还需要对应平台的官方组件及工具链。安装包构建、验证和发布见 [发布流程](RELEASE.md)；原生隔离说明见 [Windows 启动器说明](native/windows-runner/README)。运行包包含对应源码和许可证，独立验证包留作开发验证，不作为正式 Release 安装附件。

## 许可

插件源码采用 [AGPL-3.0-only](LICENSE)。本项目为独立插件，不代表汽水音乐或 MyGo Music 官方。

第三方组件及资源的来源与许可见 [NOTICE.md](NOTICE.md)。
