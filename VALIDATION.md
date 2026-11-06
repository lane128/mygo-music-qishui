# 验证记录

日期：2026-11-07。1.0.0 本机测试环境：macOS arm64、Node.js 24.15.0、Chrome 156.0.8078.81、Playwright Core 1.65.0。

## 1.0.0 完整 ZIP

- 插件 manifest 不声明任何设置，登录和账号恢复不读取 `host.setting`。单元测试将设置访问替换为抛错，正常流程仍通过。
- ZIP 自带 `bin/node-darwin-arm64`、Node 许可、Playwright Core 发行包及许可、两个固定 SHA-256 的登录 SDK 文件。
- `QISHUI_CHROMIUM_PATH=... npm test`：20 项全部通过，无跳过。包括三项真实 Chrome 回归测试，以及自动查找浏览器和相对插件目录解析运行时资源的测试。
- 从 ZIP 解压到独立临时目录，清除 `PLAYWRIGHT_CORE`、`QISHUI_SECURITY_DIR`、`QISHUI_CHROMIUM_PATH`，并将 PATH 设为 `/usr/bin:/bin`。通过解压目录中的 Node 运行预检，签名二维码申请及同一会话连续三次签名轮询均通过；不依赖开发目录或系统 Node。
- 使用解压后的插件，在 MyGO Music 的真实 `internal/plugin` / moejs 中验证加载、QR 回调、进程管道、会话保存、重新加载恢复及退出登录，全部通过。
- 使用 MyGO 自己的 ZIP 安装入口执行导入与安装，验证安装后的包内 Node 可执行，Playwright 和两个 SDK 可直接加载，不需要用户配置。
- 独立 worktree 审查后修正了构建器中 Node/Go 的 x86 架构命名差异和 Windows 的 Node 许可文件位置。当前实际运行验收范围仍为 macOS arm64。
- 相同真实宿主中，使用实际 helper 和包内 SDK，清除上述环境变量并限制 PATH 后，二维码可到达宿主回调；主动退出登录后进程结束，未保存账号凭据。
- 缺少 SDK 时，真实 helper 向宿主返回 `setup` 错误。未找到浏览器时单独返回可理解的安装提示，不要求输入路径。
- 真实 Chrome 本地测试：307/308 逐跳拦截、Passport 签名缺失阻止发送、关闭清理 profile、启动期间取消并清理 profile，均通过。

测试使用的 MyGO 上游 main SHA 为 `b63b59d0d520067eb34234ec72164f55a974a8af`。真实宿主测试保存在 `test/host_integration_test.go`，需要复制到独立 MyGO 源码检出的 `internal/plugin` 包运行；`QISHUI_PLUGIN_DIR` 指向完整 ZIP 的解压目录。

## 尚需人工验收

本次没有进行手机扫码确认，没有读取或复用旧项目保存的账号凭据。以下流程仍需在 MyGO 界面中操作：

1. 导入 1.0.0 完整 ZIP 后不出现四个路径输入项，允许启动辅助程序后可点击登录。
2. 汽水音乐 App 识别二维码，并允许确认授权。
3. 手机确认后 MyGO 显示真实账号昵称及头像。
4. 重启后识别同一账号，退出登录后回到未登录状态。

自动测试中的确认和账号恢复使用测试响应，不作为真实账号登录成功的证据。实际 SDK 的预检只证明申请和轮询链路。

1.0.0 为初始版本，只包含账号登录能力。安装应使用 GitHub Release 中的完整 ZIP；源码归档不包含运行时。
