# React 18.3.1 verification runtime

Unmodified production UMD files from the official npm packages `react@18.3.1` and `react-dom@18.3.1` (MIT). Both licenses are retained here.

The official Qishui secondary verification UMD requires the host globals `ucSecondVerifyReact` and `ucSecondVerifyReactDom`, including the legacy `render` / `unmountComponentAtNode` APIs. The native login helper injects these local files before the verification script; no extra CDN is contacted for React.

Sources:
- https://registry.npmjs.org/react/-/react-18.3.1.tgz
- https://registry.npmjs.org/react-dom/-/react-dom-18.3.1.tgz

SHA-256 of bundled files:

```text
d949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd  react.production.min.js
52412d7bc7ce4157ea628bbaacb8829e0a9cb3c58f57f99176126bc8cf2bfc85  LICENSE-react
35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d  react-dom.production.min.js
52412d7bc7ce4157ea628bbaacb8829e0a9cb3c58f57f99176126bc8cf2bfc85  LICENSE-react-dom
```
