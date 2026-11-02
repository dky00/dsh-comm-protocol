# dsh-comm-protocol

把一份带版本的**沟通协议**注入 DSH 的 system prompt。

它管的是模型「从你发言到动手之间」那一段：先锁定会改变结论的前提、说出它理解的需求、在你确认之前不给方案。协议正文本身在 [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md)，随包分发，可以直接改成你自己的。

---

## 装

这个包**没有发布到 npm**，所以 `add dsh-comm-protocol` 会 404。能用的只有下面几种：

```powershell
# 1. 本地目录，或共享盘/解压后的目录（最省事，今天就能用）
dsh plugin --profile web add C:\path\to\dsh-comm-protocol

# 2. git 仓库（需要先把包推到 GitHub）
dsh plugin --profile web add github:<user>/<repo>
```

然后重启 DSH。**首次加载会自动建配置并开启**，不需要手写任何文件。

卸载：`dsh plugin --profile web remove dsh-comm-protocol`。

想用 `add dsh-comm-protocol` 这种干净写法，得先 `npm publish`——这个名字目前在 npm 上是空的。

> `desktop` profile（Electron 桌面版用的那个）被应用独占管理，CLI 会拒绝：
> `error: profile "desktop" is managed exclusively by the Electron application`。
> 这种情况只能手工登记，见文末。

## 装完之后

两个文件，都在 `<DSH_HOME>/comm-protocol/`（默认 `~/.dsh/comm-protocol/`）：

**`config.json`** —— 开关和档位

```json
{
  "enabled": true,
  "mode": "explore",
  "expectVersion": "0.4.0",
  "probe": false
}
```

**`status.json`** —— 每轮装配后重写，用来确认它真的在跑

```json
{
  "state": "ok",
  "enabled": true,
  "mode": "explore",
  "protoVersion": "0.4.0",
  "versionMatches": true,
  "sectionRendered": 2087,
  "assembleCount": 53,
  "pid": 20244,
  "assembledAt": "2026-11-02T07:39:39.732Z"
}
```

盯着三件事就够了：`assembleCount` 在不在涨（装配在跑）、`sectionRendered` 非不非零（这一轮注入了多少字符）、`assembledAt` 新不新鲜。

`state` 有四个值：

| 值 | 含义 |
|---|---|
| `ok` | 正常注入 |
| `disabled` | 开关关着 |
| `version-mismatch` | 正文版本和 `expectVersion` 对不上，**拒绝注入** |
| `source-error` | 协议文件读不到或格式不对 |

**改 `config.json` 不用重启**，下一轮装配就生效。

## 四个配置字段

- `enabled` —— 总开关。关掉时这段文字**在模型上下文里不存在**，不是"存在但让它忽略"。
- `mode` —— 档位：`align`（只对齐）/ `explore`（默认，边聊边收窄）/ `deliver`（直接交付）。它会出现在握手里。
- `expectVersion` —— 正文版本校验。和 `PROTOCOL.md` 里的 `version:` 不一致时**不注入**，只留一条错误说明。宁可响亮地不生效，也不要静默地跑旧版。
- `probe` —— 打开后，每轮会往上下文里塞一个进程内存里随机生成的标记，用来证明确实送达了。见下节。

## 怎么确认它真的进去了

`sectionRendered > 0` 只能说明插件**渲染出了字符**，不能说明字符到了模型手里。要证这一点，用 `probe`：

1. 把 `probe` 设成 `true`
2. 开一个**新会话**
3. 先别说话，看第一条回复——它应该带 `⟨proto 0.4.0 · mode=explore⟩`
4. 再问它"probe 是多少"，它能复述出那串随机标记就说明送达了

那串标记只存在于内存，不写任何文件，所以复述得出来就只能是走了 system prompt。

## 开新会话时会看到什么

协议要求它在**会话第一条实质回复**的第一行输出：

```
⟨proto 0.4.0 · mode=explore⟩
```

这是握手信号。看到它＝从文件到上下文整条链路通了；看不到＝某一段断了（先查 `status.json`）。

只出现一次，之后不重复——每轮打标记会把输出弄脏。

## 改协议

直接编辑 `protocol/PROTOCOL.md`。它是唯一事实源，每轮重新读取，**改完不用重启**。

但如果你动了文件开头的 `version:`，必须同步 `config.json` 里的 `expectVersion`，否则协议会立刻停止注入。这是故意的：版本号失配意味着文档和你以为的不是同一份。

不想管版本校验的话，把 `expectVersion` 设成 `null`——不建议，但支持。

## 已知限制

- **没有界面开关。** DSH 设置里的插件页是只读清单（后端接口只有 `list()`），改开关就是编辑 `config.json`。
- **`desktop` profile 不能由 CLI 安装**，见下。
- `/api/comm-protocol` 这个状态接口在当前版本被鉴权挡住（连根路径都返回 401），所以状态请读 `status.json`。

## 手工登记到 desktop profile

```powershell
# 1. 把包链接进 profile 的 node_modules
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-comm-protocol" `
  -Target "<这个包的绝对路径>"

# 2. 在 profiles/desktop/package.json 里加两处
#    dependencies: "dsh-comm-protocol": "link:<这个包的绝对路径>"
#    dsh.profile.bundles: 追加 "dsh-comm-protocol"

# 3. 重启 DSH
```

## 开发

无构建步骤，纯 ESM，只有 `index.js` 一个源文件。

改**代码**需要重启 DSH 才生效（模块在进程里已加载过）；改**协议正文**和**配置**都不需要，它们每轮重新读。

语法自检：`node --check index.js`。
