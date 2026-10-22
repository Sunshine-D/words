/**
 * 云开发封装层
 *
 * 设计要点：
 * 1. **永不因云环境缺失而崩溃**。用户没开通云开发、基础库过低、网络断开、
 *    环境 ID 填错，任何一种情况都只是「云不可用」，自动降级为纯本地模式。
 *    这是本模块最重要的契约：所有方法失败都返回 null / false，不抛异常。
 * 2. **整本词库存一条文档**。词表以数组内嵌，一次读拿全表，
 *    把数据库调用次数压掉一个数量级（调用次数才是计费瓶颈，容量不是）。
 * 3. **本地缓存云端 _id**。更新走 doc(_id).update() 一次调用即可，
 *    失败时回退到「先查再增」，保证自愈。
 *
 * 集合结构（权限均设为「仅创建者可读写」，天然按 openid 隔离）：
 *   books    { bid, book,      updatedAt }
 *   words    { bid, words,     updatedAt }
 *   wrong    { bid, list,      updatedAt }
 *   stats    { stats,          updatedAt }  每用户一条
 *   settings { settings,       updatedAt }  每用户一条
 */
const util = require('./util');

/**
 * 云开发环境 ID。
 * 在微信开发者工具 → 云开发 → 环境 → 环境 ID 处复制后填入。
 *
 * 留空并不等于关闭：会尝试用「默认环境」初始化。账号下只有一个云环境时
 * 这样就能直接用，省去改代码的步骤；没开通云开发则初始化失败，
 * 自动降级为纯本地模式，不影响正常使用。
 */
const CLOUD_ENV = '';

const COLL = {
  BOOKS: 'books',
  WORDS: 'words',
  WRONG: 'wrong',
  STATS: 'stats',
  SETTINGS: 'settings'
};

const MAP_KEY = 'wm_cloudmap';

// unsupported 无 SDK / uninited 未配置或初始化失败 / ready 可用 / failed 初始化报错
let state = 'uninited';
let failReason = '';
let db = null;
let idMap = null; // { books:{bid:_id}, words:{}, wrong:{}, stats:_id, settings:_id }

/* ============ 基础能力探测 ============ */

function hasSdk() {
  return typeof wx !== 'undefined' && wx && typeof wx.cloud === 'object' && wx.cloud;
}

/**
 * 初始化（幂）。返回是否可用。
 * 只在真正需要云能力时才调用，避免拖慢首屏。
 */
function init() {
  if (state === 'ready' || state === 'failed') return state === 'ready';
  if (!hasSdk()) {
    state = 'unsupported';
    failReason = '当前基础库不支持云开发';
    return false;
  }
  try {
    wx.cloud.init(CLOUD_ENV ? { env: CLOUD_ENV, traceUser: true } : { traceUser: true });
    db = CLOUD_ENV ? wx.cloud.database({ env: CLOUD_ENV }) : wx.cloud.database();
    state = 'ready';
    loadMap();
    return true;
  } catch (e) {
    state = 'failed';
    failReason = CLOUD_ENV
      ? '云环境初始化失败，请检查环境 ID 是否正确'
      : '未开通云开发，当前仅保存在本机';
    console.warn('[cloud] init failed', e);
    return false;
  }
}

function isReady() {
  return state === 'ready';
}

function getState() {
  return state;
}

function getFailReason() {
  return failReason;
}

/** 云能力能否使用（含网络判断） */
function usable() {
  if (!init()) return false;
  try {
    if (typeof wx.getNetworkTypeSync === 'function') {
      const info = wx.getNetworkTypeSync();
      if (info && info.networkType === 'none') return false;
    }
  } catch (e) {
    // 取不到网络状态就不拦，交给后续写入失败去兜底
  }
  return true;
}

/* ============ 云端 _id 映射缓存 ============ */

function loadMap() {
  if (idMap) return idMap;
  try {
    const v = wx.getStorageSync(MAP_KEY);
    idMap = v && typeof v === 'object' ? v : freshMap();
  } catch (e) {
    idMap = freshMap();
  }
  return idMap;
}

function freshMap() {
  return { books: {}, words: {}, wrong: {}, stats: '', settings: '' };
}

function saveMap() {
  try {
    wx.setStorageSync(MAP_KEY, idMap || freshMap());
  } catch (e) {
    /* 缓存失败不影响主流程 */
  }
}

function resetMap() {
  idMap = freshMap();
  saveMap();
}

/* ============ 底层读写（全部静默失败） ============ */

function coll(name) {
  if (!usable() || !db) return null;
  try {
    return db.collection(name);
  } catch (e) {
    return null;
  }
}

/** 查询单条：按业务键 bid */
function findOne(name, where) {
  const c = coll(name);
  if (!c) return Promise.resolve(null);
  return new Promise(function (resolve) {
    c.where(where)
      .limit(1)
      .get()
      .then(function (res) {
        const list = (res && res.data) || [];
        resolve(list.length ? list[0] : null);
      })
      .catch(function (err) {
        console.warn('[cloud] findOne failed', name, err);
        resolve(null);
      });
  });
}

