// toolbar_assistant/background.js

console.log('[XianyuTool] Background Service Worker Loaded (V3.6 - Strategy & Creation)');

// --- Dynamic Header Management ---

let browserHeaders = {
    'User-Agent': navigator.userAgent,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};

chrome.runtime.onMessage.addListener((request) => {
    if (request.type === 'SYNC_HEADERS') {
        browserHeaders = { ...browserHeaders, ...request.headers };
        console.log('[XianyuTool] Headers synchronized from page');
    }
});

function getHeaders(token = null) {
    const headers = {
        'Accept': '*/*',
        'Accept-Language': browserHeaders['Accept-Language'] || 'zh-CN,zh;q=0.9',
        'Origin': 'https://hub.yhs.cn',
        'Referer': 'https://hub.yhs.cn/',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'User-Agent': browserHeaders['User-Agent'],
        'sec-ch-ua-mobile': browserHeaders['User-Agent']?.includes('Mobile') ? '?1' : '?0',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
}

// --- Messaging & Debugging ---

async function logToTab(itemId, message, data = '') {
    console.log(`[BG-LOG][${itemId}] ${message}`, data);
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: "*://*.goofish.com/*" });
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
                type: 'BG_REMOTE_LOG',
                itemId,
                message,
                data
            }).catch(() => { });
        }
    } catch (e) { }
}

// --- Token & Session Helpers ---

async function getAuthTokenFromTabs() {
    try {
        const tabs = await chrome.tabs.query({ url: "*://hub.yhs.cn/*" });
        if (tabs.length === 0) return null;

        const results = await chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            func: () => {
                const keys = ['token', 'Authorization', 'admin_token', 'userInfo', 'token_type'];
                for (const key of keys) {
                    const val = localStorage.getItem(key);
                    if (val) {
                        if (val.startsWith('{')) {
                            try { return JSON.parse(val).token || JSON.parse(val).data?.token; } catch (e) { }
                        }
                        return val;
                    }
                }
                return null;
            }
        });

        const token = results[0]?.result?.replace(/^Bearer\s+/i, '');
        if (token) {
            await chrome.storage.local.set({ 'yhs_token': token });
            return token;
        }
    } catch (e) { console.error('[XianyuTool] Token Sync Error:', e); }
    return null;
}

async function updateSession(itemId, update) {
    const { sessions = {} } = await chrome.storage.local.get(['sessions']);
    sessions[itemId] = { ...(sessions[itemId] || {}), ...update, updated_at: Date.now() };
    await chrome.storage.local.set({ sessions });
}

// --- Order Strategy Logic ---

