// content/content.js
console.log('[XianyuBot] Content Script Loaded v10 (DB + History)');

// ======================= IndexedDB Manager =======================
const DB_NAME = 'XianyuBotDB';
const DB_VERSION = 1;
const STORE_CONVERSIONS = 'conversations';
const STORE_MESSAGES = 'messages';

let db = null;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_CONVERSIONS)) {
                db.createObjectStore(STORE_CONVERSIONS, { keyPath: 'cid' });
            }
            if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
                db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' }); // id usually messageId
            }
        };
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('[TypesDB] Init Success');
            resolve(db);
        };
        request.onerror = (event) => {
            console.error('[TypesDB] Init Error', event);
            reject(event);
        };
    });
}

function saveConversation(conv) {
    if (!db) return;
    const tx = db.transaction([STORE_CONVERSIONS], 'readwrite');
    const store = tx.objectStore(STORE_CONVERSIONS);
    store.put(conv);
}

function getAllConversations() {
    return new Promise((resolve) => {
        if (!db) return resolve([]);
        const tx = db.transaction([STORE_CONVERSIONS, STORE_MESSAGES], 'readwrite');
        const convStore = tx.objectStore(STORE_CONVERSIONS);
        const msgStore = tx.objectStore(STORE_MESSAGES);

        const request = convStore.getAll();
        request.onsuccess = async () => {
            const allConvs = request.result || [];

            // 1. Migration: Conversations
            const staleConvs = allConvs.filter(c => c.cid && c.cid.includes('@'));
            if (staleConvs.length > 0) {
                console.log(`[Migration] Normalizing ${staleConvs.length} stale conversation CIDs...`);
                staleConvs.forEach(c => convStore.delete(c.cid));
            }

            // 2. Migration: Messages (Scan for un-normalized CIDs)
            const msgRequest = msgStore.getAll();
            msgRequest.onsuccess = () => {
                const allMsgs = msgRequest.result || [];
                const staleMsgs = allMsgs.filter(m => m.cid && m.cid.includes('@'));
                if (staleMsgs.length > 0) {
                    console.log(`[Migration] Normalizing CID for ${staleMsgs.length} messages...`);
                    staleMsgs.forEach(m => {
                        m.cid = normalizeCid(m.cid);
                        msgStore.put(m);
                    });
                }
                resolve(allConvs.filter(c => !c.cid || !c.cid.includes('@')));
            };
        };
        request.onerror = () => resolve([]);
    });
}

// ======================= 工具函数 =======================
function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
}
const MY_USER_ID = getCookie('unb') || '';

function safeBase64Decode(str) {
    try {
        return decodeURIComponent(escape(window.atob(str)));
    } catch (e) {
        try { return window.atob(str); } catch (z) { return null; }
    }
}

function normalizeCid(cid) {
    if (!cid) return "";
    // Remove @goofish, @taobao, etc.
    return cid.split('@')[0];
}

function generateMsgFingerprint(msg) {
    // Basic fingerprint: sender + time + first 20 chars of content
    const base = `${msg.sender || ''}_${msg.time || ''}_${(msg.content || '').substring(0, 20)}`;
    // Simple hash (JS doesn't have built-in MD5, using DJB2)
    let hash = 5381;
    for (let i = 0; i < base.length; i++) {
        hash = (hash * 33) ^ base.charCodeAt(i);
    }
    return 'fingerprint_' + (hash >>> 0).toString(16);
}

// ======================= Parsing Helpers =======================

function extractMsgInfo(msgObj) {
    let content = "未知消息";
    let images = [];
    const contentData = msgObj.content?.custom?.data;
    const contentType = msgObj.content?.contentType;

    if (contentData) {
        try {
            const jsonStr = safeBase64Decode(contentData);
            if (jsonStr) {
                const contentObj = JSON.parse(jsonStr);
                const type = contentObj.contentType;

                if (type === 1 && contentObj.text) {
                    content = contentObj.text.text || contentObj.text;
                } else if (type === 2 && contentObj.image && contentObj.image.pics) {
                    content = "[图片]";
                    images = contentObj.image.pics.map(p => p.url);
                } else if (type === 6) {
                    // Rich card / Fans promo
                    if (contentObj.textCard) {
                        content = contentObj.textCard.summary || contentObj.textCard.title || "[卡片消息]";
                    } else {
                        content = "[卡片消息]";
                    }
                } else if (type === 101) {
                    if (contentObj.custom && contentObj.custom.summary) content = contentObj.custom.summary;
                    else if (contentObj.text) content = contentObj.text.text || contentObj.text;
                } else if (type === 14 && contentObj.tip) {
                    content = `[系统] ${contentObj.tip.tip}`;
                }
            }
        } catch (e) { }
    }

    if (content === "未知消息") {
        if (msgObj.content?.custom?.summary) content = msgObj.content.custom.summary;
        else if (msgObj.extension?.reminderContent) content = msgObj.extension.reminderContent;
    }

    return { content, images };
}

