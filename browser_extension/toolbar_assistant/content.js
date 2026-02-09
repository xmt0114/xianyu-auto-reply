// toolbar_assistant/content.js

console.log('[XianyuTool] Toolbar Assistant Loaded (V4.0 - Identity & Resilience)');

// --- Safe Chrome Bridge ---
// Prevents "Extension context invalidated" errors from crashing the script
const SafeChrome = {
    async getStorage(keys) {
        try {
            return await chrome.storage.local.get(keys);
        } catch (e) {
            if (e.message.includes('context invalidated')) {
                console.warn('[XianyuTool] Extension context invalidated. Please refresh the page.');
            }
            return {};
        }
    },
    async setStorage(data) {
        try {
            await chrome.storage.local.set(data);
        } catch (e) {
            console.warn('[XianyuTool] Set storage failed (context invalidated or error).');
        }
    },
    sendMessage(msg) {
        try {
            chrome.runtime.sendMessage(msg);
        } catch (e) {
            // Ignore messaging errors for background sync
        }
    }
};

SafeChrome.sendMessage({
    type: 'SYNC_HEADERS',
    headers: {
        'User-Agent': navigator.userAgent,
        'Accept-Language': navigator.language
    }
});

// 1. Selector Constants
const TOOLBAR_SELECTOR = '[class^="sendbox-topbar--"]';
const TEXTAREA_SELECTOR = '[class^="sendbox--"] textarea.ant-input';
const IMAGE_CONTAINER_SELECTOR = '[class^="image-container--"]';
const ITEM_CARD_SELECTOR = '[class^="container--dgZTBkgv"]';

// 2. Global State
let currentItemId = null;
let currentCounterpartId = null; // The person we are talking to
let currentSessionId = null;
let currentSession = null;

let selfInfo = { id: null, name: null };
let otherInfo = { id: null, name: null }; // The contact in chat
let sellerInfo = { id: null, name: null }; // The actual item owner

// 3. Template Engine & Data Providers
const TemplateEngine = {
    render(text) {
        let result = text;
        const placeholders = text.match(/{{(.*?)}}/g);
        if (placeholders) {
            placeholders.forEach(placeholder => {
                const varName = placeholder.replace(/{{|}}/g, '');
                const value = DataProvider.getVar(varName);
                result = result.replace(placeholder, value);
            });
        }
        return result;
    }
};

const DataProvider = {
    getVar(varName) {
        const res = currentSession?.ocr_result || {};
        const item = currentSession?.item_info || {};
        switch (varName) {
            case 'buyer_name':
                return otherInfo.name || '亲';
            case 'item_id':
                return currentItemId || '未知';
            case 'item_price':
                return item.price || '{{item_price}}';
            case 'movie':
                return res.film_name || '{{movie}}';
            case 'cinema':
                return res.cinema_name || '{{cinema}}';
            case 'time':
                return res.show_time || '{{time}}';
            case 'seat':
                return res.seat_no || '{{seat}}';
            case 'count':
                return res.seat_num || '{{count}}';
            case 'orig_price':
                return res.original_fee || '{{orig_price}}';
            case 'discount_price':
                return res.user_quote || '{{discount_price}}';
            case 'order_mode':
                return res.mode_name || '{{order_mode}}';
            case 'fail_reason':
                return currentSession?.last_error || '识别未完成/失败';
            case 'order_status':
                return currentSession?.order_status_text || '待下单';
            case 'ticket_code':
                return currentSession?.ticket_code || '等待出票';
            case 'ticket_image':
                return Array.isArray(currentSession?.ticket_image) ? currentSession.ticket_image[0] : (currentSession?.ticket_image || '等待出票');
            default:
                return `{{${varName}}}`;
        }
    }
};

// --- UI Utilities ---
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `xianyu-toast xianyu-toast-${type}`;
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// --- Extraction Logic ---

function getOtherPartyInfo() {
    // Strategy A: Topbar link (Stable on Xianyu PC)
    // Looking for the "闲鱼号" button which links to their personal page
    const accountLink = document.querySelector('.xianyu-account--zSIpYDYM')?.closest('a') ||
        document.querySelector('a[href*="personal?userId="]');

    let id = null;
    if (accountLink) {
        const match = accountLink.href.match(/userId=(\d+)/);
        if (match) id = match[1];
    }

    // Decoder for URL fallback (only if DOM fails, but beware of SPA lag)
    if (!id) {
        const urlParams = new URLSearchParams(window.location.search);
        id = urlParams.get('otherId') || urlParams.get('otherUserId');
    }

    const nameEl = document.querySelector('.text1--DZXvZYq5') || document.querySelector('[class^="text1--"]');
    return { id, name: nameEl?.innerText?.trim() || null };
}

