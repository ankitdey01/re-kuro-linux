/* WebKitGTK compatibility layer for the existing WebView2 UI contract. */
(() => {
    const listeners = [];
    window.chrome = window.chrome || {};
    window.chrome.webview = window.chrome.webview || {
        addEventListener(type, listener) {
            if (type === 'message' && typeof listener === 'function') listeners.push(listener);
        },
        postMessage(message) {
            const channel = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.kuro;
            if (!channel) throw new Error('The Linux desktop bridge is unavailable.');
            channel.postMessage(JSON.stringify(message));
        },
    };

    window.__kuroReceive = (message) => {
        const event = { data: message };
        listeners.slice().forEach((listener) => listener(event));
    };
})();
