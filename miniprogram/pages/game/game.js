const app = getApp();
const storage = require('../../utils/storage');
const util = require('../../utils/util');
const audio = require('../../utils/audio');
const tts = require('../../utils/tts');

/** 按字段去重，保留首次出现 */
function dedupe(list, field) {
  const seen = {};
  const out = [];
  list.forEach(function (item) {
    const k = String(item[field] || '').toLowerCase();
    if (seen[k]) return;
    seen[k] = 1;
    out.push(item);
  });
  return out;
}

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    bookName: '',
    batchLabel: '',
    mode: 'normal', // normal 常规闯关 / review 错词复习
    wrongWords: [], // 本局配对错的词，结算时展示
    wrongCount: 0,
    masteredCount: 0, // 本局新掌握的词数（复习模式）
    timeText: '--:--',
    urgent: false,
    unlimited: false,
    matchPercent: 0,
    matched: 0,
    total: 0,
    combo: 0,
    showCombo: false,
    layout: 'side',
    enCards: [],
    cnCards: [],
    showResult: false,
    win: false,
    usedText: '',
    stars: 0,
    starsText: '',
    loading: true
  },

  onLoad(options) {
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight,
      navBarHeight: app.globalData.navBarHeight
    });

    this.bookId = options.bookId || '';
    this.batchIndex = options.batch != null && options.batch !== '' ? Number(options.batch) : -1;
    this.mode = options.mode === 'review' ? 'review' : 'normal';
    this.selectedEn = null;
    this.selectedCn = null;
    this.matched = 0;
    this.locked = false;
    this.finished = false;
    this.isSequential = false;
    this.nextPool = null;
    this.wrongThisRound = [];
    this.mastered = 0;

    // 进入即尝试解锁音频（iOS 需要用户手势，这里先声明，点击时再次 unlock）
    audio.unlock();
    this.init();
  },

  onShow() {
    const s = storage.getSettings();
    if (s.layout !== this.data.layout) {
      this.setData({ layout: s.layout });
    }
    // 从后台返回时恢复计时
    if (!this.finished && this.limit && !this.timer && this.data.enCards.length) {
      this.startTimer();
    }
  },

  onUnload() {
    this.clearTimer();
  },

  onHide() {
    this.clearTimer();
  },

  /* ================= 初始化 ================= */

  init() {
    const book = storage.getBook(this.bookId);
    if (!book) {
      util.toast('词库不存在');
      setTimeout(() => wx.navigateBack(), 700);
      return;
    }

    const words = storage.getWords(this.bookId);
    if (words.length < 4) {
      util.toast('这个词库的单词太少啦');
      setTimeout(() => wx.navigateBack(), 900);
      return;
    }

    const settings = storage.getSettings();
    const size = util.clamp(Number(settings.batchSize) || 6, 4, 15);
    const totalBatches = Math.max(1, Math.ceil(words.length / size));
    const progress = book.progress || {};

    let picked = [];
    let label = '';

    if (this.mode === 'review') {
      // 复习模式：从错词本里取未掌握的词，按错误次数优先
      const wrongs = storage.getWrongActive(this.bookId);
      if (wrongs.length < 4) {
        util.toast('错词本还不够 4 个词，先去闯关吧');
        setTimeout(() => wx.navigateBack(), 900);
        return;
      }
      picked = wrongs.slice(0, size).map(function (w, i) {
        return { id: 'k' + i, en: w.en, cn: w.cn };
      });
      label = '错词复习 · 剩 ' + wrongs.length + ' 词';
    } else if (settings.batchMode === 'sequential') {
      this.isSequential = true;
      let idx = this.batchIndex >= 0 ? this.batchIndex : progress.seqIndex || 0;
      if (idx < 0 || idx >= totalBatches) idx = 0;
      this.batchIndex = idx;
      this.totalBatches = totalBatches;
      picked = words.slice(idx * size, idx * size + size);
      label = '第 ' + (idx + 1) + ' / ' + totalBatches + ' 批';
    } else {
      this.isSequential = false;
      // pool 记录"还没抽到"的单词 id
      const allIds = words.map(function (w) {
        return w.id;
      });
      let pool = (progress.pool || []).filter(function (id) {
        return allIds.indexOf(id) >= 0;
      });
      if (pool.length === 0) pool = allIds.slice();

      const shuffled = util.shuffle(pool);
      const pickedIds = shuffled.slice(0, size);
      this.nextPool = shuffled.slice(size);

      const map = {};
      words.forEach(function (w) {
        map[w.id] = w;
      });
      picked = pickedIds
        .map(function (id) {
          return map[id];
        })
        .filter(Boolean);

      label = '随机 ' + picked.length + ' 词';
    }

    if (picked.length < 2) {
      util.toast('单词不够，无法开始');
      setTimeout(() => wx.navigateBack(), 900);
      return;
    }

    this.picked = picked;
    this.wordMap = {};
    picked.forEach(function (w) {
      this.wordMap[w.id] = w;
    }, this);
    this.limit = storage.resolveTimeLimit(picked.length);
    this.startAt = Date.now();

    // 左右两列分别独立打乱，保证顺序不对应
    const enCards = util.shuffle(picked).map(function (w) {
      return { key: w.id, text: w.en, state: 'idle' };
    });
    const cnCards = util.shuffle(picked).map(function (w) {
      return { key: w.id, text: w.cn, state: 'idle' };
    });

    this.enIndex = {};
    this.cnIndex = {};
    enCards.forEach((c, i) => {
      this.enIndex[c.key] = i;
    });
    cnCards.forEach((c, i) => {
      this.cnIndex[c.key] = i;
    });

    this.setData(
      {
        bookName: book.name,
        batchLabel: label,
        mode: this.mode,
        layout: settings.layout === 'stack' ? 'stack' : 'side',
        total: picked.length,
        matched: 0,
        matchPercent: 0,
        enCards: enCards,
        cnCards: cnCards,
        loading: false,
        unlimited: this.limit === 0,
        timeText: this.limit === 0 ? '不限时' : util.formatClock(this.limit)
      },
      () => {
        this.startTimer();
      }
    );
  },

  /* ================= 倒计时 ================= */

  startTimer() {
    if (!this.limit) return;
    this.clearTimer();
    if (this.remain == null) this.remain = this.limit;
    this.timer = setInterval(() => {
      this.remain -= 1;
      if (this.remain <= 0) {
        this.remain = 0;
        this.setData({ timeText: '00:00', urgent: true });
        this.finish(false);
        return;
      }
      this.setData({
        timeText: util.formatClock(this.remain),
        urgent: this.remain <= 10
      });
    }, 1000);
  },

  clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  /* ================= 点击配对 ================= */

  onPick(e) {
    if (this.locked || this.finished) return;

    const detail = e.detail || {};
    const side = detail.side;
    const key = detail.key;
    if (!side || !key) return;

    // 已配对的卡片不再响应
    const list = side === 'en' ? this.data.enCards : this.data.cnCards;
    const mapIdx = side === 'en' ? this.enIndex : this.cnIndex;
    const cur = list[mapIdx[key]];
    if (!cur || cur.state === 'matched') return;

    audio.click();

    if (side === 'en') {
      if (this.selectedEn === key) {
        this.setCardState('en', key, 'idle');
        this.selectedEn = null;
        return;
      }
      if (this.selectedEn) this.setCardState('en', this.selectedEn, 'idle');
      this.selectedEn = key;
      this.setCardState('en', key, 'selected');
      // 选中英文时自动朗读，强化「音 - 形 - 义」关联
      const w = this.wordMap[key];
      if (w && w.en) tts.speakQuiet(w.en);
    } else {
      if (this.selectedCn === key) {
        this.setCardState('cn', key, 'idle');
        this.selectedCn = null;
        return;
      }
      if (this.selectedCn) this.setCardState('cn', this.selectedCn, 'idle');
      this.selectedCn = key;
      this.setCardState('cn', key, 'selected');
    }

    if (this.selectedEn && this.selectedCn) {
      this.check();
    }
  },

  check() {
    const en = this.selectedEn;
    const cn = this.selectedCn;
    this.selectedEn = null;
    this.selectedCn = null;

    const enWord = this.wordMap[en];
    const cnWord = this.wordMap[cn];

    if (en === cn) {
      this.setCardState('en', en, 'matched');
      this.setCardState('cn', cn, 'matched');
      this.matched += 1;
      audio.match();

      // 复习模式：答对累计，连续达标即判定掌握
      if (this.mode === 'review' && enWord) {
        if (storage.markRight(this.bookId, enWord.en)) {
          this.mastered += 1;
          this.setData({ masteredCount: this.mastered });
        }
      }

      const percent = Math.round((this.matched / this.data.total) * 100);
      this.setData({ matched: this.matched, matchPercent: percent });

      if (this.matched >= this.data.total) {
        this.finish(true);
        return;
      }
      this.bumpCombo();
    } else {
      this.locked = true;
      audio.wrong();
      this.setCardState('en', en, 'wrong');
      this.setCardState('cn', cn, 'wrong');
      this.combo = 0;
      this.setData({ combo: 0, showCombo: false });

      // 两个词都进错词本：干扰项来自同批，点错说明辨析都不牢
      const wrongPair = [];
      if (enWord) wrongPair.push({ en: enWord.en, cn: enWord.cn });
      if (cnWord && (!enWord || cnWord.en !== enWord.en)) {
        wrongPair.push({ en: cnWord.en, cn: cnWord.cn });
      }
      if (wrongPair.length) {
        storage.markWrong(this.bookId, wrongPair);
        this.wrongThisRound = dedupe(this.wrongThisRound.concat(wrongPair), 'en');
      }

      setTimeout(() => {
        this.setCardState('en', en, 'idle');
        this.setCardState('cn', cn, 'idle');
        this.locked = false;
      }, 420);
    }
  },

  bumpCombo() {
    this.combo = (this.combo || 0) + 1;
    if (this.combo < 2) return;
    this.setData({ combo: this.combo, showCombo: true });
    if (this.comboTimer) clearTimeout(this.comboTimer);
    this.comboTimer = setTimeout(() => {
      this.setData({ showCombo: false });
    }, 1200);
  },

  setCardState(side, key, state) {
    const map = side === 'en' ? this.enIndex : this.cnIndex;
    const idx = map ? map[key] : undefined;
    if (idx === undefined) return;
    const field = (side === 'en' ? 'enCards[' : 'cnCards[') + idx + '].state';
    const patch = {};
    patch[field] = state;
    this.setData(patch);
  },

  /* ================= 结算 ================= */

  finish(win) {
    if (this.finished) return;
    this.finished = true;
    this.clearTimer();

    const ms = Date.now() - this.startAt;
    let stars = 0;
    if (win) {
      audio.win();
      if (!this.limit) {
        stars = 3;
      } else {
        const leftRatio = Math.max(0, this.remain || 0) / this.limit;
        stars = leftRatio >= 0.5 ? 3 : leftRatio >= 0.25 ? 2 : 1;
      }
    } else {
      audio.lose();
    }

    const record = { matched: this.matched, win: win, ms: ms };
    // 复习模式不推进主词库的批次进度
    if (win && this.mode !== 'review') {
      if (this.isSequential) {
        record.seqIndex = this.batchIndex + 1;
      } else {
        record.pool = this.nextPool || [];
      }
    }
    storage.recordPlay(this.bookId, record);
    storage.recordStats(this.matched, win, ms / 1000);

    let starText = '';
    for (let i = 0; i < 3; i++) {
      starText += i < stars ? '★' : '☆';
    }

    const wrongWords = this.wrongThisRound.slice();

    setTimeout(() => {
      this.setData({
        showResult: true,
        win: win,
        usedText: util.formatDuration(ms),
        stars: stars,
        starsText: starText,
        wrongWords: wrongWords,
        wrongCount: wrongWords.length
      });
    }, win ? 420 : 200);
  },

  /* ================= 操作 ================= */

  nextBatch() {
    audio.click();

    // 复习模式：一直留在错词本里
    if (this.mode === 'review') {
      const left = storage.getWrongCount(this.bookId);
      if (left < 4) {
        wx.redirectTo({ url: '/pages/book/book?id=' + this.bookId });
        return;
      }
      wx.redirectTo({ url: '/pages/game/game?bookId=' + this.bookId + '&mode=review' });
      return;
    }

    if (!this.data.win) {
      // 失败：重来本批
      const suffix =
        this.isSequential && this.batchIndex >= 0 ? '&batch=' + this.batchIndex : '';
      wx.redirectTo({ url: '/pages/game/game?bookId=' + this.bookId + suffix });
      return;
    }

    if (this.isSequential) {
      const next = this.batchIndex + 1;
      if (next >= this.totalBatches) {
        wx.redirectTo({ url: '/pages/book/book?id=' + this.bookId });
        return;
      }
      wx.redirectTo({ url: '/pages/game/game?bookId=' + this.bookId + '&batch=' + next });
    } else {
      wx.redirectTo({ url: '/pages/game/game?bookId=' + this.bookId });
    }
  },

  /** 结算页点击错词朗读 */
  speakWord(e) {
    const word = e.currentTarget.dataset.word;
    if (!word) return;
    tts.speak(word, { force: true }).catch(function (err) {
      util.toast((err && err.message) || '发音失败');
    });
  },

  goBack() {
    audio.click();
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.redirectTo({ url: '/pages/home/home' });
    }
  },

  onShareAppMessage() {
    return {
      title: '单词消消乐 · 我刚刚消掉了 ' + this.data.total + ' 个单词',
      path: '/pages/home/home'
    };
  }
});