function getSellerInfo() {
    // Extracting the owner of the item from the card or Buy button
    const cardLink = document.querySelector(ITEM_CARD_SELECTOR + ' a[href*="item?id="]');
    // Usually item links don't have seller ID directly, but we can look for other signals 
    // or assume the other party is the seller if current user is the buyer.
    return { id: null, name: null };
}

function getSelfUserInfo() {
    try {
        // Method 1: Search window context via scripts
        const scripts = document.querySelectorAll('script');
        for (const s of scripts) {
            const match = s.innerText.match(/"userId":\s*"(\d+)"/);
            if (match) return { id: match[1], name: null };
        }

        // Method 2: Search DOM for "My" or "Profile" links that are NOT in the chat topbar
        // Usually, the sidebar or header has a link to your own profile.
        // We look for userId in any link, but exclusion might be tricky.
        // Often there's a specific class for the "Me" section.
        const sidebarMyLink = document.querySelector('.side-menu--xxx a[href*="userId="]') || document.querySelector('a[href*="my.goofish.com"]');
        if (sidebarMyLink) {
            const match = sidebarMyLink.href.match(/userId=(\d+)/);
            if (match) return { id: match[1], name: '我' };
        }
    } catch (e) { }

    // Fallback log to show we are looking
    if (Date.now() % 30000 < 2000) console.log('[XianyuTool] [Identity] Still searching for Self-ID...');
    return { id: null, name: null };
}

function refreshCurrentContext() {
    // 1. Extract Name & ID from Topbar (The most stable part of current chat)
    const other = getOtherPartyInfo();
    const self = getSelfUserInfo();

    // 2. Identify Item ID (Broad Search Strategy)
    let itemId = null;
    // Strategy A: Search the main chat header area (Order info card)
    const chatContainer = document.querySelector('.chat-main--xvquhxw1') || document.body;
    // Find all links that might contain an ID, even if the primary one is javascript:void(0)
    const allLinks = Array.from(chatContainer.querySelectorAll('a[href*="id="]'));
    for (const a of allLinks) {
        const match = a.href.match(/[?&](?:itemId|id)=(\d+)/);
        if (match) {
            itemId = match[1];
            break;
        }
    }

    // Strategy B: URL Fallback (Use with caution for SPA)
    if (!itemId) {
        const urlParams = new URLSearchParams(window.location.search);
        itemId = urlParams.get('itemId');
    }

    // 3. Identity Sync & Stickiness Logic (V10.1)
    // The "Anchor" is the other party's nickname.
    // As long as the nickname in the topbar is the same, we trust our previous valid IDs.

    if (other.name) {
        const nameChanged = other.name !== otherInfo.name;

        // If nickname changed, we MUST reset IDs to avoid cross-contamination
        if (nameChanged) {
            console.log(`[XianyuTool] [Identity-Reset] Chat changed from ${otherInfo.name} to ${other.name}`);
            otherInfo.id = other.id;
            otherInfo.name = other.name;
            currentItemId = itemId;
        } else {
            // Nickname same -> We only update ID if we found a NEW valid one
            if (other.id && other.id !== otherInfo.id) {
                otherInfo.id = other.id;
            }
            if (itemId && itemId !== currentItemId) {
                currentItemId = itemId;
            }
        }
    }

    if (self.id && self.id !== selfInfo.id) {
        selfInfo = self;
    }

    // 4. Session Formation
    // Use the current locked variables
    const newSessionId = currentItemId && otherInfo.id ? `${currentItemId}_${otherInfo.id}` : null;

    if (newSessionId && newSessionId !== currentSessionId) {
        console.log(`[XianyuTool] [Session-Switch] SID: ${newSessionId}`);
        currentSessionId = newSessionId;
        loadSession(newSessionId);
    }
}

async function loadSession(sessionId) {
    if (!sessionId) return;
    const data = await SafeChrome.getStorage(['sessions']);
    currentSession = (data.sessions || {})[sessionId] || { status: 'idle' };
    updateMenuStatus();
}

