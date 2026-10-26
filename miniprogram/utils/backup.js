// 文件和云端共用同一种版本化备份；恢复采用新 ID，保留当前设备已有词库。
const storage = require('./storage');
const util = require('./util');
const JOURNAL = 'wm_restore_journal';
const MAX_BYTES = 8 * 1024 * 1024;

function object(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function validate(data) {
  if (!object(data) || data.format !== 'word-match-backup' || data.version !== 1 ||
      !Array.isArray(data.books) || !object(data.settings) || !object(data.stats)) {
    throw new Error('备份格式或版本不支持');
  }
  if (storage.estimateBytes(data) > MAX_BYTES) throw new Error('备份超过 8MB，请拆分词库后备份');
  Object.keys(data.settings).forEach(function (key) {
    const expected = storage.DEFAULT_SETTINGS[key];
    const value = data.settings[key];
    if (expected === undefined || typeof value !== typeof expected ||
        (typeof value === 'number' && !Number.isFinite(value))) throw new Error('备份设置无效');
  });
  const settings = data.settings;
  if ((settings.batchSize !== undefined && (settings.batchSize < 4 || settings.batchSize > 15)) ||
      (settings.batchMode !== undefined && ['random', 'sequential'].indexOf(settings.batchMode) < 0) ||
      (settings.layout !== undefined && ['side', 'stack'].indexOf(settings.layout) < 0) ||
      (settings.accent !== undefined && [1, 2].indexOf(settings.accent) < 0) ||
      (settings.dailyGoal !== undefined && (settings.dailyGoal < 10 || settings.dailyGoal > 200)) ||
      (settings.timeLimit !== undefined && settings.timeLimit < -1)) throw new Error('备份设置超出范围');
  const ids = new Set();
  data.books.forEach(function (entry) {
    if (!object(entry) || !object(entry.book) || typeof entry.book.id !== 'string' ||
        !entry.book.id || ids.has(entry.book.id) || !Array.isArray(entry.words) || !Array.isArray(entry.wrong)) {
      throw new Error('备份词库数据不完整');
    }
    ids.add(entry.book.id);
    if (typeof entry.book.name !== 'string' || !object(entry.book.progress)) throw new Error('备份词库信息无效');
    const progress = entry.book.progress;
    ['seqIndex', 'matchedTotal', 'playCount', 'bestMs', 'batchesDone'].forEach(function (key) {
      if (progress[key] !== undefined && (!Number.isFinite(progress[key]) || progress[key] < 0)) throw new Error('备份学习进度无效');
    });
    if (progress.pool !== undefined && (!Array.isArray(progress.pool) || progress.pool.some(id => typeof id !== 'string'))) throw new Error('备份抽词进度无效');
    const wordIds = new Set();
    entry.words.forEach(function (w) {
      if (!object(w) || typeof w.id !== 'string' || !w.id || wordIds.has(w.id) ||
          typeof w.en !== 'string' || !w.en.trim() || typeof w.cn !== 'string' || !w.cn.trim()) {
        throw new Error('备份中存在无效或重复词条');
      }
      wordIds.add(w.id);
    });
    entry.wrong.forEach(function (w) {
      if (!object(w) || typeof w.en !== 'string' || typeof w.cn !== 'string' ||
          !Number.isFinite(w.wrong) || !Number.isFinite(w.right) || w.wrong < 0 || w.right < 0) {
        throw new Error('备份错词数据无效');
      }
    });
    if (storage.estimateBytes(entry.words) > 900 * 1024 || storage.estimateBytes(entry.wrong) > 900 * 1024) {
      throw new Error('备份中的单个词库过大');
    }
  });
  const days = data.stats.days;
  if (!object(days)) throw new Error('备份学习统计无效');
  if (data.stats.bestStreak !== undefined && (!Number.isFinite(data.stats.bestStreak) || data.stats.bestStreak < 0)) throw new Error('备份连续学习天数无效');
  Object.keys(days).forEach(function (key) {
    const day = days[key];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !object(day)) throw new Error('备份统计日期无效');
    ['matched', 'games', 'wins', 'seconds'].forEach(function (field) {
      if (!Number.isFinite(day[field]) || day[field] < 0) throw new Error('备份统计数值无效');
    });
    if (day.by) {
      if (!object(day.by)) throw new Error('备份设备统计无效');
      Object.keys(day.by).forEach(function (id) {
        const counter = day.by[id];
        if (!object(counter)) throw new Error('备份设备统计无效');
        ['matched', 'games', 'wins', 'seconds'].forEach(function (field) {
          if (!Number.isFinite(counter[field]) || counter[field] < 0) throw new Error('备份设备统计数值无效');
        });
      });
    }
  });
  return data;
}

