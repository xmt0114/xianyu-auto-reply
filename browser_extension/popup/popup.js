document.getElementById('save').addEventListener('click', () => {
    const key = document.getElementById('ocr_key').value;
    chrome.storage.local.set({ ocr_key: key }, () => {
        alert('配置已保存');
    });
});

// 加载配置
chrome.storage.local.get(['ocr_key'], (result) => {
    if (result.ocr_key) {
        document.getElementById('ocr_key').value = result.ocr_key;
    }
});
