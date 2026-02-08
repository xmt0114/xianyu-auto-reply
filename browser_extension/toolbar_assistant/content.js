// toolbar_assistant/content.js

console.log('[XianyuTool] Toolbar Assistant Loaded (V2.3 - Fixed URL Parsing)');

// 1. Selector Constants
const TOOLBAR_SELECTOR = '[class^="sendbox-topbar--"]';
const TEXTAREA_SELECTOR = '[class^="sendbox--"] textarea.ant-input';
const IMAGE_CONTAINER_SELECTOR = '[class^="image-container--"]';
const ITEM_CARD_SELECTOR = '[class^="container--dgZTBkgv"]';

// 2. Global State
let lastOcrResult = null;
let lastOcrError = null; // Store error message for match_fail template
let currentItemInfo = null;

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
        const res = lastOcrResult || {};
        const item = currentItemInfo || {};
        switch (varName) {
            case 'buyer_name':
                // Check header for nickname
                return document.querySelector('[class^="text1--"]')?.innerText ||
                    document.querySelector('[class^="nick-name--"]')?.innerText || '亲';
            case 'item_id':
                return item.id || '{{item_id}}';
            case 'item_price':
                return item.price || '{{item_price}}';
            case 'movie':
                return res.film_name || '{{movie}}';
            case 'cinema':
                return res.cinema_name || '{{cinema}}';
            case 'time':
                return res.show_time || '{{time}}';
            case 'seat':
                return res.seat_no ? res.seat_no.join(', ') : '{{seat}}';
            case 'count':
                return res.seat_num || '{{count}}';
            case 'orig_price':
                return '{{orig_price}}';
            case 'discount_price':
                return '{{discount_price}}';
            case 'ticket_code':
                return '{{ticket_code}}';
            case 'fail_reason':
                return lastOcrError || '未找到场次信息';
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

    setTimeout(() => {
        toast.classList.add('show');
    }, 10);

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// 4. Extraction Helpers
function getProductInfo() {
    const card = document.querySelector(ITEM_CARD_SELECTOR);
    if (!card) return null;

    const link = card.querySelector('a[href*="item?id="]');
    const priceEl = card.querySelector('[class^="money--"]');

    let id = '';
    if (link) {
        const match = link.href.match(/id=(\d+)/);
        if (match) id = match[1];
    }

    currentItemInfo = {
        id: id,
        price: priceEl?.innerText || '',
        title: card.querySelector('[class^="title--"]')?.innerText || ''
    };
    console.log('[XianyuTool] Product Info:', currentItemInfo);
    return currentItemInfo;
}

function getLatestImageUrl() {
    const containers = document.querySelectorAll(IMAGE_CONTAINER_SELECTOR);
    if (containers.length === 0) return null;

    const lastContainer = containers[containers.length - 1];
    // Prioritize high-res image from ant-image
    const highResImg = lastContainer.querySelector('.ant-image-img');
    const thumbImg = lastContainer.querySelector('img:not(.ant-image-img)');

    let url = highResImg?.src || thumbImg?.src;
    if (!url) {
        console.warn('[XianyuTool] No src found on image elements');
        return null;
    }

    console.log('[XianyuTool] Raw image URL found:', url);

    // Clean URL: Enforce HTTPS and protocol relative prefix
    if (url.startsWith('//')) {
        url = 'https:' + url;
    } else if (url.startsWith('http:')) {
        url = url.replace('http:', 'https:');
    }

    // Improved cleaning: Only remove specific Alibaba thumbnail patterns.
    console.log('[XianyuTool] Cleaning URL properties...');
    const cleanedUrl = url.replace(/_(?:\d+x\d+|q\d+|sum|m)\..*$/i, '').replace(/_\.webp$/i, '');

    console.log('[XianyuTool] Resulting Cleaned URL:', cleanedUrl);
    return cleanedUrl;
}

// 5. OCR Logic
async function getAuthToken() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['yhs_token'], (result) => {
            resolve(result.yhs_token);
        });
    });
}

