/**
 * 单词发音（TTS）
 *
 * 小程序没有内置 TTS，这里走在线发音接口并用 InnerAudioContext 播放。
 * 默认使用有道公开发音接口，无需 API Key；失败自动回退到百度。
 *
 * ⚠️ 上线前必须在「小程序后台 - 开发管理 - 服务器域名 - downloadFile 合法域名」
 *    添加下列域名，否则真机无法播放（开发者工具可临时勾选「不校验合法域名」）：
 *      https://dict.youdao.com
 *      https://fanyi.baidu.com
 *
 * 若你有更稳定的服务商（如有道翻译开放平台、百度翻译开放平台），
 * 只需改 PROVIDERS 即可，调用方接口不变。
 */
const storage = require('./storage');

const PROVIDERS = [
  {
    id: 'youdao',
    name: '有道发音',
    url: function (word, accent) {
      // type: 1 英音 / 2 美音
      return 'https://dict.youdao.com/dictvoice?type=' + (accent === 1 ? 1 : 2) + '&audio=' + encodeURIComponent(word);
    }
  },
  {
    id: 'baidu',
    name: '百度翻译发音',
    url: function (word) {
      return 'https://fanyi.baidu.com/gettts?lan=en&spd=3&source=web&text=' + encodeURIComponent(word);
    }
  }
];

let ctx = null;
let current = null; // { word, providerIndex, resolve, reject, settled }
let lastPlayAt = 0;

function ensureCtx() {
  if (ctx) return ctx;
  try {
    ctx = wx.createInnerAudioContext();
    // 学习场景：即使 iOS 侧边静音键打开也发音
    ctx.obeyMuteSwitch = false;
    ctx.autoplay = true;
  } catch (e) {
    ctx = null;
  }
  return ctx;
}

function enabled() {
  const s = storage.getSettings();
  return s.tts !== false;
}

function accent() {
  const s = storage.getSettings();
  return Number(s.accent) === 1 ? 1 : 2;
}

function settleOk() {
  if (current && !current.settled) {
    current.settled = true;
    current.resolve(true);
  }
  current = null;
}

function settleFail(msg) {
  if (current && !current.settled) {
    // 还有备用源就试下一个
    if (current.providerIndex + 1 < PROVIDERS.length) {
      const next = current.providerIndex + 1;
      const word = current.word;
      const resolve = current.resolve;
      const reject = current.reject;
      current = { word: word, providerIndex: next, resolve: resolve, reject: reject, settled: false };
      playCurrent();
      return;
    }
    current.settled = true;
    current.reject(new Error(msg || '发音失败'));
  }
  current = null;
}

function playCurrent() {
  const audio = ensureCtx();
  if (!audio || !current) {
    settleFail('当前环境不支持播放音频');
    return;
  }
  const provider = PROVIDERS[current.providerIndex];
  const url = provider.url(current.word, accent());

  audio.stop();
  audio.src = url;
  audio.play();

  // 超时保护：某些情况下 onError / onEnded 都不回调
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(function () {
    if (current && !current.settled) settleFail('发音超时');
  }, 8000);
}

function bindOnce() {
  const audio = ensureCtx();
  if (!audio || audio.__ttsBound) return;
  audio.__ttsBound = true;

  audio.onEnded(function () {
    if (current && current.timer) clearTimeout(current.timer);
    settleOk();
  });

  audio.onError(function (res) {
    if (current && current.timer) clearTimeout(current.timer);
    const code = res && res.errCode;
    settleFail(code === 10001 ? '发音接口暂时不可用' : '发音失败（' + (code || '未知') + '）');
  });

  audio.onStop(function () {
    // 主动 stop 不算失败，交给下一次播放覆盖
  });
}

/**
 * 朗读一个单词
 * @param {String} word
 * @param {Object} [opts] { force: 忽略开关 }
 * @returns {Promise<boolean>}
 */
function speak(word, opts) {
  const text = String(word || '').trim();
  const options = opts || {};
  if (!text) return Promise.resolve(false);
  if (!options.force && !enabled()) return Promise.resolve(false);

  // 节流：300ms 内重复请求直接忽略，防连点
  const now = Date.now();
  if (current && !current.settled && now - lastPlayAt < 300) {
    return Promise.resolve(false);
  }
  lastPlayAt = now;

  bindOnce();

  return new Promise(function (resolve, reject) {
    // 上一次还没结束就先结算掉，避免 Promise 悬挂
    if (current && !current.settled) settleOk();
    current = { word: text, providerIndex: 0, resolve: resolve, reject: reject, settled: false };
    playCurrent();
  });
}

/** 静默播放：失败也不弹提示，用于「点击卡片自动朗读」 */
function speakQuiet(word) {
  return speak(word).catch(function () {
    return false;
  });
}

function destroy() {
  if (ctx) {
    try {
      ctx.destroy();
    } catch (e) {
      /* ignore */
    }
    ctx = null;
  }
  current = null;
}

module.exports = {
  speak: speak,
  speakQuiet: speakQuiet,
  enabled: enabled,
  accent: accent,
  destroy: destroy,
  PROVIDERS: PROVIDERS
};
