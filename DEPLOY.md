# 部署到 Cloudflare（详细步骤）

积分系统是一个**独立部署的 Worker**，和你的云邮后端（mail-worker）分开跑，互不影响。

- 每天签到 **+5 积分**
- 创建一个邮箱账号 **-5 积分**
- 存储用 Cloudflare **D1**（免费额度内够用很久，见文末）

有两条路，选一条就行：

| | 适合谁 | 需要装东西吗 |
| --- | --- | --- |
| **方式 A：浏览器控制台** | 没有电脑 / 不想装 Node | 完全不用，只要浏览器 |
| **方式 B：Wrangler 命令行** | 有电脑，想改代码后一条命令重部署 | 需要 Node.js 18+ |

两条路做出来的东西完全一样，**方式 A 更适合只用手机的用户**。

---

## 部署前先准备两样东西

1. **Cloudflare 账号**：https://dash.cloudflare.com/sign-up （免费，不用绑卡）
2. **你的云邮后端地址**：就是 App 里登录用的那个，例如 `https://mail.915161.xyz`
   > 注意：**不要带结尾的斜杠**，`https://mail.915161.xyz/` 要写成 `https://mail.915161.xyz`

---

# 方式 A：浏览器控制台（推荐）

## A1. 开通 Workers 子域

1. 登录 https://dash.cloudflare.com
2. 左侧点 **Workers & Pages**
3. 第一次进来会要求设置一个子域（`*.workers.dev` 的前缀），填一个你喜欢的，比如 `tommail`
4. 之后你的 Worker 地址就是 `https://<名字>.<子域>.workers.dev`

## A2. 建 D1 数据库

1. 左侧点 **Storage & Databases** → **D1 SQL Database**
2. 点 **Create**（或 Create database）
3. 名字填 `cloud-mail-points` → **Create**
4. 建好后**把这个页面留着**，等下要用里面的 Console

## A3. 建表（把 schema.sql 跑进去）

1. 进入刚建的 `cloud-mail-points` 数据库
2. 切到 **Console** 标签页
3. 打开项目里的 `points-worker/schema.sql`，**把全部内容复制**，粘进 Console 的输入框
4. 点 **Execute**（或 Run）

> 全部执行成功会显示三条语句都 OK。它建两张表 + 两个索引，都是 `IF NOT EXISTS`，
> 跑重复了也不会报错、不会丢数据。

跑完可以顺手验一下，在 Console 里执行：

```sql
SELECT name FROM sqlite_master WHERE type='table';
```

应该能看到 `points_account` 和 `points_log`。

## A4. 建 Worker

1. 左侧 **Workers & Pages** → **Create** → 选 **Workers** → **Start with Hello World**（不要选 Pages）
2. 名字填 `cloud-mail-points` → **Deploy**
3. 部署完点 **Edit code**（或 "继续编辑"）
4. 把编辑器里的示例代码**全部删掉**，粘贴项目里 `points-worker/src/index.js` 的**全部内容**
5. 点右上角 **Deploy**

> 粘贴时注意别漏了最后那几行（`export default { ... }`），删掉就没法响应请求了。

## A5. 配置变量

1. 回到这个 Worker 的页面 → **Settings**（设置）
2. 找到 **Variables and Secrets**（变量和机密）→ **Add**
3. 依次加这四条，**Type 都选 Text**、Name 一字不差：

| Name | Value | 说明 |
| --- | --- | --- |
| `MAIL_API` | `https://mail.915161.xyz` | 你的云邮后端地址，**必填** |
| `CHECKIN_POINTS` | `5` | 每天签到给多少分 |
| `CREATE_ACCOUNT_COST` | `5` | 建一个邮箱扣多少分 |
| `TZ_OFFSET_MINUTES` | `480` | 按东八区算「今天」，否则中国用户早 8 点被重置 |

点 **Save**（或 Deploy）。

> `MAIL_API` 填错是最常见的问题：它必须是**云邮后端**地址，不是这个积分 Worker 的地址。
> 这个值错了的表现是：能签到，但添加邮箱一直失败。

## A6. 绑定 D1 数据库（关键一步）

1. 还在 **Settings** 里，找到 **Bindings**（绑定）→ **Add** → 选 **D1 database**
2. **Variable name 必须填 `DB`** —— 代码里就是按 `env.DB` 取的，填别的名字会报「没有绑定 D1」
3. D1 database 选 `cloud-mail-points`

## A7. 重新部署一次

**改完 Variables / Bindings 之后，要再点一次 Deploy 才会生效**（绑定是随版本发布的）。

在 Worker 页面点 **Deploy**（或右上角的 "部署"）。

## A8. 验证部署成功

浏览器直接打开这个地址（把域名换成你的）：

```
https://cloud-mail-points.<你的子域>.workers.dev/api/points/health
```

