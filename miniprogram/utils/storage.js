/**
 * 本地数据层
 * 设计要点：
 * 1. 词库索引与词表分离存储（wm_books / wm_words_<id>），
 *    首页只读索引，避免大词库拖慢首屏。
 * 2. 所有写入走 write()，统一做容量校验与失败兜底；
 *    小程序单 key 上限 1MB、总量 10MB，写满会直接抛异常，
 *    不做兜底会导致导入大词库时白屏。
 * 3. 错词本按词库独立存储（wm_wrong_<id>），与词表解耦。
 */
const util = require('./util');

const KEY = {
  BOOKS: 'wm_books',
  WORDS: 'wm_words_',
  WRONG: 'wm_wrong_',
  SETTINGS: 'wm_settings',
  STATS: 'wm_stats',
  DEVICE: 'wm_device_id'
};

/** 旧格式（没有 by 分设备记录）的统计数据归并到这个虚拟设备名下 */
const LEGACY_OWNER = 'legacy';

const DEFAULT_SETTINGS = {
  batchSize: 6,
  batchMode: 'random', // sequential 顺序批次 / random 随机抽取
  timeLimit: 0, // 0 表示按词量自动计算，-1 不限时
  layout: 'side', // side 左右分栏 / stack 上下分栏
  sound: true,
  vibrate: true,
  tts: true, // 点击单词自动朗读
  accent: 2, // 1 英音 / 2 美音
  dailyGoal: 30 // 每日目标消除量
};

/** 连续答对多少次判定为「已掌握」，自动移出错词本 */
const MASTER_THRESHOLD = 2;

/** 单次写入体积上限（字节），超过则拒绝并给出提示 */
const SINGLE_KEY_LIMIT = 900 * 1024;

/* ============ 通用读写（带容量兜底） ============ */

let lastError = '';

/**
 * 通知同步引擎：某项数据变了。
 * 延迟 require 是为了打破 storage <-> sync 的循环依赖（两者互相只拿对方的完整导出）。
 * 本地模式下 sync.touch 会直接返回，开销可忽略。
 */
function notify(key) {
  try {
    require('./sync').touch(key);
  } catch (e) {
    /* 同步失败绝不能影响本地写入 */
  }
}

function setLastError(msg) {
  lastError = msg || '';
}

function getLastError() {
  return lastError;
}

function read(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    return v === '' || v === null || v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

/** 粗略估算对象序列化后的字节数（中文按 3 字节算） */
function estimateBytes(value) {
  let str;
  try {
    str = JSON.stringify(value);
  } catch (e) {
    return 0;
  }
  if (!str) return 0;
  let bytes = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return bytes;
}

/**
 * 写入并做容量校验
 * @returns {boolean} 是否成功；失败时通过 getLastError() 取原因
 */
function write(key, value) {
  const size = estimateBytes(value);
  if (size > SINGLE_KEY_LIMIT) {
    setLastError('数据过大（约 ' + Math.round(size / 1024) + 'KB），单条记录不能超过 900KB');
    console.error('[storage] oversize', key, size);
    return false;
  }
  try {
    wx.setStorageSync(key, value);
    lastError = '';
    return true;
  } catch (e) {
    const msg = e && e.errMsg ? e.errMsg : '';
    // 配额不足是最常见且最需要用户感知的失败
    if (msg.indexOf('exceed') >= 0 || msg.indexOf('quota') >= 0 || msg.indexOf('size limit') >= 0) {
      setLastError('本机存储空间不足，请先删除一些词库再导入');
    } else {
      setLastError('保存失败：' + (msg || '未知错误'));
    }
    console.error('[storage] write failed', key, e);
    return false;
  }
}

/** 剩余可用容量（KB），失败返回 -1 */
function quotaKB() {
  try {
    const info = wx.getStorageInfoSync();
    return Math.floor((info.limitSize - info.currentSize) * 1024);
  } catch (e) {
    return -1;
  }
}

function bytesToKB(n) {
  return Math.round(n / 1024);
}

/* ============ 设置 ============ */

function ensureSettings() {
  const s = read(KEY.SETTINGS, null);
  if (!s) {
    write(KEY.SETTINGS, DEFAULT_SETTINGS);
    return Object.assign({}, DEFAULT_SETTINGS);
  }
  return Object.assign({}, DEFAULT_SETTINGS, s);
}

function getSettings() {
  return ensureSettings();
}

function saveSettings(patch) {
  const next = Object.assign({}, getSettings(), patch || {});
  write(KEY.SETTINGS, next);
  notify('settings');
  return next;
}

/** 云端拉回来的设置：只写本地，不标脏，避免「拉 → 标脏 → 又推」的循环 */
function saveSettingsQuiet(patch) {
  const next = Object.assign({}, getSettings(), patch || {});
  write(KEY.SETTINGS, next);
  return next;
}

/* ============ 词库索引 ============ */

function listBooks() {
  const list = read(KEY.BOOKS, []);
  return Array.isArray(list) ? list : [];
}

function saveBooks(list) {
  return write(KEY.BOOKS, list);
}

function getBook(id) {
  const list = listBooks();
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

function updateBook(id, patch) {
  const list = listBooks();
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      list[i] = Object.assign({}, list[i], patch, { updatedAt: Date.now() });
      saveBooks(list);
      notify('book:' + id);
      return list[i];
    }
  }
  return null;
}