function parseMessageList(models) {
    if (!Array.isArray(models)) return;
    console.log(`[Parse] Processing MessageList with ${models.length} items...`);

    models.forEach(model => {
        const msg = model.message;
        if (!msg) return;

        const rawCid = msg.cid;
        const cid = normalizeCid(rawCid);
        if (!cid) return;

        const { content, images } = extractMsgInfo(msg);
        let msgId = msg.messageId;
        const time = msg.createAt || Date.now();
        const senderId = msg.sender?.uid || 'OTHER';

        if (!msgId) msgId = generateMsgFingerprint({ sender: senderId, time: time, content: content });

        saveMessage({
            id: msgId,
            cid: cid,
            sender: senderId,
            content: content,
            images: images,
            time: time,
            raw: model
        });
    });

    if (currentTab === 'SESSION' && activeCid) renderSessionDetail(activeCid);
}

// ======================= History Logic =======================

function saveMessage(msg) {
    if (!db) return;
    if (msg.cid) msg.cid = normalizeCid(msg.cid); // Guard: Always normalize before saving
    const tx = db.transaction([STORE_MESSAGES], 'readwrite');
    const store = tx.objectStore(STORE_MESSAGES);
    store.put(msg); // ID based upsert (deduplication)
}

function getMessagesByCid(cid) {
    return new Promise((resolve) => {
        if (!db) return resolve([]);
        const normalizedTargetCid = normalizeCid(cid);
        const tx = db.transaction([STORE_MESSAGES], 'readonly');
        const store = tx.objectStore(STORE_MESSAGES);
        const request = store.getAll();
        request.onsuccess = () => {
            const all = request.result || [];
            resolve(all.filter(m => normalizeCid(m.cid) === normalizedTargetCid));
        };
        request.onerror = () => resolve([]);
    });
}

function parseUserConvs(list) {
    if (!Array.isArray(list)) {
        console.warn('[Parse] userConvs is not an array:', list);
        return;
    }

    console.log(`[Parse] Processing ${list.length} conversations...`);

    list.forEach((item, index) => {
        // 1. Locate the Conversation Wrapper
        const wrap = item.singleChatUserConversation;
        if (!wrap) {
            console.warn(`[Parse] Item ${index} missing singleChatUserConversation`);
            return;
        }

        // 2. Extract Basic Info & CID
        const mainConv = wrap.singleChatConversation || {};
        const lastMsgWrap = wrap.lastMessage || {};
        const msgObj = lastMsgWrap.message || {};

        const ext = mainConv.extension || {};
        const rawCid = mainConv.cid || msgObj.cid || wrap.cid;
        const cid = normalizeCid(rawCid);

        if (!cid) {
            console.warn(`[Parse] Item ${index} missing CID`);
            return;
        }

        // 3. Extract Message Content
        const { content: lastContent, images: lastImages } = extractMsgInfo(msgObj);
        let msgId = msgObj.messageId || lastMsgWrap.messageId;
        let msgTime = msgObj.createAt || lastMsgWrap.createAt || Date.now();

        // 5. Extract Sender & Identity logic
        let senderId = '';
        if (msgObj.sender && msgObj.sender.uid) senderId = msgObj.sender.uid;
        else if (lastMsgWrap.sender && lastMsgWrap.sender.uid) senderId = lastMsgWrap.sender.uid;

        // Peer ID logic (Non-cookie based)
        // PairFirst is usually the one who initiated or fixed? 
        // Better Heuristic: Peer is the one NOT me. But ID is tricky without Cookie.
        // Wait, the user is right: itemSellerId is the key. 
        // If the 'peer' (reminderTitle) matches the person I'm talking to, 
        // and that person's ID (normalized) is itemSellerId, they are SELLER.

        let normalizedSellerId = normalizeCid(ext.itemSellerId || ext.ownerUserId);
        let normalizedSenderId = normalizeCid(senderId);

        // Simple Heuristic for Role: 
        // If peer sends "关注我" etc, they are seller.
        const isPeerSellerHeuristic = lastContent.includes("关注我") || lastContent.includes("粉丝优惠") || ext.itemMainPic;

        // 6. Save Conversation
        const peerNick = msgObj.extension?.reminderTitle || ext.squadName_221 || ext.itemTitle || "闲鱼用户";
        const peerAvatar = ext.peerAvatar || ext.userAvatar || ext.ownerAvatar || '';

        // Filter System/Notification (Improved)
        const isSystem = (mainConv.bizType && String(mainConv.bizType) !== "1") ||
            ["通知消息", "订阅消息", "闲鱼今日焦点", "闲鱼官方消息", "闲鱼客服"].includes(peerNick) ||
            (cid && (cid.startsWith('sys_') || cid.includes('SYSTEM'))) ||
            (peerNick === "闲鱼用户" && lastContent === "未知消息" && !ext.itemMainPic);

        if (isSystem) {
            console.log(`[Parse] Skipping System: ${peerNick} (CID:${cid})`);
            return;
        }

        const convData = {
            cid: cid,
            rawCid: rawCid,
            peerNick: peerNick,
            peerAvatar: peerAvatar,
            itemPic: ext.itemMainPic,
            itemTitle: ext.itemTitle,
            itemPrice: ext.itemPrice || ext.price,
            lastMsgTime: wrap.modifyTime || Date.now(),
            lastContent: lastContent,
            lastImages: lastImages,
            lastSenderId: senderId, // Track who sent the last message
            bizType: mainConv.bizType,
            itemSellerId: ext.itemSellerId || ext.ownerUserId,
            raw: item
        };
        saveConversation(convData);

        // 7. Save Message
        if (!msgId) msgId = generateMsgFingerprint({ sender: senderId, time: msgTime, content: lastContent });

        const msgData = {
            id: msgId,
            cid: cid,
            content: lastContent,
            images: lastImages,
            time: msgTime,
            sender: senderId,
            raw: lastMsgWrap
        };
        saveMessage(msgData);
    });

    if (currentTab === 'SESSION') renderSessionTab();
}