**成功的返回长这样：**

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "service": "cloud-mail-points",
    "mailApi": "https://mail.915161.xyz",
    "checkinPoints": 5,
    "createAccountCost": 5,
    "timezoneOffsetMinutes": 480,
    "today": "2026-02-14"
  }
}
```

对着检查：

- `mailApi` **有值**，而且是你真正的云邮地址 → 变量配对了
- `checkinPoints` / `createAccountCost` 是 `5` → 变量配对了
- 如果返回里 `mailApi` 是 `null` → 回 A5 检查变量名有没有拼错

> `/api/points/health` 不需要登录，所以能直接在浏览器打开。
> 其它接口都要带令牌，得用 curl 或 App 测（见 A9）。

到这里**部署就完成了**。可以直接跳到文末的「接到 App 上」。

## A9.（可选）用 curl 再验一次登录和签到

需要一个云邮的登录令牌。先登录拿令牌：

```bash
curl -s -X POST "https://mail.915161.xyz/api/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"你的邮箱","password":"你的密码"}'
```

返回里的 `data.token` 就是令牌，复制出来：

```bash
TOKEN="刚才复制的令牌"

# 查余额（新用户是 0）
curl -H "Authorization: $TOKEN" https://cloud-mail-points.xxx.workers.dev/api/points/me

# 签到，应该 +5
curl -X POST -H "Authorization: $TOKEN" https://cloud-mail-points.xxx.workers.dev/api/points/checkin

# 再签一次，应该返回 code 1002（说明「每天只能一次」生效了）
curl -X POST -H "Authorization: $TOKEN" https://cloud-mail-points.xxx.workers.dev/api/points/checkin
```

第一次签到返回里 `balance` 是 5、`gained` 是 5，第二次返回 `code: 1002`，就全对了。

---

# 方式 B：Wrangler 命令行

## B1. 装 Node.js 和 Wrangler

装 Node.js 18 或更高版本（https://nodejs.org），然后：

```bash
cd points-worker
npm install            # 会装上 wrangler
npx wrangler --version # 确认能跑
```

## B2. 登录 Cloudflare

```bash
npx wrangler login
```

会自动打开浏览器让你授权。如果是在没有浏览器的环境（比如服务器），改用：

```bash
npx wrangler login --browser=false
```

## B3. 建 D1 数据库

```bash
npx wrangler d1 create cloud-mail-points
```

输出里会有一行 **`database_id = "xxxxxxxx-xxxx-..."`**，**复制这个 id**。

## B4. 填 wrangler.toml

打开 `points-worker/wrangler.toml`，改两个地方：

```toml
[vars]
MAIL_API = "https://mail.915161.xyz"     # ← 改成你的云邮后端地址，不要带结尾斜杠

[[d1_databases]]
binding = "DB"                            # ← 这个不要改，必须是 DB
database_name = "cloud-mail-points"
database_id = "把 B3 复制的 id 粘到这里"   # ← 替换掉那行中文占位
```

## B5. 建表

```bash
npx wrangler d1 execute cloud-mail-points --remote --file=./schema.sql
```

> **`--remote` 不能省**。不加的话只改本地的模拟库，线上还是空的。

确认表建好了：

```bash
npx wrangler d1 execute cloud-mail-points --remote --command="SELECT name FROM sqlite_master WHERE type='table'"
```

## B6. 部署

```bash
npx wrangler deploy
```

输出最后会给你地址：

```
Published cloud-mail-points
  https://cloud-mail-points.<你的子域>.workers.dev
```

## B7. 验证

```bash
curl https://cloud-mail-points.xxx.workers.dev/api/points/health
```

对照方式 A 的 A8 检查 `mailApi` 和两个积分数字。

## B8.（可选）管理员密钥

想用管理员接口手动加分才需要：

```bash
npx wrangler secret put ADMIN_KEY
# 提示时输入一个你自己定的密钥
```

不设的话，管理员接口是关闭的（返回 404），不影响签到和扣分。

## B9. 以后改代码后重新部署

```bash
npx wrangler deploy
```

看实时日志（排查问题很有用）：

```bash
npx wrangler tail
```

---

# 接到 App 上

**推荐：在 App 里填，不用重新打包。**

1. 打开 App → 底部 **「账号」**
2. 积分那一行右边点 **「开启积分」**
3. 填 Worker 地址（只填 `xxx.workers.dev` 也行，会自动补 `https://`）
4. 先点 **「测试连接」**：
   - 通了 → 显示 `连接成功 · 签到 +5 · 建号 5 积分`
   - Worker 漏配 `MAIL_API` → 会提示「签到能查但建邮箱会失败」，回 A5 补上
   - 失败 → 会写明原因（地址写错 / 没部署 / DNS 解析不了）
5. 点 **「保存」**（保存前会再自动探一次，通不过不会存进去）

**或者写死在代码里**：改 `app/src/main/java/com/example/myapp/Format.java`：

```java
public static final String DEFAULT_POINTS_URL = "https://cloud-mail-points.xxx.workers.dev";
```

留空 = 不启用积分（App 行为和以前完全一样）。本机设置里填过的地址优先级更高。

**接上之后 App 里的表现：**

