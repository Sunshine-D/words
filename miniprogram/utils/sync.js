/**
 * 同步引擎（本地优先 + 云端双向同步）
 *
 * 为什么这样设计：
 * 业务代码里 25 处 storage 调用**全是同步的**，如果改成异步接口要动所有页面。
 * 所以约定：**读永远走本地（同步，业务零感知），写先落本地、再异步推云**。
 * 好处是断网照样能背单词，联网后自动补推，不会出现"转圈等网络"。
 *
 * 冲突解决按数据性质分三种，不能一刀切：
 * - 词库（含词表）：整体版本，以 updatedAt 较新者为准
 * - 错词本：逐词合并（wrong 取 max，right 取更近的一次）
 * - 统计：按「日期 → 设备」分桶合并，汇总值由明细求和得出
 * 后两者都是计数器，整对象覆盖会丢数据或在反复同步中数值膨胀。
 *
 * 脏键（dirty）会持久化：改动后还没推成功就关掉小程序，下次启动继续推，不丢数据。
 *
 * 模式：auto（默认，有云就同步、没云自动落本机）/ local（始终仅本机）。
 * 不让学生去理解「云端是什么」，默认 auto 即可。
 */
const cloud = require('./cloud');

const KEY_MODE = 'wm_sync_mode';
const KEY_TS = 'wm_syncts';
const KEY_DIRTY = 'wm_dirty';
const KEY_LAST = 'wm_sync_last';

const DEBOUNCE = 900; // 防抖窗口，合并短时间内的连续改动

let mode = 'auto';
let cloudReady = false; // 云是否真的可用（init 成功），auto 模式下靠它决定行为
let dirty = null;
let timer = null;
let syncing = false;
let status = 'off'; // off | idle | syncing | error | unavailable
let lastSyncAt = 0;
let lastError = '';
let listeners = [];
let storageRef = null;

function S() {
  if (!storageRef) storageRef = require('./storage');
  return storageRef;
}

/* ============ 本地小读写 ============ */