function processRealtimeMessage(parsed) {
    const data = parsed.unpacked || parsed.parsed;
    if (!data) return;

    const body = data.body || data;

    // Support for syncPushPackage (Batch or Deeply nested data)
    if (body.syncPushPackage && Array.isArray(body.syncPushPackage.data)) {
        console.log(`[Realtime] Processing SyncPushPackage with ${body.syncPushPackage.data.length} items`);
        body.syncPushPackage.data.forEach(item => {
            const innerMsg = item.data_parsed || item;
            processSingleRealtimeItem(innerMsg, parsed.type);
        });
        return;
    }

    processSingleRealtimeItem(data, parsed.type);
}

function processSingleRealtimeItem(data, originalType) {
    const msg = data.message || data;
    const rawCid = msg.cid || data.cid;
    if (!rawCid) return;
    const cid = normalizeCid(rawCid);

    const ext = msg.extension || {};

    // 1. Extract Content
    let content = "[新消息]";
    let images = [];

    if (originalType === 'CHAT' && (data.content || data.body?.content)) {
        content = data.content || data.body?.content || "";
    } else if (originalType === 'IMAGE' && data.url) {
        content = "[图片]";
        images = [data.url];
    } else {
        const info = extractMsgInfo(msg);
        content = info.content;
        images = info.images;
    }

    let msgId = msg.messageId;
    const time = msg.createAt || Date.now();
    const senderId = msg.sender?.uid || 'OTHER';
    if (!msgId) msgId = generateMsgFingerprint({ sender: senderId, time: time, content: content });

    saveMessage({
        id: msgId,
        cid: cid,
        sender: senderId,
        content: content,
        images: images,
        time: time
    });

    // 2. Update Conversation Meta
    const peerNick = ext.reminderTitle || data.peerNick || "闲鱼用户";
    const peerAvatar = ext.peerAvatar || ext.userAvatar || "";

    // Filter System
    if (["通知消息", "订阅消息", "闲鱼今日焦点", "闲鱼官方消息", "闲鱼客服"].includes(peerNick) ||
        (cid && (cid.startsWith('sys_') || cid.includes('SYSTEM'))) ||
        (peerNick === "闲鱼用户" && content === "未知消息")) {
        return;
    }

    const convUpdate = {
        cid: cid,
        rawCid: rawCid,
        peerNick: peerNick,
        peerAvatar: peerAvatar,
        lastMsgTime: time,
        lastContent: content,
        lastImages: images,
        lastSenderId: senderId,
        itemSellerId: ext.itemSellerId || ""
    };

    getAllConversations().then(convs => {
        const existing = convs.find(c => c.cid === cid);
        if (existing) {
            saveConversation({
                ...existing,
                ...convUpdate,
                itemPic: convUpdate.itemPic || existing.itemPic,
                peerAvatar: convUpdate.peerAvatar || existing.peerAvatar,
                peerNick: convUpdate.peerNick && convUpdate.peerNick !== "闲鱼用户" ? convUpdate.peerNick : existing.peerNick,
                itemSellerId: convUpdate.itemSellerId || existing.itemSellerId
            });
        } else {
            saveConversation(convUpdate);
        }
        if (currentTab === 'SESSION') renderSessionTab();
    });
}


