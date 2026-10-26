/**
 * 云同步 / 存储模式切换 集成测试
 * 用内存版 wx.cloud 桩模拟云开发，验证：
 *   降级路径、模式切换、冲突合并、脏键持久化、离线暂存、storage 钩子
 */
const path = require('path');
const base = path.resolve(__dirname, '../../miniprogram/utils');

/* ---------- 内存云开发桩 ---------- */
let seq = 1;
let offline = false;
let cloudOk = true;

function makeStore() {
  return [];
}

function matches(item, cond) {
  const keys = Object.keys(cond || {});
  for (let i = 0; i < keys.length; i++) {
    if (item[keys[i]] !== cond[keys[i]]) return false;
  }
  return true;
}

function query(store, items) {
  const q = {
    limit(n) {
      items = items.slice(0, n);
      return q;
    },
    skip(n) {
      items = items.slice(n);
      return q;
    },
    get() {
      return Promise.resolve({ data: items.slice() });
    },
    remove() {
      items.forEach(function (it) {
        const i = store.indexOf(it);
        if (i >= 0) store.splice(i, 1);
      });
      return Promise.resolve({ stats: { removed: items.length } });
    },
    update(opts) {
      items.forEach(function (it) {
        Object.assign(it, (opts && opts.data) || {});
      });
      return Promise.resolve({ stats: { updated: items.length } });
    }
  };
  return q;
}

const DB = {
  books: makeStore(),
  words: makeStore(),
  wrong: makeStore(),
  stats: makeStore(),
  settings: makeStore()
};

function collection(name) {
  const store = DB[name];
  return {
    where(cond) {
      return query(
        store,
        store.filter(function (it) {
          return matches(it, cond);
        })
      );
    },
    doc(id) {
      return {
        update(opts) {
          const hit = store.filter(function (it) {
            return it._id === id;
          })[0];
          if (!hit) {
            return Promise.reject({ errMsg: 'document does not exist' });
          }
          Object.assign(hit, (opts && opts.data) || {});
          return Promise.resolve({ stats: { updated: 1 } });
        }
      };
    },
    add(opts) {
      if (!cloudOk) return Promise.reject({ errMsg: 'cloud error' });
      const doc = Object.assign({ _id: 'c' + seq++ }, (opts && opts.data) || {});
      store.push(doc);
      return Promise.resolve({ _id: doc._id });
    },
    skip(n) {
      return query(store, store.slice()).skip(n);
    },
    limit(n) {
      return query(store, store.slice()).limit(n);
    },
    get() {
      return query(store, store.slice()).get();
    }
  };
}

/* ---------- wx 桩 ---------- */
const mem = {};
global.wx = {
  getStorageSync: function (k) {
    return mem[k] === undefined ? '' : mem[k];
  },
  setStorageSync: function (k, v) {
    mem[k] = v;
  },
  removeStorageSync: function (k) {
    delete mem[k];
  },
  getStorageInfoSync: function () {
    return { currentSize: 200, limitSize: 10240 };
  },
  getNetworkTypeSync: function () {
    return { networkType: offline ? 'none' : 'wifi' };
  }
};

function enableCloudSdk() {
  global.wx.cloud = {
    init: function () {},
    database: function () {
      return { collection: collection };
    }
  };
}

/* ---------- 加载被测模块 ---------- */
const storage = require(path.join(base, 'storage'));
const cloud = require(path.join(base, 'cloud'));
const sync = require(path.join(base, 'sync'));

/* ---------- 断言 ---------- */
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra ? ' -> ' + extra : ''));
  }
}
function reset() {
  Object.keys(mem).forEach(function (k) {
    delete mem[k];
  });
  Object.keys(DB).forEach(function (k) {
    DB[k].length = 0;
  });
  seq = 1;
  offline = false;
  cloudOk = true;
}

/* ================= 1. 降级路径 ================= */
console.log('\n[1] 无云开发 SDK 时的降级');
let pullVal = 'notset';
(function () {
  reset();
  delete global.wx.cloud;
  check('init 返回 false', cloud.init() === false);
  const pr = cloud.pullAll();
  pr.then(function (v) {
    pullVal = v;
  });
  check('pullAll 返回 Promise 而非抛异常', !!pr && typeof pr.then === 'function');
  check('pushBook 不抛异常', cloud.pushBook({ id: 'b1' }, []) instanceof Promise);
  // 默认 auto：没有云就安静地退回本机，cloudOn 必须为 false
  const m = sync.init();
  check('sync.init 不抛异常且默认 auto', m === 'auto', '实际 ' + m);
  check('无云时 cloudOn 为 false', sync.statusSnapshot().cloudOn === false);
  const b = storage.createBook({ name: '本地词库', words: [{ en: 'a', cn: '啊' }] });
  check('本地模式仍能建词库', !!b);
  check('本地模式不产生脏键', sync.statusSnapshot().dirtyCount === 0);
})();

