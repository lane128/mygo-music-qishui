// Browser environment collector adapted from public installation resources of Soda Music 3.7.0.
// Original implementations: @byted/uc-browser-sdk 1.2.9 and @byted/account-request 4.2.3.
// This integration wraps the original collector and field encoding; it does not alter reported browser characteristics.
// The supported useBitReport:false option avoids invoking external bitbrowser:// protocol handlers.
// Integration assisted by Cindy (https://cindy.app).
(function () {
'use strict';

// Original source: @byted/uc-browser-sdk 1.2.9 / es/utils/index.js
/* eslint-disable no-loop-func */
/* eslint-disable eqeqeq */
var runPromiseAllSettle = function (promises) {
    return new Promise(function (resolve, reject) {
        if (!Array.isArray(promises)) {
            // resolve([])
            return reject(new Error('promises is not a Array'));
        }
        var resolvedCounter = 0;
        var promiseNum = promises.length;
        if (promiseNum === 0) {
            return resolve([]);
        }
        var resolvedResults = [];
        for (var i = 0; i < promiseNum; i++) {
            Promise.resolve(promises[i]).then(function (value) {
                resolvedCounter++;
                //   console.log(value);
                //   resolvedResults[i] = value;
                resolvedResults.push(value);
                if (resolvedCounter == promiseNum) {
                    return resolve(resolvedResults);
                }
            }, function (reason) {
                resolvedCounter++;
                //   console.log(reason);
                //   resolvedResults[i] = reason;
                if (resolvedCounter == promiseNum) {
                    return resolve(resolvedResults);
                }
            });
        }
    });
};

// Original source: @byted/uc-browser-sdk 1.2.9 / es/plugins/navigator/index.js
// returns the number of logical processors available to run threads on the user's computer.
var getHardwareConcurrency = function () {
    return navigator.hardwareConcurrency;
};
// whether the user agent is controlled by automation.
var getWebdriver = function () {
    return navigator.webdriver || /headless/i.test(navigator.userAgent);
};
var getPlugins = function () {
    var rawPlugins = navigator.plugins;
    if (!rawPlugins) {
        return undefined;
    }
    var plugins = [];
    // Safari 10 doesn't support iterating navigator.plugins with for...of
    for (var i = 0; i < rawPlugins.length; ++i) {
        var plugin = rawPlugins[i];
        if (!plugin) {
            continue;
        }
        var mimeTypes = [];
        for (var j = 0; j < plugin.length; ++j) {
            var mimeType = plugin[j];
            mimeTypes.push({
                type: mimeType.type,
                suffixes: mimeType.suffixes,
            });
        }
        plugins.push({
            name: plugin.name,
            description: plugin.description,
            mimeTypes: mimeTypes,
        });
    }
    return plugins;
};
var getPermissionsStates = function (names) {
    if (!names) {
        return Promise.resolve([]);
    }
    // 数组
    if (Array.isArray(names)) {
        var promises_1 = [];
        names.forEach(function (name) {
            promises_1.push(getPermission(name));
        });
        return runPromiseAllSettle(promises_1);
    }
    return runPromiseAllSettle([getPermission(names)]);
};
var getPermission = function (name) {
    var _a, _b;
    return (_b = (_a = navigator.permissions) === null || _a === void 0 ? void 0 : _a.query({ name: name })) === null || _b === void 0 ? void 0 : _b.then(function (res) {
        return {
            state: res === null || res === void 0 ? void 0 : res.state,
            // @ts-ignore
            name: (res === null || res === void 0 ? void 0 : res.name) || name,
        };
    });
};
// 获取消息通知的权限
var getNotificationPermission = function () {
    if (!('Notification' in window)) {
        return 'none';
    }
    return Notification.permission;
};
// 获取 chromedriver 特征
var getChromedriver = function () {
    var decode = function (codes) { return codes.map(function (code) { return String.fromCharCode.call(null, Number(code)); }).join(''); };
    // 前缀
    var PUBLIC_PREFIX = decode([
        '0x63',
        '0x64',
        '0x63',
        '0x5f',
        '0x61',
        '0x64',
        '0x6f',
        '0x51',
        '0x70',
        '0x6f',
        '0x61',
        '0x73',
        '0x6e',
        '0x66',
        '0x61',
        '0x37',
        '0x36',
        '0x70',
        '0x66',
        '0x63',
        '0x5a',
        '0x4c',
        '0x6d',
        '0x63',
        '0x66',
        '0x6c',
    ]);
    //  构造函数 key
    var CONSTRUCTOR_KEYS = [
        ['0x41', '0x72', '0x72', '0x61', '0x79'],
        ['0x4f', '0x62', '0x6a', '0x65', '0x63', '0x74'],
        ['0x50', '0x72', '0x6f', '0x6d', '0x69', '0x73', '0x65'],
        ['0x50', '0x72', '0x6f', '0x78', '0x79'],
        ['0x53', '0x79', '0x6d', '0x62', '0x6f', '0x6c'],
        ['0x4a', '0x53', '0x4f', '0x4e'],
    ].map(decode);
    var get = function (key) {
        // @ts-ignore
        return window[key];
    };
    var checkPrototype = function (key) {
        var injectedKey = "".concat(PUBLIC_PREFIX, "_").concat(key);
        return Object.prototype.hasOwnProperty.call(window, injectedKey) || get(injectedKey) === get(key);
    };
    for (var i = 0; i < CONSTRUCTOR_KEYS.length; i++) {
        var key = CONSTRUCTOR_KEYS[i];
        if (checkPrototype(key)) {
            return true;
        }
    }
    var PREVIOUS_DRIVER_KEY = decode([
        '0x24',
        '0x63',
        '0x64',
        '0x63',
        '0x5f',
        '0x61',
        '0x73',
        '0x64',
        '0x6a',
        '0x66',
        '0x6c',
        '0x61',
        '0x73',
        '0x75',
        '0x74',
        '0x6f',
        '0x70',
        '0x66',
        '0x68',
        '0x76',
        '0x63',
        '0x5a',
        '0x4c',
        '0x6d',
        '0x63',
        '0x66',
        '0x6c',
        '0x5f',
    ]);
    // 比较古老的 chromedriver 特征
    if (PREVIOUS_DRIVER_KEY in window.document) {
        return true;
    }
    return false;
};
// 获取旧版 headless 特征，比较古老的方式
var getShelldriver = function () {
    try {
        var _a = window.navigator, plugins = _a.plugins, mimeTypes = _a.mimeTypes, language = _a.language, languages = _a.languages;
        if (!language || !Array.isArray(languages) || languages.length === 0) {
            return true;
        }
        if (!plugins || plugins.length === 0) {
            return true;
        }
        if (!mimeTypes || mimeTypes.length === 0) {
            return true;
        }
        // @ts-ignore
        if (plugins[0].__proto__ !== Plugin.prototype || plugins.__proto__ !== PluginArray.prototype) {
            return true;
        }
        // @ts-ignore
        if (plugins[0][Symbol.toStringTag] !== 'Plugin') {
            return true;
        }
    }
    catch (e) {
        return false;
    }
    return false;
};

// Original source: @byted/uc-browser-sdk 1.2.9 / es/plugins/screen/index.js
var getInnerHeight = function () {
    return window.innerHeight;
};
var getInnerWidth = function () {
    return window.innerWidth;
};
var getOuterHeight = function () {
    return window.outerHeight;
};
var getOuterWidth = function () {
    return window.outerWidth;
};

// Original source: @byted/uc-browser-sdk 1.2.9 / es/plugins/webgl/index.js
var cacheContext;
var getWebGLContext = function () {
    var context;
    if (!cacheContext) {
        var canvas = document.createElement('canvas');
        for (var _i = 0, _a = ['webgl', 'experimental-webgl']; _i < _a.length; _i++) {
            var type = _a[_i];
            try {
                context = canvas.getContext(type);
            }
            catch (_b) {
                // Ok, continue
            }
            if (context) {
                break;
            }
        }
        cacheContext = context;
    }
    else {
        context = cacheContext;
    }
    var debugInfo = context === null || context === void 0 ? void 0 : context.getExtension('WEBGL_debug_renderer_info');
    return {
        // 新增采集字段
        vendor: context === null || context === void 0 ? void 0 : context.getParameter(debugInfo === null || debugInfo === void 0 ? void 0 : debugInfo.UNMASKED_VENDOR_WEBGL),
        renderer: context === null || context === void 0 ? void 0 : context.getParameter(debugInfo === null || debugInfo === void 0 ? void 0 : debugInfo.UNMASKED_RENDERER_WEBGL),
        // version: context?.getParameter(context?.VERSION)?.toString() || '',
        // vendor: context?.getParameter(context?.VENDOR)?.toString() || '',
        // renderer: context?.getParameter(context?.RENDERER)?.toString() || '',
    };
};

// Original source: @byted/uc-browser-sdk 1.2.9 / es/plugins/storage/index.js
var getWebStorageSupportStatus = function () {
    return getStorageQuotaStatus().then(function (storageQuotaStatus) {
        return {
            indexedDB: getIDBSupportStatus(),
            localStorage: getLStorageSupportStatus(),
            storageQuotaStatus: storageQuotaStatus,
        };
    });
};
var getIDBSupportStatus = function () {
    var idb = getIDB();
    var isSafari = /(Safari|iPhone|iPad|iPod)/.test(navigator.userAgent) &&
        !/Chrome/.test(navigator.userAgent) &&
        !/BlackBerry/.test(navigator.platform);
    var hasFetch = typeof fetch === 'function' && fetch.toString().indexOf('[native code') !== -1;
    return {
        idb: typeof idb,
        open: idb && typeof idb.open,
        indexedDB: typeof indexedDB,
        IDBKeyRange: typeof IDBKeyRange,
        // @ts-ignore
        openDatabase: typeof openDatabase,
        isSafari: isSafari,
        hasFetch: hasFetch,
    };
};
var getLStorageSupportStatus = function () {
    return {
        isSupportLStorage: isSupportLStorage(window.localStorage),
        size: getLocalStorageSize(),
        write: isValidLStorageWirte(),
    };
};
function getIDB() {
    try {
        if (typeof indexedDB !== 'undefined') {
            return indexedDB;
        }
        // @ts-ignore
        if (typeof webkitIndexedDB !== 'undefined') {
            // @ts-ignore
            return webkitIndexedDB;
        }
        // @ts-ignore
        if (typeof mozIndexedDB !== 'undefined') {
            // @ts-ignore
            return mozIndexedDB;
        }
        // @ts-ignore
        if (typeof OIndexedDB !== 'undefined') {
            // @ts-ignore
            return OIndexedDB;
        }
        // @ts-ignore
        if (typeof msIndexedDB !== 'undefined') {
            // @ts-ignore
            return msIndexedDB;
        }
    }
    catch (e) {
        return;
    }
}
function isSupportLStorage(storage) {
    try {
        var x = '__storage_test__';
        storage.setItem(x, x);
        storage.removeItem(x);
        return true;
    }
    catch (e) {
        return (e instanceof DOMException &&
            (e.code === 22 ||
                e.code === 1014 ||
                e.name === 'QuotaExceededError' ||
                e.name === 'NS_ERROR_DOM_QUOTA_REACHED') &&
            storage.length !== 0);
    }
}
function getLocalStorageSize() {
    var total = 0;
    try {
        for (var key in localStorage) {
            if (localStorage.hasOwnProperty(key)) {
                total += localStorage[key].length;
            }
        }
        var size = total;
        return size;
    }
    catch (e) {
        return -1;
    }
}
function isValidLStorageWirte() {
    var id = '__storage_wirte_test__';
    var defaultValue = '1';
    try {
        localStorage.setItem(id, defaultValue);
        var cacheValue = localStorage.getItem(id);
        localStorage.removeItem(id);
        return cacheValue === defaultValue;
    }
    catch (e) {
        try {
            localStorage.removeItem(id);
        }
        catch (ee) { }
        return false;
    }
}
function getStorageQuotaStatus() {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
        return navigator.storage
            .estimate()
            .then(function (_a) {
            var usage = _a.usage, quota = _a.quota;
            return {
                usage: usage,
                quota: quota,
                isPrivate: quota && quota < 120000000,
            };
        })
            .catch(function () {
            return {};
        });
    }
    return Promise.resolve({});
}

// Original source: @byted/uc-browser-sdk 1.2.9 / es/plugins/performance/index.js
var getTimeOrigin = function () { return performance === null || performance === void 0 ? void 0 : performance.timeOrigin; };
var getUsedJSHeapSize = function () { var _a; return ((_a = performance === null || performance === void 0 ? void 0 : performance.memory) === null || _a === void 0 ? void 0 : _a.usedJSHeapSize) || 'unsupport'; };
var getNavigationTiming = function () {
    var _a, _b, _c, _d, _e;
    var res = ((_a = performance === null || performance === void 0 ? void 0 : performance.getEntries()) === null || _a === void 0 ? void 0 : _a[0]) || {};
    var guleStart = ((_c = (_b = performance.getEntriesByName('script_glue_start')) === null || _b === void 0 ? void 0 : _b[0]) === null || _c === void 0 ? void 0 : _c.startTime) || 'none';
    var guleDuration = ((_e = (_d = performance.getEntriesByName('scriptGlueDuration')) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e.duration) || 'none';
    return {
        decodedBodySize: res === null || res === void 0 ? void 0 : res.decodedBodySize,
        entryType: res === null || res === void 0 ? void 0 : res.entryType,
        initiatorType: res === null || res === void 0 ? void 0 : res.initiatorType,
        name: res === null || res === void 0 ? void 0 : res.name,
        renderBlockingStatus: res === null || res === void 0 ? void 0 : res.renderBlockingStatus,
        serverTiming: ((res === null || res === void 0 ? void 0 : res.serverTiming) || []).map(function (item) { return item.name; }).join(','),
        guleStart: guleStart,
        guleDuration: guleDuration,
    };
};
var getPerformance = function () {
    try {
        return {
            timeOrigin: getTimeOrigin(),
            usedJSHeapSize: getUsedJSHeapSize(),
            navigationTiming: getNavigationTiming(),
        };
    }
    catch (error) {
        return {};
    }
};

// Original source: @byted/uc-browser-sdk 1.2.9 / es/plugins/browser/index.js
var getBitHelper = function () {
    var playFieldDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play');
    return (HTMLMediaElement.prototype.play.name !== 'play' ||
        (playFieldDescriptor && playFieldDescriptor.writable === false) ||
        false);
};
// 全局运行一次
var getBitProtocolPromise = function () {
    // @ts-ignore
    var _cachePromise = window['__p_bh'];
    if (_cachePromise && _cachePromise instanceof Promise) {
        return _cachePromise;
    }
    var promise = Promise.race([
        (function () {
            return new Promise(function (resolve) {
                var iframe = document.createElement('iframe');
                try {
                    iframe.src = 'bitbrowser://cc/';
                    iframe.width = '0';
                    iframe.height = '0';
                    iframe.style.display = 'none';
                    document.body.appendChild(iframe);
                    iframe.onload = function () {
                        try {
                            resolve('true');
                        }
                        catch (error) { }
                    };
                    iframe.onerror = function () {
                        resolve('false');
                    };
                }
                catch (error) {
                    resolve('false');
                }
                finally {
                    // 定时销毁
                    setTimeout(function () {
                        if (document.body.contains(iframe)) {
                            document.body.removeChild(iframe);
                        }
                    }, 1000);
                }
            });
        })(),
        (function () {
            return new Promise(function (resolve) {
                setTimeout(function () {
                    resolve('false');
                }, 200);
            });
        })(),
    ]);
    // @ts-ignore
    window['__p_bh'] = promise;
    return promise;
};
var getBitProtocol = function () {
    var userAgent = navigator.userAgent;
    // avoid mobile app webview crash
    if (userAgent.indexOf('Android') > -1 || userAgent.indexOf('aweme') > -1) {
        return Promise.resolve('false');
    }
    // Electron 运行未知协议时，会加载系统逻辑，跳过
    if (userAgent.indexOf('Electron') > -1) {
        return Promise.resolve('false');
    }
    return getBitProtocolPromise();
};

// Original source: @byted/uc-browser-sdk 1.2.9 / es/index.js
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var getBrowserInfo = function (params) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, useBitReport, hardwareConcurrency, webdriver, chromedriver, shelldriver, allPlugins, plugin_1, _b, stoargeStatus, allPermissions, bitProtocol, permissions_1, innerHeight_1, innerWidth_1, outerHeight_1, outerWidth_1, notificationPermission, performance_1, bitHelper, webglContext, error_1;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                _a = (params || {}).useBitReport, useBitReport = _a === void 0 ? false : _a;
                _c.label = 1;
            case 1:
                _c.trys.push([1, 3, , 4]);
                hardwareConcurrency = getHardwareConcurrency();
                webdriver = getWebdriver();
                chromedriver = getChromedriver();
                shelldriver = getShelldriver();
                allPlugins = getPlugins();
                plugin_1 = [];
                if (allPlugins) {
                    allPlugins.forEach(function (ele) {
                        plugin_1.push(ele.name);
                    });
                }
                return [4 /*yield*/, Promise.all([
                        getWebStorageSupportStatus(),
                        getPermissionsStates(['notifications']),
                        useBitReport ? getBitProtocol() : Promise.resolve(''),
                    ])];
            case 2:
                _b = _c.sent(), stoargeStatus = _b[0], allPermissions = _b[1], bitProtocol = _b[2];
                permissions_1 = [];
                if (allPermissions && Array.isArray(allPermissions)) {
                    allPermissions.forEach(function (ele) {
                        permissions_1.push({ name: (ele === null || ele === void 0 ? void 0 : ele.name) || '', state: (ele === null || ele === void 0 ? void 0 : ele.state) || '' });
                    });
                }
                innerHeight_1 = getInnerHeight();
                innerWidth_1 = getInnerWidth();
                outerHeight_1 = getOuterHeight();
                outerWidth_1 = getOuterWidth();
                notificationPermission = getNotificationPermission();
                performance_1 = getPerformance();
                bitHelper = getBitHelper();
                webglContext = getWebGLContext();
                return [2 /*return*/, {
                        hardwareConcurrency: hardwareConcurrency,
                        // w3c 标准，所有浏览器适用
                        webdriver: webdriver,
                        // chromedriver 特征
                        chromedriver: chromedriver,
                        // 旧版 headless chrome 特征
                        shelldriver: shelldriver,
                        // 调整为仅采集长度
                        plugins: plugin_1.length,
                        permissions: permissions_1,
                        innerHeight: innerHeight_1,
                        innerWidth: innerWidth_1,
                        outerHeight: outerHeight_1,
                        outerWidth: outerWidth_1,
                        // 不再采集
                        // behavior,
                        stoargeStatus: stoargeStatus,
                        // 不再采集
                        webgl: webglContext,
                        notificationPermission: notificationPermission,
                        performance: performance_1,
                        request_host: location === null || location === void 0 ? void 0 : location.host,
                        request_pathname: location === null || location === void 0 ? void 0 : location.pathname,
                        // 特殊浏览器采集
                        browser: {
                            t: String(Date.now()).split('').reverse().join(''),
                            bit_protocol: bitProtocol,
                            bit_helper: bitHelper,
                        },
                    }];
            case 3:
                error_1 = _c.sent();
                console.error(error_1);
                return [2 /*return*/, {}];
            case 4: return [2 /*return*/];
        }
    });
}); };

