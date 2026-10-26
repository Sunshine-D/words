const storage = require('../../utils/storage');
const backup = require('../../utils/backup');
const cloud = require('../../utils/cloud');
const util = require('../../utils/util');
Page({
  data: { usedKB: 0, bookCount: 0, wordCount: 0, wrongCount: 0, busy: false },
  onLoad() { this.refresh(); },
  onShow() { this.refresh(); },
  refresh() {
    const books = storage.listBooks();
    let usedKB = 0;
    try { usedKB = wx.getStorageInfoSync().currentSize || 0; } catch (e) {}
    this.setData({ bookCount: books.length, wordCount: books.reduce((n, b) => n + (b.count || 0), 0), wrongCount: storage.totalWrongCount(), usedKB: usedKB });
  },
  async run(action) {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try { await action(); }
    catch (e) { wx.showModal({ title: '操作未完成', content: e.message || e.errMsg || '请稍后重试，本机数据仍保留', showCancel: false }); }
    finally { this.setData({ busy: false }); this.refresh(); }
  },
  ask(title, content) {
    return new Promise((resolve) => wx.showModal({ title: title, content: content, success: (r) => resolve(r.confirm), fail: () => resolve(false) }));
  },
  exportFile() {
    this.run(async () => {
      if (typeof wx.shareFileMessage !== 'function') throw new Error('当前微信版本不支持文件分享，请升级微信');
      const text = JSON.stringify(backup.create());
      const fileName = '单词备份-' + Date.now() + '.json';
      const filePath = wx.env.USER_DATA_PATH + '/' + fileName;
      const fs = wx.getFileSystemManager();
      try {
        await new Promise((resolve, reject) => fs.writeFile({ filePath: filePath, data: text, encoding: 'utf8', success: resolve, fail: reject }));
        await new Promise((resolve, reject) => wx.shareFileMessage({ filePath: filePath, fileName: fileName, success: resolve, fail: (e) => /cancel/.test(e.errMsg || '') ? resolve() : reject(e) }));
      } finally { fs.unlink({ filePath: filePath, fail() {} }); }
    });
  },
  importFile() {
    this.run(async () => {
      await getApp().requirePrivacy();
      const file = await new Promise((resolve, reject) => wx.chooseMessageFile({ count: 1, type: 'file', extension: ['json'], success: (res) => resolve(res.tempFiles && res.tempFiles[0]), fail: (e) => /cancel/.test(e.errMsg || '') ? resolve(null) : reject(e) }));
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) throw new Error('备份文件超过 8MB');
      const text = await new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath: file.path, encoding: 'utf8', success: (r) => resolve(r.data), fail: reject }));
      await this.confirmRestore(backup.parse(text));
    });
  },
  async confirmRestore(data) {
    backup.validate(data);
    const words = data.books.reduce((n, b) => n + b.words.length, 0);
    if (!await this.ask('恢复备份', '备份包含 ' + data.books.length + ' 个词库、' + words + ' 个单词。现有词库保留，备份词库另存为新词库（重复恢复会新增副本）；统计合并，设置使用备份中的值。继续吗？')) return;
    backup.restore(data);
    util.toast('备份已恢复');
  },
  cloudBackup() {
    this.run(async () => {
      if (!await this.ask('手动云端备份', '将上传全部词表、错词、学习记录和设置，并替换上一次手动云备份。平时无需使用，也不会后台上传。继续吗？')) return;
      await cloud.saveBackup(backup.create());
      util.toast('云端备份成功');
    });
  },
  cloudRestore() {
    this.run(async () => {
      if (!await this.ask('读取云端备份', '将连接云端读取上一次手动备份，读取后可预览并决定是否恢复。继续吗？')) return;
      await this.confirmRestore(await cloud.loadBackup());
    });
  }
});
