# 空间 · 积分系统

和 [Cloud Mail](https://github.com/maillab/cloud-mail) 配套的积分服务，跑在 Cloudflare Workers 上，
用 D1 存余额和流水。

- **每天签到 +5 积分**
- **创建一个邮箱账号 -5 积分**
- 身份直接复用云邮的登录令牌（不需要另建账号体系，也不需要两边共享密钥）

## 部署

```bash
cd points-worker
npm install -g wrangler        # 或者用 npx

wrangler login                 # 登录你的 Cloudflare 账号

# 1. 建 D1 数据库，把输出的 database_id 填进 wrangler.toml
wrangler d1 create cloud-mail-points

# 2. 建表
wrangler d1 execute cloud-mail-points --remote --file=./schema.sql

# 3. 改 wrangler.toml 里的 MAIL_API（你的云邮后端地址）

# 4. 部署
wrangler deploy
```

部署完会拿到一个地址，类似：

```
https://cloud-mail-points.<你的子域>.workers.dev
```

先验证一下（这一步不通过就别急着填进 App）：

```bash
curl https://cloud-mail-points.xxx.workers.dev/api/points/health
```

正常的返回长这样，`mailApi` 有值、`checkinPoints`/`createAccountCost` 是你想要的数字：

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

再验一下登录和签到（`TOKEN` 换成你的云邮登录令牌）：

```bash
TOKEN="你的登录令牌"
curl -H "Authorization: $TOKEN" https://xxx.workers.dev/api/points/me
curl -X POST -H "Authorization: $TOKEN" https://xxx.workers.dev/api/points/checkin
```

`/me` 返回 `balance` / `checkedInToday`，签到返回里 `gained` 是这次加的分。
同一天再签一次会返回 `code: 1002`，说明唯一索引生效了。

## 接到 App 上

**推荐：在 App 里填，不用重新打包。**

打开 App 的「账号」页 → 积分那一行右边的 **「开启积分」** 按钮 → 填上面那个 Worker 地址 → **「保存」**。
保存前 App 会自动探一次 `/api/points/health`：

- 通了 → 地址存进本机设置，卡片立刻变成「签到 +5 / 添加邮箱消耗 5 积分」
- 没通 → 弹框里直接显示原因（地址写错、Worker 没部署、D1 没绑…），不会把错地址存下来

也可以先点「测试连接」探一下再保存。想关掉就长按积分那一行（或再点按钮）→「关闭积分」。

**或者：写死在代码里。**

改 `app/src/main/java/com/example/myapp/Format.java`：

```java
public static final String DEFAULT_POINTS_URL = "https://cloud-mail-points.xxx.workers.dev";
```

留空 = 不启用积分系统，App 就还是原来的样子（不签到也不扣分）。
本机设置里填过的地址优先级更高。

## 填好之后 App 里的行为

- 账号页的积分卡显示真实余额，按钮变成 **「签到 +5」**，签过显示「已签到」并置灰（换天自动恢复）
- **添加邮箱走积分服务**：先扣 5 分再建号，一条请求完成；积分不够会直接提示，弹框里也会写明「消耗 5 积分」
- 建号失败（重名、人机验证没过…）会自动把 5 分退回来，不会白扣
- 没网 / 积分服务挂了：卡片退回显示上次缓存到的余额，不影响收发邮件


## 接口

除 `/health` 外都要带云邮的登录令牌：`Authorization: <token>`（和邮件接口一样，**不加 Bearer**）。

返回值统一是 `{code, message, data}`；**业务错误是 HTTP 200 + code != 200**，和邮件后端保持一致。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/points/health` | 健康检查，不用登录 |
| GET | `/api/points/me` | `{balance, checkedInToday, checkinPoints, createAccountCost, today}` |
| POST | `/api/points/checkin` | 签到加分，重复签到返回 code `1002` |
| POST | `/api/points/create-account` | body `{email, token?}`，扣分 + 建邮箱 |
| GET | `/api/points/log?limit=20` | 积分明细 |
| POST | `/api/points/grant` | body `{userId, amount, remark}`，管理接口，需要 `x-admin-key` |

业务码：

| code | 含义 |
| --- | --- |
| 200 | 成功 |
| 400 | 参数不对 |
| 401 | 未登录 / 令牌失效 |
| 1001 | 积分不足 |
| 1002 | 今天已经签到过 |
| 500 | 服务端出错（D1 没绑、MAIL_API 没配…） |

示例：

```bash
TOKEN="你的登录令牌"

curl -H "Authorization: $TOKEN" https://xxx.workers.dev/api/points/me
curl -X POST -H "Authorization: $TOKEN" https://xxx.workers.dev/api/points/checkin
curl -X POST -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
     -d '{"email":"tom@915161.xyz"}' \
     https://xxx.workers.dev/api/points/create-account
```

## 几个设计上的取舍

**扣分不会扣成负数。** 扣分是一条带条件的更新
（`UPDATE ... SET balance = balance - ? WHERE user_id = ? AND balance >= ?`），
D1 里单条语句是原子的，余额不够时一行都不会改，并发请求也拦得住。

**签到只能一次。** `points_log` 上有一个部分唯一索引
（`UNIQUE(user_id, day) WHERE reason = 'checkin'`），签到明细和加余额放在同一个 `batch`（事务）里，
撞索引就整体回滚，所以并发签到也只会成功一次。

**添加失败会退分。** 顺序是「先扣分 → 调用邮件后端的 `/api/account/add` → 成功才记账；
失败就把积分退回去并记一笔 `refund`」，用户不会因为一次失败白掉 5 分。

**身份靠令牌换。** 积分 Worker 自己不存用户，每次请求拿调用方的令牌去
`GET /api/my/loginUserInfo` 换 `userId`。好处是不需要让两个 Worker 共享 JWT 密钥，
代价是每次多一次内部请求（Worker 之间互调，很快）。

**「今天」按东八区算。** Worker 跑在 UTC，直接用 UTC 的话中国用户会在早上 8 点被重置签到。

## 一个要知道的限制

积分的拦截发生在**积分 Worker** 这一层：App 走 `/api/points/create-account` 才会扣分。
如果用户绕过 App、直接拿令牌调 `mail-worker` 的 `/api/account/add`，是不会扣分的。

要做到真正强制，得改 `mail-worker` 的 `account-service.js`，在
`POST /api/account/add` 里先调一次积分服务的扣分接口，失败就直接返回。
需要的话我可以把那部分改动也写出来。

## 管理员加分

```bash
wrangler secret put ADMIN_KEY          # 设一个密钥

curl -X POST https://xxx.workers.dev/api/points/grant \
  -H "x-admin-key: 你的密钥" -H "Content-Type: application/json" \
  -d '{"userId":1,"amount":100,"remark":"活动充值"}'
```

不配 `ADMIN_KEY` 时这个接口是关着的。
