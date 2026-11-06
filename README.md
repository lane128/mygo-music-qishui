# MyGO 汽水音乐插件

为 [MyGO Music](https://github.com/egoist/mygo-music) 添加汽水音乐 App 扫码登录。

## 安装

目前支持 **macOS Apple Silicon**，需要本机已安装 Google Chrome。

[一键安装](mygo-music://install-plugin?repo=lane128/mygo-music-qishui)，或任选一种方式：

- 在 MyGO「设置 → 插件 → +」中输入仓库地址：`https://github.com/lane128/mygo-music-qishui`。
- 从 [Releases](https://github.com/lane128/mygo-music-qishui/releases/latest) 下载 `plugin-darwin-arm64.zip`，在上述入口选择 ZIP 导入。

也可以在 [MyGO 插件目录](https://music.egoist.dev/zh/plugins) 查找此插件；新发布的仓库需要等待 GitHub 索引。

## 登录

安装后允许插件启动辅助程序，点击「登录」，用汽水音乐 App 扫码并在手机上确认。

安装包已包含运行依赖，自动识别本机 Chrome，无需填写路径或其他配置。

## 功能

- 扫码登录并显示账号资料。
- 保存登录态，重启后恢复账号。
- 退出本地登录。

当前仅提供账号登录，尚未接入搜索、歌单和播放。

## 许可

插件源码采用 AGPL-3.0，运行时及第三方组件说明见 [NOTICE.md](NOTICE.md)。
