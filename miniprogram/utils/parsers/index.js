/**
 * 解析调度器
 * 统一入口：给一个文件路径或纯文本，返回标准化的词条数组。
 */
const textParser = require('./text');
const docxParser = require('./docx');
const xlsxParser = require('./xlsx');
const pdfParser = require('./pdf');
const wordUtils = require('../word-utils');

const MAX_SIZE = 20 * 1024 * 1024; // 20MB，超过会明显卡顿主线程

const SUPPORTED = ['txt', 'csv', 'tsv', 'md', 'json', 'docx', 'xlsx', 'xls', 'pdf', 'doc'];

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function readFile(filePath) {
  return new Promise(function (resolve, reject) {
    wx.getFileSystemManager().readFile({
      filePath: filePath,
      success: function (res) {
        resolve(res.data);
      },
      fail: function (err) {
        reject(new Error('读取文件失败：' + (err.errMsg || '未知错误')));
      }
    });
  });
}

/**
 * 解析文件
 * 解析是同步的，大文件会阻塞主线程数百毫秒到数秒。
 * 这里通过 onStage 回调把阶段推给 UI，让用户看到进度而不是「假死」；
 * 每个阶段之间让出一帧，保证 loading 能真正渲染出来。
 *
 * @param {Object} file { path, name, size }
 * @param {Function} [onStage] (text, percent) => void
 * @returns {Promise<{words, skipped, ext, rawText}>}
 */
function parseFile(file, onStage) {
  const report = function (text, percent) {
    if (typeof onStage === 'function') {
      try {
        onStage(text, percent);
      } catch (e) {
        /* ignore */
      }
    }
  };

  const name = file.name || file.path || '';
  const ext = extOf(name);

  if (file.size && file.size > MAX_SIZE) {
    return Promise.reject(new Error('文件超过 20MB，请拆分后再导入'));
  }
  if (ext === 'xls' || ext === 'doc') {
    return Promise.reject(
      new Error('不支持旧版 .' + ext + ' 格式。请在 Office / WPS 中「另存为」.' + (ext === 'xls' ? 'xlsx' : 'docx') + ' 后再导入。')
    );
  }
  if (SUPPORTED.indexOf(ext) < 0) {
    return Promise.reject(
      new Error('暂不支持 .' + (ext || '未知') + ' 格式，请使用 Excel(.xlsx)、Word(.docx)、PDF 或 TXT')
    );
  }

  report('正在读取文件…', 10);

  return Promise.resolve()
    .then(function () {
      return readFile(file.path);
    })
    .then(function (buffer) {
      report('正在解压文档…', 35);
      return nextFrame().then(function () {
        let result;
        if (ext === 'docx') {
          result = docxParser.parse(buffer);
        } else if (ext === 'xlsx') {
          result = xlsxParser.parse(buffer);
        } else if (ext === 'pdf') {
          result = pdfParser.parse(buffer);
        } else {
          result = textParser.parse(buffer, name);
        }
        return result;
      });
    })
    .then(function (result) {
      report('正在识别单词…', 75);
      return nextFrame().then(function () {
        result.ext = ext;
        result.fileName = name;
        if (!result.words || !result.words.length) {
          throw new Error('没有识别到「英文 + 中文」的单词对。请检查文件内容，或改用「粘贴文本」导入。');
        }
        report('整理中…', 95);
        return result;
      });
    });
}

/** 让出一帧，避免同步任务连在一起把界面卡住 */
function nextFrame() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 16);
  });
}

/** 纯文本解析（粘贴导入） */
function parseTextInput(text) {
  const result = wordUtils.parseText(text);
  result.ext = 'text';
  result.fileName = '手动粘贴';
  return result;
}

/** 文件大小格式化 */
function prettySize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + 'KB';
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

module.exports = {
  parseFile: parseFile,
  parseTextInput: parseTextInput,
  extOf: extOf,
  prettySize: prettySize,
  SUPPORTED: SUPPORTED
};
