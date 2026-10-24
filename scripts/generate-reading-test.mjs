// 生成可在浏览器阅读的测试页，并用当前八维代码核验人工预期。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { strict as assert } from 'node:assert';

const directory = new URL('../core/understanding/', import.meta.url);
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const vocabulary = moduleUrl(stripTypeScriptTypes(readFileSync(new URL('emotion-vocabulary.ts', directory), 'utf8')));
const dictionary = moduleUrl(stripTypeScriptTypes(readFileSync(new URL('emotion-dictionary.ts', directory), 'utf8'))
  .replace("'./emotion-vocabulary'", JSON.stringify(vocabulary)));
const scoring = moduleUrl(stripTypeScriptTypes(readFileSync(new URL('emotion-scoring.ts', directory), 'utf8'))
  .replace("'./emotion-dictionary'", JSON.stringify(dictionary)));
const { scoreTextEmotions } = await import(scoring);

const vector = (index, score) => Array.from({ length: 8 }, (_, i) => i === index ? score : 0);
const cases = [
  { name: '无关键词', expression: '他打开了门。', expected: Array(8).fill(0), note: '词条命中0次，八维全零。' },
  ...['开心', '悲伤', '温柔', '希望', '害怕', '愤怒', '神秘', '庄严'].map((word, index) => ({
    name: `单维：${word}`, expression: `他感到${word}。`, expected: vector(index, .5),
    note: '仅对应维度0.5，其余补0。每段有效命中1次。',
  })),
  { name: '程度词与平均', expression: '他有点悲伤。她非常悲伤。', expected: vector(1, .5),
    note: '每段两条证据：0.25和0.75；均值0.5，不是累计值1。' },
  { name: '否定排除', expression: '他并不悲伤。', expected: Array(8).fill(0),
    note: '有词条命中，但有效命中0次；证据显示“否定排除”，八维全零。' },
  { name: '否定与有效证据并存', expression: '他并不悲伤。她非常悲伤。', expected: vector(1, .75),
    note: '每段命中2次，有效1次，均值0.75；否定项不进入分母。' },
  { name: '复杂否定', expression: '他不是不开心。', expected: Array(8).fill(0),
    note: '证据显示“复杂否定排除”，当前算法不推断双重否定的真实含义。' },
  { name: '完整长词优先', expression: '他悲痛欲绝。', expected: vector(1, 1),
    note: '命中完整“悲痛欲绝”，悲伤1；不再重复命中其中较短词条。' },
  { name: '强度上限', expression: '他极其悲痛欲绝。', expected: vector(1, 1),
    note: '基础1×程度1.5，单次贡献封顶1。' },
  { name: '混合情绪', expression: '她非常悲伤，但对明天仍充满希望。', expected: [0, .75, 0, .75, 0, 0, 0, 0],
    note: '悲伤和希望独立计算，各0.75；其余补0。' },
  { name: '一词多维', expression: '他悲喜交加。', expected: [.5, .5, 0, 0, 0, 0, 0, 0],
    note: '一个词条同时贡献喜悦和悲伤；总词条命中每段1次，各维有效命中各1次。' },
  { name: '词内“不”', expression: '他非常不安。', expected: vector(4, .75),
    note: '“不安”本身是词条，不把“不”误判为外部否定；恐惧0.75。' },
  { name: '重复不累加强度', expression: '他悲伤。她悲伤。', expected: vector(1, .5),
    note: '悲伤出现多次仍取均值0.5；累计贡献和有效次数增加。' },
  { name: '八维同时命中', expression: '开心，悲伤，温柔，希望，害怕，愤怒，神秘，庄严。', expected: Array(8).fill(.5),
    note: '每段8个词条，八维均为0.5。' },
];
const filler = '桌上放着一本书和两支笔。窗边摆着一张木桌，地面铺着方形地砖。他把纸张放进抽屉，再将杯子移到桌子的另一边。钟表指向下午三点，门外有一条通向楼梯的走廊。他翻到书的下一页，读完上面的几行文字，又将书页摊在桌面上。';
for (const item of cases) {
  item.paragraphs = Array.from({ length: 3 }, () => item.expression + filler);
  // 检查每段和全文，确保填充文字没有意外情绪词。
  for (const text of [item.expression, ...item.paragraphs, item.paragraphs.join('\n')]) {
    assert.deepEqual(scoreTextEmotions(text).vector, item.expected, item.name);
  }
  item.profile = scoreTextEmotions(item.paragraphs.join('\n'));
}
const output = new URL('../docs/reading-test/', import.meta.url);
mkdirSync(output, { recursive: true });
writeFileSync(new URL('cases.json', output), JSON.stringify(cases, null, 2) + '\n');
writeFileSync(new URL('index.html', output), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MBook 阅读测试</title><style>
body{margin:0;background:#f5f4ef;color:#202522;font-family:system-ui,"PingFang SC",sans-serif}
header,aside,article{max-width:760px;margin:24px auto;padding:20px}
header{padding-bottom:0}nav{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
a{color:#24613a}article{background:white;border:1px solid #dddcd5;border-radius:12px}
article p{font-size:20px;line-height:2;margin:20px 0}h1{font-size:26px}
aside{font-size:15px;line-height:1.8;border-top:1px solid #dddcd5}pre{white-space:pre-wrap}
select{padding:8px;font:inherit;max-width:100%}.meta{font-size:14px;line-height:1.7}
</style></head><body>
<header><h1 id="heading"></h1><nav><a id="prev">上一例</a><select id="cases" aria-label="选择用例"></select><a id="next">下一例</a></nav>
<div class="meta">先阅读正文并停留至少10秒，再到插件设置页查看对应标题的命中记录。轻缓滚动，保持正文可见。这里只验证文字识别，不以播放歌曲判断八维算法。</div></header>
<article id="article"></article>
<aside><b>预期结果（请在查看记录后对照）</b><pre id="expected"></pre><div id="note"></div>
<div>向量顺序：喜悦、悲伤、温柔、希望、恐惧、愤怒、神秘、庄严。</div>
<div>实际采集的是可见窗口，不一定是全文。命中次数按记录原文核对；窗口截断修饰短语时，按实际原文判断。</div></aside>
<script>
const cases=${JSON.stringify(cases.map(({ profile, ...item }) => item))};
const requested=Number(new URLSearchParams(location.search).get('case')||0);
const index=Number.isInteger(requested)&&requested>=0&&requested<cases.length?requested:0;
const item=cases[index];
document.title='MBook 测试 '+(index+1)+'：'+item.name;
document.getElementById('heading').textContent=document.title;
const article=document.getElementById('article');
item.paragraphs.forEach(text=>{const p=document.createElement('p');p.textContent=text;article.append(p)});
document.getElementById('expected').textContent=JSON.stringify(item.expected);
document.getElementById('note').textContent=item.note;
const select=document.getElementById('cases');
cases.forEach((item,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=(i+1)+' · '+item.name;select.append(option)});
select.value=String(index);select.addEventListener('change',()=>{location.href='?case='+select.value});
document.getElementById('prev').href='?case='+Math.max(0,index-1);
document.getElementById('next').href='?case='+Math.min(cases.length-1,index+1);
</script></body></html>`);
console.log(`已生成并核验 ${cases.length} 个用例：docs/reading-test/index.html、cases.json`);
