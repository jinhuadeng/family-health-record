-- 多设备同步：只存加密后的数据，服务器看不到内容
CREATE TABLE IF NOT EXISTS vault (
  id TEXT PRIMARY KEY,        -- SHA-256(同步码)
  v INTEGER NOT NULL,         -- 版本号，每次写入 +1
  iv TEXT NOT NULL,
  data TEXT NOT NULL,         -- AES-GCM 密文（base64，压缩后加密）
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blob (
  vid TEXT NOT NULL,
  bid TEXT NOT NULL,          -- 图片 id
  iv TEXT NOT NULL,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY (vid, bid)
);
