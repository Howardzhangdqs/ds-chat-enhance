import './style.css';

console.log('[ds-chat-enhance] loaded:', location.href);

// ---- 在这里写你的优化逻辑 ----
// 常用能力：
// - GM_addStyle(css)         注入样式（vite-plugin-monkey 已全局声明）
// - GM_setValue/GM_getValue  持久化配置
// - document.querySelector   DeepSeek 是 React SPA，建议配合 MutationObserver

const observeBody = (callback: () => void) => {
  const mo = new MutationObserver(callback);
  mo.observe(document.body, { childList: true, subtree: true });
  return mo;
};

observeBody(() => {
  // SPA 动态渲染时触发（消息列表、代码块等）
});