/* ================= 2. 云端往返 ================= */
console.log('\n[2] 云环境可用时的读写往返');
enableCloudSdk();
(function () {
  reset();
  check('cloud 可用', cloud.init() === true);
  const words = [{ en: 'personal', cn: 'adj. 私人的' }, { en: 'tie', cn: 'v. 系' }];
  return Promise.resolve()
    .then(function () {
      check('无 SDK 时 pullAll 解析为 null', pullVal === null, '实际 ' + pullVal);
    })
    .then(function () {
      return cloud.pushBook({ id: 'b1', name: 'T', updatedAt: 100 }, words);
    })
    .then(function () {
    check('books 集合写入 1 条', DB.books.length === 1);
    check('words 集合写入 1 条', DB.words.length === 1);
    check('词表内容保真', DB.words[0].words.length === 2 && DB.words[0].words[0].en === 'personal');
    return cloud.pullAll();
  }).then(function (data) {
    check('pullAll 拉回 1 本词库', data && data.books.length === 1);
    check('pullAll 拉回词表', data.words['b1'].length === 2);
    // 二次更新应复用 _id，不产生新文档
    return cloud.pushBook({ id: 'b1', name: 'T2', updatedAt: 200 }, words);
  }).then(function () {
    check('更新复用文档（未新增）', DB.books.length === 1, '实际 ' + DB.books.length);
    check('更新内容生效', DB.books[0].book.name === 'T2');
  });
})().then(function () {
  /* ================= 3. 模式切换 ================= */
  console.log('\n[3] 模式切换与冲突处理');
  reset();
  // 本地建 2 本
  storage.createBook({ name: '本地A', words: [{ en: 'a', cn: '啊' }] });
  storage.createBook({ name: '本地B', words: [{ en: 'b', cn: '波' }] });

  return sync.enableCloud('keep-local').then(function (ok) {
    check('开启云同步成功', ok === true);
    check('模式变为 auto', sync.getMode() === 'auto', '实际 ' + sync.getMode());
    check('cloudOn 为 true', sync.statusSnapshot().cloudOn === true);
    check('本地 2 本已上云', DB.books.length === 2, '实际 ' + DB.books.length);
    check('词表同步上云', DB.words.length === 2);
    check('同步后无残留脏键', sync.statusSnapshot().dirtyCount === 0);
    return sync.disableCloud();
  }).then(function () {
    check('关闭后模式为 local', sync.getMode() === 'local');
  });
}).then(function () {
  /* ================= 4. 新设备拉取 ================= */
  console.log('\n[4] 换设备（本地空 + 云端有数据）');
  const savedBooks = DB.books.map(function (d) { return d; });
  const savedWords = DB.words.map(function (d) { return d; });
  reset();
  DB.books.push.apply(DB.books, savedBooks);
  DB.words.push.apply(DB.words, savedWords);
  check('本地词库为空', storage.listBooks().length === 0);

  return sync.enableCloud('keep-cloud').then(function () {
    const books = storage.listBooks();
    check('拉回 2 本词库', books.length === 2, '实际 ' + books.length);
    check('词表一并恢复', storage.getWords(books[0].id).length > 0);
  });
}).then(function () {
  /* ================= 5. 离线暂存 ================= */
  console.log('\n[5] 断网时的行为');
  reset();
  sync.disableCloud();
  return sync.enableCloud('keep-local').then(function () {
    offline = true;
    const b = storage.createBook({ name: '离线新增', words: [{ en: 'x', cn: '叉' }] });
    storage.markWrong(b.id, [{ en: 'x', cn: '叉' }]);
    check('离线时脏键被记录', sync.statusSnapshot().dirtyCount > 0);
    check('离线时未推上云', DB.books.length === 0, '实际 ' + DB.books.length);
    check('数据仍在本机', storage.listBooks().length === 1);
    check('状态标记不可用', sync.statusSnapshot().status === 'unavailable');
    offline = false;
    return sync.syncNow();
  }).then(function () {
    check('恢复网络后补推成功', DB.books.length === 1, '实际 ' + DB.books.length);
    check('补推后清空脏键', sync.statusSnapshot().dirtyCount === 0);
  });
}).then(function () {
  /* ================= 6. storage 钩子 ================= */
  console.log('\n[6] 业务写入自动标记同步');
  reset();
  sync.disableCloud();
  return sync.enableCloud('keep-local').then(function () {
    const b = storage.createBook({ name: '钩子测试', words: [{ en: 'h', cn: '喝' }] });
    return new Promise(function (r) { setTimeout(r, 1200); }).then(function () {
      check('创建词库触发上云', DB.books.length >= 1, '实际 ' + DB.books.length);
      storage.recordPlay(b.id, { matched: 1, win: true, ms: 1000 });
      return new Promise(function (r) { setTimeout(r, 1200); });
    }).then(function () {
      check('闯关记录触发同步', sync.statusSnapshot().dirtyCount === 0);
      storage.recordStats(3, true, 30);
      return new Promise(function (r) { setTimeout(r, 1200); });
    }).then(function () {
      check('统计上云', DB.stats.length === 1, '实际 ' + DB.stats.length);
      check('统计内容正确', DB.stats[0].stats.totalMatched === 3);
    });
  });
}).then(function () {
  /* ================= 7. 删除同步 ================= */
  console.log('\n[7] 删除词库的同步');
  reset();
  sync.disableCloud();
  return sync.enableCloud('keep-local').then(function () {
    const b = storage.createBook({ name: '待删除', words: [{ en: 'd', cn: '的' }] });
    return new Promise(function (r) { setTimeout(r, 1200); }).then(function () {
      check('删除前云端有 1 本', DB.books.length === 1);
      storage.deleteBook(b.id);
      return new Promise(function (r) { setTimeout(r, 1200); });
    }).then(function () {
      check('删除后云端清空', DB.books.length === 0, '实际 ' + DB.books.length);
      check('删除后词表也清了', DB.words.length === 0);
    });
  });
}).then(function () {
  /* ================= 8. 云故障不影响本地 ================= */
  console.log('\n[8] 云端报错时的健壮性');
  reset();
  sync.disableCloud();
  return sync.enableCloud('keep-local').then(function () {
    cloudOk = false;
    const b = storage.createBook({ name: '故障期', words: [{ en: 'e', cn: '鹅' }] });
    return new Promise(function (r) { setTimeout(r, 1200); }).then(function () {
      check('云端失败但本地写入成功', storage.listBooks().length === 1);
      check('失败后保留脏键待重试', sync.statusSnapshot().dirtyCount > 0);
      cloudOk = true;
      return sync.syncNow();
    }).then(function () {
      check('恢复后重试成功', DB.books.length === 1, '实际 ' + DB.books.length);
    });
  });
}).then(function () {
  /* ================= 9. 统计按设备合并 ================= */
  console.log('\n[9] 学习统计：多设备不丢也不膨胀');
  reset();
  delete global.wx.cloud; // 纯本地，避免同步干扰
  sync.init();
  sync.disableCloud();
  (function () {
    // 本设备记 2 局
    storage.recordStats(6, true, 40);
    storage.recordStats(4, true, 30);
    const mine = storage.getStats();
    check('本机累计 10', mine.totalMatched === 10, '实际 ' + mine.totalMatched);

    // 另一台设备（不同 id）同一天记 5 个
    const remote = {
      days: {},
      bestStreak: 1
    };
    const k = require(path.join(base, 'util')).dayKey();
    const otherId = 'd-other-device';
    remote.days[k] = { matched: 5, games: 1, wins: 1, seconds: 25, by: {} };
    remote.days[k].by[otherId] = { matched: 5, games: 1, wins: 1, seconds: 25 };

    storage.mergeStats(remote);
    const merged = storage.getStats();
    check('合并后是 15（各设备的和，不互相覆盖）', merged.totalMatched === 15, '实际 ' + merged.totalMatched);
    check('合并后场次为 3', merged.totalGames === 3, '实际 ' + merged.totalGames);

    // 同一个 remote 再合并一次：不应该重复累加（这是旧方案会膨胀的地方）
    storage.mergeStats(remote);
    const again = storage.getStats();
    check('重复合并不会膨胀', again.totalMatched === 15, '实际 ' + again.totalMatched);
    check('重复合并场次不变', again.totalGames === 3, '实际 ' + again.totalGames);

    // 本设备继续背，应在 15 的基础上增加
    storage.recordStats(5, true, 20);
    const after = storage.getStats();
    check('本机继续记录后为 20', after.totalMatched === 20, '实际 ' + after.totalMatched);
  })();

  /* ================= 10. 错词本逐词合并 ================= */
  console.log('\n[10] 错词本：逐词合并，已毕业的不复活');
  (function () {
    const bid = 'bk-merge';
    storage.saveWrongList(bid, []);

    // 本机：produce 错 3 次；tie 已经连续答对 2 次毕业（更晚发生）
    storage.markWrong(bid, [{ en: 'produce', cn: 'v. 生产' }]);
    storage.markWrong(bid, [{ en: 'produce', cn: 'v. 生产' }]);
    storage.markWrong(bid, [{ en: 'tie', cn: 'v. 系' }]);
    storage.markRight(bid, 'tie');
    storage.markRight(bid, 'tie');
    const before = storage.getWrongList(bid);
    const tieBefore = before.filter(function (w) { return w.en === 'tie'; })[0];
    check('本机 tie 已毕业', tieBefore.mastered === true);
    check('本机 produce 错 2 次', before.filter(function (w) { return w.en === 'produce'; })[0].wrong === 2);

    // 云端（另一台设备更早的状态）：produce 错 5 次，tie 只错 1 次还没毕业
    const remote = [
      { en: 'produce', cn: 'v. 生产', wrong: 5, right: 0, mastered: false, at: 1000 },
      { en: 'tie', cn: 'v. 系', wrong: 1, right: 0, mastered: false, at: 1000 },
      { en: 'state', cn: 'n. 状态', wrong: 2, right: 0, mastered: false, at: 1000 }
    ];
    const changed = storage.mergeWrongList(bid, remote);
    check('合并发生改动', changed === true);

    const list = storage.getWrongList(bid);
    const produce = list.filter(function (w) { return w.en === 'produce'; })[0];
    const tie = list.filter(function (w) { return w.en === 'tie'; })[0];
    const state = list.filter(function (w) { return w.en === 'state'; })[0];

    check('produce 错误次数取 max = 5', produce.wrong === 5, '实际 ' + produce.wrong);
    check('tie 仍保持毕业（本机更新更晚）', tie.mastered === true);
    check('只在云端的 state 被补进来', !!state && state.wrong === 2);

    // 反过来：云端有一次更晚的答错，应把已毕业的词拉回错词本
    const newer = [{ en: 'tie', cn: 'v. 系', wrong: 2, right: 0, mastered: false, at: Date.now() + 60000 }];
    storage.mergeWrongList(bid, newer);
    const tie2 = storage.getWrongList(bid).filter(function (w) { return w.en === 'tie'; })[0];
    check('云端更晚的答错让 tie 重新回到错词本', tie2.mastered === false && tie2.right === 0);
    check('tie 的累计错误次数取 max = 2', tie2.wrong === 2, '实际 ' + tie2.wrong);
  })();

  /* ================= 11. 设置不被回滚（云端开启状态才有意义） ================= */
  console.log('\n[11] 设置：本机未推送的改动不被云端覆盖');
  enableCloudSdk();
  reset();
  return sync.enableCloud('keep-local').then(function () {
    storage.saveSettings({ batchSize: 12 });
    check('普通写入会标脏', sync.statusSnapshot().dirtyCount > 0);
    return sync.syncNow().then(function () {
      check('同步后脏键清空', sync.statusSnapshot().dirtyCount === 0);

      // 云端拉回来的设置必须静默落地，否则「拉 → 标脏 → 再推」会来回打转
      storage.saveSettingsQuiet({ batchSize: 3 });
      check('静默写入不标脏', sync.statusSnapshot().dirtyCount === 0);
      check('静默写入生效', storage.getSettings().batchSize === 3, '实际 ' + storage.getSettings().batchSize);

      // 本地改了还没推上去时，拉云端不能把这次改动回滚
      storage.saveSettings({ batchSize: 9 });
      check('待推送的改动被标脏', sync.statusSnapshot().dirtyCount > 0);
      sync.applyCloud({ settings: { batchSize: 3 }, books: [], words: {}, wrong: {} }, false);
      check('有未推送改动时不被云端回滚', storage.getSettings().batchSize === 9, '实际 ' + storage.getSettings().batchSize);
      storage.saveSettings({ batchSize: 6 });
      return true;
    });
  });
}).then(function () {
  console.log('\n========================');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) process.exit(1);
}).catch(function (e) {
  console.error('测试异常', e);
  process.exit(1);
});
