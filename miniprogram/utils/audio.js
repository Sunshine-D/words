/**
 * 音效引擎（全部内嵌，零音频资源，安装包体积 0 增长）
 *
 * 实现方式：使用 wx.createWebAudioContext() 实时合成波形。
 * 兼容策略：基础库 < 2.19 无该能力时，自动降级为短振动，不阻塞游戏流程。
 */
const storage = require('./storage');

let ctx = null;
let failed = false;
let soundOn = true;
let vibrateOn = true;

(function syncSetting() {
  const s = storage.getSettings();
  soundOn = s.sound !== false;
  vibrateOn = s.vibrate !== false;
})();

function setEnabled(opts) {
  if (typeof opts.sound === 'boolean') soundOn = opts.sound;
  if (typeof opts.vibrate === 'boolean') vibrateOn = opts.vibrate;
}

function getContext() {
  if (ctx || failed) return ctx;
  if (typeof wx.createWebAudioContext !== 'function') {
    failed = true;
    return null;
  }
  try {
    ctx = wx.createWebAudioContext();
  } catch (e) {
    failed = true;
    ctx = null;
  }
  return ctx;
}

/** 预留：真正点击时解锁音频上下文（iOS 需要用户手势后创建） */
function unlock() {
  const c = getContext();
  if (!c) return;
  try {
    if (c.state === 'suspended' && c.resume) c.resume();
  } catch (e) {
    /* ignore */
  }
}

/**
 * 合成一个音符
 * @param {Object} o { freq, at, dur, type, vol, slideTo }
 */
function tone(o) {
  const c = getContext();
  if (!c) return;
  const t0 = c.currentTime + (o.at || 0);
  const dur = o.dur || 0.1;
  try {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.freq, t0);
    if (o.slideTo) {
      osc.frequency.exponentialRampToValueAtTime(o.slideTo, t0 + dur);
    }
    const vol = o.vol || 0.16;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch (e) {
    failed = true;
  }
}

function buzz(type) {
  if (!vibrateOn) return;
  try {
    wx.vibrateShort({ type: type || 'light' });
  } catch (e) {
    /* ignore */
  }
}

/* ---------- 对外音效 ---------- */

/** 卡片点击：清脆的「哒」 */
function click() {
  unlock();
  if (soundOn) {
    tone({ freq: 1180, dur: 0.055, type: 'triangle', vol: 0.13 });
    tone({ freq: 2360, at: 0.004, dur: 0.035, type: 'sine', vol: 0.05 });
  }
}

/** 匹配成功：上行双音 */
function match() {
  unlock();
  if (soundOn) {
    tone({ freq: 880, dur: 0.09, type: 'sine', vol: 0.15 });
    tone({ freq: 1320, at: 0.07, dur: 0.13, type: 'sine', vol: 0.13 });
  }
  buzz('light');
}

/** 配对错误：低闷音 */
function wrong() {
  unlock();
  if (soundOn) {
    tone({ freq: 240, dur: 0.13, type: 'sawtooth', vol: 0.08, slideTo: 160 });
  }
  buzz('heavy');
}

/** 通关：四音琶音 */
function win() {
  unlock();
  if (!soundOn) return;
  const notes = [523.25, 659.25, 783.99, 1046.5];
  for (let i = 0; i < notes.length; i++) {
    tone({ freq: notes[i], at: i * 0.11, dur: 0.24, type: 'sine', vol: 0.16 });
  }
  tone({ freq: 1567.98, at: 0.46, dur: 0.4, type: 'sine', vol: 0.1 });
}

/** 失败：下行三音 */
function lose() {
  unlock();
  if (!soundOn) return;
  const notes = [440, 349.23, 261.63];
  for (let i = 0; i < notes.length; i++) {
    tone({ freq: notes[i], at: i * 0.14, dur: 0.3, type: 'triangle', vol: 0.13 });
  }
}

module.exports = {
  setEnabled: setEnabled,
  unlock: unlock,
  click: click,
  match: match,
  wrong: wrong,
  win: win,
  lose: lose
};
