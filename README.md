# 页面原型 · Runtime

为 [page-prototype Skill](https://github.com/daxinbytes/page-prototype) 提供本地 Node 服务、命令行和 Chrome 扩展。在现有页面采集 JS、CSS 与 source map，供 Agent 分析逻辑、编辑修改稿，并在浏览器中预览。

本仓库只包含运行时。Skill 独立安装；公司项目配置、采集代码、配对码和用户方案保存在本机数据目录，不进入仓库。

## 产品同学使用

先安装 [Skill](https://github.com/daxinbytes/page-prototype)，再让 Agent 配置工具。Skill 会获取本仓库、安装依赖并启动本地服务，不需要产品同学手动维护源码。

首次仍需要在 Chrome 中操作：打开 `chrome://extensions`，开启开发者模式，加载安装结果中的 `extension` 目录，再配对、授权目标站点并开始协作。Chrome 不能直接加载 GitHub URL。

## 源码安装

要求 Node.js 20+、Git、npm、Chrome 125+。Agent 与浏览器默认运行在同一台电脑，可读写本地文件并监听回环地址。当前在 macOS 验证。

```sh
git clone https://github.com/daxinbytes/page-prototype-runtime.git
cd page-prototype-runtime
npm ci --omit=dev --ignore-scripts
node install.mjs
```

安装结果为 JSON，包含 `tool`、`runtime` 和 `extension` 的绝对路径。默认数据目录 `~/.page-prototype`；旧安装自动沿用 `~/.beta-preview`。可用 `--home /自定义目录` 指定位置，后续工具设置相同的 `PAGE_PROTOTYPE_HOME`。

使用输出的 `tool` 路径调用命令，例如：

```sh
node /安装结果中的/tool路径 --help
node /安装结果中的/tool路径 init --name 演示项目 --url https://app.example.test/app --port 17373
node /安装结果中的/tool路径 start 项目ID
node /安装结果中的/tool路径 doctor
node /安装结果中的/tool路径 pair
```

`init` 输出项目 ID。将 `pair` 显示的配对码只填写在本机扩展中。首次加载扩展请选择输出的稳定 `extension` 目录，而非带版本号的内部目录。

依赖仅为 acorn 和 ws，无数据库或额外模型 API Key。模型分析能力来自用户正在使用的 Agent。业务站点所需登录、网络或 VPN 需正常可用。

## 协作与方案

0.8 面板的顺序是：选择或新建项目 → 接入并开始协作 → 创建或选择方案。只选项目不会采集；页面逐步加入，已保存页面切回后仍然显示，未连接时标为“未采集”。项目内跳转和关联新标签页可自动跟随；跨新站点需用户确认并授权。

`start` 不带项目参数时启动待选择状态；项目切换使用面板下拉框或 `project use 项目ID`，保留资料并恢复旧预览，无需停服。默认按应用路径限定范围；`id` 参数变化复用页面记录，模块参数和 hash 路由保守区分。旧版整域名配置迁移后保留历史资料，页面范围需重新确认。

公共页面可同时加入多个项目，各项目和方案的可编辑草稿独立。同一标签页一次仅应用一套修改，异步任务带项目、方案和会话校验，防止切换后套用旧稿。没有预设业务域名；示例配置见 `examples/`。

- `inspect`、`resources`、`sources`、`search`：读取当前页面与采集源码的上下文。
- `stage --project 项目ID --scenario 方案ID --tab ID 资源ID`：为当前方案准备可编辑的修改稿并绑定目标页。
- `apply --project 项目ID --scenario 方案ID`：刷新目标页面并等待资源替换结果。由 Skill 在每次修改后直接调用，用户无需重复点击应用；仍需实际验收页面行为。
- `scenario new 名称 --tab ID`：保留旧稿，从原始页面新建独立方案。
- `scenario use 方案ID --tab ID`：恢复页面并切换草稿，需要预览时再 apply。
- `restore`：停用修改，保留采集与草稿。`end`：结束协作并恢复页面。
- `page remove 页面地址 --project 项目ID`：从当前项目移出页面并停止跟随，不删除共享资源或其他项目中的同一页面。移出后需要手动接入才会再次采集。
- `scenario delete 方案ID --project 项目ID`：删除该方案的修改稿，恢复其正在展示的预览，保留原始资源和其他方案。
- `project delete 项目ID`：先结束该项目协作，再将配置及采集资料、全部方案移入运行数据目录的 `trash`。其他项目保持不变。

0.8.1 面板为项目、页面和方案提供删除/移出入口与确认提示。“结束协作”位于面板最后，使用整行红色按钮。删除方案和项目时，文件保存在本机回收目录，返回的 `archiveDirectory/record.json` 记录原位置；不自动永久清理。

0.8.2 修复先选历史方案、后接入页面时无法预览的问题。手动“查看修改效果”会核对点击时的当前页面及其已加载资源，再关联目标、应用并等待替换验证；Agent 的后台 `apply` 仍保留原目标校验。未接入或资源不匹配时会显示原因。“结束协作”调整为 40px 高的珊瑚红渐变胶囊按钮。

source map 提取出的源码用于分析；预览修改的是浏览器实际加载的 JS/CSS。当前未采集业务 API 响应或 DOM 快照。运行时验证原始资源哈希和修改语法，遇到站点代码变化会拒绝套用旧稿。

## 更新

先在当前工具执行 `end`、`stop`，再更新源码并安装：

```sh
git pull --ff-only
npm ci --omit=dev --ignore-scripts
node install.mjs --update
```

更新保留数据目录、方案、配对码及稳定扩展路径；同版本不同内容会备份旧文件。在 `chrome://extensions` 重新加载扩展后，再启动项目。Skill 更新由独立仓库负责。

## 开发与验证

```sh
npm ci --ignore-scripts
npm test
```

自动测试使用合成资源与本地站点。`npm run fixture` 启动浏览器测试页面；`test/project-manager-browser-check.mjs` 通过隔离 Chrome 的 CDP 验证项目选择、页面保留、跨域、连续应用、共享页面方案隔离及 query 去重。需启动 fixture 和一个使用独立 `BRIDGE_RUNTIME_DIR` 的待选择服务（端口 17378），将浏览器 WebSocket 地址作为测试参数；Chrome 使用 `--enable-unsafe-extension-debugging` 允许测试加载本地扩展。该测试不访问业务站点。

可选运行 `npm run package` 生成带依赖与哈希清单的 tar.gz 发行包，供无 Git 的用户安装。包内没有 Skill、用户数据或业务页面资源。源码安装不依赖生成发行包。

Skill 与运行时通过 `pagePrototypeApiVersion` / 安装记录中的 `apiVersion` 检查兼容性。发行版本需保持 `package.json` 与扩展 manifest 一致。
