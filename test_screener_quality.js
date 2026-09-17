const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const frontend = fs.readFileSync('app.js', 'utf8');
const backend = fs.readFileSync('apps-script/Code.gs', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');

function extractFunction(name, source = frontend) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

let atrMinimum = '0';
const context = {
  App: { screenerResults: [], sortColumn: 'screener-gapOpenPct', sortDirection: 'asc', sortType: 'number' },
  document: { getElementById: () => ({ value: atrMinimum }) }
};
vm.createContext(context);
for (const name of ['getAtrPct', 'isPrimeCandidate', 'compareScreenerValues', 'getVisibleScreenerResults']) {
  vm.runInContext(extractFunction(name), context);
}

const candidate = {
  ticker: 'PRIM', targets: { tp1: 110 }, breakoutDirection: 'bullish', breakoutSignal: 'potential',
  compressionRatio: 1.5, volumeRatio: 1.5, atrPct: 7, gapOpenPct: 0
};
assert.equal(context.isPrimeCandidate(candidate), true);
assert.equal(context.getAtrPct({ atr: 7, close: 100 }), 7);
assert.equal(context.isPrimeCandidate({ ...candidate, atrPct: undefined, atr: 7, close: 100 }), true);
assert.equal(context.isPrimeCandidate({ ...candidate, gapOpenPct: 99 }), true);
assert.equal(context.isPrimeCandidate({ ...candidate, atrPct: 6.99 }), false);
assert.equal(context.isPrimeCandidate({ ...candidate, compressionRatio: 1.51 }), false);
assert.equal(context.isPrimeCandidate({ ...candidate, volumeRatio: 1.49 }), false);
assert.equal(context.isPrimeCandidate({ ...candidate, breakoutDirection: 'bearish' }), false);

context.App.screenerResults = [
  { ...candidate, ticker: 'NULL', atrPct: null, gapOpenPct: null },
  { ...candidate, ticker: 'HIGH', atrPct: 7, gapOpenPct: 2 },
  { ...candidate, ticker: 'ZERO', atrPct: 5, gapOpenPct: 0 },
  { ...candidate, ticker: 'LOW', atrPct: 4.99, gapOpenPct: -1 }
];
const originalOrder = context.App.screenerResults.map(row => row.ticker);
assert.deepEqual(Array.from(context.getVisibleScreenerResults(), row => row.ticker), ['LOW', 'ZERO', 'HIGH', 'NULL']);
assert.deepEqual(context.App.screenerResults.map(row => row.ticker), originalOrder);

context.App.sortDirection = 'desc';
assert.deepEqual(Array.from(context.getVisibleScreenerResults(), row => row.ticker), ['HIGH', 'ZERO', 'LOW', 'NULL']);
context.App.sortDirection = 'asc';

atrMinimum = '5';
assert.deepEqual(Array.from(context.getVisibleScreenerResults(), row => row.ticker), ['ZERO', 'HIGH']);
atrMinimum = '7';
assert.deepEqual(Array.from(context.getVisibleScreenerResults(), row => row.ticker), ['HIGH']);

assert.match(backend, /atrPct[\s\S]*?atr\s*\/\s*lastCandle\.close\s*\*\s*100/);
assert.match(backend, /gapOpenPct[\s\S]*?lastCandle\.open\s*\/\s*previousCandle\.close\s*-\s*1/);
assert.match(html, /id="scan-atr-min"[\s\S]*?value="0" selected[\s\S]*?value="5"[\s\S]*?value="7"/);
assert.match(frontend, /getVisibleScreenerResults\(\)\.map/);
assert.match(frontend, /const canBuy = hasBuySetup/);
assert.match(frontend, /atrPct: atrPct !== null[\s\S]*?gapOpenPct:[\s\S]*?prime: isPrimeCandidate/);
assert.match(backend, /const TRADE_COLUMN_COUNT = 20/);
assert.match(backend, /atrPct: row\[17\][\s\S]*?gapOpenPct: row\[18\][\s\S]*?prime: row\[19\]/);
assert.match(backend, /row\.slice\(0, TRADE_COLUMN_COUNT\)/);
assert.match(backend, /newDoneData\.length, TRADE_COLUMN_COUNT\)\.setValues/);
assert.match(frontend, /createCard\('ATR'[\s\S]*?createCard\('GAP OPEN'[\s\S]*?createCard\('PRIME'/);

const backendContext = {};
vm.createContext(backendContext);
vm.runInContext(extractFunction('getTradeQualityCategories', backend), backendContext);
assert.deepEqual(
  JSON.parse(JSON.stringify(backendContext.getTradeQualityCategories({ atrPct: 5, gapOpenPct: 2, prime: 'YES' }))),
  { atr: '5-<7%', gap: '0-2%', prime: 'prime' }
);
assert.deepEqual(
  JSON.parse(JSON.stringify(backendContext.getTradeQualityCategories({ atrPct: 7, gapOpenPct: 2.01, prime: 'NO' }))),
  { atr: '>=7%', gap: '>2%', prime: 'non-prime' }
);
assert.deepEqual(
  JSON.parse(JSON.stringify(backendContext.getTradeQualityCategories({ atrPct: '', gapOpenPct: '', prime: '' }))),
  { atr: null, gap: null, prime: null }
);

console.log('Screener quality checks passed.');