function calculateOrderStrategy(previewData) {
    const showTime = new Date(previewData.show_time.replace(/-/g, '/')).getTime();
    const now = Date.now();
    const diffMin = (showTime - now) / 60000;

    console.log(`[XianyuTool] Strategy Check: diffMin=${diffMin.toFixed(2)}`);

    if (diffMin < 5) {
        throw new Error('距离开场不足 5 分钟,系统无法保时出票,已拦截下单。');
    }

    // 策略优先级:时间优先,不进行价格对比
    // 1. 特惠放单 (≥40分钟) - 优先级最高
    // 2. 快速放单 (≥20分钟) - 次优先
    // 3. 极速放单 (≥5分钟)  - 兜底方案

    // 策略1: 特惠放单 (时间充足,成本最低)
    if (diffMin >= 40 && Array.isArray(previewData.discount_range) && previewData.discount_range.length > 0) {
        const minRange = Math.min(...previewData.discount_range.map(r => parseFloat(r.range) || 1));
        const estimatedCost = parseFloat((parseFloat(previewData.original_fee) * minRange).toFixed(2));

        if (!isNaN(estimatedCost)) {
            console.log(`[XianyuTool] 选择特惠放单 (时间充足: ${diffMin.toFixed(1)}分钟, 预估成本: ¥${estimatedCost})`);
            return {
                order_type: 0,
                open_quote_price: estimatedCost.toFixed(2),
                premium_price: 1,
                mode_name: '特惠放单',
                // 报价策略: 预估成本 × 1.15 (可手动调整此倍数)
                user_quote: parseFloat((estimatedCost * 1.15).toFixed(2))
            };
        }
    }

    // 策略2: 快速放单 (时间适中)
    if (diffMin >= 20 && previewData.fast_ticket_total_price) {
        const cost = parseFloat(previewData.fast_ticket_total_price);
        if (!isNaN(cost)) {
            console.log(`[XianyuTool] 选择快速放单 (时间: ${diffMin.toFixed(1)}分钟, 成本: ¥${cost})`);
            return {
                order_type: 1,
                open_quote_price: cost.toFixed(2),
                premium_price: 0,
                mode_name: '快速放单',
                user_quote: parseFloat((cost * 1.04).toFixed(2))
            };
        }
    }

    // 策略3: 极速放单 (时间紧急)
    if (diffMin >= 5 && previewData.rapid_ticket_total_price) {
        const cost = parseFloat(previewData.rapid_ticket_total_price);
        if (!isNaN(cost)) {
            console.log(`[XianyuTool] 选择极速放单 (时间紧急: ${diffMin.toFixed(1)}分钟, 成本: ¥${cost})`);
            return {
                order_type: 2,
                open_quote_price: cost.toFixed(2),
                premium_price: 0,
                mode_name: '极速放单',
                user_quote: parseFloat((cost * 1.04).toFixed(2))
            };
        }
    }

    throw new Error('当前剩余时间或平台数据无法匹配任何放单模式');
}

// --- TaskRunner Class ---

class TaskRunner {
    constructor(itemId, token) {
        this.itemId = itemId;
        this.token = token;
        this.rawResponses = {};
    }

    async step(name, action) {
        await logToTab(this.itemId, `Running Step: ${name}...`);
        try {
            const result = await action();
            this.rawResponses[name] = result;
            if (result.code && result.code !== 200) {
                throw new Error(result.msg || `${name} failed with code ${result.code}`);
            }
            return result;
        } catch (e) {
            await logToTab(this.itemId, `Step ${name} FAILED:`, e.message);
            throw e;
        }
    }

    async uploadImage(blob) {
        return this.step('upload', async () => {
            const formData = new FormData();
            formData.append('file', blob, 'screenshot.jpg');
            formData.append('event', 'other');
            formData.append('event_data', Date.now().toString());
            formData.append('rapid_local', '1');

            const resp = await fetch('https://up-hub-img.yinghuasuan.com/api/upload_img', {
                method: 'POST',
                headers: getHeaders(this.token),
                body: formData
            });
            if (resp.status === 401) throw new Error('AUTH_EXPIRED');
            return resp.json();
        });
    }

    async identifyImage(newPath, pod) {
        return this.step('identify', async () => {
            const url = `https://merchant-api.yinghuasuan.com/mer/v1/order/local_imageIdentify?new_path=${newPath}&pod=${pod}`;
            const resp = await fetch(url, { headers: getHeaders(this.token) });
            return resp.json();
        });
    }

    async getSeatInfo(params) {
        return this.step('getSeatInfo', async () => {
            const query = new URLSearchParams(params).toString();
            const url = `https://merchant-api.yinghuasuan.com/mer/v1/order/getSeatInfo?${query}`;
            const resp = await fetch(url, { headers: getHeaders(this.token) });
            return resp.json();
        });
    }

