/**
 * 首次启动的示例词库
 * 目的：让用户一进入就能体验完整流程，而不是面对空白页
 */
const storage = require('./storage');

const SAMPLE = [
  { en: 'personal', cn: 'adj. 私人的' },
  { en: 'tie', cn: 'v. 系，联系' },
  { en: 'still', cn: 'adj. 静止的；adv. 甚至，仍然' },
  { en: 'offer', cn: 'v. 提供' },
  { en: 'addition', cn: 'n. 增加' },
  { en: 'success', cn: 'n. 成功' },
  { en: 'produce', cn: 'v. 生产，引起' },
  { en: 'expect', cn: 'v. 预料，期待' },
  { en: 'cause', cn: 'v. 引起；n. 原因，事业' },
  { en: 'state', cn: 'n. 情形，状态；v. 声明' },
  { en: 'manage', cn: 'v. 管理，设法（to）' },
  { en: 'directly', cn: 'adv. 直接地' },
  { en: 'improve', cn: 'v. 改善，提高' },
  { en: 'wonder', cn: 'n. 奇迹；v. 想知道' },
  { en: 'present', cn: 'adj. 当前的，出席的；v. 呈现；n. 礼物' },
  { en: 'underline', cn: 'v. 在…下面划线，强调' },
  { en: 'mislead', cn: 'v. 误导' },
  { en: 'complete', cn: 'v. 完成；adj. 完整的' },
  { en: 'lead', cn: 'v. 导致（to），带领；n. 领头位置' },
  { en: 'sensitive', cn: 'adj. 敏感的' },
  { en: 'valuable', cn: 'adj. 贵重的' },
  { en: 'courageous', cn: 'adj. 勇敢的' },
  { en: 'tend', cn: 'v. 趋向，照顾（to）' },
  { en: 'matter', cn: 'n. 事情；v. 要紧' },
  { en: 'realise', cn: 'v. 意识到，实现（梦想）' },
  { en: 'acceptable', cn: 'adj. 可接受的' },
  { en: 'consider', cn: 'v. 考虑，认为' },
  { en: 'support', cn: 'v. 支持' },
  { en: 'fit', cn: 'adj. 适宜的；v. 安装，适合' },
  { en: 'hang', cn: 'v. 悬挂' },
  { en: 'protect', cn: 'v. 保护' },
  { en: 'professional', cn: 'adj. 专业的；n. 专业人员' },
  { en: 'widen', cn: 'v. 使变宽' },
  { en: 'require', cn: 'v. 要求' },
  { en: 'creative', cn: 'adj. 创造性的' }
];

function installIfEmpty() {
  // 只装一次：用户删掉示例后，下次启动不再自动重建
  try {
    if (wx.getStorageSync('wm_seeded')) return;
    wx.setStorageSync('wm_seeded', 1);
  } catch (e) {
    /* 存储不可用时直接跳过 */
  }
  if (storage.listBooks().length > 0) return;
  storage.createBook({
    name: '高考高频词 · 示例',
    words: SAMPLE,
    source: { fileName: '内置示例', fileType: 'sample', channel: 'seed' }
  });
}

module.exports = { installIfEmpty: installIfEmpty, SAMPLE: SAMPLE };
