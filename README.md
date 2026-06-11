[简体中文](./README.md) | [English](./README_EN.md)

![GitHub Repo stars](https://img.shields.io/github/stars/wong-haha/bob-plugin-connect-dify?style=social)
![GitHub release](https://img.shields.io/github/v/release/wong-haha/bob-plugin-connect-dify)
![GitHub all releases](https://img.shields.io/github/downloads/wong-haha/bob-plugin-connect-dify/total)

# ConnectDify · Bob × Dify 工作流插件

> 一个把 Bob 的划词 / OCR 能力接入 Dify 工作流的插件。选中文本，即可触发任意你在 Dify 中编排好的工作流（Chatflow / Workflow），让 Bob 拥有「无限可能」。

## 这是什么

ConnectDify 让 Bob 不再只是翻译工具。它把你选中的文字作为输入，发送到你在 Dify 上搭建的工作流，再把工作流的结果实时显示在 Bob 窗口里。

**只要你能在 Dify 工作流里实现的能力，都能通过划词 / 截图来触发。** 例如：

- 🔍 **深度联网检索**：划选一个关键词 → Dify 工作流联网搜索、整理 → 返回结论
- 📥 **稍后阅读**：选中一个链接 → Dify 解析网页内容 → 自动保存到飞书多维表格
- 🌐 **专家级翻译 / 润色 / 解释**：接入任意 Dify 支持的大模型基座
- 💡 任何你能在 Dify 工作流里编排的文本处理流程……

它的能力上限，就是你 Dify 工作流的想象力上限。

## Demo

**深度联网检索**：
dify 工作流中按需启动关键词联网检索，再把检索后的信息作为上下文提供给 LLM 来回复/解读划词提交的内容

<img width="400" alt="Bob界面呈现" src="https://github.com/user-attachments/assets/d7385a05-ce62-43e0-9145-3a33315db243" />
<img width="800" alt="dify端深度联网检索工作流匹配" src="https://github.com/user-attachments/assets/0abe6aea-163c-420c-b8bd-bf361f01934a" />

**稍后阅读**：
链接内容抓取后，按需分段总结提炼，结合文章关键词索引以及相关话题文章联网搜索后，把总结内容&关联阅读信息一并保存到飞书多维表格管理

<img width="800" alt="dify端稍后阅读工作流匹配" src="https://github.com/user-attachments/assets/c8d44ab7-f675-4d35-8797-bbc022fe3b49" />
<img width="800" alt="飞书多维表格稍后阅读内容管理" src="https://github.com/user-attachments/assets/7a5fde20-132c-4f8f-8424-f82ff0341ea5" />
<img width="800" alt="飞书多维表格稍后阅读内容看板" src="https://github.com/user-attachments/assets/387eb839-dc86-4f01-bdb4-4c63ee988264" />

## 特性

- 同时支持 Dify 的 **Chatflow** 和 **Workflow** 两种应用类型
- 流式输出（streaming），结果边生成边显示
- 支持思考过程（reasoning / `<think>`）单独展示
- Workflow 模式可自定义入参变量名
- 内置「验证」按钮，一键测试连通性与密钥是否正确

## 安装

1. 安装 [Bob](https://bobtranslate.com)（版本 ≥ 1.15.0），一款 macOS 上的翻译和 OCR 软件
2. 前往本仓库的 [Releases](../../releases) 下载最新的 `.bobplugin` 文件
3. 双击该文件，Bob 会自动安装
4. 在 Bob「偏好设置 → 服务」中添加本插件

## 配置

<img width="800" alt="Bob配置界面示意" src="https://github.com/user-attachments/assets/915101b2-93e8-448e-bb07-51b20beb1439" />

| 配置项 | 说明 |
| --- | --- |
| 应用类型 | 选择 Chatflow 或 Workflow（与你在 Dify 中创建的应用类型一致） |
| API 密钥 | 在 Dify 应用的「访问 API」页面右上角生成 |
| API 地址 | Chatflow 通常以 `v1/chat-messages` 结尾；Workflow 通常以 `v1/workflows/run` 结尾 |
| 入参变量名 | 仅 Workflow 模式需要，填写工作流起始节点的 String 类型入参变量名 |

## 使用

选中任意文本，按下 Bob 的划词翻译快捷键（默认 ⌥ + D），文本会被发送到你的 Dify 工作流，结果会实时显示在 Bob 窗口中。

## 致谢

特别感谢 [Bob](https://bobtranslate.com) 的作者 [@ripperhe](https://github.com/ripperhe)。

正是 Bob 优秀的设计和开放、灵活的[插件系统](https://bobtranslate.com/plugin/)，这个插件才得以实现。如果你也喜欢 Bob，欢迎：

- 给 [Bob 项目](https://github.com/ripperhe/Bob) 点一个 Star ⭐️
- 在 [App Store](https://apps.apple.com/cn/app/id1630034110) 给 Bob 一个好评

## 说明

本插件由 Wong 开发，基于 Bob 官方插件接口实现，核心逻辑是对接 Dify 的 Chatflow / Workflow 接口。
如果你觉得对你有帮助，请给我点一个 Star ⭐️ 鼓励鼓励，感恩 ❤️