    async previewOrder(params) {
        return this.step('preview', async () => {
            const body = new URLSearchParams(params).toString();
            const resp = await fetch('https://merchant-api.yinghuasuan.com/mer/v1/order/preview', {
                method: 'POST',
                headers: { ...getHeaders(this.token), 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            });
            return resp.json();
        });
    }

    async createOrder(params) {
        return this.step('createOrder', async () => {
            const body = new URLSearchParams({
                ...params,
                accept_change_seat: 1,
                identify: 1,
                mark: params.mark || ''
            }).toString();
            const resp = await fetch('https://merchant-api.yinghuasuan.com/mer/v1/order/create', {
                method: 'POST',
                headers: { ...getHeaders(this.token), 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            });
            return resp.json();
        });
    }

    async interceptOrder(orderSn) {
        return this.step('intercept', async () => {
            const body = new URLSearchParams({ order_sn: orderSn }).toString();
            const resp = await fetch('https://merchant-api.yinghuasuan.com/mer/v1/order/intercept', {
                method: 'POST',
                headers: { ...getHeaders(this.token), 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body
            });
            return resp.json();
        });
    }

    async getOrderDetail(orderSn) {
        return this.step('orderDetail', async () => {
            const url = `https://merchant-api.yinghuasuan.com/mer/v1/order/detail?order_sn=${orderSn}`;
            const resp = await fetch(url, { headers: getHeaders(this.token) });
            return resp.json();
        });
    }
}

// --- Orchestrator ---

async function runOcrPipeline(itemId, imageUrl) {
    let token = (await chrome.storage.local.get(['yhs_token'])).yhs_token;
    if (!token) token = await getAuthTokenFromTabs();
    if (!token) {
        await updateSession(itemId, { status: 'error', last_error: '无法获取令牌，请确保 hub.yhs.cn 已登录' });
        return;
    }

    const runner = new TaskRunner(itemId, token);
    await updateSession(itemId, { status: 'processing', last_error: null, raw_responses: {} });

    try {
        // Step 0: Download
        const imgResp = await fetch(imageUrl, { headers: { ...getHeaders(), 'Referer': 'https://www.goofish.com/' } });
        if (!imgResp.ok) throw new Error(`图片下载失败: ${imgResp.status}`);
        const blob = await imgResp.blob();

        // Step 1: Upload
        const upload = await runner.uploadImage(blob);
        const { new_path, pod } = upload.data;

        // Step 2: Identify
        const idResult = await runner.identifyImage(new_path, pod);
        const { cinema_id, show_id, seat_no, show_type } = idResult.data;

        // Step 3: Seats
        const seatInfo = await runner.getSeatInfo({ cinema_id, show_id, show_type, seat_no });
        const seatIds = seatInfo.data.map(s => s.seatId).join(',');
        const areaIds = seatInfo.data.map(s => s.areaId).join(',');

        // Step 4: Preview
        const preview = await runner.previewOrder({
            show_id, cinema_id, seat_id: seatIds, show_type, area_id: areaIds, mark: ''
        });

        // Step 5: Strategy Calculation
        await logToTab(itemId, 'Step 6: Calculating pricing strategy...');
        const strategy = calculateOrderStrategy(preview.data);
        await logToTab(itemId, 'Strategy Result:', strategy);

        await updateSession(itemId, {
            status: 'success',
            ocr_result: {
                ...preview.data,
                seat_id: seatIds, // Explicitly store for Order Creation
                area_id: areaIds,
                ...strategy
            },
            raw_responses: runner.rawResponses,
            last_error: null
        });
        await logToTab(itemId, '✅ Pipeline Completed Successfully');

    } catch (e) {
        if (e.message === 'AUTH_EXPIRED') {
            const newToken = await getAuthTokenFromTabs();
            if (newToken) return runOcrPipeline(itemId, imageUrl);
        }
        await updateSession(itemId, { status: 'error', last_error: e.message });
        await logToTab(itemId, '❌ Pipeline Fatal Error:', e.message);
    }
}

// --- Message Handlers ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'START_OCR') {
        const { itemId, imageUrl, itemInfo } = request;
        console.log(`[XianyuTool] [START_OCR] Session: ${itemId}`, itemInfo);

        const contextMsg = `Starting OCR for Item[${itemInfo.itemId}] with ${itemInfo.otherName || 'Unknown'}[${itemInfo.otherId}]`;
        logToTab(itemId, contextMsg, imageUrl);

        updateSession(itemId, {
            item_info: itemInfo,
            status: 'processing'
        });
        runOcrPipeline(itemId, imageUrl);
        sendResponse({ started: true });
    }

    if (request.type === 'CREATE_ORDER') {
        const { itemId } = request;
        handleOrderRequest(itemId);
        sendResponse({ received: true });
    }

    if (request.type === 'INTERCEPT_ORDER') {
        const { itemId } = request;
        handleInterceptRequest(itemId);
        sendResponse({ received: true });
    }

    if (request.type === 'QUERY_ORDER_STATUS') {
        const { itemId } = request;
        handleQueryOrderStatus(itemId);
        sendResponse({ received: true });
    }

    if (request.type === 'JUMP_TO_CHAT') {
        const { itemId, otherId } = request;
        handleJumpToChat(itemId, otherId);
        sendResponse({ received: true });
    }
    return true;
});

