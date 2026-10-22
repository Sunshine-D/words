/* 游戏逻辑验证：用内存 mock 模拟 wx 运行时 */
const path = require('path');

/* ---------- mock 运行时 ---------- */
const store = {};
global.wx = {
  getStorageSync: (k) => (store[k] === undefined ? '' : store[k]),
  setStorageSync: (k, v) => {
    store[k] = v;
  },
  removeStorageSync: (k) => {
    delete store[k];
  },
  createWebAudioContext: undefined,
  vibrateShort: () => {},
  showToast: () => {},
  navigateBack: () => {},
  redirectTo: () => {},
  getFileSystemManager: () => ({})
};
global.getApp = () => ({ globalData: { statusBarHeight: 20, navBarHeight: 44 } });

let registered = null;
global.Page = (opt) => {
  registered = opt;
};

const base = path.resolve(__dirname, '../../miniprogram/utils');
const storage = require(path.join(base, 'storage'));

/* ---------- 实例化页面 ---------- */
function setPath(obj, keyPath, value) {
  const keys = keyPath.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]];
  cur[keys[keys.length - 1]] = value;
}

function instantiate(opt) {
  const inst = Object.create(opt);
  inst.data = JSON.parse(JSON.stringify(opt.data));
  inst.setData = function (patch, cb) {
    Object.keys(patch).forEach((k) => setPath(this.data, k, patch[k]));
    if (cb) cb();
  };
  return inst;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  PASS ' + name);
  } else {
    fail += 1;
    console.log('  FAIL ' + name + (extra ? '  -> ' + extra : ''));
  }
}

const WORDS = Array.from({ length: 23 }, (_, i) => ({
  en: 'word' + i,
  cn: 'n. 释义' + i
}));

(async function () {
  console.log('\n[1] 顺序模式 · 第 1 批');
  storage.saveSettings({ batchSize: 6, batchMode: 'sequential', timeLimit: -1, layout: 'side' });
  const book = storage.createBook({ name: '测试词库', words: WORDS, source: {} });
  const bookId = book.id;

  require('../../miniprogram/pages/game/game.js');
  const pageOpt = registered;

  let g = instantiate(pageOpt);
  g.onLoad({ bookId: bookId, batch: '0' });

  check('加载 6 张英文卡', g.data.enCards.length === 6, String(g.data.enCards.length));
  check('加载 6 张中文卡', g.data.cnCards.length === 6, String(g.data.cnCards.length));
  check('总数为 6', g.data.total === 6, String(g.data.total));
  check('不限时显示', g.data.timeText === '不限时', g.data.timeText);

  const enKeys = g.data.enCards.map((c) => c.key);
  const cnKeys = g.data.cnCards.map((c) => c.key);
  check(
    '左右卡片集合一致',
    enKeys.slice().sort().join(',') === cnKeys.slice().sort().join(',')
  );
  check(
    '左右顺序被打乱（不对应）',
    enKeys.join(',') !== cnKeys.join(','),
    'en=' + enKeys.join(',') + ' cn=' + cnKeys.join(',')
  );

  // 按第 1 批的原始词序核对取词是否正确（word0..word5）
  const expected = ['word0', 'word1', 'word2', 'word3', 'word4', 'word5'];
  const pickedIds = g.picked.map((w) => w.en).sort();
  check('第 1 批取词正确', pickedIds.join(',') === expected.join(','), pickedIds.join(','));

  console.log('\n[2] 全部配对 -> 通关');
  for (const key of enKeys) {
    g.onPick({ detail: { side: 'en', key: key } });
    g.onPick({ detail: { side: 'cn', key: key } });
  }
  check('已匹配 6 个', g.data.matched === 6, String(g.data.matched));
  check('进度 100%', g.data.matchPercent === 100, String(g.data.matchPercent));

  await sleep(600);
  check('弹出结算层', g.data.showResult === true, String(g.data.showResult));
  check('结果为胜利', g.data.win === true, String(g.data.win));
  check('星级 3 星', g.data.stars === 3, String(g.data.stars));

  const after = storage.getBook(bookId);
  check('顺序指针推进到第 2 批', after.progress.seqIndex === 1, String(after.progress.seqIndex));
  check('完成批次数 +1', after.progress.batchesDone === 1, String(after.progress.batchesDone));

  console.log('\n[3] 错误配对不应计数');
  let g2 = instantiate(pageOpt);
  g2.onLoad({ bookId: bookId, batch: '1' });
  const k1 = g2.data.enCards[0].key;
  const k2 = g2.data.cnCards.find((c) => c.key !== k1).key;
  g2.onPick({ detail: { side: 'en', key: k1 } });
  g2.onPick({ detail: { side: 'cn', key: k2 } });
  check('错误配对后 matched 仍为 0', g2.data.matched === 0, String(g2.data.matched));
  check('错误卡片进入 wrong 态', g2.data.enCards.find((c) => c.key === k1).state === 'wrong');

  await sleep(500);
  check('错误态自动复位', g2.data.enCards.find((c) => c.key === k1).state === 'idle');

  console.log('\n[4] 超时 -> 闯关失败');
  storage.saveSettings({ timeLimit: 1 });
  let g3 = instantiate(pageOpt);
  g3.onLoad({ bookId: bookId, batch: '2' });
  check('限时 1 秒生效', g3.data.timeText === '00:01' || g3.limit === 1, g3.data.timeText + '/' + g3.limit);
  await sleep(1600);
  check('超时后弹出结算', g3.data.showResult === true, String(g3.data.showResult));
  check('超时判定为失败', g3.data.win === false, String(g3.data.win));

  console.log('\n[5] 随机模式 · 不重复抽词');
  storage.saveSettings({ batchMode: 'random', timeLimit: -1, batchSize: 6 });
  const book2 = storage.createBook({ name: '随机测试', words: WORDS, source: {} });
  let g4 = instantiate(pageOpt);
  g4.onLoad({ bookId: book2.id });
  check('随机模式标记', g4.isSequential === false);
  check('抽出 6 个', g4.picked.length === 6, String(g4.picked.length));
  check('剩余池 17', g4.nextPool.length === 17, String(g4.nextPool.length));

  // 模拟通关，推进 pool
  for (const c of g4.data.enCards) {
    g4.onPick({ detail: { side: 'en', key: c.key } });
    g4.onPick({ detail: { side: 'cn', key: c.key } });
  }
  await sleep(600);
  const b2 = storage.getBook(book2.id);
  check('pool 已写回存储', Array.isArray(b2.progress.pool) && b2.progress.pool.length === 17,
    String(b2.progress.pool && b2.progress.pool.length));

  console.log('\n[6] 时间格式与工具');
  const util = require(path.join(base, 'util'));
  check('formatClock(90) = 01:30', util.formatClock(90) === '01:30', util.formatClock(90));
  check('formatDuration(65000) = 1分5秒', util.formatDuration(65000) === '1分5秒', util.formatDuration(65000));

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail > 0 ? 1 : 0);
})();
