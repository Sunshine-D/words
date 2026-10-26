const assert = require('assert');
const path = require('path');
const base = path.resolve(__dirname, '../../miniprogram');
let store = {};
let docs = [];
let requests = 0;
let fail = false;
let page;
let shared = '';
let fileText = '';
let modalConfirm = true;
let messages = [];
const copy = (v) => JSON.parse(JSON.stringify(v));
const collection = {
  where(cond) { return { limit() { return this; }, get() { requests++; return fail ? Promise.reject(new Error('offline')) : Promise.resolve({ data: copy(docs.filter(d => d.key === cond.key)) }); } }; },
  add({ data }) { requests++; if (fail) return Promise.reject(new Error('offline')); docs.push(Object.assign({ _id: 'snapshot' }, copy(data))); return Promise.resolve({ _id: 'snapshot' }); },
  doc(id) { return { update({ data }) { requests++; if (fail) return Promise.reject(new Error('offline')); Object.assign(docs.find(d => d._id === id), copy(data)); return Promise.resolve({ stats: { updated: 1 } }); } }; }
};
global.wx = {
  getStorageSync: k => store[k] === undefined ? '' : copy(store[k]),
  setStorageSync: (k, v) => { store[k] = copy(v); }, removeStorageSync: k => { delete store[k]; },
  getStorageInfoSync: () => ({ currentSize: 0, limitSize: 10240 }),
  cloud: { init() { requests++; }, database: () => ({ collection: () => collection }) },
  onNetworkStatusChange() {},
  env: { USER_DATA_PATH: '/local' },
  getFileSystemManager: () => ({
    writeFile(o) { fileText = o.data; o.success(); },
    readFile(o) { o.success({ data: fileText }); }, unlink() {}
  }),
  shareFileMessage(o) { shared = o.fileName; o.success(); },
  chooseMessageFile(o) { o.success({ tempFiles: [{ path: '/backup.json', size: fileText.length }] }); },
  showModal(o) { messages.push(o.title); if (o.success) o.success({ confirm: modalConfirm }); },
  showToast() {}
};
global.getApp = () => ({ requirePrivacy: () => Promise.resolve() });
global.Page = p => { page = p; page.setData = patch => Object.assign(page.data, patch); };
const storage = require(path.join(base, 'utils/storage'));
const backup = require(path.join(base, 'utils/backup'));
const cloud = require(path.join(base, 'utils/cloud'));
require(path.join(base, 'pages/data/data'));
let count = 0;
async function test(name, fn) { await fn(); count++; console.log('PASS ' + name); }
// Event handlers delegate to the real run method; capture its Promise to await full UI flow.
const run = page.run;
let pending;
page.run = function (action) { pending = run.call(this, action); return pending; };
(async () => {
  storage.createBook({ name: '本机', words: [{ en: 'apple', cn: '苹果' }] });
  await test('opening data page does not contact cloud', () => { page.onLoad(); page.onShow(); assert.equal(requests, 0); });
  await test('export event shares versioned JSON', async () => {
    page.exportFile(); await pending; assert(shared.endsWith('.json')); assert.equal(backup.parse(fileText).books.length, 1);
  });
  await test('import event restores through production storage', async () => {
    page.importFile(); await pending; assert.equal(storage.listBooks().length, 2); assert.equal(page.data.busy, false);
  });
  await test('cancelled restore leaves data unchanged', async () => {
    modalConfirm = false; const before = copy(store); page.importFile(); await pending; assert.deepEqual(store, before); modalConfirm = true;
  });
  await test('cancelled cloud action performs zero requests', async () => {
    modalConfirm = false; const before = requests; page.cloudBackup(); await pending; assert.equal(requests, before); modalConfirm = true;
  });
  await test('manual cloud backup saves a complete isolated snapshot', async () => {
    page.cloudBackup(); await pending; assert.equal(docs.length, 1); assert.equal(docs[0].key, 'backup-v1'); assert.equal(docs[0].backup.books.length, 2);
  });
  await test('second cloud backup replaces same snapshot', async () => {
    await cloud.saveBackup(backup.create()); assert.equal(docs.length, 1);
  });
  await test('cloud restore event preserves existing books', async () => {
    page.cloudRestore(); await pending; assert.equal(storage.listBooks().length, 4);
  });
  await test('failed cloud operation leaves local data unchanged and reports error', async () => {
    fail = true; const before = copy(store); page.cloudBackup(); await pending;
    assert.deepEqual(store, before); assert(messages.includes('操作未完成')); assert.equal(page.data.busy, false); fail = false;
  });
  await test('oversize cloud snapshot is refused before query/write', async () => {
    const before = requests; await assert.rejects(cloud.saveBackup({ text: 'x'.repeat(901 * 1024) }), /900KB/); assert.equal(requests, before);
  });
  await test('empty cloud backup reports missing data', async () => {
    docs = []; await assert.rejects(cloud.loadBackup(), /还没有/);
  });
  console.log('通过 ' + count + ' 项');
})().catch(e => { console.error(e); process.exitCode = 1; });
