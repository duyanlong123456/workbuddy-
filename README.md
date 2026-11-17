# WorkBuddy Bridge

把 **WorkBuddy 桌面版** 的模型能力，转成一个本地 **OpenAI 兼容接口**，供 Codex / Cline / Roo / 任意支持 `base_url` 的工具使用。

- 零依赖（只需 Node.js 18+）
- 支持 `POST /v1/chat/completions`（Chat Completions）和 `POST /v1/responses`（Responses，Codex 用）
- 自带流式、工具调用（function calling）、推理内容透传

---

## 一、前置条件

1. **安装并登录 WorkBuddy 桌面版**（腾讯 CodeBuddy / WorkBuddy）。
   - 桥接读取的是它的本地登录态，所以必须先登录。
2. **安装 Node.js 18 或更高**：https://nodejs.org/
   - 安装后命令行执行 `node -v` 能看到版本号即可。

---

## 二、启动

双击 **`start-bridge.bat`**。

看到这样的输出就成功了：

```
[OK] 桥接运行中: {"ok":true,"auth":true,"models":19}
接口地址（OpenAI 兼容）：
  http://127.0.0.1:17399/v1
```

- 停止：双击 `stop-bridge.bat`
- 环境自检：双击 `check.bat`

> 桥接只在 `127.0.0.1:17399` 本地监听，不对外网开放。

---

## 三、接入到 Codex

编辑 `%USERPROFILE%\.codex\config.toml`，加入：

```toml
model_provider = "workbuddy"
model = "deepseek-v4.1-flash"
model_reasoning_effort = "none"
disable_response_storage = true

[model_providers.workbuddy]
name = "workbuddy"
base_url = "http://127.0.0.1:17399/v1"
wire_api = "responses"
requires_openai_auth = false
```

同时在 `%USERPROFILE%\.codex\auth.json` 里放任意占位 key（桥接不校验）：

```json
{ "OPENAI_API_KEY": "workbuddy" }
```

**关键注意点（踩坑总结）**：

| 项 | 必须值 | 说明 |
|---|---|---|
| `requires_openai_auth` | `false` | 设 `true` 会强制弹 ChatGPT 登录 |
| `model_reasoning_effort` | `none` 或 `low` | 设 `high` 可能等不到推理事件而界面空白 |
| `env_key` | **不要写** | 一旦写了就必须存在同名环境变量，否则报 `Missing environment variable` |
| `wire_api` | `responses` | 必须是 responses，Codex 桌面版只认这个 |

也可以用 `model = "auto"`，让上游自动选模型。

可用模型（`/v1/models` 可查）：

```
auto, hy4-preview, hy4-preview-x, hy3, hy3-x, space-bunny,
glm-5.3, glm-5.3-flash, glm-5.2, glm-5.1, glm-5v-turbo,
kimi-k3-1, kimi-k2.8-preview, kimi-k2.7, kimi-k2.6,
deepseek-v4-pro, deepseek-v4.1-flash, minimax-m3, step-5-preview
```

---

## 四、接入其它工具（Chat Completions）

Base URL：`http://127.0.0.1:17399/v1`
API Key：随便填（如 `workbuddy`）
模型：见上面列表

适用于 Cline、Roo Code、Open WebUI、Cherry Studio、LobeChat、各种 OpenAI SDK 等。

Python 示例：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:17399/v1", api_key="workbuddy")
resp = client.chat.completions.create(
    model="deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

---

## 五、接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查，返回 `{ok, auth, models}` |
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/responses` | OpenAI Responses API（Codex 用） |

---

## 六、常见问题

**Q: 报 `无法读取 WorkBuddy 登录态` / 503**
先确认 WorkBuddy 已打开并登录。若 WorkBuddy 安装位置特殊，设置环境变量 `WB_AUTH_FILE` 指向它的登录文件：
```
setx WB_AUTH_FILE "D:\你的路径\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info"
```

**Q: 报 `Illegal API invocation from an unapproved channel`**
这是**上游服务端的风控**，不是桥接的问题：它判定这次调用不是官方客户端发出的。常见诱因是短时间高频调用、异常参数组合。可以：
- 降低并发/频率，稍等再试
- 切换到 `model = "auto"`
- 重新打开 WorkBuddy 再试

**Q: 调用后界面一直空白、不报错**
Codex 用户请检查 `model_reasoning_effort` 是否为 `none`/`low`，并确认没有残留的 `env_key`。开新会话再试。

**Q: 端口 17399 被占用**
设置环境变量换端口后，两处一起改：
```
setx WB_BRIDGE_PORT 17400
```
然后同步修改客户端里的 `base_url`。

**Q: token 过期**
桥接会自动在后台刷新（扫描 WorkBuddy 进程内存读取最新 token，约 1–3 分钟）。刷新期间首次请求可能返回 503，稍后重试即可。持续失败请重开 WorkBuddy。

**Q: WorkBuddy 升级后失效**
上游协议可能变化。可在桥接目录下查看 `requests.log`（该文件超过 8MB 会自动清空；设 `WB_LOG=0` 可完全关闭日志）定位问题。

---

## 七、文件说明

| 文件 | 作用 |
|---|---|
| `server.mjs` | 桥接主程序（Node.js，无需安装依赖） |
| `start-bridge.bat` | 启动 |
| `stop-bridge.bat` | 停止 |
| `check.bat` | 环境自检 |
| `refresh-token.ps1` | 后台刷新 token（调用内存扫描） |
| `memscan.cs` | 内存扫描用的 C# 辅助类 |
| `token-cache.json` | 自动生成的 token 缓存（含敏感信息，请勿外传） |
| `requests.log` | 调试日志，可能含对话内容，请勿外传 |

---

## 八、安全提示

- `token-cache.json` 和 `requests.log` 含你的账号令牌或对话内容，**不要发给别人**。
- 桥接仅监听本机回环地址，但本机其它程序可以访问，请勿在公共电脑长期运行。
- 本工具用于个人在自有账号上使用，请遵守 WorkBuddy 的服务条款。
