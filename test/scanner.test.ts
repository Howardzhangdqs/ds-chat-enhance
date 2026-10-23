import { CodeScanner } from '../src/scanner';

let failed = 0;
const check = (name: string, actual: string, expected: string) => {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log('  expected:', JSON.stringify(expected));
    console.log('  actual  :', JSON.stringify(actual));
  }
};

const render = (code: string, lang: string) => {
  const s = new CodeScanner(lang);
  s.feed(code);
  return s.render();
};

// 1. 完整合法文档 → 原样输出
const fullSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <!-- 脸 -->
  <circle cx="100" cy="100" r="90" fill="#FFD93D" stroke="#333" stroke-width="4"/>
  <path d="M 60 120 Q 100 160 140 120" fill="none" stroke="#333" stroke-width="6" stroke-linecap="round"/>
</svg>`;
check('完整 SVG 不变', render(fullSvg, 'svg'), fullSvg);

// 2. 未闭合 svg → 补 </svg>
const partialSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <circle cx="100" cy="100" r="90" fill="#FFD93D" stroke="#333" stroke-width="4"/>`;
check('未闭合 svg 补标签', render(partialSvg, 'svg'), partialSvg + '</svg>');

// 3. 属性没写完的标签 → 丢弃
const halfAttr = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
  <circle cx="100" cy="100" r="90" fill="#FFD93D"/>
  <circle cx="70" cy="80" r="10" fill="#333`;
check('半截标签丢弃', render(halfAttr, 'svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
  <circle cx="100" cy="100" r="90" fill="#FFD93D"/>
  </svg>`);

// 4. 注释未闭合 → 丢弃
const halfComment = `<svg width="10" height="10">
  <!-- 左眼`;
check('半截注释丢弃', render(halfComment, 'svg'), `<svg width="10" height="10">
  </svg>`);

// 5. HTML 嵌套未闭合 → 逆序补齐
const partialHtml = `<div class="card">
  <h1>标题</h1>
  <p>正文`;
check('HTML 逆序补齐', render(partialHtml, 'html'), `${partialHtml}</p></div>`);

// 6. void 元素不参与闭合
const voidHtml = `<div><br><img src="a.png"><hr></div>`;
check('void 元素不补标签', render(voidHtml, 'html'), voidHtml);

// 7. script 内容不当作标签解析
const scriptHtml = `<div><script>if (a < b) { document.write("<p>x</p>"); }</script><span>ok</span>`;
check('script 原文保留', render(scriptHtml, 'html'), `${scriptHtml}</div>`);

// 8. 属性值里的 '>' 不打断解析
const gtAttr = `<svg><rect width="10" height="10" fill="red" data-x="a>b"/></svg>`;
check('属性内 > 正常', render(gtAttr, 'svg'), gtAttr);

// 9. 文本中的 '<' 当普通文本
const textLt = `<p>1 < 2 and 3 < 4</p>`;
check('文本中的 <', render(textLt, 'html'), textLt);

// 10. 完整 HTML 文档不变
const fullHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>t</title></head>
<body><h1>hi</h1></body>
</html>`;
check('完整 HTML 不变', render(fullHtml, 'html'), fullHtml);

// ---- 增量等价性：分块喂入的结果必须与一次性喂入一致 ----
const streamSvg = `<svg width="100" height="100">
  <g transform="translate(10,10)">
    <circle cx="5" cy="5" r="4" fill="red"/>
    <rect x="1" y="1" width="9" height="9"/>
  </g>
  <text x="1" y="20">hi</text>
</svg>`;
const oneShot = render(streamSvg, 'svg');
const chunked = new CodeScanner('svg');
for (let i = 0; i < streamSvg.length; i += 7) chunked.feed(streamSvg.slice(0, i + 7));
check('分块喂入 == 一次性', chunked.render(), oneShot);

// 流式中途的补齐结果也应与「同样前缀一次性喂入」一致
for (let cut = 5; cut < streamSvg.length; cut += 13) {
  const prefix = streamSvg.slice(0, cut);
  const a = new CodeScanner('svg');
  a.feed(prefix);
  const b = new CodeScanner('svg');
  for (let i = 0; i < prefix.length; i += 3) b.feed(prefix.slice(0, i + 3));
  if (a.render() !== b.render()) {
    failed++;
    console.log(`FAIL  分块一致性 @${cut}`);
    console.log('  expected:', JSON.stringify(a.render()));
    console.log('  actual  :', JSON.stringify(b.render()));
    break;
  }
}
if (failed === 0) console.log('PASS  分块一致性（所有前缀）');

// token 流结构
const sc = new CodeScanner('svg');
sc.feed('<svg><g><circle r="1"/></g></svg>');
const types = sc.allTokens().map((t) => (t.type === 'text' ? 'text' : `${t.type}:${t.name}`));
check(
  'token 流结构',
  types.join(','),
  'open:svg,open:g,selfclose:circle,close:g,close:svg',
);

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
