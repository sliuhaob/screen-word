# 屏幕取词

Windows 离线屏幕取词与英汉查词工具。

按下取词键，程序识别当前屏幕，并在单词旁显示可点击的词框和中文释义。可靠词框分批出现，适合阅读英文游戏字幕、网页和文档。

## 下载

[下载 v1.0 Windows x64 版](https://github.com/sliuhaob/screen-word/releases/tag/v1.0)

下载 `screen-word-v1.0-windows-x64.zip`，解压后运行其中的 `screen-word-v1.0-windows-x64.exe`。词库和识别模型已内置。

## 使用

1. 点击“启用取词”，回到需要查词的窗口。
2. 按取词键，点击单词或词组查看中文释义。
3. 按 Esc 或再次按取词键退出浮层。

默认取词键是鼠标后退侧键，可改为其他鼠标键或键盘快捷键。主界面支持直接搜索查词；释义窗口支持修改识别文字、切换原词形和动词原形。

OBS 录制浮层时使用“显示器采集”。将它放在来源列表上方，或隐藏覆盖它的游戏、窗口采集来源。

## 功能

- 透明词框与中文释义，分批补充识别结果。
- 支持词组、动词时态还原及原词形切换。
- 内置 ECDICT Revised 词库，支持多义项和输入提示。
- 本地识别与查词，启动时默认暂停取词。

识别效果受字体、分辨率和背景影响。画面文字变化后，重新按键取词。

## 开发

Windows 10/11 x64，Node.js 24 或以上：

```powershell
npm ci
npm start
```

```powershell
npm test
npm run build
npm run test:app
npm run verify
```

构建输出位于 `dist/`。`node scripts/build.cjs --dir` 仅生成解包目录。鼠标键辅助程序由系统的 C# 编译器自动构建。

## 来源与许可

应用源码采用 [MIT](LICENSE)。词库来自 [ECDICT Revised](https://github.com/sliuhaob/ecdict-revised)，基础 ECDICT 内容采用 MIT，中文修订采用 CC BY-SA 4.0。识别使用 Tesseract.js。

详见 [第三方声明](THIRD_PARTY_NOTICES.md) 和 [词库说明](resources/NOTICE.md)。