/* ============ 词表 ============ */

function getWords(bookId) {
  const words = read(KEY.WORDS + bookId, []);
  return Array.isArray(words) ? words : [];
}

function saveWords(bookId, words) {
  const ok = write(KEY.WORDS + bookId, words);
  if (ok) notify('book:' + bookId);
  return ok;
}

/** 云端拉回来的词表：只写本地，不标脏（否则会被原样推回去，白白多一轮调用） */
function saveWordsQuiet(bookId, words) {
  return write(KEY.WORDS + bookId, words);
}

/**
 * 创建词库
 * @param {Object} opts { name, words:[{en,cn}], source:{fileName,fileType,channel} }
 * @returns {Object|null} 失败返回 null，原因通过 getLastError() 取
 */
function createBook(opts) {
  const id = util.uid('book');
  const now = Date.now();
  const words = (opts.words || []).map(function (w, i) {
    return {
      id: 'w' + i,
      en: String(w.en || '').trim(),
      cn: String(w.cn || '').trim()
    };
  });

  const book = {
    id: id,
    name: opts.name || '未命名词库',
    count: words.length,
    createdAt: now,
    updatedAt: now,
    lastPlayedAt: 0,
    source: opts.source || { fileName: '', fileType: '', channel: '' },
    progress: {
      seqIndex: 0,
      pool: [],
      matchedTotal: 0,
      playCount: 0,
      bestMs: 0,
      batchesDone: 0
    },
    preview: words.slice(0, 3).map(function (w) {
      return { en: w.en, cn: w.cn };
    })
  };

  // 先写词表（占空间的主体），失败就直接返回，避免留下孤儿索引
  if (!saveWords(id, words)) return null;

  const list = listBooks();
  list.unshift(book);
  if (!saveBooks(list)) {
    try {
      wx.removeStorageSync(KEY.WORDS + id);
    } catch (e) {
      /* ignore */
    }
    return null;
  }
  return book;
}

function deleteBook(id) {
  const list = listBooks().filter(function (b) {
    return b.id !== id;
  });
  saveBooks(list);
  try {
    wx.removeStorageSync(KEY.WORDS + id);
  } catch (e) {
    /* ignore */
  }
  try {
    wx.removeStorageSync(KEY.WRONG + id);
  } catch (e) {
    /* ignore */
  }
  // 通知云端同步删除（sync 发现本地已无此书时会走删除分支）
  notify('book:' + id);
}

/**
 * 记录一次闯关结果
 */
function recordPlay(bookId, result) {
  const book = getBook(bookId);
  if (!book) return null;
  const p = Object.assign({}, book.progress || {});
  p.matchedTotal = (p.matchedTotal || 0) + (result.matched || 0);
  p.playCount = (p.playCount || 0) + 1;
  if (result.win) {
    p.batchesDone = (p.batchesDone || 0) + 1;
    if (!p.bestMs || result.ms < p.bestMs) p.bestMs = result.ms;
  }
  if (typeof result.seqIndex === 'number') p.seqIndex = result.seqIndex;
  if (result.pool) p.pool = result.pool;
  return updateBook(bookId, { progress: p, lastPlayedAt: Date.now() });
}

