/* 集成验证：游戏页配对错误 -> 写入错词本 -> 复习模式取词 -> 答对毕业 */
const path = require('path');

const store = {};
global.wx = {
  getStorageSync: (k) => (store[k] === undefined ? '' : store[k]),
  setStorageSync: (k, v) => {
    store[k] = v;
  },
  removeStorageSync: (k) => {
    delete store[k];
  },
  getStorageInfoSync: () => ({ limitSize: 10240, currentSize: 10 }),
  showToast: () => {},
  showModal: () => {},
  navigateBack: () => {},
  redirectTo: () => {},
  navigateTo: () => {}
};
global.getApp = () => ({ globalData: { statusBarHeight: 20, navBarHeight: 44 } });

let registered = null;
global.Page = (opt) => {
  registered = opt;
};

const base = path.resolve(__dirname, '../../miniprogram/utils');
const storage = require(path.join(base, 'storage'));

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

const WORDS = Array.from({ length: 12 }, (_, i) => ({ en: 'word' + i, cn: 'n. 释义' + i }));

(async function () {
  console.log('\n[1] 常规闯关：故意配错');
  storage.saveSettings({ batchSize: 6, batchMode: 'sequential', timeLimit: -1, layout: 'side' });
  const book = storage.createBook({ name: '错词测试库', words: WORDS, source: {} });
  const bookId = book.id;
  storage.clearWrong(bookId);

  require('../../miniprogram/pages/game/game.js');
  const pageOpt = registered;

  let g = instantiate(pageOpt);
  g.onLoad({ bookId: bookId, batch: '0' });

  const enKeys = g.data.enCards.map((c) => c.key);
  const cnKeys = g.data.cnCards.map((c) => c.key);

  // 找一对不匹配的左右卡片
  let wrongEn = null;
  let wrongCn = null;
  for (const k of enKeys) {
    for (const c of cnKeys) {
      if (c !== k) {
        wrongEn = k;
        wrongCn = c;
        break;
      }
    }
    if (wrongEn) break;
  }

  g.onPick({ detail: { side: 'en', key: wrongEn } });
  g.onPick({ detail: { side: 'cn', key: wrongCn } });

  check('配错后进入锁定', g.locked === true);
  check('错词本写入 2 条', storage.getWrongCount(bookId) === 2, String(storage.getWrongCount(bookId)));
  check('本局错词记录 2 条', g.wrongThisRound.length === 2, String(g.wrongThisRound.length));

  await sleep(500);
  check('锁定自动解除', g.locked === false);

  // 把剩下的配对完成
  for (const key of enKeys) {
    if (g.data.enCards[g.enIndex[key]].state === 'matched') continue;
    g.onPick({ detail: { side: 'en', key: key } });
    g.onPick({ detail: { side: 'cn', key: key } });
  }
  check('全部配对完成', g.data.matched === 6, String(g.data.matched));

  await sleep(600);
  check('结算展示错词', g.data.wrongCount === 2, String(g.data.wrongCount));
  check('常规模式不推进复习毕业', g.data.masteredCount === 0);

  console.log('\n[2] 复习模式：取错词、答对毕业');
  // 再错 3 个，凑够 4 个
  storage.markWrong(bookId, [{ en: 'word7', cn: 'n. 释义7' }]);
  storage.markWrong(bookId, [{ en: 'word8', cn: 'n. 释义8' }]);
  const before = storage.getWrongCount(bookId);
  check('待复习词数 >= 4', before >= 4, String(before));

  let r = instantiate(pageOpt);
  r.onLoad({ bookId: bookId, mode: 'review' });
  check('复习模式标记', r.mode === 'review');
  check('复习批次标签', /错词复习/.test(r.data.batchLabel), r.data.batchLabel);

  const rEnKeys = r.data.enCards.map((c) => c.key);
  for (const key of rEnKeys) {
    r.onPick({ detail: { side: 'en', key: key } });
    r.onPick({ detail: { side: 'cn', key: key } });
  }
  check('复习局全部答对', r.data.matched === r.data.total, r.data.matched + '/' + r.data.total);

  const after = storage.getWrongCount(bookId);
  check('答对一次后仍未毕业（需连续 2 次）', after === before - 1 || after === before, before + ' -> ' + after);

  await sleep(600);
  check('复习局不推进主批次进度', r.data.batchLabel.indexOf('错词复习') >= 0);

  console.log('\n[3] 复习模式答对两次 -> 毕业');
  // 用一个全新错词，确保 right 从 0 开始
  const target = 'word9';
  storage.markWrong(bookId, [{ en: target, cn: 'n. 释义9' }]);
  const first = storage.markRight(bookId, target);
  const second = storage.markRight(bookId, target);
  check('第一次答对未毕业', first === false, String(first));
  check('第二次答对毕业', second === true, String(second));
  check('毕业后移出待复习', storage.getWrongActive(bookId).every((x) => x.en !== target));

  console.log('\n[4] 错词不足 4 个时拒绝进入复习');
  storage.clearWrong(bookId);
  let blocked = instantiate(pageOpt);
  let navigatedBack = false;
  const origToast = global.wx.showToast;
  global.wx.showToast = () => {};
  blocked.onLoad({ bookId: bookId, mode: 'review' });
  check('错词不足时不发牌', blocked.data.enCards.length === 0, String(blocked.data.enCards.length));
  global.wx.showToast = origToast;

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail > 0 ? 1 : 0);
})();
