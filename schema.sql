-- 云链空间 · 积分系统 D1 表结构
--
-- 部署时执行一次：
--   npx wrangler d1 execute cloud-mail-points --remote --file=./schema.sql

-- 每个用户一行，user_id 就是邮件后端的 userId
CREATE TABLE IF NOT EXISTS points_account (
  user_id    INTEGER PRIMARY KEY,
  balance    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL
);

-- 积分明细（流水）：正数是加，负数是扣
CREATE TABLE IF NOT EXISTS points_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  amount     INTEGER NOT NULL,
  -- checkin 签到 / add_account 建邮箱 / refund 失败退回 / admin 管理员调整
  reason     TEXT    NOT NULL,
  day        TEXT,               -- 站点时区的 YYYY-MM-DD，签到去重用
  created_at TEXT    NOT NULL,
  remark     TEXT
);

CREATE INDEX IF NOT EXISTS idx_points_log_user ON points_log(user_id, id DESC);

-- 「每人每天只能签到一次」交给数据库兜底：
-- 即使同一秒发来两个签到请求，也只会有一个插入成功，另一个撞唯一索引。
CREATE UNIQUE INDEX IF NOT EXISTS idx_points_log_checkin
  ON points_log(user_id, day) WHERE reason = 'checkin';