function getLatestImageUrl() {
    const containers = document.querySelectorAll(IMAGE_CONTAINER_SELECTOR);
    const lastContainer = containers[containers.length - 1];
    if (!lastContainer) return null;

    const img = lastContainer.querySelector('.ant-image-img') || lastContainer.querySelector('img');
    let url = img?.src;
    if (!url) return null;

    if (url.startsWith('//')) url = 'https:' + url;
    const cleanedUrl = url.replace(/_(?:\d+x\d+|q\d+|sum|m)\..*$/i, '').replace(/_\.webp$/i, '');
    return cleanedUrl;
}

// --- Background Bridge ---
async function startOCRInBackground() {
    refreshCurrentContext();
    if (!currentSessionId) {
        showToast(`无法开始识别: 缺少 ${!currentItemId ? '商品ID' : ''} ${!currentCounterpartId ? '对方ID' : ''}`, 'error');
        return;
    }

    const imageUrl = getLatestImageUrl();
    if (!imageUrl) {
        showToast('未找到有效图片', 'error');
        return;
    }

    const priceEl = document.querySelector(ITEM_CARD_SELECTOR + ' [class^="money--"]');

    // Check for existing order (V10.0)
    if (currentSession?.order_sn) {
        const orderStatus = currentSession.order_status_text || '处理中';
        if (!confirm(`⚠️ 检测到该会话已有订单[${currentSession.order_sn}] (${orderStatus})。\n\n重发识图将覆盖当前报价策略，但保留订单历史记录。是否继续？`)) {
            return;
        }
    }

    const item_info = {
        price: priceEl?.innerText || '',
        itemId: currentItemId,
        otherId: otherInfo.id,
        otherName: otherInfo.name
    };

    console.log(`[XianyuTool] [OCR-Submit] Session: ${currentSessionId}, Image: ${imageUrl}`);

    SafeChrome.sendMessage({
        type: 'START_OCR',
        itemId: currentSessionId,
        imageUrl: imageUrl,
        itemInfo: item_info
    });

    showToast('已提交后台识别...', 'info');
}

// --- UI Logic ---
function updateMenuStatus() {
    const mainBtn = document.getElementById('xianyu-main-menu-btn');
    const orderBtn = document.getElementById('xianyu-create-order-btn');
    const interceptBtn = document.getElementById('xianyu-intercept-order-btn');
    if (!mainBtn) return;

    const status = currentSession?.status;
    const hasQuote = !!currentSession?.ocr_result?.user_quote;
    const orderSn = currentSession?.order_sn;
    const orderType = currentSession?.ocr_result?.order_type; // 0: Discount, 1: Fast

    if (status === 'processing') {
        mainBtn.innerText = '🔍 识别中...';
        mainBtn.classList.add('loading');
    } else {
        mainBtn.innerText = '💬 快捷话术';
        mainBtn.classList.remove('loading');
    }

    // Order Button State
    if (orderBtn) {
        if (hasQuote && status === 'success') {
            orderBtn.classList.remove('disabled');
            orderBtn.title = `立即提交订单 (${currentSession.ocr_result.mode_name})`;
        } else {
            orderBtn.classList.add('disabled');
            orderBtn.title = '缺少有效的报价数据，无法下单';
        }
    }

    // Intercept Button State (V6.0)
    if (interceptBtn) {
        // Only active for Discount (0) or Fast (1) orders that have an SN
        if (orderSn && (orderType === 0 || orderType === 1) && currentSession?.intercept_status !== 'success') {
            interceptBtn.classList.remove('disabled');
            interceptBtn.title = `拦截订单 (SN: ${orderSn})`;
        } else {
            interceptBtn.classList.add('disabled');
            interceptBtn.title = orderSn ? '该模式不支持拦截或已拦截' : '未找到可拦截的订单流水号';
        }
    }

    // Status Indicator (V7.0)
    let statusBadge = document.getElementById('xianyu-order-status-badge');
    const debugInfo = document.getElementById('xianyu-session-debug-info');
    if (debugInfo) {
        debugInfo.innerText = currentSessionId ? `SID: ${currentSessionId.split('_').pop()}` : 'ID缺失';
        debugInfo.title = `Full Session ID: ${currentSessionId || 'None'}`;
    }

    if (orderSn) {
        if (!statusBadge) {
            statusBadge = document.createElement('div');
            statusBadge.id = 'xianyu-order-status-badge';
            statusBadge.className = 'xianyu-status-badge';
            document.getElementById('xianyu-quick-reply-wrapper')?.appendChild(statusBadge);
        }
        const statusText = currentSession.order_status_text || '已下单';
        const isFinal = [1, 2, 3, 5].includes(currentSession.order_status); // Simple check
        statusBadge.innerHTML = `<span>📋 ${statusText}</span><span class="sync-icon" title="刷新状态">🔄</span>`;
        statusBadge.onclick = (e) => {
            e.stopPropagation();
            SafeChrome.sendMessage({ type: 'QUERY_ORDER_STATUS', itemId: currentSessionId });
            showToast('正在同步订单状态...', 'info');
        };
    } else if (statusBadge) {
        statusBadge.remove();
    }
    const menu = document.getElementById('xianyu-script-menu');
    if (menu) {
        const successItem = menu.querySelector('.script-match_success');
        const failItem = menu.querySelector('.script-match_fail');

        if (status === 'processing') {
            successItem?.classList.add('disabled');
            failItem?.classList.add('disabled');
        } else if (status === 'success') {
            successItem?.classList.remove('disabled');
            failItem?.classList.add('disabled');
        } else if (status === 'error') {
            successItem?.classList.add('disabled');
            failItem?.classList.remove('disabled');
        } else {
            successItem?.classList.add('disabled');
            failItem?.classList.add('disabled');
        }
    }
}