function readObj(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    if (v === '' || v === null || v === undefined) return fallback;
    return typeof v === 'object' && v !== null ? v : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeObj(key, value) {
  try {
    wx.setStorageSync(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

function loadDirty() {
  if (dirty) return dirty;
  dirty = readObj(KEY_DIRTY, {});
  return dirty;
}

function saveDirty() {
  writeObj(KEY_DIRTY, dirty || {});
}

function tsMap() {
  return readObj(KEY_TS, {});
}

function setTs(key, ts) {
  const m = tsMap();
  m[key] = ts || Date.now();
  writeObj(KEY_TS, m);
}

function getTs(key) {
  const m = tsMap();
  return m[key] || 0;
}

function isDirty(key) {
  const d = loadDirty();
  return !!(key && d[key]);
}

/** 是否真的在往云端同步。auto 模式下云不可用则为 false */
function active() {
  return mode !== 'local' && cloudReady;
}

/* ============ 状态广播 ============ */

function emit() {
  const payload = {
    mode: mode,
    cloudOn: active(),
    status: status,
    lastSyncAt: lastSyncAt,
    lastError: lastError,
    dirtyCount: Object.keys(loadDirty()).length,
    cloudState: cloud.getState(),
    cloudReason: cloud.getFailReason()
  };
  listeners.forEach(function (fn) {
    try {
      fn(payload);
    } catch (e) {
      /* ignore */
    }
  });
}

function onStatus(fn) {
  if (typeof fn === 'function') listeners.push(fn);
  return function () {
    listeners = listeners.filter(function (f) {
      return f !== fn;
    });
  };
}

function setStatus(s, err) {
  status = s;
  lastError = err || '';
  emit();
}

/* ============ 模式 ============ */

function getMode() {
  return mode;
}

function init() {
  try {
    const v = wx.getStorageSync(KEY_MODE);
    // 只有显式选过「仅本机」才是 local；旧版本存的 'cloud' 归并到 auto
    mode = v === 'local' ? 'local' : 'auto';
  } catch (e) {
    mode = 'auto';
  }
  try {
    const t = wx.getStorageSync(KEY_LAST);
    lastSyncAt = typeof t === 'number' ? t : 0;
  } catch (e) {
    lastSyncAt = 0;
  }
  loadDirty();

  if (mode === 'local') {
    cloudReady = false;
    setStatus('off');
    return mode;
  }

  // auto：能连上云就同步，连不上就安静地退回本机，不给用户制造焦虑
  cloudReady = cloud.init();
  if (!cloudReady) {
    setStatus('unavailable', cloud.getFailReason());
    watchNetwork();
    return mode;
  }
  setStatus('idle');
  watchNetwork();
  schedule(true);
  return mode;
}

/**
 * 监听网络恢复。
 * 启动时没网（地铁、飞行模式）会让 cloudReady 一直为 false，
 * 不重试的话用户得杀掉小程序重开才能恢复同步。
 */
let netWatched = false;
function watchNetwork() {
  if (netWatched) return;
  if (typeof wx.onNetworkStatusChange !== 'function') return;
  netWatched = true;
  try {
    wx.onNetworkStatusChange(function (res) {
      if (!res || !res.isConnected) return;
      if (mode === 'local') return;
      if (cloudReady && cloud.usable()) {
        schedule(false);
        return;
      }
      // 之前没连上（启动时无网 / 环境未就绪），现在有网了再试一次
      cloudReady = cloud.init();
      if (!cloudReady) {
        setStatus('unavailable', cloud.getFailReason());
        return;
      }
      setStatus('idle');
      schedule(true);
    });
  } catch (e) {
    /* 监听失败不影响主流程 */
  }
}

/**
 * 切换前的探查：给 UI 用于弹冲突选择框
 * @returns {{ok, reason, localCount, cloudCount}}
 */
function probeCloud() {
  if (!cloud.init()) {
    return { ok: false, reason: cloud.getFailReason() || '云环境不可用', localCount: 0, cloudCount: 0 };
  }
  return cloud.pullAll().then(function (data) {
    if (!data) return { ok: false, reason: '读取云端数据失败，请检查网络', localCount: 0, cloudCount: 0 };
    return {
      ok: true,
      reason: '',
      localCount: S().listBooks().length,
      cloudCount: (data.books || []).length,
      data: data
    };
  });
}

/**
 * 启用云同步
 * @param {string} strategy 'keep-local' 用本地覆盖云端 / 'keep-cloud' 用云端覆盖本地 / 'merge' 按时间合并
 * @param {Object} [probed] probeCloud 返回的 data，避免重复拉取
 */
function enableCloud(strategy, probed) {
  if (!cloud.init()) {
    cloudReady = false;
    setStatus('unavailable', cloud.getFailReason());
    return Promise.resolve(false);
  }
  mode = 'auto';
  cloudReady = true;
  writeObj(KEY_MODE, 'auto');
  setStatus('syncing');

  return Promise.resolve()
    .then(function () {
      return probed || cloud.pullAll();
    })
    .then(function (data) {
      if (!data) {
        setStatus('error', '读取云端失败');
        return false;
      }
      const strat = strategy || 'merge';
      if (strat === 'keep-cloud') {
        applyCloud(data, true);
      } else if (strat === 'merge') {
        applyCloud(data, false);
      }
      // keep-local：本地不动，直接整包覆盖云端
      return pushEverything().then(function (allOk) {
        if (!allOk) {
          setStatus('error', '部分数据未上传，将在联网后重试');
          return false;
        }
        markSynced();
        return true;
      });
    })
    .catch(function (err) {
      setStatus('error', '开启云同步失败');
      console.error('[sync] enableCloud failed', err);
      return false;
    });
}

function disableCloud() {
  mode = 'local';
  cloudReady = false;
  writeObj(KEY_MODE, 'local');
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  setStatus('off');
  return true;
}

function markSynced() {
  lastSyncAt = Date.now();
  writeObj(KEY_LAST, lastSyncAt);
  dirty = {};
  saveDirty();
  setStatus('idle');
}

/* ============ 云端 → 本地 ============ */

/**
 * 把云端数据合并写回本地
 * @param {Object} data cloud.pullAll() 结果
 * @param {boolean} force true 时无条件以云端为准
 */
function applyCloud(data, force) {
  if (!data) return;
  const st = S();
  const localBooks = st.listBooks();
  const cloudBooks = data.books || [];

  // 词库：以 updatedAt 较新者为准
  const merged = [];
  const used = {};
  cloudBooks.forEach(function (cb) {
    if (!cb || !cb.id) return;
    used[cb.id] = true;
    const lb = localBooks.filter(function (b) {
      return b.id === cb.id;
    })[0];
    let winner = cb;
    if (lb && !force && (lb.updatedAt || 0) > (cb.updatedAt || 0)) {
      winner = lb; // 本地更新，保留本地
    } else {
      // 云端为准（或强制覆盖），词表一起下来。
      // 用静默写入：拉下来的词表不该被标脏又推回去
      const words = data.words[cb.id];
      if (words && words.length) st.saveWordsQuiet(cb.id, words);
    }
    merged.push(winner);
    setTs('book:' + cb.id, (winner.updatedAt || 0));
  });

  if (force) {
    // 强制以云端为准：本地多余的词库要删掉，保证两端一致
    localBooks.forEach(function (b) {
      if (!used[b.id]) st.deleteBook(b.id);
    });
  } else {
    localBooks.forEach(function (b) {
      if (!used[b.id]) merged.push(b);
    });
  }

  st.saveBooks(merged);

  // 错词本：逐词合并。整列表覆盖会让已毕业的词被另一端旧数据复活
  Object.keys(data.wrong || {}).forEach(function (bid) {
    const list = data.wrong[bid] || [];
    if (force) {
      st.saveWrongList(bid, list);
    } else {
      st.mergeWrongList(bid, list);
    }
    setTs('wrong:' + bid, Date.now());
  });

  // 统计：按「日期 → 设备」分桶合并。整对象覆盖会丢掉另一台设备上的记录
  if (data.stats) {
    if (force) st.saveStats(data.stats);
    else st.mergeStats(data.stats);
    setTs('stats', Date.now());
  }

  // 设置：本地有还没推上去的改动时不要覆盖，否则会把用户刚改的设置回滚。
  // 同样用静默写入，避免「拉 → 标脏 → 再推」的循环。
  if (data.settings && (force || !isDirty('settings'))) {
    const s = Object.assign({}, data.settings);
    delete s.storageMode;
    st.saveSettingsQuiet(s);
    setTs('settings', Date.now());
  }
}

/* ============ 本地 → 云端 ============ */

/**
 * 把本地全量推到云端。
 * 返回是否**全部**成功——部分失败时不能清空 dirty，否则未成功的部分就再也不会重试了。
 */
function pushEverything() {
  const st = S();
  const books = st.listBooks();
  const jobs = [];
  books.forEach(function (b) {
    jobs.push(cloud.pushBook(b, st.getWords(b.id)));
    const wrong = st.getWrongList(b.id);
    if (wrong && wrong.length) jobs.push(cloud.pushWrong(b.id, wrong));
  });
  jobs.push(cloud.pushStats(st.getStats()));
  jobs.push(cloud.pushSettings(st.getSettings()));
  return Promise.all(
    jobs.map(function (p) {
      return Promise.resolve(p).then(
        function (r) {
          return r !== false;
        },
        function () {
          return false;
        }
      );
    })
  ).then(function (rs) {
    return rs.every(function (r) {
      return r;
    });
  });
}

/** 只推送脏键。失败的键必须留在 dirty 里等重试，清掉就等于永久丢数据 */
function pushDirty() {
  const keys = Object.keys(loadDirty());
  if (!keys.length) return Promise.resolve(true);
  const st = S();
  const tasks = []; // { key, run: Promise<boolean> }

  keys.forEach(function (k) {
    let run = null;
    if (k.indexOf('book:') === 0) {
      const bid = k.slice(5);
      const b = st.getBook(bid);
      // 本地已删除 → 同步删除云端
      run = b ? cloud.pushBook(b, st.getWords(bid)) : cloud.deleteBook(bid);
    } else if (k.indexOf('wrong:') === 0) {
      const bid = k.slice(6);
      run = cloud.pushWrong(bid, st.getWrongList(bid));
    } else if (k === 'stats') {
      run = cloud.pushStats(st.getStats());
    } else if (k === 'settings') {
      run = cloud.pushSettings(st.getSettings());
    } else {
      run = Promise.resolve(true);
    }
    tasks.push({
      key: k,
      run: Promise.resolve(run).then(
        function (r) {
          return r !== false;
        },
        function () {
          return false;
        }
      )
    });
  });

  return Promise.all(
    tasks.map(function (t) {
      return t.run;
    })
  ).then(function (results) {
    const d = loadDirty();
    let failed = 0;
    results.forEach(function (ok, i) {
      if (ok) {
        delete d[tasks[i].key];
      } else {
        failed += 1;
      }
    });
    saveDirty();
    if (!failed) {
      lastSyncAt = Date.now();
      writeObj(KEY_LAST, lastSyncAt);
    }
    const left = Object.keys(d).length;
    if (left) {
      setStatus('error', left + ' 项未同步，将在联网后重试');
    } else {
      setStatus('idle');
    }
    return left === 0;
  });
}

/* ============ 对外：标记改动 ============ */

/**
 * 业务层改动后调用。由 storage.write / deleteBook 自动触发，页面无需关心。
 * @param {string} key 'book:<id>' | 'wrong:<id>' | 'stats' | 'settings'
 */
function touch(key) {
  if (!active()) return;
  if (!key) return;
  const d = loadDirty();
  d[key] = Date.now();
  saveDirty();
  setTs(key, Date.now());
  // 离线要立刻反馈，不能等防抖窗口过去才变灰——用户需要马上知道"存在本机了"
  if (!cloud.usable()) {
    setStatus('unavailable', '当前无网络，已保存在本机');
    return;
  }
  schedule(false);
}

function schedule(immediate) {
  if (!active()) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (immediate) {
    runSync();
    return;
  }
  timer = setTimeout(function () {
    timer = null;
    runSync();
  }, DEBOUNCE);
}

function runSync() {
  if (!active() || syncing) return Promise.resolve(false);
  if (!cloud.usable()) {
    setStatus('unavailable', '当前无网络，已保存在本机');
    return Promise.resolve(false);
  }
  syncing = true;
  setStatus('syncing');
  return pushDirty().then(function (ok) {
    syncing = false;
    return ok;
  });
}

/** 手动立即同步（数据管理页按钮） */
function syncNow() {
  if (!active()) {
    setStatus('off');
    return Promise.resolve(false);
  }
  syncing = false;
  return runSync();
}

/** 启动时的轻量同步：先推脏键，再拉云端补全新设备的数据 */
function bootstrap() {
  if (!active()) return Promise.resolve(false);
  if (!cloud.usable()) {
    setStatus('unavailable', '当前无网络');
    return Promise.resolve(false);
  }
  setStatus('syncing');
  return pushDirty()
    .then(function () {
      return cloud.pullAll();
    })
    .then(function (data) {
      if (data) applyCloud(data, false);
      markSynced();
      return true;
    })
    .catch(function () {
      setStatus('error', '启动同步失败');
      return false;
    });
}

function statusSnapshot() {
  return {
    mode: mode,
    cloudOn: active(),
    status: status,
    lastSyncAt: lastSyncAt,
    lastError: lastError,
    dirtyCount: Object.keys(loadDirty()).length,
    cloudState: cloud.getState(),
    cloudReason: cloud.getFailReason()
  };
}

module.exports = {
  init: init,
  getMode: getMode,
  probeCloud: probeCloud,
  enableCloud: enableCloud,
  disableCloud: disableCloud,
  touch: touch,
  syncNow: syncNow,
  bootstrap: bootstrap,
  onStatus: onStatus,
  // 内部方法，仅测试使用：直接驱动一次云端合并
  applyCloud: applyCloud,
  statusSnapshot: statusSnapshot,
  KEY_MODE: KEY_MODE
};
