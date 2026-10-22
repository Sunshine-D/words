/**
 * 单词消消乐 · 小程序入口
 * 职责：全局状态初始化、系统信息缓存、首次启动种子数据
 */
const storage = require('./utils/storage');
const seed = require('./utils/seed');
const sync = require('./utils/sync');

App({
  globalData: {
    statusBarHeight: 20,
    navBarHeight: 44,
    settings: null,
    // 页面间临时传递导入结果
    pendingImport: null,
    // 隐私授权：是否需要用户确认（由 getPrivacySetting 写入）
    needPrivacy: false,
    privacyName: '《用户隐私保护指引》'
  },

  onLaunch() {
    this.initSystemInfo();
    storage.ensureSettings();
    this.globalData.settings = storage.getSettings();
    seed.installIfEmpty();
    this.initPrivacy();
    // 必须在种子数据之后：否则会把内置示例词库当成"本地新增"推上去
    sync.init();
    // 云端模式下后台补一次同步；本地模式此调用会立即返回
    sync.bootstrap();
  },

  onShow() {
    this.globalData.settings = storage.getSettings();
  },

  /**
   * 隐私授权
   * 小程序使用 wx.chooseMessageFile 读取用户文件，属于隐私接口。
   * 必须在公众平台配置《用户隐私保护指引》，并在 app.json 声明
   * "__usePrivacyCheck__": true，否则调用隐私接口会直接失败。
   */
  initPrivacy() {
    if (typeof wx.onNeedPrivacyAuthorization !== 'function') return;
    const that = this;

    if (typeof wx.getPrivacySetting === 'function') {
      wx.getPrivacySetting({
        success(res) {
          that.globalData.needPrivacy = !!res.needAuthorization;
          if (res.privacyContractName) {
            that.globalData.privacyName = res.privacyContractName;
          }
        },
        fail() {
          /* 低版本基础库忽略 */
        }
      });
    }

    wx.onNeedPrivacyAuthorization(function (resolve) {
      that.askPrivacy(resolve, false);
    });
  },

  /** 统一的授权弹窗 */
  askPrivacy(resolve, secondTime) {
    const that = this;
    wx.showModal({
      title: '用户隐私保护提示',
      content:
        '感谢你使用单词消消乐。读取本地词表文件前，请先阅读并同意' +
        that.globalData.privacyName +
        '。我们不会上传你的词表内容。',
      confirmText: '同意并继续',
      cancelText: secondTime ? '暂不同意' : '查看指引',
      success(res) {
        if (res.confirm) {
          that.globalData.needPrivacy = false;
          resolve({ buttonId: 'agree-btn', event: 'agree' });
          return;
        }
        if (!secondTime && typeof wx.openPrivacyContract === 'function') {
          wx.openPrivacyContract({
            fail() {
              /* ignore */
            },
            complete() {
              // 看完指引再问一次
              that.askPrivacy(resolve, true);
            }
          });
          return;
        }
        resolve({ event: 'disagree' });
      },
      fail() {
        resolve({ event: 'disagree' });
      }
    });
  },

  /** 调用隐私接口前先确保已授权 */
  requirePrivacy() {
    return new Promise(function (resolve, reject) {
      if (typeof wx.requirePrivacyAuthorize !== 'function') {
        resolve(true);
        return;
      }
      wx.requirePrivacyAuthorize({
        success() {
          resolve(true);
        },
        fail(err) {
          reject(err || new Error('未同意隐私保护指引'));
        }
      });
    });
  },

  openPrivacyContract() {
    if (typeof wx.openPrivacyContract === 'function') {
      wx.openPrivacyContract({ fail() {} });
    }
  },

  initSystemInfo() {
    let info = null;
    try {
      if (wx.getWindowInfo) {
        info = wx.getWindowInfo();
      } else {
        info = wx.getSystemInfoSync();
      }
    } catch (e) {
      info = null;
    }
    const statusBarHeight = (info && info.statusBarHeight) || 20;
    this.globalData.statusBarHeight = statusBarHeight;

    // 胶囊按钮位置反推导航栏可用高度（自定义导航栏时使用）
    try {
      const menu = wx.getMenuButtonBoundingClientRect();
      if (menu && menu.height) {
        this.globalData.navBarHeight = (menu.top - statusBarHeight) * 2 + menu.height;
      }
    } catch (e) {
      this.globalData.navBarHeight = 44;
    }
  }
});
