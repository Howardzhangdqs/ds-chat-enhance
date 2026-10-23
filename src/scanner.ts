/**
 * 增量代码扫描器。
 *
 * 目标：流式输出时只处理「新增的那一段」，已处理的部分缓存复用，
 * 避免每次更新都全量重扫（O(n²) → O(n)）。
 *
 * 产出两种东西：
 * 1. render()  —— 补齐未闭合标签后的完整文本（供字符串方式使用）
 * 2. tokens    —— 结构化 token 流（供增量构建 DOM 使用）
 */

export type Token =
  | { type: 'text'; text: string }
  | { type: 'comment'; text: string } // 注释 / doctype：构建 DOM 时忽略，但保留在文本输出里
  | { type: 'open'; name: string; raw: string }
  | { type: 'selfclose'; name: string; raw: string }
  | { type: 'close'; name: string };

const HTML_VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const HTML_RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const SVG_RAW_TEXT = new Set(['script', 'style']);

export class CodeScanner {
  /** 原始文本（全量，append-only） */
  private raw = '';
  /** 已消费到的位置：未写完的标签会停在这里，下次继续解析 */
  private pos = 0;
  /** 已输出的文本（不含尾部补齐的闭合标签） */
  private out = '';
  /** 未闭合元素栈 */
  private stack: string[] = [];
  /** 全部 token（DOM 构建端按游标增量消费） */
  private tokens: Token[] = [];
  /** 处于原始文本元素（script/style）内部时的标签名 */
  private rawTextTag: string | null = null;
  /** 版本号：内容被重写（非追加）时自增，DOM 端据此重建 */
  private v = 0;
  private readonly isHtml: boolean;
  private readonly rawTextTags: Set<string>;

  constructor(lang: string) {
    this.isHtml = lang !== 'svg';
    this.rawTextTags = this.isHtml ? HTML_RAW_TEXT : SVG_RAW_TEXT;
  }

  get version(): number {
    return this.v;
  }

  get openStack(): string[] {
    return this.stack;
  }

  allTokens(): Token[] {
    return this.tokens;
  }

  /** 已处理部分的输出（不含尾部补齐） */
  get output(): string {
    return this.out;
  }

  reset(): void {
    this.raw = '';
    this.pos = 0;
    this.out = '';
    this.stack = [];
    this.tokens = [];
    this.rawTextTag = null;
    this.v++;
  }

  /**
   * 喂入全文（必须以上一次的内容为前缀，否则整体重建）。
   * 返回 true 表示是增量更新，false 表示发生了整体重建。
   */
  feed(text: string): boolean {
    let incremental = true;
    if (!text.startsWith(this.raw)) {
      this.reset();
      incremental = false;
    }
    this.raw = text;
    this.scan();
    return incremental;
  }

  /** 完整输出：已处理文本 + 尾部补齐的闭合标签 */
  render(): string {
    let tail = this.rawTextTag ? this.raw.slice(this.pos) : '';
    let closes = '';
    for (let k = this.stack.length - 1; k >= 0; k--) closes += `</${this.stack[k]}>`;
    return this.out + tail + closes;
  }

  private scan(): void {
    const raw = this.raw;
    let i = this.pos;
    let out = this.out;
    const stack = this.stack;
    const tokens = this.tokens;

    while (i < raw.length) {
      // 原始文本元素内部：内容整体当作文本，直到闭合标签
      if (this.rawTextTag) {
        const re = new RegExp('</\\s*' + this.rawTextTag + '\\s*>', 'i');
        const m = re.exec(raw.slice(i));
        if (!m) break; // 还没写完 → 等更多文本
        const content = raw.slice(i, i + m.index);
        if (content) {
          out += content;
          tokens.push({ type: 'text', text: content });
        }
        i += m.index;
        out += m[0];
        tokens.push({ type: 'close', name: this.rawTextTag });
        i += m[0].length;
        stack.pop();
        this.rawTextTag = null;
        continue;
      }

      const lt = raw.indexOf('<', i);
      if (lt === -1) {
        const t = raw.slice(i);
        out += t;
        tokens.push({ type: 'text', text: t });
        i = raw.length;
        break;
      }
      if (lt > i) {
        const t = raw.slice(i, lt);
        out += t;
        tokens.push({ type: 'text', text: t });
        i = lt;
      }

      // 注释
      if (raw.startsWith('<!--', i)) {
        const end = raw.indexOf('-->', i + 4);
        if (end === -1) break; // 注释未写完 → 丢弃并等待
        const t = raw.slice(i, end + 3);
        out += t;
        tokens.push({ type: 'comment', text: t });
        i = end + 3;
        continue;
      }

      // doctype / 处理指令
      if (raw.startsWith('<!', i) || raw.startsWith('<?', i)) {
        const end = raw.indexOf('>', i);
        if (end === -1) break;
        const t = raw.slice(i, end + 1);
        out += t;
        tokens.push({ type: 'comment', text: t });
        i = end + 1;
        continue;
      }

      // 普通标签
      if (i + 1 >= raw.length) break; // '<' 落在末尾 → 等更多文本再判断
      let j = i + 1;
      let closing = false;
      if (raw[j] === '/') {
        closing = true;
        j++;
        if (j >= raw.length) break; // '</' 落在末尾 → 等更多文本再判断
      }
      const m = /^[a-zA-Z][a-zA-Z0-9:_-]*/.exec(raw.slice(j, j + 64));
      if (!m) {
        out += '<';
        tokens.push({ type: 'text', text: '<' });
        i += 1;
        continue;
      }
      const name = m[0].toLowerCase();
      j += m[0].length;
      let quote = '';
      let end = -1;
      for (let k = j; k < raw.length; k++) {
        const ch = raw[k];
        if (quote) {
          if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === '>') {
          end = k;
          break;
        }
      }
      if (end === -1) break; // 标签没写完 → 丢弃并等待
      const selfClosing = raw[end - 1] === '/';
      const rawTag = raw.slice(i, end + 1);
      out += rawTag;
      i = end + 1;

      if (closing) {
        const idx = stack.lastIndexOf(name);
        if (idx !== -1) {
          // 其上的未闭合元素视为已闭合
          for (let k = stack.length - 1; k > idx; k--) tokens.push({ type: 'close', name: stack[k] });
          tokens.push({ type: 'close', name });
          stack.length = idx;
        }
        continue;
      }

      if (selfClosing || (this.isHtml && HTML_VOID.has(name))) {
        tokens.push({ type: 'selfclose', name, raw: rawTag });
        continue;
      }

      stack.push(name);
      tokens.push({ type: 'open', name, raw: rawTag });
      if (this.rawTextTags.has(name)) this.rawTextTag = name;
    }

    this.pos = i;
    this.out = out;
  }
}
