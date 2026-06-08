[简体中文](./README.md) | [English](./README_EN.md)

![GitHub Repo stars](https://img.shields.io/github/stars/wong-haha/bob-plugin-connect-dify?style=social)
![GitHub release](https://img.shields.io/github/v/release/wong-haha/bob-plugin-connect-dify)
![GitHub all releases](https://img.shields.io/github/downloads/wong-haha/bob-plugin-connect-dify/total)

# ConnectDify · A Bob × Dify Workflow Plugin

> A plugin that connects Bob's text-selection / OCR power to your Dify workflows. Select any text to trigger any workflow (Chatflow / Workflow) you've built in Dify — giving Bob "infinite possibilities".

## What is this

ConnectDify makes Bob more than a translation tool. It takes the text you select as input, sends it to a workflow you've built on Dify, and streams the result back into the Bob window in real time.

**Anything you can build inside a Dify workflow can be triggered by selecting text or taking a screenshot.** For example:

- 🔍 **Deep web research**: select a keyword → a Dify workflow searches & synthesizes the web → returns a conclusion
- 📥 **Read it later**: select a link → Dify parses the page content → automatically saves it to a Feishu (Lark) Base
- 🌐 **Expert-level translation / polishing / explanation**: powered by any LLM that Dify supports
- 💡 Any text-processing pipeline you can orchestrate in a Dify workflow…

Its ceiling is the limit of your imagination in Dify.

## Demo

**Deep web research**:
The Dify workflow triggers a web search on demand, then feeds the retrieved information to the LLM as context to answer / interpret the selected text.

<img width="400" alt="The result shown inside Bob" src="https://github.com/user-attachments/assets/d7385a05-ce62-43e0-9145-3a33315db243" />
<img width="800" alt="The deep web-research workflow in Dify" src="https://github.com/user-attachments/assets/0abe6aea-163c-420c-b8bd-bf361f01934a" />

**Read it later**:
After fetching the link's content, it summarizes section by section on demand, indexes the article's keywords, searches the web for related topics, and saves both the summary and the related-reading info into a Feishu (Lark) Base.

<img width="800" alt="The read-it-later workflow in Dify" src="https://github.com/user-attachments/assets/c8d44ab7-f675-4d35-8797-bbc022fe3b49" />
<img width="800" alt="Read-it-later content managed in a Feishu Base" src="https://github.com/user-attachments/assets/7a5fde20-132c-4f8f-8424-f82ff0341ea5" />
<img width="800" alt="Read-it-later board view in a Feishu Base" src="https://github.com/user-attachments/assets/387eb839-dc86-4f01-bdb4-4c63ee988264" />

## Features

- Supports both **Chatflow** and **Workflow** app types in Dify
- Streaming output — results appear as they are generated
- Separate display of the reasoning process (`<think>`)
- Customizable input variable name in Workflow mode
- Built-in "Validate" button to test connectivity and your API key in one click

## Installation

1. Install [Bob](https://bobtranslate.com) (version ≥ 1.15.0), a translation & OCR app for macOS
2. Go to this repo's [Releases](../../releases) and download the latest `.bobplugin` file
3. Double-click the file and Bob will install it automatically
4. Add this plugin under Bob → Preferences → Services

## Configuration

<img width="800" alt="The plugin configuration panel in Bob" src="https://github.com/user-attachments/assets/915101b2-93e8-448e-bb07-51b20beb1439" />

| Option | Description |
| --- | --- |
| App type | Choose Chatflow or Workflow (must match the app type you created in Dify) |
| API key | Generate it from the top-right of the "Access API" page in your Dify app |
| API URL | Chatflow usually ends with `v1/chat-messages`; Workflow usually ends with `v1/workflows/run` |
| Input variable name | Workflow mode only — the String input variable name of the workflow's start node |

## Usage

Select any text and press Bob's translation shortcut (default ⌥ + D). The text is sent to your Dify workflow and the result is displayed in the Bob window in real time.

## Acknowledgements

Special thanks to [@ripperhe](https://github.com/ripperhe), the author of [Bob](https://bobtranslate.com).

This plugin is only possible thanks to Bob's excellent design and its open, flexible [plugin system](https://bobtranslate.com/plugin/). If you like Bob too, please consider:

- Giving the [Bob project](https://github.com/ripperhe/Bob) a Star ⭐️
- Leaving a review for Bob on the [App Store](https://apps.apple.com/cn/app/id1630034110)

## About

Developed by Wong, built on Bob's official plugin API. The core logic connects to Dify's Chatflow / Workflow endpoints.