/** 拉取集合内全部自己的文档（自动翻页，上限 500 条防失控） */
function findAll(name) {
  const c = coll(name);
  if (!c) return Promise.resolve([]);
  const MAX = 500;
  const out = [];
  function page(skip) {
    return c
      .skip(skip)
      .limit(100)
      .get()
      .then(function (res) {
        const list = (res && res.data) || [];
        out.push.apply(out, list);
        if (list.length === 100 && out.length < MAX) return page(skip + 100);
        return out;
      });
  }
  return page(0).catch(function (err) {
    console.warn('[cloud] findAll failed', name, err);
    return out;
  });
}

/**
 * 写入一条：存在则更新，不存在则新增。
 * 优先用缓存的 _id 直接更新（1 次调用），失败时回退到查询后判断（2-3 次）。
 */
function upsert(name, key, idSlot, where, payload) {
  const c = coll(name);
  if (!c) return Promise.resolve(false);
  const map = loadMap();

  function doAdd() {
    return new Promise(function (resolve) {
      const doc = Object.assign({}, payload, { updatedAt: Date.now() });
      c.add({ data: doc })
        .then(function (res) {
          if (res && res._id) {
            map[idSlot][key] = res._id;
            saveMap();
          }
          resolve(true);
        })
        .catch(function (err) {
          console.warn('[cloud] add failed', name, err);
          resolve(false);
        });
    });
  }

  function doUpdate(id) {
    return new Promise(function (resolve) {
      c.doc(id)
        .update({ data: Object.assign({}, payload, { updatedAt: Date.now() }) })
        .then(function () {
          resolve(true);
        })
        .catch(function (err) {
          // 文档可能被删或 _id 失效，清理后走新增
          const msg = (err && err.errMsg) || '';
          if (msg.indexOf('document') >= 0 || msg.indexOf('exist') >= 0 || msg.indexOf('-1') >= 0) {
            delete map[idSlot][key];
            saveMap();
            resolve(doAdd());
            return;
          }
          console.warn('[cloud] update failed', name, err);
          resolve(false);
        });
    });
  }

  const cached = map[idSlot][key];
  if (cached) return doUpdate(cached);

  return findOne(name, where).then(function (hit) {
    if (hit && hit._id) {
      map[idSlot][key] = hit._id;
      saveMap();
      return doUpdate(hit._id);
    }
    return doAdd();
  });
}

/** 删除：业务键匹配的所有文档 */
function remove(name, where) {
  const c = coll(name);
  if (!c) return Promise.resolve(false);
  return new Promise(function (resolve) {
    c.where(where)
      .remove()
      .then(function () {
        resolve(true);
      })
      .catch(function (err) {
        console.warn('[cloud] remove failed', name, err);
        resolve(false);
      });
  });
}

/* ============ 业务级接口 ============ */

/**
 * 拉取云端全量数据
 * @returns {Promise<{books,words,wrong,stats,settings,at}>|null}
 *  words / wrong 是 { bid: 数据 } 形式
 */
function pullAll() {
  if (!usable()) return Promise.resolve(null);
  const out = { books: [], words: {}, wrong: {}, stats: null, settings: null, at: 0 };
  const map = loadMap();

  return Promise.all([
    findAll(COLL.BOOKS),
    findAll(COLL.WORDS),
    findAll(COLL.WRONG),
    findOne(COLL.STATS, { key: 'me' }),
    findOne(COLL.SETTINGS, { key: 'me' })
  ])
    .then(function (res) {
      const books = res[0] || [];
      const words = res[1] || [];
      const wrong = res[2] || [];
      const statsDoc = res[3];
      const settingsDoc = res[4];

      books.forEach(function (d) {
        if (!d || !d.bid) return;
        out.books.push(d.book);
        if (d._id) map.books[d.bid] = d._id;
        if (d.updatedAt > out.at) out.at = d.updatedAt;
      });
      words.forEach(function (d) {
        if (!d || !d.bid) return;
        out.words[d.bid] = d.words || [];
        if (d._id) map.words[d.bid] = d._id;
      });
      wrong.forEach(function (d) {
        if (!d || !d.bid) return;
        out.wrong[d.bid] = d.list || [];
        if (d._id) map.wrong[d.bid] = d._id;
      });
      if (statsDoc) {
        out.stats = statsDoc.stats || null;
        if (statsDoc._id) map.stats = statsDoc._id;
      }
      if (settingsDoc) {
        out.settings = settingsDoc.settings || null;
        if (settingsDoc._id) map.settings = settingsDoc._id;
      }
      saveMap();
      return out;
    })
    .catch(function (err) {
      console.warn('[cloud] pullAll failed', err);
      return null;
    });
}

function pushBook(book, words) {
  if (!usable() || !book) return Promise.resolve(false);
  return Promise.all([
    upsert(COLL.BOOKS, book.id, 'books', { bid: book.id }, { bid: book.id, book: book }),
    upsert(COLL.WORDS, book.id, 'words', { bid: book.id }, { bid: book.id, words: words || [] })
  ]).then(function (r) {
    return r[0] && r[1];
  });
}

