import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const directory = new URL('../core/understanding/', import.meta.url);
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const vocabulary = moduleUrl(stripTypeScriptTypes(readFileSync(new URL('emotion-vocabulary.ts', directory), 'utf8')));
const dictionary = moduleUrl(stripTypeScriptTypes(readFileSync(new URL('emotion-dictionary.ts', directory), 'utf8'))
  .replace("'./emotion-vocabulary'", JSON.stringify(vocabulary)));
const scoring = moduleUrl(stripTypeScriptTypes(readFileSync(new URL('emotion-scoring.ts', directory), 'utf8'))
  .replace("'./emotion-dictionary'", JSON.stringify(dictionary)));
const { scoreTextEmotions } = await import(scoring);
const output = new URL('../docs/reading-test/scenes/', import.meta.url);
const source = JSON.parse(readFileSync(new URL('source.json', output), 'utf8'));
const cases = source.map((item, index) => ({
  ...item, id: index + 1, textLength: item.paragraphs.join('\n').length,
  baseline: scoreTextEmotions(item.paragraphs.join('\n')),
  paragraphBaselines: item.paragraphs.map(text => scoreTextEmotions(text)),
}));
writeFileSync(new URL('cases.json', output), JSON.stringify(cases, null, 2) + '\n');
writeFileSync(new URL('测试集.md', output), `# 自然阅读测试集

21篇原创阅读片段，无重复填充。启动项目测试服务后，打开 http://localhost:8765/scenes/。
每篇保持前台阅读至少10秒，再慢慢向下滚动，查看插件设置中的阅读命中记录。

八维顺序：喜悦、悲伤、温柔、希望、恐惧、愤怒、神秘、庄严。
人工核对要点代表语义意图；代码基线代表当前词典的实际结果，两者可能不一致。
整篇/单段基线不等于插件的可见窗口结果。必须以记录原文和证据为准；
反讽、引用、隐含氛围是能力边界测试，不应把代码结果直接当作正确答案。

切歌：每个新窗口匹配首选不同即切换；全零保持当前，冷启动使用兜底。
30分钟内播过的非当前歌曲仍可能被候选冷却排除。音乐加载失败会尝试其他候选。

建议顺序：16无情绪 → 1喜悦 → 2悲伤 → 4希望 → 6愤怒；
每篇检查原文、向量、selection.selectedId与实际播放，并等加载完成。
场景20应逐段滚动，比较前后窗口；场景11/12比较轻重证据，场景21检查重复均值。

${cases.map(item => `## ${item.id}. ${item.title}（${item.kind}）

核对：${item.check}

${item.paragraphs.join('\n\n')}

当前代码整篇基线：${JSON.stringify(item.baseline.vector.map(n => Number(n.toFixed(3))))}
`).join('\n')}

反馈请附：用例编号、记录原文、八维分数、证据、匹配首选、实际播放歌曲、导出JSON。
`);
writeFileSync(new URL('index.html', output), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MBook 自然阅读测试集</title><style>
body{margin:0;background:#f4f1e9;color:#272c2a;font-family:system-ui,"PingFang SC",sans-serif}
header,aside,article{max-width:720px;margin:24px auto;padding:24px}
nav{display:flex;gap:18px;align-items:center;flex-wrap:wrap}a{color:#236049}
article{background:#fffdf8;border:1px solid #ddd6c8;border-radius:12px}
article h1{font-size:28px}article p{font-size:21px;line-height:2.1;margin:28px 0}
select{font:inherit;padding:8px;max-width:100%}aside{font-size:15px;line-height:1.8}
pre{white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer}
button{font:inherit;padding:8px 12px}textarea{box-sizing:border-box;width:100%;min-height:120px;font:inherit}
@media(max-width:760px){header,aside,article{margin:12px;padding:18px}}
</style></head><body>
<header><nav><a id="prev">上一篇</a><select id="choose" aria-label="选择阅读片段"></select><a id="next">下一篇</a></nav>
<p>21篇原创阅读片段。保持正文前台可见至少10秒，缓慢滚动；随后到插件设置查看命中记录。核对说明位于正文之外。</p>
<a href="测试集.md">完整文字版</a> · <a href="cases.json">代码基线与证据 JSON</a> · <a href="../">基础词典测试</a></header>
<article id="reading"></article>
<aside><h2>读完后核对</h2><p id="kind"></p><p id="check"></p>
<p>人工核对要点与代码基线是两种信息：基线只描述当前算法，不证明语义识别正确。反讽、引用、隐含氛围可能出现误判。</p>
<p>向量顺序：喜悦、悲伤、温柔、希望、恐惧、愤怒、神秘、庄严。</p>
<details><summary>查看当前代码基线（整篇及每段）</summary><pre id="baseline"></pre></details>
<p>插件只分析可见窗口。把记录中的原文粘贴到下面，可用同一评分函数核对这个实际窗口。</p>
<textarea id="input" aria-label="实际采集原文" placeholder="粘贴记录中的原文"></textarea>
<button id="score" disabled>核对窗口分数</button><pre id="result"></pre>
<p>新窗口首选不同即切歌；全零保持当前。匹配首选与播放可能因加载失败不同，非当前歌曲仍有30分钟重复冷却。</p></aside>
<script type="module">
const cases=${JSON.stringify(cases.map(item => ({
  ...item, baseline: { vector: item.baseline.vector, hits: item.baseline.matchedExpressionCount },
  paragraphBaselines: item.paragraphBaselines.map(p => ({ vector: p.vector, hits: p.matchedExpressionCount })),
}))).replaceAll('<', '\\u003c')};
const requested=Number(new URLSearchParams(location.search).get('case')||0);
const index=Number.isInteger(requested)&&requested>=0&&requested<cases.length?requested:0;
const item=cases[index];document.title='MBook 自然测试 '+item.id+'：'+item.title;
const article=document.getElementById('reading'),heading=document.createElement('h1');
heading.textContent=item.title;article.append(heading);
item.paragraphs.forEach(text=>{const p=document.createElement('p');p.textContent=text;article.append(p)});
document.getElementById('kind').textContent='用例 '+item.id+' / '+cases.length+' · '+item.kind+' · '+item.textLength+'字';
document.getElementById('check').textContent=item.check;
document.getElementById('baseline').textContent=JSON.stringify({whole:item.baseline,paragraphs:item.paragraphBaselines},null,2);
const select=document.getElementById('choose');
cases.forEach((c,i)=>{const option=document.createElement('option');option.value=i;option.textContent=c.id+' · '+c.title;select.append(option)});
select.value=index;select.onchange=()=>{location.href='?case='+select.value};
document.getElementById('prev').href='?case='+Math.max(0,index-1);
document.getElementById('next').href='?case='+Math.min(cases.length-1,index+1);
try {
 const {scoreTextEmotions}=await import(${JSON.stringify(scoring)});
 const button=document.getElementById('score');button.disabled=false;
 button.onclick=()=>{const profile=scoreTextEmotions(document.getElementById('input').value);
 document.getElementById('result').textContent=JSON.stringify(profile,null,2)};
} catch {document.getElementById('result').textContent='窗口核对模块加载失败，请使用cases.json查看基线。'}
</script></body></html>`);
console.log(JSON.stringify({ count: cases.length, output: 'docs/reading-test/scenes/',
  zeroBaseline: cases.filter(c => c.baseline.vector.every(n => n === 0)).map(c => c.id),
  lengths: cases.map(c => c.textLength) }));
