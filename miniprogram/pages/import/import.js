const parsers = require('../../utils/parsers/index');
const storage = require('../../utils/storage');
const util = require('../../utils/util');

Page({
  data: {
    step: 1, // 1 选择来源 / 2 解析中 / 3 预览 / 4 粘贴文本
    loadingText: '正在读取文件…',
    progress: 0,
    words: [],
    showCount: 80,
    bookName: '',
    source: {},
    error: '',
    skippedCount: 0,
    pasteText: '',
    // 编辑弹层
    editing: false,
    editIndex: -1,
    editEn: '',
    editCn: ''
  },

  onLoad() {
    this.raw = [];
  },

  /* ================= 选择文件 ================= */

  chooseFile() {
    const that = this;
    const app = getApp();
    // 读取用户文件属于隐私接口，必须先确保已同意隐私保护指引
    app
      .requirePrivacy()
      .then(function () {
        that.pickFile();
      })
      .catch(function () {
        util.toast('需要先同意隐私保护指引');
      });
  },

  pickFile() {
    const that = this;
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      // 不限制扩展名：让用户能选到 .xls/.doc，从而给出「请另存为新格式」的明确提示
      success(res) {
        const f = (res.tempFiles && res.tempFiles[0]) || null;
        if (!f) return;
        that.handleFile({ path: f.path, name: f.name || '单词表', size: f.size });
      },
      fail(err) {
        if (err && err.errMsg && err.errMsg.indexOf('cancel') >= 0) return;
        util.toast('未能选择文件');
      }
    });
  },

  handleFile(file) {
    const that = this;
    const sizeText = parsers.prettySize(file.size);
    // 大文件先确认，避免解析时长时间无响应造成「闪退」错觉
    if (file.size && file.size > 5 * 1024 * 1024) {
      wx.showModal({
        title: '文件较大',
        content: '这个文件有 ' + sizeText + '，解析可能需要几秒，期间页面会短暂无响应。要继续吗？',
        confirmText: '继续解析',
        cancelText: '先不了',
        success(r) {
          if (r.confirm) that.doParse(file, sizeText);
        }
      });
      return;
    }
    this.doParse(file, sizeText);
  },

  doParse(file, sizeText) {
    const that = this;
    this.setData({
      step: 2,
      error: '',
      progress: 5,
      loadingText: '正在解析 ' + file.name + (sizeText ? '（' + sizeText + '）' : '')
    });
    // 让 loading 先渲染，再执行同步解析
    setTimeout(function () {
      parsers
        .parseFile(file, function (text, percent) {
          that.setData({ loadingText: text, progress: percent });
        })
        .then(function (res) {
          that.applyResult(res, {
            fileName: file.name,
            fileType: res.ext,
            channel: 'file'
          });
        })
        .catch(function (err) {
          that.setData({
            step: 1,
            progress: 0,
            error: (err && err.message) || '解析失败，请换一个文件试试'
          });
        });
    }, 80);
  },

  /* ================= 粘贴文本 ================= */

  openPaste() {
    this.setData({ step: 4, pasteText: '', error: '' });
  },

  onPasteInput(e) {
    this.setData({ pasteText: e.detail.value });
  },

  confirmPaste() {
    const text = (this.data.pasteText || '').trim();
    if (!text) {
      util.toast('先粘贴一些内容吧');
      return;
    }
    const that = this;
    this.setData({ step: 2, loadingText: '正在识别…' });
    setTimeout(function () {
      try {
        const res = parsers.parseTextInput(text);
        if (!res.words.length) {
          that.setData({
            step: 4,
            error: '没有识别到「英文 + 中文」的对照，检查一下是不是每行一个词条'
          });
          return;
        }
        that.applyResult(res, { fileName: '手动粘贴', fileType: 'text', channel: 'paste' });
      } catch (e) {
        that.setData({ step: 4, error: e.message || '识别失败' });
      }
    }, 60);
  },

  /* ================= 结果 ================= */

  applyResult(res, source) {
    const words = res.words.map(function (w) {
      return { en: w.en, cn: w.cn };
    });
    const baseName = String(source.fileName || '我的词库').replace(/\.[a-z0-9]+$/i, '');
    this.raw = words;
    this.setData({
      step: 3,
      words: words,
      showCount: 80,
      skippedCount: (res.skipped && res.skipped.length) || 0,
      bookName: baseName,
      source: source,
      error: ''
    });
  },

  onNameInput(e) {
    this.setData({ bookName: e.detail.value });
  },

  onListScrollToLower() {
    if (this.data.showCount >= this.data.words.length) return;
    this.setData({ showCount: Math.min(this.data.words.length, this.data.showCount + 120) });
  },

  /* ================= 编辑单词 ================= */

  openEdit(e) {
    const i = e.currentTarget.dataset.index;
    const w = this.data.words[i];
    if (!w) return;
    this.setData({ editing: true, editIndex: i, editEn: w.en, editCn: w.cn });
  },

  closeEdit() {
    this.setData({ editing: false, editIndex: -1 });
  },

  onEditEn(e) {
    this.setData({ editEn: e.detail.value });
  },

  onEditCn(e) {
    this.setData({ editCn: e.detail.value });
  },

  saveEdit() {
    const i = this.data.editIndex;
    const en = (this.data.editEn || '').trim();
    const cn = (this.data.editCn || '').trim();
    if (!en || !cn) {
      util.toast('英文和释义都不能为空');
      return;
    }
    const words = this.data.words.slice();
    words[i] = { en: en, cn: cn };
    this.setData({ words: words, editing: false, editIndex: -1 });
  },

  removeWord(e) {
    const i = e.currentTarget.dataset.index;
    const words = this.data.words.slice();
    words.splice(i, 1);
    this.setData({
      words: words,
      showCount: Math.min(this.data.showCount, Math.max(20, words.length))
    });
  },

  addWord() {
    const words = this.data.words.concat([{ en: '', cn: '' }]);
    this.setData({
      words: words,
      editing: true,
      editIndex: words.length - 1,
      editEn: '',
      editCn: ''
    });
  },

  /* ================= 保存 ================= */

  save() {
    const words = this.data.words.filter(function (w) {
      return w.en && w.cn;
    });
    if (words.length < 4) {
      util.toast('至少需要 4 个单词才能开始闯关');
      return;
    }
    const name = (this.data.bookName || '').trim() || '我的词库';

    // 写入前先估容量，避免 setStorageSync 抛异常导致白屏
    const needKB = Math.ceil(storage.estimateBytes(words) / 1024);
    const leftKB = storage.quotaKB();
    if (leftKB >= 0 && needKB > leftKB) {
      wx.showModal({
        title: '本机存储空间不足',
        content:
          '这份词表约需 ' + needKB + 'KB，当前剩余约 ' + leftKB + 'KB。请先删除一些旧词库，或把词表拆小后再导入。',
        confirmText: '知道了',
        showCancel: false
      });
      return;
    }

    const book = storage.createBook({
      name: name,
      words: words,
      source: this.data.source
    });

    if (!book) {
      wx.showModal({
        title: '保存失败',
        content: storage.getLastError() || '本机存储空间不足，请先删除一些词库',
        confirmText: '知道了',
        showCancel: false
      });
      return;
    }

    wx.showToast({ title: '已创建词库', icon: 'success', duration: 900 });
    setTimeout(function () {
      wx.redirectTo({ url: '/pages/book/book?id=' + book.id + '&fresh=1' });
    }, 700);
  },

  back() {
    if (this.data.step === 3 || this.data.step === 4) {
      this.setData({ step: 1, error: '' });
      return;
    }
    wx.navigateBack();
  }
});
