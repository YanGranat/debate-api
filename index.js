import "dotenv/config";

import express from "express";
import cors from "cors";
import { v4 as uuid } from "uuid";
import Redis from "ioredis";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis(process.env.REDIS_URL);
redis.on("connect", () => console.log("✅ Redis connected"));
redis.on("error", (err) => console.error("🛑 Redis error", err));

const KEY_USER = (id) => `user:${id}`;
const KEY_CLAIMS = (id) => `claims:${id}`;
const KEY_DEBATES = (id) => `debates:${id}`;
const KEY_DEBATE = (id) => `debate:${id}`;
const KEY_HISTORY = (id) => `history:${id}`;
const KEY_SUMMARY = (id) => `summary:${id}`;
const KEY_STATS = (id) => `stats:${id}`;
const KEY_LEADER = "leaderboard";
const KEY_INBOX = (id) => `inbox:${id}`;
const KEY_FINISH = (id) => `finish:${id}`;
// ИЗМЕНЕНИЕ 1: Добавлен ключ для списка неактивных пользователей.
const KEY_INACTIVE_USERS = "users:inactive";

// ИЗМЕНЕНИЕ 1: Добавлены новые ключи для системы приглашений.
const KEY_INVITATION = (id) => `invitation:${id}`;
const KEY_USER_INVITATIONS = (id) => `invitations:${id}`;

// ───────── Пользователи ─────────
app.post("/user", async (req, res) => {
  const { name, bio } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Name is required" });
  }

  const id = name;
  const exists = await redis.exists(KEY_USER(id));
  if (exists) {
    return res.status(409).json({ error: "User already exists", userId: id });
  }

  await redis.hset(KEY_USER(id), {
    name,
    bio: bio || "Информация не предоставлена.",
    status: "inactive",
    createdAt: Date.now(),
  });
  // ИЗМЕНЕНИЕ 2: Добавляем нового пользователя в список ожидания активации.
  await redis.sadd(KEY_INACTIVE_USERS, id);

  res.status(201).json({ userId: id, name });
});

app.get("/user/:id", async (req, res) => {
  const { id } = req.params;
  const data = await redis.hgetall(KEY_USER(id));
  if (!data.name) return res.status(404).json({ error: "User not found" });
  res.json({ userId: id, ...data });
});

app.patch("/user/:id", async (req, res) => {
  const { id } = req.params;
  const exists = await redis.exists(KEY_USER(id));
  if (!exists) return res.status(404).json({ error: "User not found" });

  const updates = {};
  if (req.body.name) updates.name = req.body.name;
  if (req.body.status) updates.status = req.body.status;

  if (Object.keys(updates).length > 0) {
    await redis.hset(KEY_USER(id), updates);
    // ИЗМЕНЕНИЕ 3: Если статус меняется на active, удаляем из списка ожидания.
    if (updates.status === "active") {
      await redis.srem(KEY_INACTIVE_USERS, id);
    }
  }
  res.json({ userId: id, ...updates });
});

app.get("/inbox/:user", async (req, res) => {
  const key = KEY_INBOX(req.params.user);
  const msgs = await redis.lrange(key, 0, -1);
  if (msgs.length > 0) {
    await redis.del(key);
  }
  res.json(msgs);
});

// ───────── Утверждения (claims) ─────────
app.post("/user/:user/claim", async (req, res) => {
  const claim = { id: uuid(), text: req.body.text, ts: Date.now() };
  await redis.rpush(KEY_CLAIMS(req.params.user), JSON.stringify(claim));
  res.status(201).json(claim);
});

app.get("/user/:user/claims", async (req, res) => {
  const raw = await redis.lrange(KEY_CLAIMS(req.params.user), 0, -1);
  res.json(raw.map(JSON.parse));
});

app.delete("/user/:user/claim/:claimId", async (req, res) => {
  const key = KEY_CLAIMS(req.params.user);
  const list = await redis.lrange(key, 0, -1);
  for (const item of list) {
    const c = JSON.parse(item);
    if (c.id === req.params.claimId) {
      await redis.lrem(key, 0, item);
      return res.json({ deleted: true, claimId: req.params.claimId });
    }
  }
  res.status(404).json({ deleted: false, error: "Claim not found" });
});