// ======================= UI Logic =======================
let currentTab = 'CHAT'; // Reverted: CHAT is default
let activeCid = null; // Track which session is being viewed

function createSidebar() {
    if (document.getElementById('xianyu-bot-sidebar')) return;
    const sidebar = document.createElement('div');
    sidebar.id = 'xianyu-bot-sidebar';
    sidebar.style.cssText = `position:fixed;top:0;right:0;width:500px;height:100vh;background:#fdfdfd;border-left:1px solid #ddd;z-index:2147483647;font-family:sans-serif;display:flex;flex-direction:column;box-shadow:-4px 0 20px rgba(0,0,0,0.1);`;

    // Header
    const header = document.createElement('div');
    header.style.cssText = "background:#fff;padding:12px;border-bottom:1px solid #eee;flex-shrink:0;";
    header.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <div style="font-weight:bold;color:#333;">🐟 闲鱼助手 (Capture & DB)</div>
            <button id="close-sidebar-btn" style="border:none;background:transparent;cursor:pointer;font-size:20px;">×</button>
        </div>
        <div style="display:flex;background:#f5f5f5;padding:4px;border-radius:6px;">
            <button id="tab-chat-btn" class="tab-btn" style="flex:1;padding:8px;border:none;background:#fff;border-radius:4px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.1);color:#000;">💬 实时</button>
            <button id="tab-session-btn" class="tab-btn" style="flex:1;padding:8px;border:none;background:transparent;border-radius:4px;cursor:pointer;color:#888;">📂 会话DB</button>
            <button id="tab-all-btn" class="tab-btn" style="flex:1;padding:8px;border:none;background:transparent;border-radius:4px;cursor:pointer;color:#888;">📝 日志</button>
        </div>
    `;
    sidebar.appendChild(header);

    // Container
    const mainContainer = document.createElement('div');
    mainContainer.id = 'bot-main-container';
    mainContainer.style.cssText = "flex:1;overflow-y:auto;padding:12px;scroll-behavior:smooth;";
    sidebar.appendChild(mainContainer);

    // Logs Wrapper (For Chat/All)
    const logWrapper = document.createElement('div');
    logWrapper.id = 'bot-logs';
    mainContainer.appendChild(logWrapper);

    // Sessions Wrapper (For Session DB)
    const sessionWrapper = document.createElement('div');
    sessionWrapper.id = 'bot-sessions';
    sessionWrapper.style.display = 'none';
    mainContainer.appendChild(sessionWrapper);


    document.body.appendChild(sidebar);

    // Bindings
    document.getElementById('close-sidebar-btn').addEventListener('click', () => {
        sidebar.style.display = 'none';
        createRestoreButton();
    });

    const btnChat = document.getElementById('tab-chat-btn');
    const btnSession = document.getElementById('tab-session-btn');
    const btnAll = document.getElementById('tab-all-btn');

    const updateBtns = (activeId) => {
        [btnChat, btnSession, btnAll].forEach(btn => {
            btn.style.background = 'transparent';
            btn.style.color = '#888';
            btn.style.boxShadow = 'none';
        });
        const active = activeId === 'CHAT' ? btnChat : (activeId === 'SESSION' ? btnSession : btnAll);
        active.style.background = '#fff';
        active.style.color = '#000';
        active.style.boxShadow = '0 1px 3px rgba(0,0,0,0.1)';
    };

    const handleTabSwitch = (id) => {
        currentTab = id;
        updateBtns(id);

        if (id === 'SESSION') {
            logWrapper.style.display = 'none';
            sessionWrapper.style.display = 'block';
            renderSessionTab();
        } else {
            sessionWrapper.style.display = 'none';
            logWrapper.style.display = 'block';

            // IMPORTANT: Update existing log entry visibility in the DOM
            const logs = logWrapper.children;
            for (let log of logs) {
                const type = log.dataset.type;
                const isChat = ['CHAT', 'IMAGE', 'SYSTEM'].includes(type);
                if (id === 'ALL') {
                    log.style.display = 'block';
                } else if (id === 'CHAT') {
                    log.style.display = isChat ? 'block' : 'none';
                }
            }
        }
    };

    btnChat.addEventListener('click', () => handleTabSwitch('CHAT'));
    btnSession.addEventListener('click', () => handleTabSwitch('SESSION'));
    btnAll.addEventListener('click', () => handleTabSwitch('ALL'));

    // Initial render
    handleTabSwitch('CHAT');
}

async function renderSessionTab() {
    const container = document.getElementById('bot-sessions');
    if (!container) return;

    if (activeCid) {
        renderSessionDetail(activeCid);
    } else {
        renderSessionList();
    }
}

async function renderSessionList() {
    const container = document.getElementById('bot-sessions');
    container.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">Loading Sessions...</div>';

    const convs = await getAllConversations();
    convs.sort((a, b) => b.lastMsgTime - a.lastMsgTime);

    container.innerHTML = '';

    // Header for List
    const header = document.createElement('div');
    header.style.cssText = "padding:10px 0; border-bottom:1px solid #f0f0f0; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center;";
    header.innerHTML = `<span style="font-size:16px; font-weight:bold; color:#333;">消息</span>`;
    container.appendChild(header);

    if (convs.length === 0) {
        container.innerHTML += '<div style="text-align:center;padding:40px 20px;color:#999;font-size:13px;">暂无会话数据<br><span style="font-size:11px;">(请点击网页左下角"消息"以同步)</span></div>';
        return;
    }

    convs.forEach(c => {
        const item = document.createElement('div');
        item.style.cssText = "display:flex; padding:12px 10px; border-bottom:1px solid #f8f8f8; cursor:pointer; align-items:center; transition:background 0.2s;";
        item.onmouseover = () => item.style.background = "#f9f9f9";
        item.onmouseout = () => item.style.background = "transparent";

        // Time format
        const date = new Date(c.lastMsgTime);
        const now = new Date();
        let timeStr = "";
        if (date.toDateString() === now.toDateString()) {
            timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        } else {
            timeStr = `${date.getMonth() + 1}-${date.getDate()}`;
        }

        // Role Detection Logic: Precise identification
        let isSeller = false;
        const normalizedMyId = normalizeCid(MY_USER_ID);
        const normalizedSellerId = normalizeCid(c.itemSellerId);

        // 1. Primary check: If itemSellerId matches my ID
        if (normalizedSellerId && normalizedMyId) {
            isSeller = (normalizedSellerId === normalizedMyId);
        }

        // 2. Heuristic refinement based on last message sender and content
        // If content contains seller prompts ("关注", "粉丝", "券", "改价")
        const sellerKeywords = ["关注", "粉丝", "券", "改价", "暗号"];
        const hasSellerKeywords = sellerKeywords.some(kw => c.lastContent.includes(kw));

        if (hasSellerKeywords) {
            const normalizedSenderId = normalizeCid(c.lastSenderId);
            // If I sent the seller keywords, I am the seller.
            if (normalizedSenderId === normalizedMyId) {
                isSeller = true;
            } else if (normalizedSenderId) {
                // If peer sent them, they are the seller, so I am the buyer.
                isSeller = false;
            }
        }

        const roleLabel = isSeller ? "卖家" : "买家";
        const roleColor = isSeller ? "#ff9800" : "#2196f3";
        const roleBg = isSeller ? "#fff3e0" : "#e3f2fd";
        const roleTag = `<span style="margin-left:8px; background:${roleBg}; color:${roleColor}; padding:1px 6px; border-radius:4px; font-size:11px;">我是${roleLabel}</span>`;

        item.innerHTML = `
            <!-- Avatar (Peer) -->
            <div style="width:44px; height:44px; border-radius:50%; background:#f0f0f0; flex-shrink:0; display:flex; align-items:center; justify-content:center; overflow:hidden; margin-right:12px; border:1px solid #eee;">
                <img src="${c.peerAvatar || 'https://img.alicdn.com/tfs/TB1OO6XpYvpK1RjSZPiXXbm7FXa-80-80.png'}" style="width:100%; height:100%; object-fit:cover;" onerror="this.src='https://img.alicdn.com/tfs/TB1OO6XpYvpK1RjSZPiXXbm7FXa-80-80.png'">
            </div>
            
            <!-- Content -->
            <div style="flex:1; min-width:0;">
                <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:4px;">
                    <div style="display:flex; align-items:center;">
                        <span style="font-weight:bold; color:#333; font-size:14px; max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${c.peerNick || "闲鱼用户"}</span>
                        ${roleTag}
                    </div>
                    <span style="font-size:11px; color:#bbb; flex-shrink:0; margin-left:8px;">${timeStr}</span>
                </div>
                <div style="font-size:13px; color:#888; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    ${c.lastContent || "[图片]"}
                </div>
            </div>

            <!-- Item Thumbnail -->
            <div style="width:40px; height:40px; border-radius:4px; background:#f5f5f5; flex-shrink:0; margin-left:12px; overflow:hidden; border:1px solid #f0f0f0;">
                 <img src="${c.itemPic || ''}" style="width:100%; height:100%; object-fit:cover; opacity:0.8;" onerror="this.style.display='none'">
            </div>
        `;

        item.onclick = () => {
            activeCid = c.cid;
            renderSessionTab();
        };

        container.appendChild(item);
    });
}

async function renderSessionDetail(cid) {
    const container = document.getElementById('bot-sessions');
    container.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">Loading Messages...</div>';

    // 1. Header with Back Button
    const conv = (await getAllConversations()).find(it => it.cid === cid);
    const header = document.createElement('div');
    header.style.cssText = "padding:10px 0; border-bottom:1px solid #f0f0f0; margin-bottom:10px; display:flex; align-items:center; background:#fff; position:sticky; top:0; z-index:10;";
    header.innerHTML = `
        <button id="back-to-list-btn" style="border:none; background:transparent; cursor:pointer; font-size:18px; padding-right:10px; color:#666;">←</button>
        <span style="font-weight:bold; color:#333; font-size:15px;">${conv?.peerNick || "会话详情"}</span>
    `;
    container.innerHTML = '';
    container.appendChild(header);

    header.querySelector('#back-to-list-btn').onclick = () => {
        activeCid = null;
        renderSessionTab();
    };

    // 2. Fetch Messages
    const msgs = await getMessagesByCid(cid);
    msgs.sort((a, b) => a.time - b.time);

    const msgList = document.createElement('div');
    msgList.style.cssText = "display:flex; flex-direction:column; gap:12px; padding-bottom:20px;";

    if (msgs.length === 0) {
        msgList.innerHTML = '<div style="text-align:center; color:#ccc; font-size:12px; margin-top:20px;">暂无历史消息内容</div>';
    }

    msgs.forEach(m => {
        // Detect 'Me': compare sender ID with MY_USER_ID
        // m.sender might be "12345@goofish", MY_USER_ID is "12345"
        const isMe = m.sender === 'ME' || (MY_USER_ID && m.sender.startsWith(MY_USER_ID));

        const row = document.createElement('div');
        row.style.cssText = `display:flex; flex-direction:column; align-items: ${isMe ? 'flex-end' : 'flex-start'}; margin-bottom: 4px;`;

        const bubble = document.createElement('div');
        bubble.style.cssText = `
            max-width: 80%;
            padding: 8px 12px;
            border-radius: 12px;
            font-size: 14px;
            line-height: 1.5;
            word-break: break-all;
            background: ${isMe ? '#ffe400' : '#f0f0f0'};
            color: ${isMe ? '#000' : '#333'};
            position: relative;
        `;

        // Image support
        let content = m.content;
        if (m.images && m.images.length > 0) {
            content += `<div style="margin-top:5px; display:flex; flex-direction:column; gap:4px;">${m.images.map(img => `<img src="${img}" style="max-width:200px; border-radius:4px; cursor:pointer;" onclick="window.open('${img}')">`).join('')}</div>`;
        }

        bubble.innerHTML = content;

        const time = document.createElement('div');
        time.style.cssText = "font-size:10px; color:#ccc; margin-top:4px; margin-bottom:2px;";
        const d = new Date(m.time);
        time.innerText = `${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}`;

        row.appendChild(bubble);
        row.appendChild(time);
        msgList.appendChild(row);
    });

    container.appendChild(msgList);

    // Auto scroll to bottom
    setTimeout(() => {
        const main = document.getElementById('bot-main-container');
        if (main) main.scrollTop = main.scrollHeight;
    }, 50);
}

function createRestoreButton() {
    if (document.getElementById('restore-sidebar')) return;
    const btn = document.createElement('button');
    btn.innerHTML = '🐟';
    btn.style.cssText = `position:fixed;bottom:30px;right:30px;width:48px;height:48px;border-radius:50%;background:#ffda44;border:3px solid #fff;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:2147483647;cursor:pointer;font-size:24px;`;
    btn.addEventListener('click', () => {
        const s = document.getElementById('xianyu-bot-sidebar');
        if (s) s.style.display = 'flex';
        btn.remove();
    });
    document.body.appendChild(btn);
}

