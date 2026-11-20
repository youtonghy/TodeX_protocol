# TodeX Protocol

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>

TodeX 共享的客户端核心：TodeX 应用与 TodeX 后端（`todex-agentd`）安全通信所需的一切。[TodeX 桌面端](https://github.com/youtonghy/TodeX_desktop)、[TodeX Web](https://github.com/youtonghy/TodeX_web) 和 [TodeX Native](https://github.com/youtonghy/TodeX_native) 都基于它构建，因此配对、加密和对话在每个客户端上的表现都一致。

## 提供的能力

- **设备配对**：用户在客户端与后端之间核对验证码的配对流程。批准时一步完成设备签名密钥的登记和后端传输密钥的固定，不支持手动导入密钥。提供用于展示的密钥指纹，以及针对每种失败情况的明确错误码。
- **传输加密**：与已配对后端之间的每个请求和实时连接都经过加密（X25519 或抗量子的 ML-KEM-768），本机回环也不例外。客户端拒绝以明文连接远程主机；后端密钥或策略变化时要求重新配对；并安全地处理时钟偏差和繁忙响应的重试。
- **端到端加密的历史记录**：读写加密的对话历史、为新设备授予访问权限，以及 24 个单词 / 二维码形式的恢复密钥。
- **后端客户端**：后端 `/v2` API 和实时对话事件的类型化客户端，附带连接探测、常见连接错误的诊断，以及带抖动的重连延迟。
- **对话运行时**：把后端的事件流转换成应用展示的内容：消息、工具步骤、授权请求、计划、终端输出，并按动画帧合并实时事件。
- **后端组**：签名的成员名单、邀请与加入码、在线状态、中转，以及客户端尝试组内成员地址的顺序。
- **共享的应用逻辑**：配置同步、Agent 调用、Agent 桌面工具、SSH、路径映射、`@` 引用菜单、计划审阅、Markdown 等各客户端共用的功能。

它是与平台无关的 TypeScript，不依赖任何 UI、DOM、Electron 或 React Native。

## 在客户端中使用

客户端直接编译这些源码，不需要发布或安装包。把本仓库检出在客户端旁边：

```
parent/
  TodeX_desktop/   （或 TodeX_web、TodeX_native）
  TodeX_protocol/
```

客户端通过指向 `../TodeX_protocol/src` 的路径别名，以 `@todex/protocol/*` 导入。桌面端的 CI 会检出本仓库的 `main` 分支，所以请先推送协议改动，再推送依赖它的客户端改动。

## 开发

```bash
npm install
npm test                # 编译并运行单元测试
npm run check:protocol  # 协议一致性检查
npm run typecheck
```

线上格式的改动必须与 [TodeX Backend](https://github.com/youtonghy/TodeX_backend) 保持兼容。跨实现的测试向量放在 `tests/fixtures/`（transport v2 与后端组），并原样与后端共享。

逐模块说明、测试向量的重新生成方法和贡献规则见 [docs/MODULES.md](docs/MODULES.md)。