async function handleJumpToChat(itemId, otherId) {
    const { sessions = {} } = await chrome.storage.local.get(['sessions']);
    const session = sessions[itemId];
    const nickname = session?.item_info?.otherName;

    const tabs = await chrome.tabs.query({ url: "*://*.goofish.com/*" });
    for (const tab of tabs) {
        try {
            // Send a command to the tab to find this conversation and click it
            const res = await chrome.tabs.sendMessage(tab.id, {
                type: 'FIND_AND_CLICK_CONV',
                otherId,
                nickname
            });

            if (res && res.found) {
                chrome.tabs.update(tab.id, { active: true });
                chrome.windows.update(tab.windowId, { focused: true });
                return;
            }
        } catch (e) { }
    }
}

async function handleOrderRequest(sessionId, isRetry = false) {
    const { sessions = {} } = await chrome.storage.local.get(['sessions']);
    const session = sessions[sessionId];
    if (!session || session.status !== 'success') {
        logToTab(sessionId, '❌ 无法下单：会话状态不是 success 或不存在');
        return;
    }

    let token = (await chrome.storage.local.get(['yhs_token'])).yhs_token;
    if (!token) token = await getAuthTokenFromTabs();

    const runner = new TaskRunner(sessionId, token);
    try {
        const res = session.ocr_result;
        const params = {
            show_id: res.show_id,
            cinema_id: res.cinema_id,
            seat_id: res.seat_id,
            show_type: res.show_type,
            area_id: res.area_id,
            order_type: res.order_type,
            open_quote_price: res.open_quote_price,
            // LOOSE EQUAL and parseInt to be safe
            premium_price: (parseInt(res.order_type) == 0) ? 1 : (res.premium_price || 0),
            mark: ''
        };

        await logToTab(sessionId, isRetry ? '⚡ Retrying Order after price sync...' : '🚀 Submitting Order to YHS...', params);
        const orderResult = await runner.createOrder(params);

        // Track History
        const history = session.order_history || [];
        history.push({
            timestamp: Date.now(),
            params,
            response: orderResult,
            is_retry: isRetry
        });
        await updateSession(sessionId, { order_history: history });

        await logToTab(sessionId, '✅ Order Result:', orderResult);

        if (orderResult.code === 200) {
            const orderSn = orderResult.data.order_sn || orderResult.data.orderSn;
            await updateSession(sessionId, {
                order_info: orderResult.data,
                order_sn: orderSn,
                order_time: Date.now(),
                last_status_sync: Date.now()
            });
            await logToTab(sessionId, `Order Success. SN: ${orderSn}`);
            setTimeout(() => handleQueryOrderStatus(sessionId), 5000);
        } else if (orderResult.code === 10001 && !isRetry) {
            await logToTab(sessionId, '⚠️ 价格策略失效 (10001)，自动触发“快路”纠偏重试...');
            return retryOrderWithFreshPricing(sessionId);
        } else {
            // NOTIFY FRONTEND ON API FAILURE
            const nickname = session.item_info?.otherName || '未知用户';
            broadcastAlert({
                type: 'FAILURE',
                sessionId,
                msg: `[下单失败] (${nickname}) 平台返回: ${orderResult.msg}`,
                itemInfo: session.item_info
            });
        }
    } catch (e) {
        await logToTab(sessionId, '❌ Order Creation FAILED:', e.message);
        const nickname = session.item_info?.otherName || '未知用户';
        broadcastAlert({
            type: 'FAILURE',
            sessionId,
            msg: `[下单异常] (${nickname}) 请求发生错误: ${e.message}`,
            itemInfo: session.item_info
        });
    }
}