async function performOCR() {
    const token = await getAuthToken();
    if (!token) {
        alert('未找到令牌，请先登录 hub.yhs.cn 刷新一次。');
        return;
    }

    const imageUrl = getLatestImageUrl();
    if (!imageUrl) {
        console.error('[XianyuTool] Extraction failed: No image URL found in chat area.');
        alert('未在当前聊天中识别到图片，请确认页面已加载图片。');
        return;
    }

    console.log('[XianyuTool] >>> OCR Workflow Started <<<');
    console.log('[XianyuTool] URL:', imageUrl);
    const product = getProductInfo();
    console.log('[XianyuTool] Current Product Context:', product);

    const mainBtn = document.getElementById('xianyu-main-menu-btn');
    if (mainBtn) mainBtn.innerText = '🔍 识别中...';

    try {
        console.log('[XianyuTool] Step 1: Fetching image blob...');
        const imgResp = await fetch(imageUrl);
        if (!imgResp.ok) throw new Error(`无法获取图片内容 (HTTP ${imgResp.status})`);
        const blob = await imgResp.blob();
        console.log('[XianyuTool] Image blob fetched, size:', blob.size);

        // 3. Upload to Image Server
        console.log('[XianyuTool] Step 2: Uploading to server...');
        const formData = new FormData();
        formData.append('file', blob, 'screenshot.jpg');
        formData.append('event', 'other');
        formData.append('event_data', (Date.now() - 245678900000 + Math.floor(Math.random() * 1000)).toString());
        formData.append('rapid_local', '1');

        const uploadResp = await fetch('https://up-hub-img.yinghuasuan.com/api/upload_img', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        const uploadResult = await uploadResp.json();
        console.log('[XianyuTool] Upload Result:', uploadResult);

        if (uploadResult.code !== 200) throw new Error('上传失败: ' + (uploadResult.msg || '未知错误'));

        const { new_path, pod } = uploadResult.data;
        console.log('[XianyuTool] Upload success, new_path:', new_path, 'pod:', pod);

        // 4. Identify Information
        console.log('[XianyuTool] Step 3: Identifying ticket info...');
        const idUrl = `https://merchant-api.yinghuasuan.com/mer/v1/order/local_imageIdentify?new_path=${new_path}&pod=${pod}`;
        const idResp = await fetch(idUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const idResult = await idResp.json();
        console.log('[XianyuTool] ID Result:', idResult);

        if (idResult.code === 200) {
            lastOcrResult = idResult.data;
            lastOcrError = null;
            getProductInfo();
            console.log('[XianyuTool] Recognition Success:', lastOcrResult);
            showToast(`识别成功：${lastOcrResult.film_name}`, 'success');

            // Auto-fill success template (3-识别成功报价)
            const successScript = window.XianyuScripts.find(s => s.id === 'match_success');
            if (successScript) fillTextInput(successScript.content);
        } else {
            lastOcrError = idResult.msg;
            lastOcrResult = null;
            console.warn('[XianyuTool] Recognition Failed:', lastOcrError);
            showToast(`识别失败：${lastOcrError}`, 'error');

            // Auto-fill fail template (4-识别失败)
            const failScript = window.XianyuScripts.find(s => s.id === 'match_fail');
            if (failScript) fillTextInput(failScript.content);
        }
    } catch (e) {
        lastOcrError = e.message;
        lastOcrResult = null;
        console.error('[XianyuTool] Exception:', e);
        showToast('异常: ' + e.message, 'error');
    } finally {
        if (mainBtn) mainBtn.innerText = '💬 快捷话术';
    }
}

// 6. UI Implementation
function fillTextInput(text) {
    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (!textarea) return;

    const renderedText = TemplateEngine.render(text);
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    nativeInputValueSetter.call(textarea, renderedText);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
}

function createMenu() {
    const menu = document.createElement('div');
    menu.id = 'xianyu-script-menu';
    menu.style.display = 'none';

    const ocrItem = document.createElement('div');
    ocrItem.className = 'xianyu-menu-item ocr-item';
    ocrItem.innerHTML = `<strong>🔍 识别最新图片 (提取场次+商品)</strong><span class="preview">自动分析聊天图片并关联当前链接</span>`;
    ocrItem.onclick = (e) => {
        e.stopPropagation();
        performOCR();
        menu.style.display = 'none';
    };
    menu.appendChild(ocrItem);

    const scripts = window.XianyuScripts || [];
    scripts.forEach(script => {
        const item = document.createElement('div');
        item.className = 'xianyu-menu-item';
        item.innerHTML = `<strong>${script.title}</strong><span class="preview">${script.content.substring(0, 15)}...</span>`;
        item.onclick = (e) => {
            e.stopPropagation();
            fillTextInput(script.content);
            menu.style.display = 'none';
        };
        menu.appendChild(item);
    });

    return menu;
}

function injectUI() {
    const toolbar = document.querySelector(TOOLBAR_SELECTOR);
    if (!toolbar || document.getElementById('xianyu-quick-reply-wrapper')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'xianyu-quick-reply-wrapper';
    wrapper.style.position = 'relative';

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
    wrapper.appendChild(menu);
    toolbar.appendChild(wrapper);
}

// 7. Initialize
const observer = new MutationObserver(injectUI);
observer.observe(document.body, { childList: true, subtree: true });
injectUI();
getProductInfo(); // Initial capture
