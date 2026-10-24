// Node >=22.13；不执行打包、不加载WXT。运行后更新完整八维词典CSV。
import { readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const directory = new URL('../core/understanding/', import.meta.url);
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const vocabulary = moduleUrl(stripTypeScriptTypes(readFileSync(new URL('emotion-vocabulary.ts', directory), 'utf8')));
const dictionary = moduleUrl(stripTypeScriptTypes(readFileSync(new URL('emotion-dictionary.ts', directory), 'utf8'))
  .replace("'./emotion-vocabulary'", JSON.stringify(vocabulary)));
const { EMOTION_DICTIONARY, EMOTION_DIMENSIONS } = await import(dictionary);
const csvCell = value => {
  const text = value == null ? '' : String(value);
  return /[,"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const rows = [
  ['term', ...EMOTION_DIMENSIONS].join(','),
  ...EMOTION_DICTIONARY.map(entry => [
    entry.term, ...EMOTION_DIMENSIONS.map(d => entry.scores[d]),
  ].map(csvCell).join(',')),
];
writeFileSync(new URL('emotion-dictionary.csv', directory), `${rows.join('\n')}\n`);
console.log(`已导出 ${EMOTION_DICTIONARY.length} 个词条的八维基础强度`);