async function retryOrderWithFreshPricing(sessionId) {
    const { sessions = {} } = await chrome.storage.local.get(['sessions']);
    const session = sessions[sessionId];
    const prevOcr = session.ocr_result;

    let token = (await chrome.storage.local.get(['yhs_token'])).yhs_token;
    if (!token) token = await getAuthTokenFromTabs();
    const runner = new TaskRunner(sessionId, token);

    try {
        // Fast-path: Seat -> Preview -> Strategy
        const seatInfo = await runner.getSeatInfo({
            cinema_id: prevOcr.cinema_id,
            show_id: prevOcr.show_id,
            show_type: prevOcr.show_type,
            seat_no: prevOcr.seat_no
        });
        const seatIds = seatInfo.data.map(s => s.seatId).join(',');
        const areaIds = seatInfo.data.map(s => s.areaId).join(',');

        const preview = await runner.previewOrder({
            show_id: prevOcr.show_id, cinema_id: prevOcr.cinema_id,
            seat_id: seatIds, show_type: prevOcr.show_type, area_id: areaIds, mark: ''
        });

        const strategy = calculateOrderStrategy(preview.data);

        await updateSession(sessionId, {
            ocr_result: {
                ...prevOcr,
                ...preview.data,
                seat_id: seatIds,
                area_id: areaIds,
                ...strategy
            }
        });

        return handleOrderRequest(sessionId, true);

    } catch (e) {
        const nickname = session.item_info?.otherName || '未知用户';
        broadcastAlert({
            type: 'FAILURE',
            sessionId,
            msg: `[重试纠偏失败] (${nickname}) 无法重新报价: ${e.message}`,
            itemInfo: session.item_info
        });
    }
}

async function handleInterceptRequest(sessionId) {
    const { sessions = {} } = await chrome.storage.local.get(['sessions']);
    const session = sessions[sessionId];
    const orderSn = session?.order_sn;

    if (!orderSn) {
        logToTab(sessionId, '❌ 无法拦截：未找到该会话的订单流水号(order_sn)');
        return;
    }

    let token = (await chrome.storage.local.get(['yhs_token'])).yhs_token;
    if (!token) token = await getAuthTokenFromTabs();

    const runner = new TaskRunner(sessionId, token);
    try {
        await logToTab(sessionId, `⛔ Sending Intercept request for SN: ${orderSn}...`);
        const result = await runner.interceptOrder(orderSn);
        await logToTab(sessionId, 'Intercept Result:', result);

        if (result.code === 200 || result.code === 201) {
            // If successfully intercepted or already closed
            await updateSession(sessionId, { intercept_status: 'success' });
        } else {
            await logToTab(sessionId, `Intercept failed: ${result.msg}`);
        }
    } catch (e) {
        await logToTab(sessionId, '❌ Intercept request FAILED:', e.message);
    }
}