function pushWords(bookId, words) {
  return upsert(COLL.WORDS, bookId, 'words', { bid: bookId }, { bid: bookId, words: words || [] });
}

function pushWrong(bookId, list) {
  return upsert(COLL.WRONG, bookId, 'wrong', { bid: bookId }, { bid: bookId, list: list || [] });
}

/** stats / settings 为单条文档，key 固定为 'me' */
function pushStats(stats) {
  if (!usable()) return Promise.resolve(false);
  const map = loadMap();
  const slot = 'stats';
  const c = coll(COLL.STATS);
  if (!c) return Promise.resolve(false);
  // key 固定为 'me'：显式条件比 where({}) 更稳，也便于按 openid 之外再兜一层
  const data = { key: 'me', stats: stats, updatedAt: Date.now() };
  const WHERE = { key: 'me' };

  function add() {
    return new Promise(function (resolve) {
      c.add({ data: data })
        .then(function (r) {
          if (r && r._id) {
            map[slot] = r._id;
            saveMap();
          }
          resolve(true);
        })
        .catch(function () {
          resolve(false);
        });
    });
  }

  if (map[slot]) {
    return new Promise(function (resolve) {
      c.doc(map[slot])
        .update({ data: data })
        .then(function () {
          resolve(true);
        })
        .catch(function () {
          map[slot] = '';
          saveMap();
          resolve(add());
        });
    });
  }
  return findOne(COLL.STATS, WHERE).then(function (hit) {
    if (hit && hit._id) {
      map[slot] = hit._id;
      saveMap();
      return new Promise(function (resolve) {
        c.doc(hit._id)
          .update({ data: data })
          .then(function () {
            resolve(true);
          })
          .catch(function () {
            resolve(false);
          });
      });
    }
    return add();
  });
}

function pushSettings(settings) {
  if (!usable()) return Promise.resolve(false);
  const map = loadMap();
  const c = coll(COLL.SETTINGS);
  if (!c) return Promise.resolve(false);
  const data = { key: 'me', settings: settings, updatedAt: Date.now() };
  const WHERE = { key: 'me' };

  function add() {
    return new Promise(function (resolve) {
      c.add({ data: data })
        .then(function (r) {
          if (r && r._id) {
            map.settings = r._id;
            saveMap();
          }
          resolve(true);
        })
        .catch(function () {
          resolve(false);
        });
    });
  }

  if (map.settings) {
    return new Promise(function (resolve) {
      c.doc(map.settings)
        .update({ data: data })
        .then(function () {
          resolve(true);
        })
        .catch(function () {
          map.settings = '';
          saveMap();
          resolve(add());
        });
    });
  }
  return findOne(COLL.SETTINGS, WHERE).then(function (hit) {
    if (hit && hit._id) {
      map.settings = hit._id;
      saveMap();
      return new Promise(function (resolve) {
        c.doc(hit._id)
          .update({ data: data })
          .then(function () {
            resolve(true);
          })
          .catch(function () {
            resolve(false);
          });
      });
    }
    return add();
  });
}

function deleteBook(bookId) {
  if (!usable()) return Promise.resolve(false);
  const map = loadMap();
  delete map.books[bookId];
  delete map.words[bookId];
  delete map.wrong[bookId];
  saveMap();
  return Promise.all([
    remove(COLL.BOOKS, { bid: bookId }),
    remove(COLL.WORDS, { bid: bookId }),
    remove(COLL.WRONG, { bid: bookId })
  ]).then(function () {
    return true;
  });
}

/** 清空云端全部数据（数据管理页「删除云端数据」用） */
function clearAll() {
  if (!usable()) return Promise.resolve(false);
  return Promise.all([
    findAll(COLL.BOOKS).then(function (list) {
      return Promise.all(
        list.map(function (d) {
          return remove(COLL.BOOKS, { bid: d.bid });
        })
      );
    }),
    findAll(COLL.WORDS).then(function (list) {
      return Promise.all(
        list.map(function (d) {
          return remove(COLL.WORDS, { bid: d.bid });
        })
      );
    }),
    findAll(COLL.WRONG).then(function (list) {
      return Promise.all(
        list.map(function (d) {
          return remove(COLL.WRONG, { bid: d.bid });
        })
      );
    })
  ])
    .then(function () {
      resetMap();
      return true;
    })
    .catch(function () {
      resetMap();
      return false;
    });
}

module.exports = {
  CLOUD_ENV: CLOUD_ENV,
  COLL: COLL,
  init: init,
  isReady: isReady,
  usable: usable,
  getState: getState,
  getFailReason: getFailReason,
  pullAll: pullAll,
  pushBook: pushBook,
  pushWords: pushWords,
  pushWrong: pushWrong,
  pushStats: pushStats,
  pushSettings: pushSettings,
  deleteBook: deleteBook,
  clearAll: clearAll,
  resetMap: resetMap
};
