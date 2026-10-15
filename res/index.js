/**
 * 云链空间 · 积分系统（Cloudflare Worker + D1）
 * ================================================
 *
 * 和 mail-worker（云邮后端）配套使用，但它是一个**独立部署**的 Worker：
 * 自己不存用户，身份完全靠调用方带来的登录令牌，向 mail-worker 的
 * GET /api/my/loginUserInfo 换取 userId。
 *
 * 接口（返回信封和邮件接口保持一致：HTTP 200 + code，业务码 != 200 表示失败）：
 *
 *   GET  /api/points/health          健康检查（不需要登录）
 *   GET  /api/points/me              当前用户：余额、今天是否已签到、签到 / 添加的花费
 *   POST /api/points/checkin         每日签到，+CHECKIN_POINTS（默认 5）
 *   POST /api/points/create-account  扣 CREATE_ACCOUNT_COST（默认 5）积分并创建一个邮箱账号
 *   GET  /api/points/log?limit=20    积分明细
 *   POST /api/points/grant           管理员手动加减积分（需要 ADMIN_KEY）
 *
 * 设计要点：
 *  - 扣分用一条带条件的 UPDATE（`WHERE balance >= ?`），D1 里这是原子的，
 *    并发请求不会把余额扣成负数。
 *  - 「每天只能签到一次」交给数据库的部分唯一索引兜底，
 *    所以同一个用户并发签到也只会有一次成功。
 *  - create-account = 先扣分，再转发给 mail-worker 的 /api/account/add；
 *    添加失败（比如邮箱已存在、人机验证没过）会把积分退回去，不会白扣。
 */

const CODE_OK = 200;
const CODE_BAD_REQUEST = 400;
const CODE_UNAUTHORIZED = 401;
const CODE_NOT_FOUND = 404;
const CODE_SERVER_ERROR = 500;
const CODE_NOT_ENOUGH_POINTS = 1001;
const CODE_ALREADY_CHECKED_IN = 1002;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-admin-key',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

/** 业务失败：HTTP 200 + code != 200（和邮件后端一样，客户端只认 code）。 */
function fail(code, message) {
  return new Response(JSON.stringify({ code, message, data: null }), {
    status: CODE_OK,
    headers: JSON_HEADERS,
  });
}

function ok(data) {
  return new Response(JSON.stringify({ code: CODE_OK, message: 'success', data }), {
    status: CODE_OK,
    headers: JSON_HEADERS,
  });
}

/** 服务器自身出错：用真正的 5xx，方便在 Cloudflare 面板里看到。 */
function serverError(message) {
  return new Response(
      JSON.stringify({ code: CODE_SERVER_ERROR, message, data: null }),
      { status: CODE_SERVER_ERROR, headers: JSON_HEADERS });
}

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- 配置

function mailBase(env) {
  return String(env.MAIL_API || '').replace(/\/+$/, '');
}

function intVar(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function checkinPoints(env) {
  return intVar(env.CHECKIN_POINTS, 5);
}

function createAccountCost(env) {
  return intVar(env.CREATE_ACCOUNT_COST, 5);
}

/**
 * 「今天」按站点时区算，默认东八区。
 * Worker 跑在 UTC，直接用 UTC 的话中国用户会在早上 8 点看到签到被重置。
 */
function today(env) {
  const offsetMinutes = intVar(env.TZ_OFFSET_MINUTES, 480);
  return new Date(Date.now() + offsetMinutes * 60000).toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- 小工具

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return {};
  }
}

function requestToken(request) {
  const raw = request.headers.get('authorization') || '';
  return raw.replace(/^Bearer\s+/i, '').trim();
}

function db(env) {
  if (!env.DB) {
    throw new HttpError(
        CODE_SERVER_ERROR,
        '没有绑定 D1：请在 wrangler.toml 里配置 [[d1_databases]] 的 binding = "DB"');
  }
  return env.DB;
}