// ======================= JSON Unpack & Cleaning =======================
function unpackSyncData(data) {
    try {
        if (data && data.body && data.body.syncPushPackage && data.body.syncPushPackage.data) {
            const items = data.body.syncPushPackage.data;
            if (Array.isArray(items) && items.length > 0) {
                const rawBase64 = items[0].data;
                if (rawBase64 && typeof rawBase64 === 'string') {
                    try {
                        const decodedStr = decodeURIComponent(escape(window.atob(rawBase64)));
                        return JSON.parse(decodedStr);
                    } catch (e) { return JSON.parse(window.atob(rawBase64)); }
                }
            }
        }
    } catch (e) {
        console.log('[Content] unpackSyncData | Error:', e);
    }
    return null;
}

function parsePayload(payload) {
    let result = { type: 'OTHER', details: null, raw: payload, unpacked: null, alias: '' };
    console.log('[Content] parsePayload | payload:', payload);
    try {
        if (payload.type === 'HTTP_HISTORY' || payload.type === 'HTTP_MSG') {
            result.type = 'HTTP_HISTORY';
            result.alias = '📜 历史 (Capture)';
            const history = payload.data?.body || payload.data;

            if (history?.userConvs) {
                parseUserConvs(history.userConvs);
            }
            if (history?.userMessageModels) {
                parseMessageList(history.userMessageModels);
            }

            result.details = { content: `[History] ${payload.url ? payload.url.substring(0, 40) : ''}...`, sender: 'History', isMe: false, time: '' };
            return result;
        }

        let data = null;
        if (payload.type === 'DECRYPTED') data = payload.decoded;
        else if (payload.type === 'TEXT') {
            if (payload.decoded === '2::') {
                result.alias = '❤️ PING';
                result.type = 'SYNC';
                return result;
            }
            // Detect if decoded is ALREADY an object (from Inject)
            if (typeof payload.decoded === 'object' && payload.decoded !== null) {
                data = payload.decoded;
            } else if (typeof payload.decoded === 'string') {
                // Peek before parsing to avoid noise
                const trimmed = payload.decoded.trim();
                if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                    try { data = JSON.parse(trimmed); }
                    catch (e) { console.error('[Content] JSON Parse Failed:', e); }
                } else {
                    result.type = 'TEXT_RAW';
                    result.alias = '📝 Raw Text';
                }
            }
        }

        // Ensure raw gets populated if decoded exists
        if (payload.decoded) payload.raw = payload.decoded;

        if (data) {
            const unpacked = unpackSyncData(data);
            if (unpacked) {
                data = unpacked;
                result.unpacked = unpacked;
                result.alias = '📦 Sync Package';
            }

            // Basic Chat Detection
            if (result.type === 'OTHER' && (data['-26'] || data.body)) {
                result.type = 'SYNC';
                result.alias = '🔄 Sync Packet';
            }
        } else if (payload.decoded === '2::') {
            result.alias = '❤️ PING';
            result.type = 'SYNC';
        }
    } catch (e) { result.alias = '❌ Parse Error'; }
    return result;
}

