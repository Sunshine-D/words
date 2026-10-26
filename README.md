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
│   └── data/      数据与备份：容量概览、JSON 文件备份恢复、可选手动云备份
├── components/word-card/   卡片组件（4 态 + 字号自适应）
└── utils/
    ├── storage.js   数据层（同步读写 + 容量兜底 + 错词本 + 统计）
    ├── sync.js      本地模式初始化（旧同步接口仅保留兼容）
    ├── backup.js    版本化备份、内容校验、保留现有词库恢复、恢复日志
    ├── cloud.js     微信云开发封装（永不因云环境缺失崩溃）
    ├── tts.js       发音（有道 dictvoice 为主，百度自动回退）
    ├── audio.js     音效合成（WebAudio 实时合成，零音频资源）
    ├── inflate.js / zip.js  手写 DEFLATE 与 ZIP 解析（小程序无 zlib）
    └── parsers/     text/CSV、docx、xlsx、pdf 解析器（零外部依赖）
preview.html         高保真界面预览（不参与小程序打包）
```

## 运行

1. 用微信开发者工具打开项目根目录（其中的 `project.config.json` 已设置 `miniprogramRoot`）。
2. `project.config.json` 里的 appid 目前是 `touristappid`，需换成你自己的 AppID。

## 技术要点

- **零 npm 依赖**，主包约 346KB（限制 2MB）。docx/xlsx/pdf 解析全部手写。
- **默认仅本机保存**：导入、闯关、错词复习、统计均不依赖云服务。启动和学习过程不连接云端；旧版 auto 设置升级后也停用自动同步。
- **免费文件备份**：进入「数据与备份」导出 JSON，通过微信分享保存；恢复时先预览词库数和单词数，再确认导入。
- **安全恢复**：现有词库保留，备份词库使用新 ID（重复恢复会新增副本）；学习统计按设备分桶合并，设置采用备份值。写入失败回滚，异常退出后启动读取恢复日志。
- **手动云备份可选**：只有主动点击并确认才连接云服务；不自动上传、不提供后台多设备同步。整包备份上限 900KB，更大的数据请使用文件备份（上限 8MB）。
- **数据持久性**：删除小程序或清理微信数据可能丢失本地记录，请定期将备份文件分享到可保留的位置。

## 测试

```
node .workbuddy/test/run.js         # 文件解析 27 项
node .workbuddy/test/game.test.js   # 游戏逻辑 26 项
node .workbuddy/test/feature.test.js    # 新增功能 38 项
node .workbuddy/test/wrongbook.test.js  # 错词本 17 项
node .workbuddy/test/sync.test.js       # 旧同步接口兼容性 62 项
node .workbuddy/test/backup.test.js     # 本地备份与存储 13 项
node .workbuddy/test/manual-backup.test.js # 页面操作与手动云备份 11 项
```

共 194 项，全部为 Node 桩测试，尚未做真机验证。

## 发布与真机验证

1. 填入实际 AppID，配置公众平台隐私保护指引；仅本地学习和文件备份无需开通云服务。
2. 发音需要配置下载合法域名 `https://dict.youdao.com`、`https://fanyi.baidu.com`；离线配对不依赖发音服务。
3. 真机验证文件分享与聊天文件恢复、隐私授权、iOS 音效、清理后恢复备份、空间不足提示。
4. 如运营方选择提供云端备份，再配置微信云开发及 `settings` 集合，权限设为「仅创建者可读写」，验证用户数据隔离。云服务费用与配额以实际账户为准。
5. 新版手动备份保存为 `settings` 集合中的 `backup-v1` 记录，覆盖上一次手动备份；不删除旧版云集合数据，也不自动迁移旧版同步记录。需要旧版数据时先通过旧版恢复到本机并导出文件。

测试为 Node 桩测试，不代表已经通过微信开发者工具和真机验证。
