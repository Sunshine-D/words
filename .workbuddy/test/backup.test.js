const assert = require('assert');
const path = require('path');
const base = path.resolve(__dirname, '../../miniprogram');
let store = {};
let failKey = '';
let cloudCalls = 0;
global.wx = {
  getStorageSync: (k) => store[k] === undefined ? '' : JSON.parse(JSON.stringify(store[k])),
  setStorageSync: (k, v) => { if (k === failKey) { failKey = ''; throw new Error('injected write failure'); } store[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: (k) => { delete store[k]; },
  getStorageInfoSync: () => ({ currentSize: 100, limitSize: 10240 }),
  cloud: { init() { cloudCalls++; throw new Error('must not connect'); } },
  showModal() {}, showToast() {}
};
const storage = require(path.join(base, 'utils/storage'));
const backup = require(path.join(base, 'utils/backup'));
const sync = require(path.join(base, 'utils/sync'));
let count = 0;
function test(name, fn) { fn(); count++; console.log('PASS ' + name); }
test('upgrade from auto stays local and does not connect', () => {
  store.wm_sync_mode = 'auto'; assert.equal(sync.init(), 'local'); assert.equal(cloudCalls, 0);
});
test('capacity is measured in KB', () => assert.equal(storage.quotaKB(), 10140));
const book = storage.createBook({ name: '测试', words: ['a','b','c','d'].map(en => ({ en, cn: '释义' })) });
storage.markWrong(book.id, [{ en: 'a', cn: '释义' }]);
storage.recordStats(4, true, 12);
storage.recordPlay(book.id, { matched: 4, win: true, ms: 12000, seqIndex: 1 });
const snapshot = backup.create();
test('file round trip retains words, wrong words, progress and stats', () => {
  store = {};
  backup.restore(backup.parse(JSON.stringify(snapshot)));
  const restored = storage.listBooks()[0];
  assert.equal(restored.progress.seqIndex, 1);
  assert.equal(storage.getWords(restored.id).length, 4);
  assert.equal(storage.getWrongCount(restored.id), 1);
  assert.equal(storage.getStats().totalMatched, 4);
});
test('repeat restore keeps existing books and does not inflate statistics', () => {
  backup.restore(snapshot); assert.equal(storage.listBooks().length, 2); assert.equal(storage.getStats().totalMatched, 4);
});
test('corrupt files leave local data intact', () => {
  const before = JSON.stringify(store);
  assert.throws(() => backup.parse('{'));
  const bad = JSON.parse(JSON.stringify(snapshot)); bad.books[0].words[0].en = null;
  assert.throws(() => backup.restore(bad)); assert.equal(JSON.stringify(store), before);
});
test('invalid statistics rejected before writes', () => {
  const bad = JSON.parse(JSON.stringify(snapshot)); Object.values(bad.stats.days)[0].games = -1;
  assert.throws(() => backup.restore(bad));
});
test('invalid settings and progress rejected before writes', () => {
  const bad = JSON.parse(JSON.stringify(snapshot)); bad.settings.layout = 'invalid';
  assert.throws(() => backup.restore(bad));
  bad.settings.layout = 'side'; bad.books[0].book.progress.pool = 'invalid';
  assert.throws(() => backup.restore(bad));
});
test('insufficient capacity refuses restore before changing local data', () => {
  const before = JSON.stringify(store); const info = wx.getStorageInfoSync;
  wx.getStorageInfoSync = () => ({ currentSize: 10240, limitSize: 10240 });
  assert.throws(() => backup.restore(snapshot), /空间不足/);
  assert.equal(JSON.stringify(store), before); wx.getStorageInfoSync = info;
});
test('index write failure rolls back words, settings and stats', () => {
  const before = JSON.stringify(store);
  failKey = 'wm_books'; assert.throws(() => backup.restore(snapshot));
  assert.equal(JSON.stringify(store), before);
});
test('interrupted restore recovers on restart', () => {
  const before = storage.listBooks();
  store.wm_restore_journal = { ids: ['pending'], books: before, settings: storage.getSettings(), stats: storage.getStats(), committed: false };
  store.wm_words_pending = [{ en: 'partial' }];
  backup.recover(); assert.equal(store.wm_words_pending, undefined); assert.deepEqual(storage.listBooks(), before);
});
test('empty backup restores successfully', () => {
  store = {}; const empty = backup.create(); backup.restore(empty); assert.equal(storage.listBooks().length, 0);
});
test('failed delete keeps words and index', () => {
  const b = storage.createBook({ words: [{ en: 'x', cn: '字' }] });
  failKey = 'wm_books'; assert.equal(storage.deleteBook(b.id), false);
  assert(storage.getBook(b.id)); assert.equal(storage.getWords(b.id).length, 1);
});
test('App launch does not initialize cloud even for legacy auto setting', () => {
  store.wm_sync_mode = 'auto'; let app;
  global.App = (definition) => { app = definition; };
  require(path.join(base, 'app')); app.onLaunch(); assert.equal(cloudCalls, 0);
});
console.log('通过 ' + count + ' 项');