- 积分卡显示真实余额，按钮变成 **「签到 +5」**；签过显示「已签到」并置灰，第二天自动恢复
- **添加邮箱走积分服务**：先扣 5 分再建号，一条请求搞定；积分不够会直接提示
- 建号失败（重名、人机验证没过…）会**自动把 5 分退回来**，不会白扣
- 没网 / 积分服务挂了：卡片退回显示上次缓存的余额，不影响收发邮件

---

# 日常运维

## 改积分规则（签到给多少、建号扣多少）

- **方式 A**：Worker → Settings → Variables and Secrets → 改 → **再 Deploy 一次**
- **方式 B**：改 `wrangler.toml` 的 `[vars]` → `npx wrangler deploy`

改完可以让 App 重新「测试连接」确认数字变了。

## 手动给某个用户加分（发福利）

```bash
curl -X POST https://xxx.workers.dev/api/points/grant \
  -H "x-admin-key: 你设的ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId":1,"amount":100,"remark":"活动充值"}'
```

`amount` 给负数就是扣分（余额不够会被拒绝，不会扣成负数）。
`userId` 就是邮件后端的 userId（在 D1 里查，或让用户看账号页）。

## 查数据 / 看流水

方式 A：D1 → `cloud-mail-points` → **Console**，执行 SQL。
方式 B：`npx wrangler d1 execute cloud-mail-points --remote --command="..."`

```sql
-- 所有人的余额
SELECT * FROM points_account ORDER BY balance DESC;

-- 某个用户的最近 20 条流水
SELECT * FROM points_log WHERE user_id = 1 ORDER BY id DESC LIMIT 20;

-- 今天有多少人签到
SELECT COUNT(*) FROM points_log WHERE reason='checkin' AND day = date('now','+8 hours');
```

## 测试用：把某人今天的签到重置掉

想反复测签到就执行这个（**扣回 5 分并删掉今天的签到记录**）：

```sql
DELETE FROM points_log WHERE user_id = 1 AND reason = 'checkin' AND day = '2026-02-14';
UPDATE points_account SET balance = balance - 5 WHERE user_id = 1;
```

把日期换成 `/api/points/health` 返回的 `today`。

## 直接改余额（应急）

**注意**：要同时改余额和记一笔流水，否则账本对不上。

```sql
UPDATE points_account SET balance = 100, updated_at = datetime('now') WHERE user_id = 1;
INSERT INTO points_log (user_id, amount, reason, day, created_at, remark)
VALUES (1, 100, 'admin', date('now','+8 hours'), datetime('now'), '手动调整');
```

---

# 故障排查

| 现象 | 原因 / 怎么修 |
| --- | --- |
| 返回「没有绑定 D1」 | A6 没做或绑定的 **Variable name 不是 `DB`** |
| 返回「没有配置 MAIL_API」 | A5 的变量名拼错，或变量加完**没有再 Deploy 一次** |
| `/api/points/me` 返回 401「未登录」 | 令牌过期了，在 App 里退出重新登录；或 curl 时忘了带 `Authorization` 头 |
| 签到报 1002 | 正常，今天已经签过了（换设备签的也会算） |
| 添加邮箱报 1001 | 积分不足，提示里会写明需要多少分 |
| 添加邮箱一直失败，但签到正常 | `MAIL_API` 填错了（填成了积分 Worker 自己的地址？），或忘了带 `https://` |
| 添加邮箱失败后余额被扣了 | 不该发生（失败会自动退回）。用 `wrangler tail` 看日志，并查 `points_log` 里有没有 `refund` 记录 |
| 打开 health 显示 1101 / 1102 之类 | Worker 代码没粘全，或粘错了文件（要的是 `src/index.js`） |
| 改了变量不生效 | **Variables / Bindings 改完必须再 Deploy 一次** |
| 想清空重来 | D1 → Console 执行 `DROP TABLE points_log; DROP TABLE points_account;` 然后重跑 `schema.sql` |

看实时日志：

```bash
npx wrangler tail
```

（控制台方式：Worker 页面 → **Logs**）

---

# 免费额度够不够

Cloudflare 免费套餐（2026 年现状，具体以官网为准）：

- **Workers**：每天 10 万次请求
- **D1**：5 GB 存储、每天读 500 万行、写 10 万行

按签到 + 建邮箱算，每个用户每天差不多 2~4 行读写。
**几百个用户随便用，跑不到限额。** 唯一的实际约束是每天建邮箱的次数（写操作），够用。

---

# 一个必须知道的限制

积分是在**积分 Worker 这一层**拦截的：App 走 `/api/points/create-account` 才会扣分。

如果用户绕过 App，直接拿令牌去调**云邮后端**的 `POST /api/account/add`，**是不会扣分的**。

要彻底堵住，得改云邮后端（mail-worker）的 `account-service.js`，让 `/api/account/add`
自己也先调一次积分服务扣分，失败就直接拒绝。代价是以后每次升级 cloud-mail 都要重新打一次补丁。

如果你需要，告诉我，我把那部分改动也写出来。