function create() {
  return validate({
    format: 'word-match-backup', version: 1, createdAt: Date.now(),
    books: storage.listBooks().map(function (book) {
      return { book: book, words: storage.getWords(book.id), wrong: storage.getWrongList(book.id) };
    }),
    settings: storage.getSettings(), stats: storage.getStats()
  });
}

function parse(text) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) throw new Error('备份文件过大');
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (e) { throw new Error('无法读取备份，请选择导出的 JSON 文件'); }
  return validate(data);
}

function check(ok) {
  if (!ok) throw new Error(storage.getLastError() || '保存失败');
}

// 索引最后提交。异常退出后，下次启动清理未提交词库并恢复原设置/统计。
function recover() {
  const journal = wx.getStorageSync(JOURNAL);
  if (!journal || !Array.isArray(journal.ids)) return;
  if (!journal.committed) {
    wx.setStorageSync('wm_books', journal.books);
    wx.setStorageSync('wm_settings', journal.settings);
    wx.setStorageSync('wm_stats', journal.stats);
    journal.ids.forEach(function (id) {
      wx.removeStorageSync('wm_words_' + id);
      wx.removeStorageSync('wm_wrong_' + id);
    });
  }
  wx.removeStorageSync(JOURNAL);
}

function restore(input) {
  const data = validate(JSON.parse(JSON.stringify(input)));
  recover();
  const books = storage.listBooks();
  const entries = data.books.map(function (entry) {
    const id = util.uid('restored');
    return { id: id, entry: entry };
  });
  const journal = {
    ids: entries.map(function (v) { return v.id; }),
    books: books, settings: storage.getSettings(), stats: storage.getStats(), committed: false
  };
  if (storage.estimateBytes(journal) > 900 * 1024) throw new Error('当前学习记录过大，无法安全创建恢复日志');
  const needKB = Math.ceil((storage.estimateBytes(data) + storage.estimateBytes(journal)) / 1024) + 32;
  const quota = storage.quotaKB();
  if (quota >= 0 && needKB > quota) throw new Error('本机空间不足，请先导出备份并清理旧词库');
  // 日志写入失败时尚未修改任何业务数据。
  wx.setStorageSync(JOURNAL, journal);
  try {
    entries.forEach(function (v) {
      check(storage.saveWordsQuiet(v.id, v.entry.words));
      check(storage.saveWrongList(v.id, v.entry.wrong));
    });
    check(storage.mergeStats(data.stats, true));
    check(storage.saveSettings(data.settings));
    check(storage.saveBooks(books.concat(entries.map(function (v) {
      return Object.assign({}, v.entry.book, { id: v.id, count: v.entry.words.length, updatedAt: Date.now() });
    }))));
    journal.committed = true;
    wx.setStorageSync(JOURNAL, journal);
  } catch (e) {
    try { recover(); }
    catch (rollbackError) { throw new Error('恢复未完成，请释放存储空间后重启小程序，原数据恢复日志已保留'); }
    throw e;
  }
  try { wx.removeStorageSync(JOURNAL); } catch (e) { /* committed 日志可在下次启动清理 */ }
  return entries.length;
}

module.exports = { create: create, parse: parse, validate: validate, restore: restore, recover: recover };
