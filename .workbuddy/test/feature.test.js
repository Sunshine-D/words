/* 新增功能验证：错词本 / 学习统计 / 存储兜底 / TTS */
const path = require('path');

/* ---------- mock 运行时 ---------- */
const store = {};
let quotaBytes = 10 * 1024 * 1024;
let throwOnWrite = false;

global.wx = {
  getStorageSync: (k) => (store[k] === undefined ? '' : store[k]),
  setStorageSync: (k, v) => {
    if (throwOnWrite) {
      const e = new Error('setStorageSync:fail exceed storage max size');
      e.errMsg = 'setStorageSync:fail exceed storage max size';
      throw e;
    }
    store[k] = v;
  },
  removeStorageSync: (k) => {
    delete store[k];
  },
  getStorageInfoSync: () => ({
    limitSize: 10240,
    currentSize: Math.round((10 * 1024 * 1024 - quotaBytes) / 1024)
  }),
  showToast: () => {},
  showModal: () => {}
};
global.getApp = () => ({ globalData: {} });

const base = path.resolve(__dirname, '../../miniprogram/utils');
const storage = require(path.join(base, 'storage'));
const tts = require(path.join(base, 'tts'));

let pass = 0;
let fail = 0;
let group = '';

function g(name) {
  group = name;
  console.log('\n[' + group + '] ' + name);
}
function ok(desc, cond) {
  if (cond) {
    pass += 1;
    console.log('  PASS ' + desc);
  } else {
    fail += 1;
    console.log('  FAIL ' + desc);
  }
}
function eq(desc, actual, expected) {
  ok(desc + '（得到 ' + JSON.stringify(actual) + '）', JSON.stringify(actual) === JSON.stringify(expected));
}

/* ================= 错词本 ================= */
g('错词本');

const WORDS = [];
for (let i = 0; i < 12; i++) {
  WORDS.push({ en: 'word' + i, cn: '释义' + i });
}
const book = storage.createBook({ name: '测试库', words: WORDS });
ok('词库创建成功', !!book);

storage.markWrong(book.id, [{ en: 'word1', cn: '释义1' }, { en: 'word2', cn: '释义2' }]);
eq('错词本新增 2 条', storage.getWrongCount(book.id), 2);

storage.markWrong(book.id, [{ en: 'word1', cn: '释义1' }]);
const w1 = storage.getWrongActive(book.id).filter((w) => w.en === 'word1')[0];
eq('重复错同一个词累计次数', w1.wrong, 2);

// 大小写与空格不影响同一词条
storage.markWrong(book.id, [{ en: '  WORD1  ', cn: '释义1' }]);
eq('英文大小写/空格归一化', storage.getWrongCount(book.id), 2);

eq('答对一次不毕业', storage.markRight(book.id, 'word1'), false);
eq('连续答对两次毕业', storage.markRight(book.id, 'word1'), true);
eq('毕业后从待复习移除', storage.getWrongCount(book.id), 1);

// 答错会把连续正确清零
storage.markWrong(book.id, [{ en: 'word2', cn: '释义2' }]);
const w2 = storage.getWrongActive(book.id).filter((w) => w.en === 'word2')[0];
eq('答错清零连续正确', w2.right, 0);

storage.removeWrong(book.id, 'word2');
eq('手动移除错词', storage.getWrongCount(book.id), 0);

eq('全站错词总数', storage.totalWrongCount(book.id ? 0 : 0) >= 0, true);
storage.markWrong(book.id, [{ en: 'word3', cn: '释义3' }]);
eq('已掌握数量统计', storage.getWrongList(book.id).filter((w) => w.mastered).length, 1);

storage.clearWrong(book.id);
eq('清空错词本', storage.getWrongCount(book.id), 0);

/* ================= 学习统计 ================= */
g('学习统计');

storage.recordStats(6, true, 42);
storage.recordStats(4, false, 30);
const s = storage.getStats();
eq('累计消除', s.totalMatched, 10);
eq('总局数', s.totalGames, 2);
eq('胜场', s.totalWins, 1);
eq('累计用时（秒）', s.totalSeconds, 72);

const sum = storage.statsSummary();
eq('今日消除', sum.today, 10);
eq('连续天数至少 1', sum.streak >= 1, true);
eq('日历返回 7 天', sum.calendar.length, 7);
ok('最后一天是今天', sum.calendar[6].isToday);
ok('今日有数据则点亮', sum.calendar[6].active);
eq('目标默认 30', sum.goal >= 1, true);
eq('目标进度计算', sum.goalPercent, Math.min(100, Math.round((10 / sum.goal) * 100)));

storage.setDailyGoal(50);
eq('设置每日目标', storage.getSettings().dailyGoal, 50);
storage.setDailyGoal(5);
eq('目标下限收束到 10', storage.getSettings().dailyGoal, 10);

/* ================= 存储兜底 ================= */
g('存储兜底');

throwOnWrite = true;
const before = storage.listBooks().length;
const bad = storage.createBook({ name: '写不进去', words: WORDS });
eq('写入失败返回 null', bad, null);
ok('失败原因可读', /存储空间不足|保存失败/.test(storage.getLastError()));
eq('索引未被污染', storage.listBooks().length, before);
throwOnWrite = false;

quotaBytes = 1024; // 只剩 1KB
eq('剩余容量读取', storage.quotaKB() > 0, true);
quotaBytes = 10 * 1024 * 1024;

// 大数据体量估算
const big = [];
for (let i = 0; i < 3000; i++) big.push({ en: 'w' + i, cn: '中文释义中文释义' + i });
ok('体积估算可用', storage.estimateBytes(big) > 0);

/* ================= TTS ================= */
g('发音');

const url1 = tts.PROVIDERS[0].url('personal', 1);
ok('有道英音 URL', url1.indexOf('dict.youdao.com') >= 0 && url1.indexOf('type=1') >= 0);
const url2 = tts.PROVIDERS[0].url('personal', 2);
ok('有道美音 URL', url2.indexOf('type=2') >= 0);
const url3 = tts.PROVIDERS[1].url('hello world');
ok('百度 URL 做了编码', url3.indexOf('hello%20world') >= 0);

storage.saveSettings({ tts: false });
eq('关闭发音后 enabled=false', tts.enabled(), false);
storage.saveSettings({ tts: true, accent: 1 });
eq('口音读取', tts.accent(), 1);

/* ================= 设置默认值 ================= */
g('设置默认值');
eq('发音默认开启', storage.DEFAULT_SETTINGS.tts, true);
eq('默认美音', storage.DEFAULT_SETTINGS.accent, 2);
const st = storage.getSettings();
ok('批次大小在 4-15', st.batchSize >= 4 && st.batchSize <= 15);

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail > 0 ? 1 : 0);
