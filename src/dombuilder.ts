/**
 * 增量 DOM 构建器。
 *
 * 消费 CodeScanner 产出的 token 流，只把「新增」的节点追加到文档里，
 * 不重建整棵树 → 流式更新时没有整段重解析，也就没有闪烁。
 */

import type { CodeScanner, Token } from './scanner';

const SVG_NS = 'http://www.w3.org/2000/svg';

const copyAttrs = (src: Element, dst: Element) => {
  for (const a of Array.from(src.attributes)) {
    try {
      dst.setAttribute(a.name, a.value);
    } catch {
      /* ignore */
    }
  }
};

export class DomBuilder {
  private doc: Document;
  private svg: boolean;
  private stack: Element[] = [];
  private index = 0; // 已消费的 token 数
  private version = -1;

  constructor(doc: Document, svg: boolean) {
    this.doc = doc;
    this.svg = svg;
  }

  /** 应用扫描器产出的 token（增量；扫描器版本变化时整体重建） */
  apply(scanner: CodeScanner): void {
    if (scanner.version !== this.version) {
      this.reset();
      this.version = scanner.version;
    }
    const tokens = scanner.allTokens();
    for (; this.index < tokens.length; this.index++) this.applyToken(tokens[this.index]);
  }

  reset(): void {
    const body = this.doc.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    this.stack = [];
    this.index = 0;
  }

  private current(): Element {
    return this.stack.length ? this.stack[this.stack.length - 1] : this.doc.body;
  }

  private applyToken(t: Token): void {
    if (t.type === 'comment') return; // 注释 / doctype 不进 DOM
    if (t.type === 'text') {
      if (!t.text) return;
      this.current().appendChild(this.doc.createTextNode(t.text));
      return;
    }
    if (t.type === 'close') {
      for (let k = this.stack.length - 1; k >= 0; k--) {
        if (this.stack[k].tagName.toLowerCase() === t.name) {
          this.stack.length = k;
          return;
        }
      }
      return;
    }

    // 借用浏览器解析器解析单个标签，属性/命名空间都由浏览器处理
    const holder = this.svg ? this.doc.createElementNS(SVG_NS, 'svg') : this.doc.createElement('div');
    holder.innerHTML = t.raw;
    const el = holder.firstElementChild;
    if (!el) return;

    if (!this.svg) {
      if (t.name === 'html') {
        copyAttrs(el, this.doc.documentElement);
        return;
      }
      if (t.name === 'body') {
        copyAttrs(el, this.doc.body);
        this.stack.push(this.doc.body);
        return;
      }
      if (t.name === 'head') return; // head 的子元素（style/meta）放进 body 同样生效
    }

    this.current().appendChild(el);
    if (t.type === 'open') this.stack.push(el);
  }
}