app.get("/user/:user/contradictions", async (req, res) => {
  const keys = await redis.keys("claims:*");
  const out = {};
  for (const k of keys) {
    const u = k.split(":")[1];
    if (u === req.params.user) continue;
    const raw = await redis.lrange(k, 0, -1);
    if (raw.length > 0) {
      out[u] = raw.map(JSON.parse);
    }
  }
  res.json({ user: req.params.user, contradictions: out });
});

// ───────── Поиск оппонентов ─────────
app.get("/match/:user", async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get('host')}/user/${req.params.user}/contradictions`;
    const response = await axios.get(fullUrl);
    const data = response.data.contradictions;
    const list = [];
    for (const opponentName in data) {
      for (const claim of data[opponentName]) {
        list.push({
          opponent: opponentName,
          claimId: claim.id,
          text: claim.text,
        });
      }
    }
    res.json(list);
  } catch (error) {
    console.error("Error in /match/:user", error.message);
    res.status(500).json({
      error: "Failed to fetch contradictions",
      details: error.message,
    });
  }
});

// ───────── Приглашения ─────────
app.post("/invitation", async (req, res) => {
  const { fromUser, toUser, topic } = req.body;
  const invitationId = uuid();
  await redis.hset(KEY_INVITATION(invitationId), { fromUser, toUser, topic, createdAt: Date.now() });
  await redis.rpush(KEY_USER_INVITATIONS(toUser), invitationId);
  await redis.rpush(KEY_INBOX(toUser), `📩 У вас новое приглашение на дебаты от ${fromUser} на тему «${topic}». ID приглашения: ${invitationId}`);
  res.status(201).json({ invitationId, message: "Приглашение отправлено." });
});

app.post("/invitation/:id/accept", async (req, res) => {
  const { id } = req.params;
  const invData = await redis.hgetall(KEY_INVITATION(id));
  if (!invData.fromUser) return res.status(404).json({ error: "Приглашение не найдено или уже недействительно." });
  const { fromUser, toUser, topic } = invData;
  const debateId = uuid();
  await redis.hset(KEY_DEBATE(debateId), { userA: fromUser, userB: toUser, topic, status: "active", createdAt: Date.now() });
  await Promise.all([redis.rpush(KEY_DEBATES(fromUser), debateId), redis.rpush(KEY_DEBATES(toUser), debateId)]);
  await redis.rpush(KEY_INBOX(fromUser), `✅ ${toUser} принял(а) ваше приглашение! Дебаты на тему «${topic}» начаты. ID дебата: ${debateId}`);
  await redis.del(KEY_INVITATION(id));
  await redis.lrem(KEY_USER_INVITATIONS(toUser), 0, id);
  res.json({ debateId, message: "Дебаты начаты!" });
});

app.post("/invitation/:id/reject", async (req, res) => {
  const { id } = req.params;
  const invData = await redis.hgetall(KEY_INVITATION(id));
  if (!invData.fromUser) return res.status(404).json({ error: "Приглашение не найдено." });
  const { fromUser, toUser, topic } = invData;
  await redis.rpush(KEY_INBOX(fromUser), `❌ ${toUser} отклонил(а) ваше приглашение на дебаты на тему «${topic}».`);
  await redis.del(KEY_INVITATION(id));
  await redis.lrem(KEY_USER_INVITATIONS(toUser), 0, id);
  res.json({ message: "Приглашение отклонено." });
});

app.get("/user/:user/invitations", async (req, res) => {
  const ids = await redis.lrange(KEY_USER_INVITATIONS(req.params.user), 0, -1);
  const invitations = [];
  for (const id of ids) {
    const data = await redis.hgetall(KEY_INVITATION(id));
    if (data.fromUser) {
      invitations.push({ invitationId: id, ...data });
    }
  }
  res.json(invitations);
});


// ───────── Дебаты ─────────


app.get("/debates/:user", async (req, res) => {
  const ids = await redis.lrange(KEY_DEBATES(req.params.user), 0, -1);
  const out = [];
  for (const id of ids) {
    const m = await redis.hgetall(KEY_DEBATE(id));
    if (Object.keys(m).length > 0) {
      const lastRaw = await redis.lrange(KEY_HISTORY(id), -1, -1);
      const lastMessage = lastRaw.length > 0 ? JSON.parse(lastRaw[0]) : null;
      out.push({ debateId: id, ...m, lastMessage });
    }
  }
  res.json(out);
});

app.post("/debate/:id/message", async (req, res) => {
  const { from, text } = req.body;
  const debateId = req.params.id;
  const msg = { from, text, ts: Date.now() };
  await redis.rpush(KEY_HISTORY(debateId), JSON.stringify(msg));
  const m = await redis.hgetall(KEY_DEBATE(debateId));
  const to = from === m.userA ? m.userB : m.userA;
  await redis.rpush(KEY_INBOX(to),`💬 Новое сообщение в дебате «${m.topic}» (ID: ${debateId}) от ${from}: ${text}`);
  res.json({ delivered: true });
});

app.get("/debate/:id/history", async (req, res) =>
  res.json(
    (await redis.lrange(KEY_HISTORY(req.params.id), 0, -1)).map(JSON.parse)
  )
);

app.post("/debate/:id/finish", async (req, res) => {
  const { user, wantWinner } = req.body;
  const id = req.params.id;
  await redis.set(`${KEY_FINISH(id)}:${user}`, wantWinner ? "want" : "no");
  const m = await redis.hgetall(KEY_DEBATE(id));
  const other = user === m.userA ? m.userB : m.userA;
  const otherFlag = await redis.get(`${KEY_FINISH(id)}:${other}`);

  if (!wantWinner) {
    await redis.hset(KEY_DEBATE(id), "status", "ended", "endedAt", Date.now());
    return res.json({ ended: true, winner: null });
  }

  if (otherFlag === "want") {
    const hist = (await redis.lrange(KEY_HISTORY(id), 0, -1)).map(JSON.parse);
    const cnt = hist.reduce((a, x) => {
      a[x.from] = (a[x.from] || 0) + 1;
      return a;
    }, {});
    const winner = (cnt[m.userA] || 0) >= (cnt[m.userB] || 0) ? m.userA : m.userB;
    const loser = winner === m.userA ? m.userB : m.userA;

    await redis.hset(KEY_DEBATE(id),"status","ended","winner",winner,"endedAt",Date.now());
    await redis.hincrby(KEY_STATS(winner), "wins", 1);
    await redis.hincrby(KEY_STATS(loser), "losses", 1);

    const [winsW, lossesW] = await redis.hmget(KEY_STATS(winner), "wins", "losses");
    const [winsL, lossesL] = await redis.hmget(KEY_STATS(loser), "wins", "losses");

    await redis.zadd(KEY_LEADER, Number(winsW) - Number(lossesW), winner);
    await redis.zadd(KEY_LEADER, Number(winsL) - Number(lossesL), loser);

    return res.json({ ended: true, winner });
  }

  await redis.rpush(KEY_INBOX(other),`✅ ${user} предложил завершить дебат (ID: ${id}) и определить победителя. Для согласия вызовите команду завершения.`);
  res.json({ awaitingConfirmation: true });
});

app.get("/debate/:id/summary", async (req, res) => {
  res.json({
    debateId: req.params.id,
    summary: (await redis.get(KEY_SUMMARY(req.params.id))) || "",
  });
});

app.put("/debate/:id/summary", async (req, res) => {
  await redis.set(KEY_SUMMARY(req.params.id), req.body.summary);
  res.json({ updated: true });
});

app.get("/user/:user/context", async (req, res) => {
  try {
    const u = req.params.user;
    const fullUrlDebates = `${req.protocol}://${req.get('host')}/debates/${u}`;
    const claims = (await redis.lrange(KEY_CLAIMS(u), 0, -1)).map(JSON.parse);
    const debates = await axios.get(fullUrlDebates).then((r) => r.data);
    const stats = await redis.hgetall(KEY_STATS(u));
    const lb = await redis.zrevrange(KEY_LEADER, 0, 4, "WITHSCORES");
    const leaderboard = [];
    for (let i = 0; i < lb.length; i += 2) {
      leaderboard.push({ user: lb[i], score: Number(lb[i + 1]) });
    }
    const userProfile = await redis.hgetall(KEY_USER(u));
    const invitations = await axios.get(`${req.protocol}://${req.get('host')}/user/${u}/invitations`).then((r) => r.data);
    res.json({ user: u, profile: userProfile, claims, debates, stats, leaderboard, invitations });
  } catch (error) {
    console.error("Error in /user/:user/context", error.message);
    res.status(500).json({ error: "Failed to fetch user context", details: error.message });
  }
});