/* ============ 设备标识 ============ */

/**
 * 本机标识，每台设备一个，用于把学习统计做成「按设备分别记录再求和」的计数器。
 * 为什么要这个：两台设备各玩各的再联网，如果对汇总值直接相加，
 * 每次同步都会把对方已经包含自己贡献的数字再加一遍，数字会无限膨胀；
 * 如果直接取 max，同一天在两台设备上背的单词又只算一份。
 * 按设备分桶记录，两个问题都消失。
 */
function getDeviceId() {
  let id = '';
  try {
    id = wx.getStorageSync(KEY.DEVICE);
  } catch (e) {
    id = '';
  }
  if (typeof id === 'string' && id.length >= 6) return id;
  id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    wx.setStorageSync(KEY.DEVICE, id);
  } catch (e) {
    /* 存不下就用临时 id：合并粒度变粗，但不会出错 */
  }
  return id;
}

/* ============ 错词本 ============ */

/** 错词条目标识：英文小写，跨批次稳定 */
function wordKeyOf(en) {
  return String(en || '').trim().toLowerCase();
}

function getWrongList(bookId) {
  const list = read(KEY.WRONG + bookId, []);
  return Array.isArray(list) ? list : [];
}

function saveWrongList(bookId, list) {
  const ok = write(KEY.WRONG + bookId, list);
  if (ok) notify('wrong:' + bookId);
  return ok;
}

/** 未完成掌握的错词，按错误次数降序 */
function getWrongActive(bookId) {
  return getWrongList(bookId)
    .filter(function (w) {
      return !w.mastered;
    })
    .sort(function (a, b) {
      if (b.wrong !== a.wrong) return b.wrong - a.wrong;
      return b.at - a.at;
    });
}

function getWrongCount(bookId) {
  return getWrongActive(bookId).length;
}

function upsert(bookId, en, cn, patch) {
  const list = getWrongList(bookId);
  const key = wordKeyOf(en);
  let hit = null;
  for (let i = 0; i < list.length; i++) {
    if (wordKeyOf(list[i].en) === key) {
      hit = list[i];
      break;
    }
  }
  if (!hit) {
    hit = { en: String(en).trim(), cn: String(cn || '').trim(), wrong: 0, right: 0, mastered: false, at: Date.now() };
    list.push(hit);
  }
  Object.assign(hit, patch);
  hit.at = Date.now();
  saveWrongList(bookId, list);
  return hit;
}

/**
 * 记一次配对错误：涉事的两个词都记一笔。
 * 消消乐的干扰项来自同一批，点错说明对这两个词的辨析都不牢。
 * @param {Array<{en,cn}>} words
 */
function markWrong(bookId, words) {
  const list = Array.isArray(words) ? words : [];
  const touched = [];
  list.forEach(function (w) {
    if (!w || !w.en) return;
    const item = upsert(bookId, w.en, w.cn, {
      wrong: (findOne(bookId, w.en) ? findOne(bookId, w.en).wrong + 1 : 1),
      right: 0 // 答错清零连续正确
    });
    touched.push(item);
  });
  return touched;
}

function findOne(bookId, en) {
  const list = getWrongList(bookId);
  const key = wordKeyOf(en);
  for (let i = 0; i < list.length; i++) {
    if (wordKeyOf(list[i].en) === key) return list[i];
  }
  return null;
}

/**
 * 记一次配对正确：连续答对达到阈值即判定掌握
 * @returns {boolean} 本次是否达成掌握
 */
function markRight(bookId, en) {
  const item = findOne(bookId, en);
  if (!item || item.mastered) return false;
  const right = (item.right || 0) + 1;
  const mastered = right >= MASTER_THRESHOLD;
  upsert(bookId, item.en, item.cn, { right: right, mastered: mastered });
  return mastered;
}

function removeWrong(bookId, en) {
  const list = getWrongList(bookId).filter(function (w) {
    return wordKeyOf(w.en) !== wordKeyOf(en);
  });
  return saveWrongList(bookId, list);
}

function clearWrong(bookId) {
  return saveWrongList(bookId, []);
}

