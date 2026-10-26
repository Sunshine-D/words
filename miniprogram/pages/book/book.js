const storage = require('../../utils/storage');
const util = require('../../utils/util');
const audio = require('../../utils/audio');
const tts = require('../../utils/tts');

const PAGE_SIZE = 40;

Page({
  data: {
    bookId: '',
    book: null,
    settings: {},
    batches: [],
    totalBatches: 0,
    doneBatches: 0,
    percent: 0,
    timeLimitLabel: '自动',
    words: [],
    loadedWords: 0,
    totalWords: 0,
    wordsExpanded: false,
    modeTip: '',
    startLabel: '开始闯关',
    // 错词本
    wrongCount: 0,
    wrongPreview: [],
    masteredCount: 0,
    goalOptions: [20, 30, 50, 80]
  },

  onLoad(options) {
    const id = options.id || '';
    this.setData({ bookId: id });
    if (options.fresh === '1') {
      setTimeout(function () {
        util.toast('导入成功，试试第一批');
      }, 400);
    }
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const id = this.data.bookId;
    const book = storage.getBook(id);
    if (!book) {
      util.toast('词库不存在');
      setTimeout(function () {
        wx.navigateBack();
      }, 800);
      return;
    }

    const settings = storage.getSettings();
    const size = util.clamp(Number(settings.batchSize) || 6, 4, 15);
    const allWords = storage.getWords(id);

    const totalBatches = Math.max(1, Math.ceil(book.count / size));
    const seqIndex = (book.progress && book.progress.seqIndex) || 0;

    const batches = [];
    for (let i = 0; i < totalBatches; i++) {
      const from = i * size + 1;
      const to = Math.min(book.count, (i + 1) * size);
      let status = 'idle';
      if (i < seqIndex) status = 'done';
      else if (i === seqIndex) status = 'current';
      batches.push({
        index: i,
        label: from + '-' + to,
        status: status
      });
    }

    const layoutWords = allWords.slice(0, PAGE_SIZE).map(function (w, i) {
      return { id: w.id, en: w.en, cn: w.cn, no: i + 1 };
    });

    this.allWords = allWords;

    // 错词本
    const wrongAll = storage.getWrongList(id);
    const wrongActive = storage.getWrongActive(id);
    const wrongPreview = wrongActive.slice(0, 5).map(function (w) {
      return { en: w.en, cn: w.cn, wrong: w.wrong };
    });

    let startLabel;
    if (settings.batchMode === 'sequential') {
      startLabel = seqIndex >= totalBatches ? '全部学完 · 再来一轮' : '开始第 ' + (seqIndex + 1) + ' 批';
    } else {
      startLabel = '随机闯关';
    }

    this.setData({
      book: book,
      settings: settings,
      batches: batches,
      totalBatches: totalBatches,
      doneBatches: Math.min(totalBatches, (book.progress && book.progress.batchesDone) || 0),
      percent: Math.round((Math.min(totalBatches, seqIndex) / totalBatches) * 100),
      timeLimitLabel: this.labelOfTime(settings.timeLimit),
      words: layoutWords,
      loadedWords: layoutWords.length,
      totalWords: book.count,
      startLabel: startLabel,
      wrongCount: wrongActive.length,
      wrongPreview: wrongPreview,
      masteredCount: wrongAll.filter(function (w) {
        return w.mastered;
      }).length,
      modeTip:
        settings.batchMode === 'sequential'
          ? '按文件顺序一批一批往下学'
          : '每批从没练过的单词里随机抽取'
    });
  },

  labelOfTime(v) {
    const n = Number(v) || 0;
    if (n === -1) return '不限时';
    if (n === 0) return '自动（按词量算）';
    return n + ' 秒';
  },

  /* ================= 设置 ================= */

  saveSetting(patch) {
    const next = storage.saveSettings(patch);
    if (!next) return;
    this.setData({ settings: next });
    this.refresh();
  },

  decBatch() {
    const size = util.clamp((Number(this.data.settings.batchSize) || 6) - 1, 4, 15);
    this.saveSetting({ batchSize: size });
    audio.click();
  },

  incBatch() {
    const size = util.clamp((Number(this.data.settings.batchSize) || 6) + 1, 4, 15);
    this.saveSetting({ batchSize: size });
    audio.click();
  },

  pickSize(e) {
    const size = Number(e.currentTarget.dataset.size);
    this.saveSetting({ batchSize: size });
    audio.click();
  },

  pickMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.saveSetting({ batchMode: mode });
    audio.click();
  },

  pickTime(e) {
    const t = Number(e.currentTarget.dataset.time);
    this.saveSetting({ timeLimit: t });
    audio.click();
  },

  pickLayout(e) {
    const l = e.currentTarget.dataset.layout;
    this.saveSetting({ layout: l });
    audio.click();
  },

  /* ================= 开始游戏 ================= */

  startNext() {
    audio.unlock();
    const book = this.data.book;
    const seqIndex = (book.progress && book.progress.seqIndex) || 0;
    // 全部学完后再点一次，从第一批重新开始
    if (this.data.settings.batchMode === 'sequential' && seqIndex >= this.data.totalBatches) {
      storage.updateBook(this.data.bookId, {
        progress: Object.assign({}, book.progress, { seqIndex: 0 })
      });
    }
    wx.navigateTo({ url: '/pages/game/game?bookId=' + this.data.bookId });
  },

  startBatch(e) {
    const i = Number(e.currentTarget.dataset.index);
    audio.unlock();
    wx.navigateTo({
      url: '/pages/game/game?bookId=' + this.data.bookId + '&batch=' + i
    });
  },

  /* ================= 错词本 ================= */

  startReview() {
    audio.unlock();
    const n = storage.getWrongCount(this.data.bookId);
    if (n < 4) {
      util.toast('错词本至少要 4 个词才能复习');
      return;
    }
    wx.navigateTo({
      url: '/pages/game/game?bookId=' + this.data.bookId + '&mode=review'
    });
  },

  clearWrongBook() {
    const that = this;
    if (!this.data.wrongCount) {
      util.toast('错词本是空的');
      return;
    }
    wx.showModal({
      title: '清空错词本',
      content: '会删掉这本词库下 ' + this.data.wrongCount + ' 个未掌握的错词，已掌握的不受影响。',
      confirmText: '清空',
      confirmColor: '#f04438',
      success(res) {
        if (!res.confirm) return;
        if (!storage.clearWrong(that.data.bookId)) return;
        util.toast('已清空');
        that.refresh();
      }
    });
  },

  speakWord(e) {
    const word = e.currentTarget.dataset.word;
    if (!word) return;
    tts.speak(word, { force: true }).catch(function (err) {
      util.toast((err && err.message) || '发音失败');
    });
  },

  /* ================= 发音与学习目标 ================= */

  toggleTts() {
    const next = !this.data.settings.tts;
    this.saveSetting({ tts: next });
    if (next) tts.speak('hello', { force: true }).catch(function () {});
  },

  pickAccent(e) {
    const a = Number(e.currentTarget.dataset.accent);
    this.saveSetting({ accent: a });
    audio.click();
  },

  pickGoal(e) {
    const g = Number(e.currentTarget.dataset.goal);
    storage.setDailyGoal(g);
    this.setData({ settings: storage.getSettings() });
    audio.click();
  },

  /* ================= 单词表 ================= */

  toggleWords() {
    const expanded = !this.data.wordsExpanded;
    this.setData({ wordsExpanded: expanded });
    if (expanded && this.data.loadedWords < PAGE_SIZE * 2) {
      this.loadMoreWords();
    }
  },

  loadMoreWords() {
    const next = Math.min(this.data.totalWords, this.data.loadedWords + PAGE_SIZE);
    const list = this.allWords.slice(0, next).map(function (w, i) {
      return { id: w.id, en: w.en, cn: w.cn, no: i + 1 };
    });
    this.setData({ words: list, loadedWords: list.length });
  },

  onWordScroll() {
    if (!this.data.wordsExpanded) return;
    if (this.data.loadedWords >= this.data.totalWords) return;
    this.loadMoreWords();
  },

  /* ================= 删除 ================= */

  removeBook() {
    const that = this;
    wx.showModal({
      title: '删除词库',
      content: '「' + this.data.book.name + '」及其学习记录会被删除，无法恢复。',
      confirmText: '删除',
      confirmColor: '#f04438',
      success(res) {
        if (!res.confirm) return;
        if (!storage.deleteBook(that.data.bookId)) return;
        wx.showToast({ title: '已删除', icon: 'success' });
        setTimeout(function () {
          wx.navigateBack();
        }, 600);
      }
    });
  }
});