// Original source: @byted/account-request 4.2.3 / es/utils/index.js
var writeUTF = function (str) {
    var value = str.toString();
    var back = [];
    var code;
    for (var i = 0; i < value.length; i++) {
        code = value.charCodeAt(i);
        if (0x00 <= code && code <= 0x7f) {
            back.push(code);
        }
        else if (0x80 <= code && code <= 0x7ff) {
            back.push(192 | (31 & (code >> 6)));
            back.push(128 | (63 & code));
        }
        else if ((0x800 <= code && code <= 0xd7ff) || (0xe000 <= code && code <= 0xffff)) {
            back.push(224 | (15 & (code >> 12)));
            back.push(128 | (63 & (code >> 6)));
            back.push(128 | (63 & code));
        }
    }
    for (var j = 0; j < back.length; j++) {
        back[j] &= 0xff;
    }
    return back;
};
var encrypt = function (value) {
    var result = [];
    var newCode = [];
    if (value === void 0) {
        return '';
    }
    newCode = writeUTF(value);
    for (var i = 0, length_1 = newCode.length; i < length_1; ++i) {
        result.push((newCode[i] ^ 5).toString(16));
    }
    return result.join('');
};

window.__mygoCollectBrowserInfo = async function () {
  const actualBrowserInfo = await getBrowserInfo({ useBitReport: false });
  return encrypt(JSON.stringify(actualBrowserInfo));
};
})();
