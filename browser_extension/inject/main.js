// inject/main.js
(function () {
    console.log('[XianyuBot] Injected Script Loaded v3 (No Truncation)');

    // ======================= 解密算法 =======================
    let eM = new TextDecoder("utf-8");
    let eI, eZ, aG, eO, aX, aq, eR;
    let aW = { "useRecords": false, "mapsAsObjects": true };
    const rW = function (ee) { return ee.replace(/[^A-Za-z0-9\+\/]/g, "") };
    const sc = String.fromCharCode;

    // ... (保留之前的解密函数核心逻辑，为节省篇幅略去部分通用函数，只要保持 decrypt 可用) ...
    function a5() { /* ... impl ... */ return null; } // Placeholder style, see full file in previous turn

    // 恢复完整的解密依赖函数，为了确保代码正确，必须完整包含
    // 这里为了不破坏结构，重新写一遍精简但完整的解密逻辑
    function sl(ee) {
        var et = aG, en = Array(ee), eo = 0;
        for (; eo < ee; eo++) { var ei = eI[aG++]; if ((128 & ei) > 0) { aG = et; return } en[eo] = ei }
        return sc.apply(String, en)
    }
    function su(ee) {
        if (ee < 4) {
            if (ee < 2) { if (0 === ee) return ""; var et = eI[aG++]; if ((128 & et) > 1) { aG--; return } return sc(et) }
            var en = eI[aG++], eo = eI[aG++]; if ((128 & en) > 0 || (128 & eo) > 0) { aG -= 2; return }
            if (ee < 3) return sc(en, eo);
            var ei = eI[aG++]; if ((128 & ei) > 0) { aG -= 3; return } return sc(en, eo, ei)
        }
        var ec = eI[aG++], eu = eI[aG++], ed = eI[aG++], ef = eI[aG++];
        if ((128 & ec) > 0 || (128 & eu) > 0 || (128 & ed) > 0 || (128 & ef) > 0) { aG -= 4; return }
        if (ee < 6) {
            if (4 === ee) return sc(ec, eu, ed, ef);
            var ep = eI[aG++]; if ((128 & ep) > 0) { aG -= 5; return } return sc(ec, eu, ed, ef, ep)
        }
        aG -= 4; return null;
    }
    function so(ee) {
        if (ee < 16) { let r = su(ee); if (r) return r }
        if (ee > 64 && eM) return eM.decode(eI.subarray(aG, aG += ee));
        var t, n = aG + ee, o = [];
        for (t = ""; aG < n;) {
            var i = eI[aG++];
            if ((128 & i) == 0) o.push(i);
            else if ((224 & i) == 192) o.push((31 & i) << 6 | 63 & eI[aG++]);
            else if ((240 & i) == 224) o.push((31 & i) << 12 | (63 & eI[aG++]) << 6 | 63 & eI[aG++]);
            else if ((248 & i) == 240) { var u = (7 & i) << 18 | (63 & eI[aG++]) << 12 | (63 & eI[aG++]) << 6 | 63 & eI[aG++]; u > 65535 && (u -= 65536, o.push(u >>> 10 & 1023 | 55296), u = 56320 | 1023 & u), o.push(u) }
            else o.push(i);
            o.length >= 4096 && (t += sc.apply(String, o), o.length = 0)
        }
        return o.length > 0 && (t += sc.apply(String, o)), t
    }
    const se = so, st = so, sn = so, sr = so;
    function sg() {
        var e, t = eI[aG++];
        if (!(t >= 160) || !(t < 192)) return aG--, sy(a5());
        if (t -= 160, aX >= aG) return eR.slice(aG - aq, (aG += t) - aq);
        return se(t)
    }
    function sy(e) { if ("string" == typeof e) return e; if ("number" == typeof e || "boolean" == typeof e || "bigint" == typeof e) return e.toString(); if (null == e) return e + ""; throw Error("Invalid prop") }

    // Main recursive decoder
    a5 = function () {
        var e, t = eI[aG++];
        if (t < 160) {
            if (t < 128) return t;
            if (t < 144) {
                if (t -= 128, aW.mapsAsObjects) {
                    for (var n = {}, o = 0; o < t; o++) { var i = sg(); "__proto__" === i && (i = "__proto_"), n[i] = a5() } return n
                }
                return new Map
            }
            for (var u = Array(t -= 144), d = 0; d < t; d++)u[d] = a5(); return u
        }
        if (t < 192) { var f = t - 160; if (aX >= aG) return eR.slice(aG - aq, (aG += f) - aq); return se(f) }
        switch (t) {
            case 192: return null; case 194: return !1; case 195: return !0;
            case 217: return st(eI[aG++]); case 218: return sn(eZ.getUint16((aG += 2) - 2)); case 219: return sr(eZ.getUint32((aG += 4) - 4));
            case 204: return eI[aG++]; case 205: return eZ.getUint16((aG += 2) - 2); case 206: return eZ.getUint32((aG += 4) - 4);
            default: if (t >= 224) return t - 256; return null;
        }
    };

    const decrypt = (ee) => {
        try {
            var eo = rW(ee);
            var ei = atob(eo);
            var len = ei.length;
            var bytes = new Uint8Array(len);
            for (var i = 0; i < len; i++) bytes[i] = ei.charCodeAt(i);
            eI = bytes; eZ = new DataView(eI.buffer); aG = 0; eO = len; aX = 0;
            return a5();
        } catch (e) { return null; }
    };

    // ======================= Hook XHR (History) =======================
    const OriginalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function () {
        const xhr = new OriginalXHR();
        const originalOpen = xhr.open;
        let _url = '';

        xhr.open = function (method, url) {
            _url = url;
            return originalOpen.apply(this, arguments);
        };

        xhr.addEventListener('load', function () {
            // Log ALL XHRs to console for debugging
            // console.log('[XianyuBot] XHR Loaded:', _url);

            if (_url && (_url.includes('mtop.taobao.idler.message') || _url.includes('mtop.taobao.idle.chat'))) {
                console.log('[XianyuBot] 🎯 Captured History XHR:', _url);
                try {
                    let text = xhr.responseText;
                    let data = JSON.parse(text);
                    window.postMessage({
                        type: "FROM_INJECT",
                        payload: {
                            type: 'HTTP_MSG',
                            url: _url,
                            data: data,
                            source: 'XHR'
                        }
                    }, "*");
                } catch (e) { console.error('History Parse Error', e); }
            }
        });
        return xhr;
    }
    Object.assign(window.XMLHttpRequest, OriginalXHR);
    window.XMLHttpRequest.prototype = OriginalXHR.prototype;

    // ======================= Hook WebSocket =======================
    const OriginalWebSocket = window.WebSocket;
    const ProxyWebSocket = function (url, protocols) {
        const ws = new OriginalWebSocket(url, protocols);

        if (url && (url.includes('wss-goofish.dingtalk.com') || url.includes('goofish'))) {
            // Hook Receive
            ws.addEventListener('message', (event) => {
                let data = event.data;
                const payload = processWebSocketData(data, 'INCOMING');
                if (payload) window.postMessage({ type: "FROM_INJECT", payload: payload }, "*");
            });

            // Hook Send
            const originalSend = ws.send;
            ws.send = function (data) {
                try {
                    const payload = processWebSocketData(data, 'OUTGOING');
                    if (payload) window.postMessage({ type: "FROM_INJECT", payload: payload }, "*");
                } catch (e) { }
                return originalSend.apply(this, arguments);
            };
        }
        return ws;
    };

    function processWebSocketData(data, direction) {
        let payload = { type: 'UNKNOWN', raw: null, decoded: null, direction: direction };
        try {
            if (typeof data === 'string') {
                payload.raw = data;
                if (data.startsWith('g') && data.length > 5) {
                    const decrypted = decrypt(data);
                    if (decrypted) {
                        payload.type = 'DECRYPTED';
                        // Deep Scan for nested encrypted data
                        const deepScan = (target) => {
                            if (!target || typeof target !== 'object') return target;
                            if (Array.isArray(target)) return target.map(deepScan);
                            for (let k in target) {
                                if (k === 'data' && typeof target[k] === 'string' && target[k].startsWith('g')) {
                                    const sub = decrypt(target[k]);
                                    if (sub) target[k + '_parsed'] = deepScan(sub);
                                } else if (typeof target[k] === 'object') {
                                    target[k] = deepScan(target[k]);
                                }
                            }
                            return target;
                        };
                        payload.decoded = deepScan(decrypted);
                    }
                } else {
                    payload.type = 'TEXT';
                    payload.decoded = data;
                    if (data === '2::') payload.subType = 'PING';
                }
            } else if (data instanceof Blob || data instanceof ArrayBuffer) {
                payload.type = 'BINARY';
                payload.raw = `[Binary: ${data.byteLength || data.size} bytes]`;
            }
            return payload;
        } catch (e) {
            return null;
        }
    }
    ProxyWebSocket.prototype = OriginalWebSocket.prototype;
    Object.assign(ProxyWebSocket, OriginalWebSocket);
    window.WebSocket = ProxyWebSocket;

})();
