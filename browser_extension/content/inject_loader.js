// content/inject_loader.js
// 负责将 inject/main.js 注入到页面主世界(Main World)中，以便访问页面的全局变量(如lib.mtop)

const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject/main.js');
script.onload = function () {
    this.remove(); // 执行完后移除标签
};
(document.head || document.documentElement).appendChild(script);

console.log('[XianyuBot] Inject Loader executed');

// 监听来自注入脚本不仅的消息（如果有需要转发给Background的）
window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data.type && (event.data.type === "FROM_INJECT")) {
        // console.log("[Content] Received from Inject:", event.data.payload);
        // chrome.runtime.sendMessage(event.data.payload); // 转发给Background
    }
});
