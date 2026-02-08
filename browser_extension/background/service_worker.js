// background/service_worker.js

console.log('[XianyuBot] Background Service Worker Started');

// 监听来自Content Script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    handleMessage(request, sender, sendResponse);
    return true; // 保持消息通道开启以进行异步响应
});

async function handleMessage(request, sender, sendResponse) {
    const { type, payload } = request;

    try {
        switch (type) {
            case 'OCR_IMAGE':
                // 调用第三方OCR API
                // const result = await api.ocr(payload.url);
                // sendResponse({ success: true, data: result });
                console.log('Received OCR Request:', payload);
                sendResponse({ success: true, data: { mock: '识别结果占位符' } });
                break;
                
            case 'GET_TICKET_QUOTE':
                // 调用票务API查价
                console.log('Received Quote Request:', payload);
                sendResponse({ success: true, data: { price: 35.5, original: 80 } });
                break;
                
            case 'PLACE_ORDER':
                // 下单逻辑
                console.log('Received Order Request:', payload);
                sendResponse({ success: true, orderId: 'MOCK_ORDER_123' });
                break;
                
            default:
                console.warn('Unknown message type:', type);
                sendResponse({ success: false, error: 'Unknown type' });
        }
    } catch (error) {
        console.error('Error handling message:', error);
        sendResponse({ success: false, error: error.message });
    }
}