async function bodyOf(response) {
  try {
    return await response.json();
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- 身份

/**
 * 用调用方带来的令牌去邮件后端换身份。
 *
 * 这样积分系统不需要知道 mail-worker 的 JWT 密钥，也就不会有「两边密钥不一致」的坑，
 * 代价是每次积分请求多一次内部请求（Cloudflare 内部调用，很快）。
 */
async function currentUser(request, env) {
  const token = requestToken(request);
  if (!token) {
    throw new HttpError(CODE_UNAUTHORIZED, '未登录');
  }
  if (!mailBase(env)) {
    throw new HttpError(CODE_SERVER_ERROR, '没有配置 MAIL_API（邮件后端地址）');
  }

  const response = await fetch(mailBase(env) + '/api/my/loginUserInfo', {
    headers: { authorization: token, accept: 'application/json' },
  });
  const payload = await bodyOf(response);
  const userId = payload && payload.data ? payload.data.userId : null;
  if (!payload || payload.code !== CODE_OK || !userId) {
    throw new HttpError(CODE_UNAUTHORIZED, '登录状态已失效，请重新登录');
  }
  return { token, userId: Number(userId), email: payload.data.email || '' };
}

// ---------------------------------------------------------------- 账本

async function balanceOf(env, userId) {
  const row = await db(env)
      .prepare('SELECT balance FROM points_account WHERE user_id = ?')
      .bind(userId)
      .first();
  return row ? Number(row.balance) : 0;
}

async function checkedInToday(env, userId, day) {
  const row = await db(env)
      .prepare("SELECT id FROM points_log WHERE user_id = ? AND reason = 'checkin' AND day = ? LIMIT 1")
      .bind(userId, day)
      .first();
  return Boolean(row);
}

/** 加 / 减积分并记一笔明细。 */
async function addPoints(env, userId, amount, reason, remark) {
  await db(env).batch([
    db(env).prepare(
        `INSERT INTO points_account (user_id, balance, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance,
                                            updated_at = excluded.updated_at`)
        .bind(userId, amount, nowIso()),
    db(env).prepare(
        'INSERT INTO points_log (user_id, amount, reason, day, created_at, remark) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(userId, amount, reason, today(env), nowIso(), remark || null),
  ]);
}

async function statusOf(env, userId) {
  const day = today(env);
  return {
    balance: await balanceOf(env, userId),
    checkedInToday: await checkedInToday(env, userId, day),
    checkinPoints: checkinPoints(env),
    createAccountCost: createAccountCost(env),
    today: day,
  };
}

// ---------------------------------------------------------------- 业务

async function handleMe(env, user) {
  return ok(await statusOf(env, user.userId));
}

async function handleCheckin(env, user) {
  const day = today(env);
  const points = checkinPoints(env);
  const at = nowIso();

  try {
    // 明细 + 余额放在一个批里（D1 的 batch 是事务）：
    // 明细撞上「同一天唯一签到」索引就会整体失败，余额不会被改。
    await db(env).batch([
      db(env).prepare(
          "INSERT INTO points_log (user_id, amount, reason, day, created_at, remark) VALUES (?, ?, 'checkin', ?, ?, ?)")
          .bind(user.userId, points, day, at, '每日签到'),
      db(env).prepare(
          `INSERT INTO points_account (user_id, balance, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance,
                                              updated_at = excluded.updated_at`)
          .bind(user.userId, points, at),
    ]);
  } catch (error) {
    const message = String((error && error.message) || '');
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      return fail(CODE_ALREADY_CHECKED_IN, '今天已经签到过了，明天再来');
    }
    throw error;
  }

  const status = await statusOf(env, user.userId);
  status.gained = points;
  return ok(status);
}

/**
 * 扣积分 + 建邮箱。
 *
 * 先扣分再调用邮件后端：添加失败（重名、人机验证没过、站点没开多号模式…）
 * 会把刚扣的积分原路退回，所以用户不会因为一次失败白掉 5 分。
 */
async function handleCreateAccount(request, env, user) {
  const body = await readJson(request);
  const email = String(body.email || '').trim();
  if (!email || email.indexOf('@') <= 0) {
    return fail(CODE_BAD_REQUEST, '邮箱地址不对');
  }

  const cost = createAccountCost(env);
  const at = nowIso();

  // 带条件的 UPDATE：余额不够时一行都不会改，所以扣不到负数
  const charged = await db(env)
      .prepare('UPDATE points_account SET balance = balance - ?, updated_at = ? WHERE user_id = ? AND balance >= ?')
      .bind(cost, at, user.userId, cost)
      .run();
  if (!charged.meta || charged.meta.changes !== 1) {
    return fail(CODE_NOT_ENOUGH_POINTS,
        '积分不足，添加邮箱需要 ' + cost + ' 积分，每天签到可以获得 ' + checkinPoints(env) + ' 积分');
  }
  await db(env).prepare(
      "INSERT INTO points_log (user_id, amount, reason, day, created_at, remark) VALUES (?, ?, 'add_account', ?, ?, ?)")
      .bind(user.userId, -cost, today(env), at, email)
      .run();

  const result = await addMailAccount(env, user.token, email, body.token);
  if (!result.ok) {
    // 没建成就把积分退回去，并记一笔单独的原因，方便对账
    await addPoints(env, user.userId, cost, 'refund', email + '：' + result.message);
    return fail(result.code, result.message);
  }

  // data 里除了邮件后端返回的账号信息，再带上最新余额和花费，客户端一次就能刷新
  const data = Object.assign({}, result.data || {}, {
    balance: await balanceOf(env, user.userId),
    cost,
  });
  return ok(data);
}

/** 转发给 mail-worker 的 POST /api/account/add。 */
async function addMailAccount(env, token, email, verifyToken) {
  const payload = { email };
  const verify = verifyToken == null ? '' : String(verifyToken).trim();
  if (verify) {
    payload.token = verify;
  }

  let response;
  try {
    response = await fetch(mailBase(env) + '/api/account/add', {
      method: 'POST',
      headers: {
        authorization: token,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, code: CODE_SERVER_ERROR, message: '连接邮件后端失败：' + (e && e.message) };
  }

  const json = await bodyOf(response);
  if (!json) {
    return {
      ok: false,
      code: response.status || CODE_SERVER_ERROR,
      message: '邮件后端没有返回内容 (HTTP ' + response.status + ')',
    };
  }
  // 把人机验证之类的错误原样带回去，客户端要靠 message 判断要不要弹 token 输入框
  if (json.code !== CODE_OK) {
    return {
      ok: false,
      code: json.code || response.status,
      message: json.message || '添加邮箱失败',
    };
  }
  return { ok: true, data: json.data };
}

async function handleLog(env, user, url) {
  const limit = Math.min(Math.max(intVar(url.searchParams.get('limit'), 20), 1), 100);
  const rows = await db(env)
      .prepare('SELECT amount, reason, day, created_at, remark FROM points_log WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .bind(user.userId, limit)
      .all();
  return ok({ list: (rows && rows.results) || [] });
}

/** 管理员手动加减积分（发福利 / 修数据）。ADMIN_KEY 没配就是关着的。 */
async function handleGrant(request, env) {
  const key = String(env.ADMIN_KEY || '');
  if (!key) {
    return fail(CODE_NOT_FOUND, '没有开启管理员接口');
  }
  if ((request.headers.get('x-admin-key') || '') !== key) {
    return fail(CODE_UNAUTHORIZED, '管理员密钥不对');
  }

  const body = await readJson(request);
  const userId = Number(body.userId);
  const amount = Number(body.amount);
  if (!Number.isInteger(userId) || userId <= 0) {
    return fail(CODE_BAD_REQUEST, 'userId 不对');
  }
  if (!Number.isInteger(amount) || amount === 0) {
    return fail(CODE_BAD_REQUEST, 'amount 要是非 0 整数');
  }

  const at = nowIso();
  const changed = amount > 0
      ? await db(env).prepare(
          `INSERT INTO points_account (user_id, balance, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance,
                                              updated_at = excluded.updated_at`)
          .bind(userId, amount, at).run()
      // 减少时同样加条件，别把余额扣成负数
      : await db(env).prepare(
          'UPDATE points_account SET balance = balance + ?, updated_at = ? WHERE user_id = ? AND balance >= ?')
          .bind(amount, at, userId, -amount).run();
  if (!changed.meta || changed.meta.changes !== 1) {
    return fail(CODE_NOT_ENOUGH_POINTS, '余额不足或账号不存在');
  }
  await db(env).prepare(
      "INSERT INTO points_log (user_id, amount, reason, day, created_at, remark) VALUES (?, ?, 'admin', ?, ?, ?)")
      .bind(userId, amount, today(env), at, body.remark || '管理员调整')
      .run();

  return ok({ userId, balance: await balanceOf(env, userId) });
}

// ---------------------------------------------------------------- 入口

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    try {
      if (path === '/' || path === '/api/points/health') {
        return ok({
          service: 'cloud-mail-points',
          mailApi: mailBase(env) || null,
          checkinPoints: checkinPoints(env),
          createAccountCost: createAccountCost(env),
          timezoneOffsetMinutes: intVar(env.TZ_OFFSET_MINUTES, 480),
          today: today(env),
        });
      }

      if (path === '/api/points/grant' && method === 'POST') {
        return await handleGrant(request, env);
      }

      const user = await currentUser(request, env);

      if (path === '/api/points/me' && method === 'GET') {
        return await handleMe(env, user);
      }
      if (path === '/api/points/checkin' && method === 'POST') {
        return await handleCheckin(env, user);
      }
      if (path === '/api/points/create-account' && method === 'POST') {
        return await handleCreateAccount(request, env, user);
      }
      if (path === '/api/points/log' && method === 'GET') {
        return await handleLog(env, user, url);
      }

      return fail(CODE_NOT_FOUND, '没有这个接口：' + path);
    } catch (error) {
      if (error instanceof HttpError) {
        return fail(error.code, error.message);
      }
      return serverError(String((error && error.message) || error));
    }
  },
};
