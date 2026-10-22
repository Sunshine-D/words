# 单词消消乐 · 微信小程序

面向在校学生的英语单词消除类小程序。支持从 PDF / Word / Excel / TXT / CSV 导入词库，
按批次闯关，自动收集错词并生成复习本，带真人发音与学习统计。

## 目录结构

```
miniprogram/
├── app.js / app.json / app.wxss   # 全局配置、隐私授权拦截、共享样式
├── pages/
│   ├── home/      首页：词库列表、学习统计、每日目标、近 7 日日历
│   ├── import/    导入：选文件 → 解析 → 预览校对 → 入库
│   ├── book/      词库详情：批次大小、顺序/随机取词、限时设置
│   ├── game/      闯关主页面（支持 mode=review 复习模式）
│   ├── review/    错词本：跨词库总览与分库复习
│   └── data/      数据与存储：存储方式、容量概览、立即同步
├── components/word-card/   卡片组件（4 态 + 字号自适应）
└── utils/
    ├── storage.js   数据层（同步读写 + 容量兜底 + 错词本 + 统计）
    ├── sync.js      同步引擎（本地优先 + 云端异步双向同步）
    ├── cloud.js     微信云开发封装（永不因云环境缺失崩溃）
    ├── tts.js       发音（有道 dictvoice 为主，百度自动回退）
    ├── audio.js     音效合成（WebAudio 实时合成，零音频资源）
    ├── inflate.js / zip.js  手写 DEFLATE 与 ZIP 解析（小程序无 zlib）
    └── parsers/     text/CSV、docx、xlsx、pdf 解析器（零外部依赖）
preview.html         高保真界面预览（不参与小程序打包）
```

## 运行

1. 用微信开发者工具打开 `miniprogram` 目录。
2. `project.config.json` 里的 appid 目前是 `touristappid`，需换成你自己的 AppID。

## 技术要点

- **零 npm 依赖**，主包约 346KB（限制 2MB）。docx/xlsx/pdf 解析全部手写。
- **本地优先 + 云端异步同步**：读永远走本地（同步，断网可玩），写先落本地再防抖 900ms 推云。
- **存储模式默认 auto**：能连云就备份，连不上静默退回本机，用户零感知。
- **多设备合并**：学习统计按设备分桶（G-Counter，不膨胀），错词本逐词合并（已毕业的词不会被复活）。

## 测试

```
node .workbuddy/test/run.js         # 文件解析 27 项
node .workbuddy/test/game.test.js   # 游戏逻辑 26 项
node .workbuddy/test/feature.test.js    # 新增功能 38 项
node .workbuddy/test/wrongbook.test.js  # 错词本 17 项
node .workbuddy/test/sync.test.js       # 同步 62 项
```

共 170 项，全部为 Node 桩测试，尚未做真机验证。

## 上线前必须处理

1. 开发者工具开通云开发，建 5 个集合：`books` / `words` / `wrong` / `stats` / `settings`，
   权限均设为「仅创建者可读写」。
2. 免费云环境在小程序发布后第 15 天会销毁数据，正式发布需转付费（个人版 ¥19.9/月）。
3. 公众平台配置隐私指引，补充「收集与存储用户学习数据」。
4. downloadFile 合法域名加入 `https://dict.youdao.com`、`https://fanyi.baidu.com`。
5. 真机验证：云权限隔离、iOS 静音模式音效、TTS 域名白名单、未开通云时的降级表现。
