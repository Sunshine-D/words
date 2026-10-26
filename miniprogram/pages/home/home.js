const storage = require('../../utils/storage');
const util = require('../../utils/util');
const sync = require('../../utils/sync');

Page({
  data: {
    greeting: '你好',
    syncTip: '',
    books: [],
    stats: {
      today: 0,
      streak: 0,
      total: 0,
      goal: 30,
      goalPercent: 0,
      goalDone: false,
      calendar: []
    },
    wrongTotal: 0,
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
    const settings = storage.getSettings();
    const batchSize = util.clamp(Number(settings.batchSize) || 6, 4, 15);
    const books = storage.listBooks().map(function (b) {
      const totalBatches = Math.max(1, Math.ceil(b.count / batchSize));
      const done = Math.min(totalBatches, (b.progress && b.progress.batchesDone) || 0);
      return {
        id: b.id,
        name: b.name,
        count: b.count,
        initial: (b.name || 'W').slice(0, 1).toUpperCase(),
        percent: Math.round((done / totalBatches) * 100),
        batchesDone: done,
        totalBatches: totalBatches,
        lastText: b.lastPlayedAt ? '上次 ' + util.fromNow(b.lastPlayedAt) : '还没开始',
        preview: b.preview || []
      };
    });

    const summary = storage.statsSummary();
    const s = sync.statusSnapshot();
    let tip;
    if (s.mode === 'local') {
      tip = '数据保存在本机 · 导出或恢复备份';
    } else if (!s.cloudOn) {
      tip = '云端暂不可用，已存在本机 · 查看';
    } else if (s.status === 'unavailable') {
      tip = '云端暂不可用，已存在本机 · 查看';
    } else if (s.dirtyCount > 0) {
      tip = s.dirtyCount + ' 项待备份 · 查看';
    } else if (s.lastSyncAt) {
      tip = '已备份 · ' + util.fromNow(s.lastSyncAt);
    } else {
      tip = '自动备份已开启 · 查看';
    }
    this.setData({
      greeting: this.pickGreeting(),
      books: books,
      loaded: true,
      wrongTotal: storage.totalWrongCount(),
      stats: summary,
      syncTip: tip
    });
  },

  pickGreeting() {
    const h = new Date().getHours();
    if (h < 6) return '夜深了';
    if (h < 11) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  },

  goImport() {
    wx.navigateTo({ url: '/pages/import/import' });
  },

  goReview() {
    wx.navigateTo({ url: '/pages/review/review' });
  },

  goData() {
    wx.navigateTo({ url: '/pages/data/data' });
  },

  openBook(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/book/book?id=' + id });
  },

  quickStart(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/game/game?bookId=' + id });
  },

  onShareAppMessage() {
    return {
      title: '单词消消乐 —— 把单词和释义配成对',
      path: '/pages/home/home'
    };
  }
});