/**
 * 合并云端错词本（静默写入，不标脏、不会再推回云端）。
 *
 * 必须逐词合并，不能整列表覆盖：整列表覆盖会让「A 机上已经连续答对 2 次、已毕业」
 * 的词，被 B 机上那份还没毕业的旧列表复活，错误次数也被回退。
 *
 * 合并规则：
 * - wrong 是累计错误次数（只增不减）→ 取 max
 * - right 是连续答对次数（答错会清零）→ 不是单调量，按 at 取「更近发生的那次」为准
 * - mastered 由 right 派生，保证内部状态自洽
 * - 只在一端出现的词 → 直接保留
 *
 * @returns {boolean} 本地是否发生变化
 */
function mergeWrongList(bookId, remoteList) {
  const remote = Array.isArray(remoteList) ? remoteList : [];
  if (!remote.length) return false;

  const local = getWrongList(bookId);
  const index = {};
  local.forEach(function (w) {
    if (w && w.en) index[wordKeyOf(w.en)] = w;
  });

  let changed = false;
  remote.forEach(function (r) {
    if (!r || !r.en) return;
    const k = wordKeyOf(r.en);
    const l = index[k];

    if (!l) {
      const item = {
        en: String(r.en).trim(),
        cn: String(r.cn || '').trim(),
        wrong: r.wrong || 0,
        right: r.right || 0,
        at: r.at || Date.now(),
        mastered: (r.right || 0) >= MASTER_THRESHOLD
      };
      local.push(item);
      index[k] = item;
      changed = true;
      return;
    }

    if ((r.wrong || 0) > (l.wrong || 0)) {
      l.wrong = r.wrong;
      changed = true;
    }
    if (!l.cn && r.cn) {
      l.cn = String(r.cn).trim();
      changed = true;
    }

    // 更近的一侧描述的是「当前状态」，优先采信
    if ((r.at || 0) > (l.at || 0)) {
      const rr = r.right || 0;
      if (rr !== (l.right || 0)) {
        l.right = rr;
        changed = true;
      }
      l.at = r.at;
      const rm = rr >= MASTER_THRESHOLD;
      if (rm !== !!l.mastered) {
        l.mastered = rm;
        changed = true;
      }
    }
  });

  if (!changed) return false;
  return write(KEY.WRONG + bookId, local);
}

/** 全站错词总数（用于首页徽标） */
function totalWrongCount() {
  return listBooks().reduce(function (sum, b) {
    return sum + getWrongCount(b.id);
  }, 0);
}

/* ============ 学习统计 ============ */

function emptyStats() {
  return {
    days: {},
    totalMatched: 0,
    totalGames: 0,
    totalWins: 0,
    totalSeconds: 0,
    streak: 0,
    bestStreak: 0,
    dailyGoal: DEFAULT_SETTINGS.dailyGoal
  };
}

/**
 * 一天的记录。by 是「设备 → 该设备的贡献」，
 * matched/games/wins/seconds 只是由 by 求和得到的派生值（见 rollupDay）。
 * 唯一事实来源是 by，这样多设备合并才有依据。
 */
function emptyDay() {
  return { matched: 0, games: 0, wins: 0, seconds: 0, by: {} };
}

/** 由 by 重算当天的合计值 */
function rollupDay(day) {
  const by = (day && day.by) || {};
  let m = 0;
  let g = 0;
  let w = 0;
  let sec = 0;
  Object.keys(by).forEach(function (k) {
    const c = by[k] || {};
    m += c.matched || 0;
    g += c.games || 0;
    w += c.wins || 0;
    sec += c.seconds || 0;
  });
  day.matched = m;
  day.games = g;
  day.wins = w;
  day.seconds = sec;
  return day;
}

/**
 * 旧格式迁移：早期版本只存汇总值、没有 by。
 * 把已有数值挂到给定设备名下，之后就统一走分设备逻辑。
 * 本地旧数据归本机、云端旧数据归 LEGACY_OWNER，两边才不会互相顶掉。
 */
function migrateDay(day, owner) {
  if (!day) return emptyDay();
  if (!day.by || typeof day.by !== 'object') {
    day.by = {};
    day.by[owner] = {
      matched: day.matched || 0,
      games: day.games || 0,
      wins: day.wins || 0,
      seconds: day.seconds || 0
    };
  }
  return rollupDay(day);
}

