const storage = require('../../utils/storage');
const sync = require('../../utils/sync');
const cloud = require('../../utils/cloud');
const util = require('../../utils/util');
const audio = require('../../utils/audio');

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    mode: 'auto', // auto 自动备份（有云就同步） / local 仅本机
    cloudOn: false,
    status: 'off',
    statusText: '正在检查…',
    cloudState: 'uninited',
    cloudReason: '',
    lastSyncText: '从未同步',
    dirtyCount: 0,
    usedKB: 0,
    bookCount: 0,
    wordCount: 0,
    wrongCount: 0,
    busy: false,
    confirmShow: false,
    confirmTitle: '',
    confirmDesc: '',
    confirmLocal: 0,
    confirmCloud: 0,
    conflictData: null, // 非空表示弹窗处于「两边都有数据」的裁决态
    envHint: ''
  },

  onLoad() {
    const app = getApp();
    this.setData({
      statusBarHeight: (app.globalData && app.globalData.statusBarHeight) || 20,
      navBarHeight: (app.globalData && app.globalData.navBarHeight) || 44
    });
    this.unbind = sync.onStatus(this.applyStatus.bind(this));
    this.refresh();
  },

  onUnload() {
    if (this.unbind) this.unbind();
  },

  onShow() {
    this.refresh();
  },

  applyStatus(s) {
    this.setData({
      mode: s.mode,
      cloudOn: s.cloudOn,
      status: s.status,
      statusText: this.textOf(s),
      cloudState: s.cloudState,
      cloudReason: s.cloudReason,
      lastSyncText: s.lastSyncAt ? util.fromNow(s.lastSyncAt) : '从未同步',
      dirtyCount: s.dirtyCount
    });
  },

  textOf(s) {
    if (s.mode === 'local') return '仅保存在本机';
    if (!s.cloudOn) return '云端暂不可用，已存本机';
    if (s.status === 'syncing') return '正在同步…';
    if (s.status === 'unavailable') return '云环境不可用，已转本机保存';
    if (s.status === 'error') return s.lastError || '同步异常，数据已存本机';
    if (s.dirtyCount > 0) return s.dirtyCount + ' 项待同步';
    return '已备份到云端';
  },

  refresh() {
    const books = storage.listBooks();
    let words = 0;
    books.forEach(function (b) {
      words += b.count || 0;
    });
    let usedKB = 0;
    try {
      const info = wx.getStorageInfoSync();
      usedKB = Math.round(info.currentSize || 0);
    } catch (e) {
      usedKB = 0;
    }
    let envHint = '';
    if (!cloud.CLOUD_ENV) {
      envHint = '尚未配置云环境 ID，自动备份暂不可用（数据仍安全存在本机）';
    }
    this.applyStatus(sync.statusSnapshot());
    this.setData({
      bookCount: books.length,
      wordCount: words,
      usedKB: usedKB,
      wrongCount: storage.totalWrongCount(),
      envHint: envHint
    });
  },

  /* ================= 模式切换 ================= */

  pickMode(e) {
    const target = e.currentTarget.dataset.mode;
    if (this.data.busy) return;
    if (target === this.data.mode) return;
    audio.click();

    if (target === 'local') {
      this.confirm(
        '切换为「只存本机」',
        '之后的学习记录只存在这台手机，换手机或清理微信缓存会丢失。云端已存的数据不会被删除。',
        function () {
          sync.disableCloud();
          this.refresh();
          util.toast('已切换为仅本机保存');
        }.bind(this)
      );
      return;
    }

    // 切到云：先探查，再决定是否需要用户裁决冲突
    this.setData({ busy: true });
    util.toast('正在检查云端…');
    sync
      .probeCloud()
      .then((res) => {
        this.setData({ busy: false });
        if (!res || !res.ok) {
          util.toast((res && res.reason) || '云环境不可用');
          this.refresh();
          return;
        }
        if (res.localCount === 0) {
          // 本地没数据（新设备）：直接以云端为准
          this.runEnable('keep-cloud');
          return;
        }
        if (res.cloudCount === 0) {
          // 云端空：直接上传本地
          this.runEnable('keep-local');
          return;
        }
        // 两端都有：让用户裁决
        this.setData({
          confirmShow: true,
          confirmTitle: '两边都有数据',
          confirmDesc: '选择要以哪一边为准。选错会覆盖另一边，建议保留数据更全的一侧。',
          confirmLocal: res.localCount,
          confirmCloud: res.cloudCount,
          conflictData: res.data
        });
      })
      .catch(() => {
        this.setData({ busy: false });
        util.toast('检查云端失败');
      });
  },

  runEnable(strategy, probed) {
    this.setData({ busy: true, confirmShow: false });
    util.toast('正在开启自动备份…');
    sync
      .enableCloud(strategy, probed)
      .then((ok) => {
        this.setData({ busy: false });
        this.refresh();
        util.toast(ok ? '已开启自动备份' : '开启失败，已保持本机保存');
      })
      .catch(() => {
        this.setData({ busy: false });
        util.toast('开启失败');
      });
  },

  /* ================= 弹窗 ================= */

  // pendingAction 存放确认后要执行的回调
  confirm(title, desc, fn) {
    this.pendingAction = fn;
    this.setData({
      confirmShow: true,
      confirmTitle: title,
      confirmDesc: desc,
      confirmLocal: 0,
      confirmCloud: 0,
      conflictData: null
    });
  },

  closeConfirm() {
    this.pendingAction = null;
    this.setData({ confirmShow: false, conflictData: null });
  },

  onConfirmOk() {
    audio.click();
    if (this.data.conflictData) {
      // 冲突裁决：默认合并
      this.runEnable('merge', this.data.conflictData);
      return;
    }
    const fn = this.pendingAction;
    this.setData({ confirmShow: false });
    this.pendingAction = null;
    if (fn) fn();
  },

  useLocal() {
    audio.click();
    if (this.data.conflictData) this.runEnable('keep-local', this.data.conflictData);
  },

  useCloud() {
    audio.click();
    if (this.data.conflictData) this.runEnable('keep-cloud', this.data.conflictData);
  },

  /* ================= 操作 ================= */

  syncNow() {
    if (this.data.mode === 'local' || !this.data.cloudOn) {
      util.toast('当前未开启云端备份');
      return;
    }
    audio.click();
    this.setData({ busy: true });
    sync.syncNow().then(() => {
      this.setData({ busy: false });
      this.refresh();
    });
  },

  clearCloud() {
    if (this.data.mode === 'local' || !this.data.cloudOn) {
      util.toast('当前未开启云端备份');
      return;
    }
    this.confirm(
      '删除云端数据',
      '会清空云端的全部词库与学习记录，本机数据不受影响。删除后无法恢复。',
      () => {
        util.toast('正在删除…');
        cloud.clearAll().then((ok) => {
          this.refresh();
          util.toast(ok ? '云端数据已清空' : '删除失败');
        });
      }
    );
  },

  noop() {
    /* 阻止冒泡，点到弹窗本体不关闭 */
  },

  goBack() {
    audio.click();
    wx.navigateBack({
      fail() {
        wx.switchTab({ url: '/pages/home/home' });
      }
    });
  }
});
