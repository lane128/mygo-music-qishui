# macOS verification helper

The normal host HTTP login remains in `src/plugin.mjs`. After a passport 2046 response, macOS starts this isolated helper and asks the user to scan a fresh QR code. The helper owns that QR, cookies, security SDK and official verification callback together. It returns a bounded private JSON line; the plugin checks the account API before replacing the stored session. Existing account credentials never enter this process.

The API root can be decoded as **GB18030** by WebKit. Its external UTF-8 verification script then raises a syntax error before exporting `ucWebSecondVerify`. `LoadHTML` supplies an explicit UTF-8 document at the original API origin, and script loaders also specify UTF-8. This protects later scripts created by the official component too.

`go test -race ./...` checks embedded source and session-cookie validation. The repository's `npm test` and `npm run test:native` include this module.

For the actual WebKit/official-SDK regression, copy `test/native_login_webkit.go.txt` from the repository root to `native/login/qa_webkit.go`, build with `go -C native/login build -tags loginqa -o /absolute/temporary/login-qa .`, then remove the copied file. Start the QA binary with `QISHUI_LOGIN_QA_REPORT` set to a private absolute JSON report path and keep its stdin open after sending this synthetic frame:

```json
{"type":"start","device":{"schema":1,"aid":386088,"did":"1234567890123456","iid":"123456789012345","clientVersion":"3.7.0"},"computerName":"MyGo QA","timeoutMs":30000}
```

The QA build skips QR creation and account login. It loads the public official verification script, checks UTF-8, the API origin and its exported entry point, then closes the window. A successful report has `"passed":true`; a closed/cancelled stdout frame is expected after the QA window closes. This check needs macOS and network access. The test tag is not used by production builds.

Adapted login-window code and browser integration are AGPL-3.0-only; see the root `NOTICE.md`, `LICENSE`, `licenses/`, and the pinned React asset provenance in `page/vendor/react-18.3.1/README.md`.