function getStats() {
  const s = read(KEY.STATS, null);
  if (!s) return emptyStats();
  const base = Object.assign(emptyStats(), s);
  if (!base.days) base.days = {};
  return base;
}

/** 由 days 重算全部汇总值：totalXxx 与 streak 都是派生量，不再独立维护 */
function rollupStats(s) {
  let m = 0;
  let g = 0;
  let w = 0;
  let sec = 0;
  Object.keys(s.days || {}).forEach(function (k) {
    const d = rollupDay(s.days[k]);
    m += d.matched;
    g += d.games;
    w += d.wins;
    sec += d.seconds;
  });
  s.totalMatched = m;
  s.totalGames = g;
  s.totalWins = w;
  s.totalSeconds = sec;
  s.streak = computeStreak(s.days);
  if ((s.bestStreak || 0) < s.streak) s.bestStreak = s.streak;
  return s;
}

function recordStats(matched, win, seconds) {
  const s = getStats();
  const self = getDeviceId();
  const key = util.dayKey();
  const day = migrateDay(s.days[key] || emptyDay(), self);

  const c = day.by[self] || { matched: 0, games: 0, wins: 0, seconds: 0 };
  c.matched += matched || 0;
  c.games += 1;
  c.wins += win ? 1 : 0;
  c.seconds += Math.max(0, Math.round(seconds || 0));
  day.by[self] = c;

  s.days[key] = rollupDay(day);
  rollupStats(s);

  write(KEY.STATS, s);
  notify('stats');
  return s;
}

/**
 * 合并云端统计（静默写入：拉下来的数据不标脏、不会再推回去）。
 *
 * 为什么不能整对象覆盖：recordStats 是累加语义，A 机背的 30 个和 B 机背的 20 个
 * 是两批真实记录，取谁都会丢掉另一半。
 * 为什么不能对汇总值相加：B 拉到 A 的数据后本地变成 50 再推上去，
 * A 下次拉到 50 又和自己的 30 相加变 80 —— 每同步一次就膨胀一次。
 * 按设备分桶后「各自只增、求和得出总数」，两个问题都消失。
 *
 * @returns {boolean} 本地是否发生变化
 */
function mergeStats(remote) {
  const r = remote || {};
  const rd = r.days || {};
  if (!Object.keys(rd).length && !r.bestStreak) return false;

  const s = getStats();
  const self = getDeviceId();
  let changed = false;

  Object.keys(rd).forEach(function (k) {
    const rDay = rd[k];
    if (!rDay) return;
    let lDay = s.days[k];
    if (!lDay) {
      lDay = emptyDay();
      s.days[k] = lDay;
      changed = true;
    }
    migrateDay(lDay, self);
    migrateDay(rDay, LEGACY_OWNER);

    Object.keys(rDay.by).forEach(function (dev) {
      const rc = rDay.by[dev] || {};
      const lc = lDay.by[dev];
      if (!lc) {
        lDay.by[dev] = {
          matched: rc.matched || 0,
          games: rc.games || 0,
          wins: rc.wins || 0,
          seconds: rc.seconds || 0
        };
        changed = true;
        return;
      }
      // 同一设备：取较大值即可（本设备的数只增不减，取 max 还能防重放重复累加）
      ['matched', 'games', 'wins', 'seconds'].forEach(function (f) {
        const rv = rc[f] || 0;
        if (rv > (lc[f] || 0)) {
          lc[f] = rv;
          changed = true;
        }
      });
    });

    rollupDay(lDay);
  });

  if ((r.bestStreak || 0) > (s.bestStreak || 0)) {
    s.bestStreak = r.bestStreak;
    changed = true;
  }

  if (!changed) return false;
  rollupStats(s);
  return write(KEY.STATS, s);
}

/** 整体覆盖统计（云端「以云端为准」强制回写时用） */
function saveStats(s) {
  const next = Object.assign(emptyStats(), s || {});
  if (!next.days) next.days = {};
  rollupStats(next);
  return write(KEY.STATS, next);
}