function fillTextInput(text) {
    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (!textarea) return;

    const renderedText = TemplateEngine.render(text);
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    set.call(textarea, renderedText);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
}

function createMenu() {
    const menu = document.createElement('div');
    menu.id = 'xianyu-script-menu';
    menu.style.display = 'none';

    const ocrItem = document.createElement('div');
    ocrItem.className = 'xianyu-menu-item ocr-item';
    ocrItem.innerHTML = `<strong>🔍 后台识别最新图片</strong><span class="preview">识别结果自动回填</span>`;
    ocrItem.onclick = (e) => {
        e.stopPropagation();
        startOCRInBackground();
        menu.style.display = 'none';
    };
    menu.appendChild(ocrItem);

    const scripts = window.XianyuScripts || [];
    scripts.forEach(script => {
        const item = document.createElement('div');
        const isStatic = ['opening', 'after_image', 'paid', 'paid_wrong_price'].includes(script.id);
        const isActive = (currentSession?.status === 'success' && script.id === 'match_success') || (currentSession?.status === 'error' && script.id === 'match_fail');

        item.className = `xianyu-menu-item script-${script.id} ${(isStatic || isActive) ? '' : 'disabled'}`;
        item.innerHTML = `<strong>${script.title}</strong><span class="preview">${script.content.substring(0, 15)}...</span>`;
        item.onclick = (e) => {
            e.stopPropagation();
            if (item.classList.contains('disabled')) {
                showToast('模板不可用：状态不符', 'info');
                return;
            }
            fillTextInput(script.content);
            menu.style.display = 'none';
        };
        menu.appendChild(item);
    });

    return menu;
}