// ======================= Main Log Handling =======================
function deepClean(obj) {
    if (typeof obj === 'string') {
        try {
            if (obj.startsWith('{') || obj.startsWith('[')) return deepClean(JSON.parse(obj));
        } catch (e) { }
        return obj;
    } else if (typeof obj === 'object' && obj !== null) {
        for (let key in obj) obj[key] = deepClean(obj[key]);
    }
    return obj;
}

function copyToClipboard(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    try {
        document.execCommand('copy');
    } catch (err) {
        console.error('Copy failed', err);
    }
    document.body.removeChild(textArea);
}

function addLog(payload) {
    // [DEBUG] ENTRY LOG - This must appear if function is called
    console.log('[Content] addLog | Type:', payload ? payload.type : 'N/A');

    // 1. Parsing First (To access unpacked data)
    const parsed = parsePayload(payload);

    // [DEBUG] Log unpacked data structure to trace userConvs
    if (parsed.unpacked) {
        // console.log('[Content] Unpacked:', parsed.unpacked);
    }

    // 2. Universal History & Realtime Detection
    try {
        // Source A: HTTP History
        if (payload.type === 'HTTP_MSG' || payload.type === 'HTTP_HISTORY') {
            const body = payload.data.body || payload.data;
            if (body && body.userConvs) {
                console.log(`[Content] 📡 HTTP History detected: ${body.userConvs.length} items`);
                parseUserConvs(body.userConvs);
            }
        }

        // Source B: WebSocket/Sync History (The "Sync Packet" case)
        const dataObj = parsed.unpacked || JSON.parse(payload.decoded) || (parsed.raw && typeof parsed.raw === 'object' ? parsed.raw : null);

        if (dataObj && dataObj.body && dataObj.body.userConvs) {
            const { userConvs, hasMore, nextCursor } = dataObj.body;
            console.log(`[Content] 📡 Sync/WS History detected: ${userConvs.length} items | hasMore: ${hasMore} | cursor: ${nextCursor}`);
            parseUserConvs(userConvs);
        }

        // Source C: Realtime Single Message
        if (parsed.type === 'CHAT' || parsed.type === 'IMAGE' || (parsed.type === 'SYNC' && parsed.unpacked && !dataObj?.body?.userConvs)) {
            processRealtimeMessage(parsed);
        }

    } catch (e) { console.error('[Content] Auto-Save Error', e); }


    // 3. Render to Log UI (Rich View)
    const container = document.getElementById('bot-logs');
    if (!container) return;

    // Tab Filter
    const isChat = ['CHAT', 'IMAGE', 'SYSTEM'].includes(parsed.type);
    const isHistory = (parsed.type === 'HTTP_HISTORY' || payload.type === 'HTTP_MSG');

    const entry = document.createElement('div');
    entry.dataset.type = isHistory ? 'HTTP_HISTORY' : parsed.type;
    entry.style.marginBottom = '10px';

    // Display Logic
    // Display Logic
    if (currentTab === 'CHAT' && !isChat) {
        entry.style.display = 'none';
    } else if (currentTab === 'SESSION') {
        entry.style.display = 'none'; // Logs hidden in Session tab
    } else {
        entry.style.display = 'block';
    }

    // Content Prep
    let displayObj = parsed.unpacked || (isHistory ? payload.data : (payload.decoded || payload.raw));
    let cleanObj = deepClean(JSON.parse(JSON.stringify(displayObj || { warning: 'null data' })));
    let rawJsonStr = JSON.stringify(cleanObj, null, 2);
    let label = parsed.alias || `[${parsed.type}]`;
    if (isHistory) label = '📜 历史 (Capture)';
    if (parsed.unpacked) label += ' (Unpacked)';

    // Construct UI
    const card = document.createElement('div');
    card.style.cssText = "border:1px solid #eee;border-radius:6px;background:#fff;overflow:hidden;";

    // Title Bar
    const titleBar = document.createElement('div');
    const direction = parsed.direction ? ` [${parsed.direction}]` : '';
    const aliasColor = parsed.direction === 'OUTGOING' ? '#4caf50' : '#2196f3';

    titleBar.style.cssText = "padding:6px 10px;background:#fcfcfc;border-bottom:1px solid #eee;display:flex;justify-content:space-between;align-items:center;";
    titleBar.innerHTML = `
        <span style="background:${aliasColor};color:#fff;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:bold;">${label}${direction}</span>
        <span style="font-size:10px;color:#bbb;">${new Date().toLocaleTimeString()}</span>
    `;
    card.appendChild(titleBar);

    const actionDiv = document.createElement('div');

    // Copy Button
    const copyBtn = document.createElement('button');
    copyBtn.innerText = '复制';
    copyBtn.style.cssText = "border:1px solid #ccc;background:#fff;cursor:pointer;font-size:10px;padding:2px 8px;border-radius:4px;margin-right:5px;";
    copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard(rawJsonStr);
        copyBtn.innerText = '已复制!';
        setTimeout(() => copyBtn.innerText = '复制', 1000);
    });
    actionDiv.appendChild(copyBtn);

    // Toggle Button
    const toggleBtn = document.createElement('button');
    toggleBtn.innerText = '展开/收起';
    toggleBtn.style.cssText = "border:none;background:transparent;cursor:pointer;font-size:10px;color:#888;";
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const contentDiv = card.querySelector('.json-content');
        contentDiv.style.display = contentDiv.style.display === 'none' ? 'block' : 'none';
    });
    actionDiv.appendChild(toggleBtn);

    titleBar.appendChild(actionDiv);
    card.appendChild(titleBar);

    // Content Box
    const contentBox = document.createElement('div');
    contentBox.className = 'json-content';
    contentBox.style.cssText = `display:block; border-top:1px solid #eee; padding:10px; max-height:450px; overflow:auto;`;

    const pre = document.createElement('pre');
    pre.style.cssText = "margin:0; font-family:monospace; font-size:11px; white-space:pre-wrap; word-break:break-all; color:#333;";
    pre.textContent = rawJsonStr;

    contentBox.appendChild(pre);
    card.appendChild(contentBox);

    entry.appendChild(card);
    container.appendChild(entry);

    // Auto-scroll
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 200) {
        container.scrollTop = container.scrollHeight;
    }
}


// ======================= Init =======================
initDB();

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", createSidebar);
else createSidebar();

window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data.type === "FROM_INJECT") {
        // [DEBUG] Listener Log
        console.log('[Content] Listener received FROM_INJECT');
        addLog(event.data.payload);
    }
});
