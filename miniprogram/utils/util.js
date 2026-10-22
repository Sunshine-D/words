/**
 * 通用工具方法
 */

let idSeed = 0;

/** 生成短唯一 ID */
function uid(prefix) {
  idSeed += 1;
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return (prefix || 'id') + '_' + t + r + idSeed;
}

/** Fisher-Yates 洗牌，返回新数组 */
function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** 秒 -> mm:ss */
function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return pad(m) + ':' + pad(rest);
}

/** 毫秒 -> 1分23秒 / 45秒 */
function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? m + '分' + s + '秒' : s + '秒';
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

/** 今天 00:00 的时间戳 */
function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 相对时间：刚刚 / 3分钟前 / 昨天 / 10月20日 */
function fromNow(ts) {
  if (!ts) return '还没玩过';
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
  const t0 = todayStart();
  if (ts >= t0) return '今天 ' + new Date(ts).getHours() + ':' + pad(new Date(ts).getMinutes());
  if (ts >= t0 - 86400000) return '昨天';
  if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' 天前';
  const d = new Date(ts);
  return d.getMonth() + 1 + '月' + d.getDate() + '日';
}

/** Promise 化的 wx API */
function promisify(fn, options) {
  return new Promise(function (resolve, reject) {
    fn(Object.assign({}, options, { success: resolve, fail: reject }));
  });
}

/** 轻提示 */
function toast(title, icon) {
  wx.showToast({ title: title, icon: icon || 'none', duration: 1800 });
}

module.exports = {
  uid: uid,
  shuffle: shuffle,
  clamp: clamp,
  formatClock: formatClock,
  formatDuration: formatDuration,
  pad: pad,
  todayStart: todayStart,
  dayKey: dayKey,
  fromNow: fromNow,
  promisify: promisify,
  toast: toast
};