app.get("/stats/:user", async (req, res) =>
  res.json(await redis.hgetall(KEY_STATS(req.params.user)))
);

app.get("/leaderboard", async (_req, res) => {
  const d = await redis.zrevrange(KEY_LEADER, 0, 4, "WITHSCORES");
  const out = [];
  for (let i = 0; i < d.length; i += 2)
    out.push({ user: d[i], score: Number(d[i + 1]) });
  res.json(out);
});

// ИЗМЕНЕНИЕ 4: OpenAPI спецификация обновлена, чтобы соответствовать изменениям.
app.get("/openapi.json", (req, res) => {
  const host = req.get('host');
  const schema = {
    openapi: "3.1.0",
    info: { title: "Debate Arena API", version: "v1.1.0-invitations" },
    servers: [{ url: `https://${host}` }],
    paths: {
      "/user": { post: { summary: "Создать нового пользователя.", operationId: "createUser", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, bio: { type: "string" } }, required: ["name"] } } } }, responses: { "201": { description: "Пользователь создан." } } } },
      "/user/{id}": { get: { summary: "Получить профиль.", operationId: "getUserProfile", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK." } } }, patch: { summary: "Обновить профиль.", operationId: "updateUserProfile", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", enum: ["active", "inactive"] } } } } } }, responses: { "200": { description: "OK." } } } },
      "/inbox/{user}": { get: { summary: "Получить уведомления.", operationId: "getInboxMessages", parameters: [{ name: "user", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK." } } } },
      "/user/{user}/claim": { post: { summary: "Добавить утверждение.", operationId: "addClaim", parameters: [{ name: "user", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } } }, responses: { "201": { description: "OK." } } } },
      "/user/{user}/claims": { get: { summary: "Получить утверждения.", operationId: "getClaims", parameters: [{ name: "user", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK." } } } },
      "/user/{user}/claim/{claimId}": { delete: { summary: "Удалить утверждение.", operationId: "deleteClaim", parameters: [{ name: "user", in: "path", required: true, schema: { type: "string" } }, { name: "claimId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK." } } } },
      "/match/{user}": { get: { summary: "Найти оппонентов.", operationId: "findMatches", parameters: [{ name: "user", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK." } } } },
      "/invitation": { post: { summary: "Создать приглашение на дебаты.", operationId: "createInvitation", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { fromUser: { type: "string" }, toUser: { type: "string" }, topic: { type: "string" } }, required: ["fromUser", "toUser", "topic"] } } } }, responses: { "201": { description: "Приглашение отправлено." } } } },
      "/user/{user}/invitations": { get: { summary: "Получить список входящих приглашений.", operationId: "getInvitations", parameters: [{ name: "user", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Список приглашений." } } } },
      "/invitation/{id}/accept": { post: { summary: "Принять приглашение.", operationId: "acceptInvitation", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Дебаты начаты." } } } },
      "/invitation/{id}/reject": { post: { summary: "Отклонить приглашение.", operationId: "rejectInvitation", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Приглашение отклонено." } } } },
      "/debates/{user}": { get: { summary: "Получить дебаты.", operationId: "getDebates", parameters: [{ name: "user", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK." } } } },
      "/debate/{id}/history": { get: { summary: "Получить историю.", operationId: "getDebateHistory", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK." } } } },
      "/debate/{id}/message": { post: { summary: "Отправить сообщение.", operationId: "sendMessage", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { from: { type: "string" }, text: { type: "string" } }, required: ["from", "text"] } } } }, responses: { "200": { description: "OK." } } } },
      "/debate/{id}/finish": { post: { summary: "Завершить дебат.", operationId: "finishDebate", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { user: { type: "string" }, wantWinner: { type: "boolean" } }, required: ["user", "wantWinner"] } } } }, responses: { "200": { description: "OK." } } } },
      "/user/{user}/context": { get: { summary: "Получить контекст.", operationId: "getUserContext", parameters: [{ name: "user", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK." } } } },
      "/leaderboard": { get: { summary: "Получить лидерборд.", operationId: "getLeaderboard", responses: { "200": { description: "Топ-5 лидеров." } } } }
    }
  };
  res.json(schema);
});


app.get("/ping", (_req, res) => res.json({ ok: true, timestamp: Date.now() }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