/** 连续学习天数 */
function computeStreak(days) {
  let streak = 0;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  for (let i = 0; i < 365; i++) {
    const key = util.dayKey(cursor.getTime());
    if (days[key] && days[key].games > 0) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else if (i === 0) {
      // 今天还没学，从昨天开始算
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function todayStat() {
  const s = getStats();
  return s.days[util.dayKey()] || { matched: 0, games: 0, wins: 0, seconds: 0 };
}

function todayMatched() {
  return todayStat().matched;
}

/**
 * 近 N 天学习日历，从最早到今天
 * @returns {Array<{key,label,matched,active,isToday,level}>}
 * level 0-3 用于渲染深浅
 */
function getCalendar(n) {
  const days = n || 7;
  const s = getStats();
  const out = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - (days - 1));
  const todayKey = util.dayKey();
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  for (let i = 0; i < days; i++) {
    const key = util.dayKey(cursor.getTime());
    const d = s.days[key];
    const matched = d ? d.matched : 0;
    let level = 0;
    if (matched > 0) level = 1;
    if (matched >= 10) level = 2;
    if (matched >= 30) level = 3;
    out.push({
      key: key,
      label: WEEK[cursor.getDay()],
      matched: matched,
      active: matched > 0,
      isToday: key === todayKey,
      level: level
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** 首页用的统计摘要 */
function statsSummary() {
  const s = getStats();
  const today = todayStat();
  const goal = Math.max(1, Number(s.dailyGoal) || DEFAULT_SETTINGS.dailyGoal);
  return {
    today: today.matched,
    todayGames: today.games,
    todaySeconds: today.seconds,
    streak: s.streak || 0,
    bestStreak: s.bestStreak || 0,
    total: s.totalMatched || 0,
    totalGames: s.totalGames || 0,
    totalWins: s.totalWins || 0,
    goal: goal,
    goalPercent: Math.min(100, Math.round((today.matched / goal) * 100)),
    goalDone: today.matched >= goal,
    calendar: getCalendar(7)
  };
}

function setDailyGoal(n) {
  return saveSettings({ dailyGoal: util.clamp(Number(n) || 30, 10, 200) });
}

/* ============ 批次计算 ============ */

function getBatchSize() {
  const s = getSettings();
  return util.clamp(Number(s.batchSize) || 6, 4, 15);
}

/** 顺序模式：把词表切成固定批次 */
function buildBatches(words, size) {
  const batches = [];
  for (let i = 0; i < words.length; i += size) {
    batches.push(words.slice(i, i + size));
  }
  return batches;
}

/** 批次限时（秒）：0 表示不限时 */
function resolveTimeLimit(wordCount) {
  const s = getSettings();
  const manual = typeof s.timeLimit === 'number' ? s.timeLimit : 0;
  if (manual === -1) return 0; // 用户选择不限时
  if (manual > 0) return manual;
  // 自动：每个词约 7 秒，最少 30 秒，最多 180 秒
  return util.clamp(wordCount * 7, 30, 180);
}

module.exports = {
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  MASTER_THRESHOLD: MASTER_THRESHOLD,
  getLastError: getLastError,
  estimateBytes: estimateBytes,
  quotaKB: quotaKB,
  bytesToKB: bytesToKB,
  ensureSettings: ensureSettings,
  getSettings: getSettings,
  saveSettings: saveSettings,
  saveSettingsQuiet: saveSettingsQuiet,
  getDeviceId: getDeviceId,
  listBooks: listBooks,
  getBook: getBook,
  updateBook: updateBook,
  saveBooks: saveBooks,
  getWords: getWords,
  saveWords: saveWords,
  saveWordsQuiet: saveWordsQuiet,
  createBook: createBook,
  deleteBook: deleteBook,
  recordPlay: recordPlay,
  // 错词本
  saveWrongList: saveWrongList,
  getWrongList: getWrongList,
  getWrongActive: getWrongActive,
  getWrongCount: getWrongCount,
  markWrong: markWrong,
  markRight: markRight,
  removeWrong: removeWrong,
  clearWrong: clearWrong,
  totalWrongCount: totalWrongCount,
  mergeWrongList: mergeWrongList,
  // 统计
  getStats: getStats,
  saveStats: saveStats,
  mergeStats: mergeStats,
  recordStats: recordStats,
  todayMatched: todayMatched,
  todayStat: todayStat,
  getCalendar: getCalendar,
  statsSummary: statsSummary,
  setDailyGoal: setDailyGoal,
  // 批次
  getBatchSize: getBatchSize,
  buildBatches: buildBatches,
  resolveTimeLimit: resolveTimeLimit
};
