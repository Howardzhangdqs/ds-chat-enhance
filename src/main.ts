// DeepSeek Chat Enhance — SVG / HTML 代码块默认渲染 + 眼睛切换
import { CodeScanner } from './scanner';
import { DomBuilder } from './dombuilder';

const dsceBoot = () => {
  const VERSION = '0.7.2';

  interface DsceGlobal {
    __DSCE__?: { version: string; destroy?: () => void };
  }
  const g = window as unknown as DsceGlobal;
  if (g.__DSCE__ && g.__DSCE__.version === VERSION) return; // 同版本已在运行
  if (g.__DSCE__?.destroy) {
    try {
      g.__DSCE__.destroy();
    } catch {
      /* ignore */
    }
  }

  const PREVIEW_LANGS = new Set(['svg', 'html', 'htm']);
  const UPDATE_DEBOUNCE_MS = 250; // 流式期间的刷新节流
  const RECONCILE_MS = 1000; // 兜底对账周期
  const SETTLE_MS = 1000; // 代码稳定多久算「生成完成」
  const MAX_FRAME_HEIGHT = 640;

  const CSS = `
.md-code-block.dsce-on > pre { display: none; }
.md-code-block.dsce-on.dsce-view-code > pre { display: block; }
.dsce-preview { display: none; padding: 0; overflow: hidden; }
.md-code-block.dsce-on:not(.dsce-view-code) > .dsce-preview { display: block; }
.dsce-frame { display: block; width: 100%; border: 0; background: transparent; }
.dsce-eye {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border: none; border-radius: 999px;
  background: transparent; color: inherit; cursor: pointer;
  transition: background-color .15s ease;
}
.dsce-eye:hover { background: rgba(127, 127, 127, .25); }
.dsce-eye:active { background: rgba(127, 127, 127, .4); }
.dsce-eye svg { width: 16px; height: 16px; display: block; }
.dsce-eye--float { position: absolute; top: 5px; right: 8px; z-index: 30; }
`;

  const EYE_OPEN =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.6 8S4.2 3.8 8 3.8 14.4 8 14.4 8 11.8 12.2 8 12.2 1.6 8 1.6 8Z"/><circle cx="8" cy="8" r="2.1"/></svg>';
  const EYE_OFF =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 2.4 13.6 13.6"/><path d="M6.4 4.2c.5-.1 1-.2 1.6-.2 3.8 0 6.4 4 6.4 4s-.9 1.4-2.4 2.6M4.3 5.3C2.6 6.6 1.6 8 1.6 8s2.6 4 6.4 4c.7 0 1.3-.1 1.9-.3"/><path d="M6.4 7.5a2 2 0 0 0 2.4 2.5"/></svg>';

  interface BlockState {
    block: HTMLElement;
    lang: string;
    mode: 'preview' | 'code';
    appliedText: string | null; // 已处理的最新的原始文本
    pendingText: string | null; // 最近一次排队中的原始文本
    lastChangeAt: number; // 代码最后一次变化的时间
    raw: boolean; // 是否已切换到「原样渲染」模式
    scanner: CodeScanner; // 增量扫描器（缓存已处理部分）
    builder: DomBuilder | null; // 增量 DOM 构建器
    shellKey: string; // iframe 外壳标识（语言 + 背景色）
    timer: ReturnType<typeof setTimeout> | null;
    btn: HTMLButtonElement;
    wrap: HTMLDivElement;
    frame: HTMLIFrameElement;
  }

  const stateMap = new WeakMap<HTMLElement, BlockState>();
  const liveStates = new Set<BlockState>();
  const OWNER = 'o' + Math.random().toString(36).slice(2, 8);
  // 所有权标记放在 DOM 上：Tampermonkey 沙箱与页面世界都能看到，
  // 后启动的实例会接管，旧实例检测到后自行退出（避免控件重复）
  const rootEl = document.documentElement;
  rootEl.dataset.dsceOwner = OWNER;
  const isOwner = () => rootEl.dataset.dsceOwner === OWNER;
  let styleEl: HTMLStyleElement;
  let mo: MutationObserver;
  let reconcileTimer: ReturnType<typeof setInterval>;

  const addStyle = (css: string) => {
    // 移除其它实例注入的样式，保证「最新实例」的规则生效
    document.querySelectorAll('style[data-dsce-style]').forEach((s) => {
      if (s.getAttribute('data-dsce-style') !== OWNER) s.remove();
    });
    styleEl = document.createElement('style');
    styleEl.setAttribute('data-dsce-style', OWNER);
    // 隐藏其它实例留下的控件（多实例共存时只显示当前实例的）
    styleEl.textContent =
      css +
      `\n.dsce-eye:not([data-dsce-owner="${OWNER}"]),` +
      `\n.dsce-preview:not([data-dsce-owner="${OWNER}"]) { display: none !important; }`;
    document.head.appendChild(styleEl);
  };

  /** 读取代码块语言：banner 里第一个不在按钮内的 span 文本 */
  const getBannerLang = (block: HTMLElement): string | null => {
    const banner = block.querySelector('.md-code-block-banner');
    if (!banner) return null;
    for (const span of banner.querySelectorAll('span')) {
      if (span.closest('.ds-button')) continue;
      const t = (span.textContent ?? '').trim().toLowerCase();
      if (t) return t;
    }
    return null;
  };

  /** 流式阶段可能还没有语言标签，退化为按代码内容推断 */
  const inferLang = (code: string): string | null => {
    const head = code.slice(0, 400).trim();
    if (/^<svg[\s>]/i.test(head)) return 'svg';
    if (/^<(!doctype\s+html|html[\s>]|head[\s>]|body[\s>]|div[\s>]|span[\s>]|p[\s>]|table[\s>])/i.test(head))
      return 'html';
    return null;
  };

  const detectLang = (block: HTMLElement, code: string): string | null => {
    const banner = getBannerLang(block);
    if (banner && PREVIEW_LANGS.has(banner)) return banner;
    const inferred = inferLang(code);
    if (inferred) return inferred;
    return banner;
  };

  /** 取代码块（或其祖先）的实际背景色，让预览与代码块无缝融合 */
  const hostBg = (block: HTMLElement): string => {
    let el: HTMLElement | null = block;
    while (el) {
      const c = getComputedStyle(el).backgroundColor;
      if (c && c !== 'transparent' && !/rgba\\(.+,\\s*0\\)$/.test(c)) return c;
      el = el.parentElement;
    }
    return '#fff';
  };

  /**
   * 量 iframe 内容高度。
   * 注意：只靠 scrollHeight 对「只有 viewBox 的 SVG」可能取整偏小，
   * 因此额外用 SVG 的实际 rect 高度兜底（会触发同步布局，取到小数）。
   */
  const contentHeight = (doc: Document): number => {
    let h = Math.max(doc.body?.scrollHeight ?? 0, doc.documentElement?.scrollHeight ?? 0, 0);
    const svg = doc.body?.querySelector('svg');
    if (svg) h = Math.max(h, svg.getBoundingClientRect().height);
    return h;
  };

  /** iframe 载入后按内容量高度（sandbox 保留同源、禁脚本，仍可测量） */
  const fitFrame = (frame: HTMLIFrameElement, lang: string) => {
    try {
      const doc = frame.contentDocument;
      if (!doc || !doc.body) return;
      const h = Math.max(contentHeight(doc), 40);
      // SVG 是图片语义，被截断就看不全，给更宽松的上限；HTML 保持 640 并允许内部滚动
      const limit = lang === 'svg' ? 4000 : MAX_FRAME_HEIGHT;
      frame.style.height = `${Math.ceil(Math.min(h, limit))}px`;
    } catch {
      /* ignore */
    }
  };

  /** iframe 外壳：SVG 与代码块背景融合；HTML 用白底 + 内边距 */
  const shellFor = (lang: string, bg: string): string => {
    // 关键：body 必须有确定宽度（width:100%）且只有它做 flex 容器。
    // 若 html 也 display:flex，body 会变成 shrink-to-fit 的 flex 项，
    // 而 SVG 又依赖 max-width:100% → 循环依赖，body / svg 双双塌成 0×0。
    const css =
      lang === 'svg'
        ? `html,body{margin:0;padding:0;background:${bg};overflow:hidden;}` +
          `body{display:flex;align-items:center;justify-content:center;width:100%;}` +
          `svg,img{display:block;max-width:100%;height:auto;}`
        : 'html,body{margin:0;padding:0;background:#fff;}body{padding:12px;box-sizing:border-box;}';
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body></body></html>`;
  };

  const mountButton = (block: HTMLElement, st: BlockState) => {
    const banner = block.querySelector('.md-code-block-banner');
    const dsBtns = banner ? banner.querySelectorAll('.ds-button') : [];
    const host = dsBtns.length
      ? ((dsBtns[dsBtns.length - 1] as HTMLElement).parentElement as HTMLElement | null)
      : null;
    if (host) {
      st.btn.classList.remove('dsce-eye--float');
      host.appendChild(st.btn); // 原生工具栏最右侧 = 代码块右上角
    } else {
      st.btn.classList.add('dsce-eye--float');
      block.appendChild(st.btn); // 结构变化时退化为悬浮按钮
    }
  };

  const mountPreview = (block: HTMLElement, st: BlockState) => {
    const pre = block.querySelector('pre');
    if (pre) pre.insertAdjacentElement('afterend', st.wrap);
    else block.appendChild(st.wrap);
  };

  /**
   * 用模型给的原始代码重建预览（生成完成后执行一次）。
   * 不做任何标签补齐，交给浏览器原样解析，最大程度还原模型输出。
   */
  const renderRaw = (st: BlockState, raw: string) => {
    const doc = st.frame.contentDocument;
    if (!doc || !doc.body) return;
    try {
      st.block.dataset.dsceRaw = '1'; // 标记：当前是「原样渲染」模式
      if (st.lang === 'svg') {
        doc.body.innerHTML = raw; // 浏览器按原始 SVG 解析
      } else {
        // HTML：保留 head 里的样式与 body 上的属性，只替换内容
        const parsed = new DOMParser().parseFromString(raw, 'text/html');
        doc.head.querySelectorAll('[data-dsce-model]').forEach((el) => el.remove());
        parsed.head.querySelectorAll('style, link[rel="stylesheet"]').forEach((el) => {
          const node = doc.importNode(el, true);
          node.setAttribute('data-dsce-model', '1');
          doc.head.appendChild(node);
        });
        for (const a of Array.from(parsed.body.attributes)) {
          try {
            doc.body.setAttribute(a.name, a.value);
          } catch {
            /* ignore */
          }
        }
        doc.body.innerHTML = parsed.body.innerHTML;
      }
      fitFrame(st.frame, st.lang);
    } catch {
      /* ignore */
    }
  };

  /** 把当前文本增量灌进 iframe（只处理新增部分，只追加新节点） */
  const render = (st: BlockState, text: string) => {
    const lang = st.lang;
    const bg = hostBg(st.block);
    const shellKey = `${lang}|${bg}`;
    if (shellKey !== st.shellKey) {
      // 语言或主题变了 → 换外壳重建
      st.shellKey = shellKey;
      st.scanner = new CodeScanner(lang);
      st.builder = null;
      st.raw = false;
      st.frame.style.background = lang === 'svg' ? 'transparent' : '#fff';
      st.frame.srcdoc = shellFor(lang, bg);
    }
    if (st.raw) {
      renderRaw(st, text); // 已完成 → 原样重建
      return;
    }
    st.scanner.feed(text); // 增量扫描：只解析新增片段
    delete st.block.dataset.dsceRaw; // 增量模式
    if (st.builder) {
      st.builder.apply(st.scanner); // 增量构建：只追加新节点
      fitFrame(st.frame, st.lang);
    }
  };

  const applyNow = (st: BlockState, text: string) => {
    st.pendingText = text;
    if (st.appliedText === text) return;
    st.appliedText = text;
    st.lastChangeAt = Date.now();
    render(st, text);
  };

  const toggle = (block: HTMLElement) => {
    const st = stateMap.get(block);
    if (!st) return;
    st.mode = st.mode === 'preview' ? 'code' : 'preview';
    block.classList.toggle('dsce-view-code', st.mode === 'code');
    const showingCode = st.mode === 'code';
    st.btn.innerHTML = showingCode ? EYE_OFF : EYE_OPEN;
    const label = showingCode ? '显示渲染效果' : '显示源代码';
    st.btn.title = label;
    st.btn.setAttribute('aria-label', label);
    if (st.mode === 'preview') {
      const pre = block.querySelector('pre');
      const text = pre ? (pre.textContent ?? '') : '';
      if (st.appliedText !== text) applyNow(st, text); // 源码有更新时重建预览
    }
  };

  const ensureState = (block: HTMLElement, lang: string): BlockState => {
    let st = stateMap.get(block);
    if (st) {
      if (!st.btn.isConnected) mountButton(block, st);
      if (!st.wrap.isConnected) mountPreview(block, st);
      return st;
    }

    const frame = document.createElement('iframe');
    frame.className = 'dsce-frame';
    frame.setAttribute('sandbox', 'allow-same-origin'); // 禁脚本，可测量
    frame.title = 'preview';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dsce-eye';
    btn.dataset.dsceOwner = OWNER;
    btn.title = '显示源代码';
    btn.setAttribute('aria-label', '显示源代码');
    btn.innerHTML = EYE_OPEN;
    btn.addEventListener('click', () => toggle(block));

    const wrap = document.createElement('div');
    wrap.className = 'dsce-preview';
    wrap.dataset.dsceOwner = OWNER;
    wrap.appendChild(frame);

    st = {
      block,
      lang,
      mode: 'preview',
      appliedText: null,
      pendingText: null,
      lastChangeAt: 0,
      raw: false,
      scanner: new CodeScanner(lang),
      builder: null,
      shellKey: '',
      timer: null,
      btn,
      wrap,
      frame,
    };
    stateMap.set(block, st);
    liveStates.add(st);
    // 外壳载入完成 → 建构建器，把已扫描的内容一次性铺进去
    frame.addEventListener('load', () => {
      try {
        const doc = frame.contentDocument;
        if (!doc || !doc.body) return;
        st.builder = new DomBuilder(doc, st.lang === 'svg');
        st.builder.apply(st.scanner);
        fitFrame(frame, st.lang);
      } catch {
        /* ignore */
      }
    });
    mountButton(block, st);
    mountPreview(block, st);
    block.classList.add('dsce-on');
    return st;
  };

  const process = (block: HTMLElement) => {
    const pre = block.querySelector('pre');
    const text = pre ? (pre.textContent ?? '') : '';
    const lang = detectLang(block, text);
    if (!lang || !PREVIEW_LANGS.has(lang)) return;
    const st = ensureState(block, lang);
    if (st.lang !== lang) {
      // 语言变了 → 重新初始化扫描器与外壳
      st.lang = lang;
      st.scanner = new CodeScanner(lang);
      st.builder = null;
      st.shellKey = '';
      st.appliedText = null;
      st.raw = false;
    }
    if (st.mode !== 'preview' || st.pendingText === text) return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.timer = null;
      if (!block.isConnected) return; // 节点已被替换，新节点有自己的一套状态
      const cur = block.querySelector('pre');
      if (st.mode === 'preview') applyNow(st, cur ? (cur.textContent ?? '') : '');
    }, UPDATE_DEBOUNCE_MS);
  };

  const scan = () => {
    if (!isOwner()) {
      destroy(); // 已被更新的实例接管 → 自行退出
      return;
    }
    document.querySelectorAll<HTMLElement>('.md-code-block').forEach(process);
  };

  /**
   * 兜底对账：保证「当前代码」与「已渲染内容」始终一致。
   * 解决节点被 React 重建、防抖被节流等导致最终态没刷新的问题。
   */
  const reconcile = () => {
    if (!isOwner()) {
      destroy();
      return;
    }
    for (const st of Array.from(liveStates)) {
      const block = st.block;
      if (!block.isConnected) {
        liveStates.delete(st);
        continue;
      }
      if (!st.btn.isConnected) mountButton(block, st);
      if (!st.wrap.isConnected) mountPreview(block, st);
      const pre = block.querySelector('pre');
      const text = pre ? (pre.textContent ?? '') : '';
      if (text === st.appliedText) {
        if (st.mode === 'preview') {
          // 兜底：iframe 已就绪但构建器没建起来（如 load 事件丢失）
          if (!st.builder) {
            try {
              const doc = st.frame.contentDocument;
              if (doc && doc.body) {
                st.builder = new DomBuilder(doc, st.lang === 'svg');
                st.builder.apply(st.scanner);
              }
            } catch {
              /* ignore */
            }
          }
          // 生成完成（代码已稳定一段时间）→ 用模型原始代码原样重建一次
          if (!st.raw && st.appliedText && Date.now() - st.lastChangeAt > SETTLE_MS) {
            st.raw = true;
            renderRaw(st, st.appliedText);
          }
          if (st.builder && !st.frame.style.height) fitFrame(st.frame, st.lang);
        }
        continue;
      }
      if (st.mode !== 'preview') {
        st.pendingText = text; // 源码视图下也记录最新文本
        continue;
      }
      applyNow(st, text);
    }
  };

  /** 窗口/侧栏宽度变化后，SVG 宽度变了 → 按比例重新量一次高度 */
  const refitAll = () => {
    for (const st of Array.from(liveStates)) {
      if (!st.frame.isConnected || !st.wrap.isConnected) continue;
      if (st.mode !== 'preview') continue;
      fitFrame(st.frame, st.lang);
    }
  };

  const destroy = () => {
    mo.disconnect();
    clearInterval(reconcileTimer);
    window.removeEventListener('resize', refitAll);
    styleEl.remove();
    for (const st of liveStates) {
      const block = st.block;
      if (!block.isConnected) continue;
      block.querySelector('.dsce-eye')?.remove();
      block.querySelector('.dsce-preview')?.remove();
      block.classList.remove('dsce-on', 'dsce-view-code');
    }
    liveStates.clear();
    if (isOwner()) delete rootEl.dataset.dsceOwner;
    delete g.__DSCE__;
  };

  addStyle(CSS);
  mo = new MutationObserver(scan);
  mo.observe(document.body, { childList: true, subtree: true });
  reconcileTimer = setInterval(reconcile, RECONCILE_MS);
  window.addEventListener('resize', refitAll);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scan();
  });
  g.__DSCE__ = { version: VERSION, destroy };
  scan();
  console.log('[ds-chat-enhance] svg/html preview ready v' + VERSION);
};

dsceBoot();
