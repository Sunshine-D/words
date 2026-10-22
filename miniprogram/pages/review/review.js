const storage = require('../../utils/storage');
const util = require('../../utils/util');
const audio = require('../../utils/audio');
const tts = require('../../utils/tts');

Page({
  data: {
    groups: [],
    total: 0,
    masteredTotal: 0,
    loaded: false
  },

  onShow() {
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh();
    wx.stopPullDownRefresh();
  },

  refresh() {
    const books = storage.listBooks();
    const groups = [];
    let total = 0;
    let masteredTotal = 0;

    books.forEach(function (b) {
      const all = storage.getWrongList(b.id);
      const active = storage.getWrongActive(b.id);
      const mastered = all.filter(function (w) {
        return w.mastered;
      }).length;
      if (active.length === 0 && mastered === 0) return;

      total += active.length;
      masteredTotal += mastered;

      groups.push({
        id: b.id,
        name: b.name,
        count: active.length,
        mastered: mastered,
        canReview: active.length >= 4,
        preview: active.slice(0, 3).map(function (w) {
          return { en: w.en, cn: w.cn, wrong: w.wrong };
        })
      });
    });

    // 错词多的排前面
    groups.sort(function (a, b) {
      return b.count - a.count;
    });

    this.setData({ groups: groups, total: total, masteredTotal: masteredTotal, loaded: true });
  },

  startReview(e) {
    const id = e.currentTarget.dataset.id;
    audio.unlock();
    wx.navigateTo({ url: '/pages/game/game?bookId=' + id + '&mode=review' });
  },

  speakWord(e) {
    const word = e.currentTarget.dataset.word;
    if (!word) return;
    tts.speak(word, { force: true }).catch(function (err) {
      util.toast((err && err.message) || '发音失败');
    });
  },

  goImport() {
    wx.navigateTo({ url: '/pages/import/import' });
  }
});