async function handleQueryOrderStatus(sessionId) {
    const { sessions = {} } = await chrome.storage.local.get(['sessions']);
    const session = sessions[sessionId];
    const orderSn = session?.order_sn;

    if (!orderSn) {
        logToTab(sessionId, '❌ 无法查询：未找到订单流水号');
        return;
    }

    let token = (await chrome.storage.local.get(['yhs_token'])).yhs_token;
    if (!token) token = await getAuthTokenFromTabs();

    const runner = new TaskRunner(sessionId, token);
    try {
        const result = await runner.getOrderDetail(orderSn);
        if (result.code === 200) {
            const data = result.data;
            const status = data.status;

            await updateSession(sessionId, {
                order_status: status,
                order_status_text: data.status_text,
                ticket_code: data.ticket_code,
                ticket_image: data.ticket_image,
                last_status_sync: Date.now()
            });

            await logToTab(sessionId, `Status Sync: ${data.status_text} (Code: ${status})`);

            const nickname = session.item_info?.otherName || '未知用户';

            // SUCCESS HANDLING: Notify for tickets (3, 5)
            if (status === 3 || status === 5) {
                broadcastAlert({
                    type: 'SUCCESS',
                    sessionId,
                    msg: `[出票成功] (${nickname}) 票据已生就绪，点击查看！`,
                    itemInfo: {
                        ...session.item_info,
                        ticket_code: data.ticket_code,
                        ticket_image: data.ticket_image
                    }
                });
            }

            // FAILURE HANDLING: Notify UI for refunds (-1, -2)
            if (status === -1 || status === -2) {
                const nickname = session.item_info?.otherName || '未知用户';
                broadcastAlert({
                    type: 'FAILURE',
                    sessionId,
                    msg: `[退款预警] (${nickname}) 订单[${orderSn}]已关闭: ${data.close_cause || '平台关闭'}`,
                    itemInfo: session.item_info
                });
            }
        }
    } catch (e) {
        await logToTab(sessionId, '❌ Status sync FAILED:', e.message);
    }
}

async function broadcastAlert(alert) {
    const tabs = await chrome.tabs.query({ url: "*://*.goofish.com/*" });
    tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, { type: 'ORDER_ALERT', alert }).catch(() => { });
    });
}

// --- Smart Poller (V7.2) ---

chrome.alarms.create('MASTER_SYNC', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'MASTER_SYNC') {
        runSmartPollCycle();
        // 30s Dual-Tick
        setTimeout(runSmartPollCycle, 30000);
    }
});

async function runSmartPollCycle() {
    const { sessions = {} } = await chrome.storage.local.get(['sessions']);
    const now = Date.now();

    for (const [id, session] of Object.entries(sessions)) {
        if (!session.order_sn) continue;

        // Skip final states
        if ([3, 5, -1, -2, -3].includes(session.order_status)) continue;

        const ageSec = (now - (session.order_time || now)) / 1000;
        const lastSyncAgeSec = (now - (session.last_status_sync || 0)) / 1000;

        // Tiered Intervals
        let requiredInterval = 180; // Default 3m (10-60m age)
        if (ageSec < 300) requiredInterval = 30; // 0-5m age -> 30s freq
        else if (ageSec < 600) requiredInterval = 60; // 5-10m age -> 1m freq

        // Timeout Check
        const orderType = session.ocr_result?.order_type; // 0: Discount, 1: Fast, 2: Rapid
        let timeoutSec = 3600; // Default 60m
        if (orderType === 2) timeoutSec = 300; // Rapid -> 5m
        else if (orderType === 1) timeoutSec = 900; // Fast -> 15m

        if (ageSec > timeoutSec && session.alert_type !== 'TIMEOUT') {
            await updateSession(id, { alert_type: 'TIMEOUT' });
            const nickname = session.item_info?.otherName || '未知用户';
            broadcastAlert({
                type: 'TIMEOUT',
                sessionId: id,
                msg: `[超时预警] (${nickname}) ${session.ocr_result.mode_name}已超过 ${Math.round(timeoutSec / 60)} 分钟未出票`,
                itemInfo: session.item_info
            });
        }

        // Jittered Execution
        if (lastSyncAgeSec >= requiredInterval) {
            const jitter = Math.random() * 7000 + 3000; // 3-10s
            setTimeout(() => handleQueryOrderStatus(id), jitter);
        }
    }
}