function injectToolbarUI() {
    const toolbar = document.querySelector(TOOLBAR_SELECTOR);
    if (!toolbar || document.getElementById('xianyu-quick-reply-wrapper')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'xianyu-quick-reply-wrapper';
    wrapper.style.display = 'flex';
    wrapper.style.gap = '8px';
    wrapper.style.alignItems = 'center';

    // 1. Order Button
    const orderBtn = document.createElement('button');
    orderBtn.id = 'xianyu-create-order-btn';
    orderBtn.className = 'xianyu-custom-tool-btn disabled';
    orderBtn.innerHTML = '🚀 下单';
    orderBtn.style.backgroundColor = '#ff4d4f';
    orderBtn.style.color = '#fff';
    orderBtn.style.border = 'none';
    orderBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (orderBtn.classList.contains('disabled')) return;

        if (confirm(`确定要提交订单吗？\n模式: ${currentSession.ocr_result.mode_name}\n报价: ¥${currentSession.ocr_result.user_quote}`)) {
            SafeChrome.sendMessage({ type: 'CREATE_ORDER', itemId: currentSessionId });
            showToast('已提交后台下单...', 'info');
        }
    };

    // 1.1 Intercept Button (V6.0)
    const interceptBtn = document.createElement('button');
    interceptBtn.id = 'xianyu-intercept-order-btn';
    interceptBtn.className = 'xianyu-custom-tool-btn disabled';
    interceptBtn.innerHTML = '⛔ 拦截';
    interceptBtn.style.backgroundColor = '#607d8b';
    interceptBtn.style.color = '#fff';
    interceptBtn.style.border = 'none';
    interceptBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (interceptBtn.classList.contains('disabled')) return;

        if (confirm(`确定要拦截订单吗？\n订单号: ${currentSession.order_sn}`)) {
            SafeChrome.sendMessage({ type: 'INTERCEPT_ORDER', itemId: currentSessionId });
            showToast('已提交拦截请求...', 'info');
        }
    };

    // 2. Main Menu Button
    const btn = document.createElement('button');
    btn.id = 'xianyu-main-menu-btn';
    btn.className = 'xianyu-custom-tool-btn';
    btn.innerText = '💬 快捷话术';

    const menu = createMenu();
    btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
    };

    document.addEventListener('click', () => { menu.style.display = 'none'; });
    wrapper.appendChild(btn);
    wrapper.appendChild(orderBtn);
    wrapper.appendChild(interceptBtn); // Intercept on the far right
    wrapper.appendChild(menu);

    // Session ID Debug Info (V10.0)
    const debugInfo = document.createElement('div');
    debugInfo.id = 'xianyu-session-debug-info';
    debugInfo.style.cssText = 'font-size: 9px; color: #ccc; margin-left: 4px; max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: help;';
    debugInfo.onclick = () => alert(`Current Session ID: ${currentSessionId || 'None'}\nItem: ${currentItemId || 'None'}\nOther: ${otherInfo.id || 'None'}`);
    wrapper.appendChild(debugInfo);

    toolbar.appendChild(wrapper);
}

function injectGlobalAdmin() {
    if (document.getElementById('xianyu-global-admin-id')) return;

    console.log('[XianyuTool] [UI] Injecting Global Admin Button...');
    const adminContainer = document.createElement('div');
    adminContainer.id = 'xianyu-global-admin-id';
    adminContainer.className = 'xianyu-global-admin';

    const panel = document.createElement('div');
    panel.className = 'xianyu-admin-panel';
    panel.innerHTML = `
        <div class="xianyu-admin-title">🛠 闲鱼助手全局管理</div>
        <button class="xianyu-admin-action-btn" id="xianyu-clear-btn">🧹 清理所有识别缓存</button>
        <div style="font-size:10px; color:#999; margin-top:8px;">清理范围: 识图缓存、价格策略、Raw数据</div>
    `;

    const trigger = document.createElement('button');
    trigger.className = 'xianyu-admin-btn';
    trigger.innerHTML = '<span style="font-size:18px;">🛠️</span><span style="font-size:10px; margin-top:-4px;">管理</span>';
    trigger.style.flexDirection = 'column';
    trigger.onclick = (e) => { e.stopPropagation(); panel.classList.toggle('show'); };

    panel.querySelector('#xianyu-clear-btn').onclick = async () => {
        if (confirm('确定要清空所有已保存的识别记录吗？')) {
            await SafeChrome.setStorage({ sessions: {} });
            showToast('所有缓存已清理', 'success');
            panel.classList.remove('show');
            currentSession = { status: 'idle' };
            updateMenuStatus();
        }
    };

    document.addEventListener('click', () => panel.classList.remove('show'));
    adminContainer.appendChild(panel);
    adminContainer.appendChild(trigger);
    document.body.appendChild(adminContainer);
}

function injectAlertHub() {
    if (document.getElementById('xianyu-alert-hub')) return;

    const hub = document.createElement('div');
    hub.id = 'xianyu-alert-hub';
    hub.className = 'xianyu-alert-hub';
    hub.innerHTML = `
        <div class="hub-header">📢 通知中心 <span class="hub-toggle">▼</span></div>
        <div class="hub-list" id="xianyu-alert-list"></div>
    `;

    hub.querySelector('.hub-header').onclick = () => {
        hub.classList.toggle('collapsed');
    };

    document.body.appendChild(hub);
}

