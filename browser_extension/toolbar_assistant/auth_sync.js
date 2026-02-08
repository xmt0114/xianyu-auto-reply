// toolbar_assistant/auth_sync.js

(function () {
    console.log('[XianyuTool] Auth Sync Script Active on hub.yhs.cn');

    function syncToken() {
        // Look for token in localStorage. Common keys: 'token', 'Authorization', 'user_info'
        const possibleKeys = ['token', 'Authorization', 'token_type', 'admin_token', 'userInfo'];
        let token = null;

        for (const key of possibleKeys) {
            const val = localStorage.getItem(key);
            if (val) {
                // If it's a JSON string, try to extract token from it
                if (val.startsWith('{')) {
                    try {
                        const obj = JSON.parse(val);
                        token = obj.token || obj.accessToken || obj.data?.token;
                    } catch (e) { }
                } else {
                    token = val;
                }
            }
            if (token) break;
        }

        if (token) {
            // Remove "Bearer " prefix if present
            token = token.replace(/^Bearer\s+/i, '');

            chrome.storage.local.set({ 'yhs_token': token }, () => {
                console.log('[XianyuTool] Token Synced Successfully');
            });
        } else {
            console.warn('[XianyuTool] Token not found in localStorage. Keys found:', Object.keys(localStorage));
        }
    }

    // Run on load and whenever storage changes
    syncToken();
    window.addEventListener('storage', syncToken);

    // Periodically sync in case of SPAs that don't trigger storage event on same page
    setInterval(syncToken, 5000);
})();
