# MyGO 汽水音乐插件

为 [MyGO Music](https://github.com/egoist/mygo-music) 接入汽水音乐，使用汽水音乐 App 扫码登录。

**1.0.1** 已接入个人歌单、歌曲搜索、推荐、歌词和播放。

## 安装

目前支持 **macOS Apple Silicon**，登录需要本机已安装 Google Chrome、Chromium 或 Microsoft Edge。

[一键安装](mygo-music://install-plugin?repo=lane128/mygo-music-qishui)，或任选一种方式：

- 在 MyGO「设置 → 插件 → +」中输入仓库地址：`https://github.com/lane128/mygo-music-qishui`。
- 从 [Releases](https://github.com/lane128/mygo-music-qishui/releases/latest) 下载 `plugin-darwin-arm64.zip`，在上述入口选择 ZIP 导入。

通过仓库安装后，可在插件菜单中「检查更新」。ZIP 导入显示「来自本机」，需先移除插件，再通过仓库安装以启用更新；MyGO 会保留插件数据。

也可以在 [MyGO 插件目录](https://music.egoist.dev/zh/plugins) 查找此插件；新发布的仓库需要等待 GitHub 索引。

## 登录

安装后允许插件启动辅助程序，点击「登录」，用汽水音乐 App 扫码并在手机上确认。

安装包已包含辅助程序及运行依赖，浏览器需预先安装。插件自动识别浏览器，无需填写路径或其他配置。

## 功能

- 扫码登录、账号资料、登录态恢复和退出。
- 首页显示个人歌单，打开歌单可浏览完整歌曲列表。
- 歌曲搜索、推荐歌曲和歌词。
- 使用当前账号获准的音频播放，支持音质选择和进度拖动。

播放依赖已包含在 ZIP 中。AAC 会转换为 MyGO 支持的格式，音质标识保留来源等级；仅获准试听的歌曲会提示播放不可用。暂不支持歌曲点赞、歌单编辑、专辑和歌手搜索。

## 许可

插件源码采用 AGPL-3.0，运行时及第三方组件说明见 [NOTICE.md](NOTICE.md)。