function handleIncomingAlert(alert) {
    injectAlertHub();
    const list = document.getElementById('xianyu-alert-list');
    if (!list) return;

    // Avoid duplicates
    if (document.getElementById(`alert-${alert.sessionId}`)) {
        document.getElementById(`alert-${alert.sessionId}`).remove();
    }

    const item = document.createElement('div');
    item.id = `alert-${alert.sessionId}`;
    const type = alert.type.toLowerCase();
    item.className = `alert-item type-${type}`;

    const icon = type === 'success' ? '✅' : (type === 'timeout' ? '⏳' : '🚨');

    item.innerHTML = `
        <div class="alert-msg">${icon} ${alert.msg}</div>
        <div class="alert-actions">
            ${type === 'success' ? '<button class="view-btn">查看凭证</button>' : '<button class="jump-btn">跳转聊天</button>'}
            <button class="close-btn">已知晓</button>
        </div>
        <div class="ticket-view-area" style="display: none;"></div>
    `;

    if (type === 'success') {
        const viewBtn = item.querySelector('.view-btn');
        const viewArea = item.querySelector('.ticket-view-area');
        viewBtn.onclick = () => {
            const isVisible = viewArea.style.display === 'block';
            viewArea.style.display = isVisible ? 'none' : 'block';
            viewBtn.innerText = isVisible ? '查看凭证' : '隐藏凭证';

            if (!isVisible && !viewArea.innerHTML) {
                // Render ticket details
                let html = '<strong>客票凭证详情：</strong>';
                if (alert.itemInfo.ticket_code) {
                    html += `<div class="ticket-code-display">${alert.itemInfo.ticket_code}</div>`;
                }
                if (alert.itemInfo.ticket_image) {
                    const imgs = Array.isArray(alert.itemInfo.ticket_image) ? alert.itemInfo.ticket_image : [alert.itemInfo.ticket_image];
                    imgs.forEach(src => {
                        html += `<img src="${src}" class="ticket-preview-img" onclick="window.open('${src}')" title="点击查看原图">`;
                    });
                }
                viewArea.innerHTML = html;
            }
        };
    } else {
        item.querySelector('.jump-btn').onclick = () => {
            SafeChrome.sendMessage({
                type: 'JUMP_TO_CHAT',
                itemId: alert.sessionId,
                otherId: alert.itemInfo?.otherId
            });
        };
    }

    item.querySelector('.close-btn').onclick = () => {
        item.remove();
        if (list.children.length === 0) {
            document.getElementById('xianyu-alert-hub').classList.add('collapsed');
        }
    };

    list.prepend(item);
    document.getElementById('xianyu-alert-hub').classList.remove('collapsed');
}

// --- Lifecycle ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'BG_REMOTE_LOG') {
        console.log(`[BG-REMOTE][${request.itemId}] ${request.message}`, request.data);
    }
    if (request.type === 'ORDER_ALERT') {
        handleIncomingAlert(request.alert);
    }
    if (request.type === 'FIND_AND_CLICK_CONV') {
        const { otherId, nickname } = request;
        console.log(`[XianyuTool] Attempting jump to: ${nickname} (${otherId})`);

        // Strategy A: Already there
        if (otherInfo.id == otherId) {
            sendResponse({ found: true });
            return;
        }

        // Strategy B: Click in list based on provided HTML structure
        const items = document.querySelectorAll('.conversation-item--JReyg97P');
        for (const item of items) {
            if (nickname && item.textContent.includes(nickname)) {
                item.click();
                console.log(`[XianyuTool] Successfully clicked conversation item for: ${nickname}`);
                sendResponse({ found: true });
                return;
            }
        }
        sendResponse({ found: false });
    }
    if (request.type === 'CHECK_IDENTITY') {
        sendResponse({ otherId: otherInfo.id, itemId: currentItemId });
    }
});

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.sessions) {
        const newSessions = changes.sessions.newValue || {};
        const oldSessions = changes.sessions.oldValue || {};

        if (currentSessionId && newSessions[currentSessionId]) {
            const oldStatus = oldSessions[currentSessionId]?.status;
            const newStatus = newSessions[currentSessionId]?.status;
            currentSession = newSessions[currentSessionId];
            updateMenuStatus();

            if (oldStatus === 'processing' && newStatus === 'success') {
                showToast(`识别成功`, 'success');
                const script = window.XianyuScripts.find(s => s.id === 'match_success');
                if (script) fillTextInput(script.content);
            } else if (oldStatus === 'processing' && newStatus === 'error') {
                showToast(`识别失败: ${currentSession.last_error}`, 'error');
            }
        }
    }
});

setInterval(refreshCurrentContext, 2000);

const observer = new MutationObserver(() => {
    injectToolbarUI();
    injectGlobalAdmin();
    injectAlertHub();
});
observer.observe(document.body, { childList: true, subtree: true });

injectToolbarUI();
injectGlobalAdmin();
injectAlertHub();
refreshCurrentContext();
