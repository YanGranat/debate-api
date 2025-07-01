import express from "express";
import cors from "cors";
import { v4 as uuid } from "uuid";
import Redis from "ioredis";
import axios from "axios";

// ==================
// ОСНОВНЫЕ НАСТРОЙКИ
// ==================

const app = express();
app.use(cors());
app.use(express.json());

// Получаем префикс из переменных окружения, чтобы изолировать данные этого проекта
const REDIS_PREFIX = process.env.REDIS_PREFIX || 'debate-arena:';

// Вспомогательная функция, которая добавляет префикс ко всем ключам в Redis
const prefixKey = (key) => `${REDIS_PREFIX}${key}`;

// Подключение к Redis
const redis = new Redis(process.env.REDIS_URL);
redis.on("connect", () => console.log("✅ Redis connected"));
redis.on("error", (err) => console.error("🛑 Redis error", err));

// ==================
// КЛЮЧИ ДЛЯ REDIS (уже с префиксами)
// ==================

const KEY_USER = (id) => prefixKey(`user:${id}`);
const KEY_CLAIMS = (id) => prefixKey(`claims:${id}`);
const KEY_DEBATES = (id) => prefixKey(`debates:${id}`);
const KEY_DEBATE = (id) => prefixKey(`debate:${id}`);
const KEY_HISTORY = (id) => prefixKey(`history:${id}`);
const KEY_SUMMARY = (id) => prefixKey(`summary:${id}`);
const KEY_STATS = (id) => prefixKey(`stats:${id}`);
const KEY_LEADER = prefixKey("leaderboard");
const KEY_INBOX = (id) => prefixKey(`inbox:${id}`);
const KEY_FINISH = (id) => prefixKey(`finish:${id}`);
const KEY_INACTIVE_USERS = prefixKey("users:inactive");
const KEY_INVITATION = (id) => prefixKey(`invitation:${id}`);
const KEY_USER_INVITATIONS = (id) => prefixKey(`invitations:${id}`);

// ==================
// ОБРАБОТЧИКИ API (эндпоинты)
// ==================

// ───────── Пользователи ─────────

app.post("/user", async (req, res) => {
    try {
        const { name, bio } = req.body;
        // ЗАЩИТА: Проверка наличия обязательных данных
        if (!name || typeof name !== 'string' || name.trim() === '') {
            return res.status(400).json({ error: "Name is required and must be a non-empty string." });
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
        await redis.sadd(KEY_INACTIVE_USERS, id);

        res.status(201).json({ userId: id, name });
    } catch (error) {
        console.error("Error in POST /user:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get("/user/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const data = await redis.hgetall(KEY_USER(id));
        // ЗАЩИТА: Проверка, что пользователь найден
        if (!data || Object.keys(data).length === 0) {
            return res.status(404).json({ error: "User not found" });
        }
        res.json({ userId: id, ...data });
    } catch (error) {
        console.error(`Error in GET /user/${req.params.id}:`, error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.patch("/user/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const exists = await redis.exists(KEY_USER(id));
        if (!exists) return res.status(404).json({ error: "User not found" });

        const updates = {};
        if (req.body.status) updates.status = req.body.status;
        // Можно добавить другие поля для обновления здесь

        if (Object.keys(updates).length > 0) {
            await redis.hset(KEY_USER(id), updates);
            if (updates.status === "active") {
                await redis.srem(KEY_INACTIVE_USERS, id);
            }
        }
        res.json({ userId: id, message: "Profile updated successfully." });
    } catch (error) {
        console.error(`Error in PATCH /user/${req.params.id}:`, error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get("/inbox/:user", async (req, res) => {
    try {
        const key = KEY_INBOX(req.params.user);
        const msgs = await redis.lrange(key, 0, -1);
        if (msgs.length > 0) {
            // Очищаем inbox после прочтения
            await redis.del(key);
        }
        res.json(msgs);
    } catch (error) {
        console.error(`Error in GET /inbox/${req.params.user}:`, error);
        res.status(500).json({ error: "Internal server error" });
    }
});


// ───────── Утверждения (claims) ─────────

app.post("/user/:user/claim", async (req, res) => {
    try {
        // ЗАЩИТА: Проверка наличия текста утверждения
        if (!req.body.text || typeof req.body.text !== 'string' || req.body.text.trim() === '') {
            return res.status(400).json({ error: "Claim text is required." });
        }
        const claim = { id: uuid(), text: req.body.text, ts: Date.now() };
        await redis.rpush(KEY_CLAIMS(req.params.user), JSON.stringify(claim));
        res.status(201).json(claim);
    } catch (error) {
        console.error(`Error in POST /user/${req.params.user}/claim:`, error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ... (остальной код будет следовать тому же шаблону защиты)
// Полный код ниже

app.get("/user/:user/claims", async (req, res) => {
  try {
    const raw = await redis.lrange(KEY_CLAIMS(req.params.user), 0, -1);
    res.json(raw.map(JSON.parse));
  } catch (error) {
      console.error(`Error in GET /user/${req.params.user}/claims:`, error);
      res.status(500).json({ error: "Internal server error" });
  }
});

app.delete("/user/:user/claim/:claimId", async (req, res) => {
  try {
    const key = KEY_CLAIMS(req.params.user);
    const list = await redis.lrange(key, 0, -1);
    const claimToDelete = list.find(item => JSON.parse(item).id === req.params.claimId);

    if (claimToDelete) {
      await redis.lrem(key, 0, claimToDelete);
      return res.json({ deleted: true, claimId: req.params.claimId });
    }
    
    res.status(404).json({ deleted: false, error: "Claim not found" });
  } catch (error) {
    console.error(`Error in DELETE /user/${req.params.user}/claim/${req.params.claimId}:`, error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/user/:user/contradictions", async (req, res) => {
  try {
    const keys = await redis.keys(prefixKey("claims:*"));
    const out = {};
    for (const k of keys) {
      const u = k.split(":")[2]; // Adjusted for prefix
      if (u === req.params.user) continue;
      const raw = await redis.lrange(k, 0, -1);
      if (raw.length > 0) {
        out[u] = raw.map(JSON.parse);
      }
    }
    res.json({ user: req.params.user, contradictions: out });
  } catch (error) {
    console.error(`Error in GET /user/${req.params.user}/contradictions:`, error);
    res.status(500).json({ error: "Internal server error" });
  }
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
    console.error(`Error in GET /match/${req.params.user}:`, error);
    res.status(500).json({ error: "Failed to fetch contradictions", details: error.message });
  }
});

// ───────── Приглашения ─────────

app.post("/invitation", async (req, res) => {
  try {
    const { fromUser, toUser, topic } = req.body;
    // ЗАЩИТА: Проверка входных данных
    if (!fromUser || !toUser || !topic) {
        return res.status(400).json({ error: "fromUser, toUser, and topic are required." });
    }
    const invitationId = uuid();
    await redis.hset(KEY_INVITATION(invitationId), { fromUser, toUser, topic, createdAt: Date.now() });
    await redis.rpush(KEY_USER_INVITATIONS(toUser), invitationId);
    await redis.rpush(KEY_INBOX(toUser), `📩 У вас новое приглашение на дебаты от ${fromUser} на тему «${topic}». ID приглашения: ${invitationId}`);
    res.status(201).json({ invitationId, message: "Приглашение отправлено." });
  } catch (error) {
      console.error("Error in POST /invitation:", error);
      res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/invitation/:id/accept", async (req, res) => {
    try {
        const { id } = req.params;
        const invData = await redis.hgetall(KEY_INVITATION(id));
        if (!invData.fromUser) return res.status(404).json({ error: "Приглашение не найдено или уже недействительно." });
        const { fromUser, toUser, topic } = invData;
        const debateId = uuid();
        await redis.hset(KEY_DEBATE(debateId), { userA: fromUser, userB: toUser, topic, status: "active", turn: toUser, createdAt: Date.now() });
        await Promise.all([redis.rpush(KEY_DEBATES(fromUser), debateId), redis.rpush(KEY_DEBATES(toUser), debateId)]);
        await redis.rpush(KEY_INBOX(fromUser), `✅ ${toUser} принял(а) ваше приглашение! Дебаты на тему «${topic}» начаты. ID дебата: ${debateId}. Ваш оппонент делает первый ход.`);
        await redis.del(KEY_INVITATION(id));
        await redis.lrem(KEY_USER_INVITATIONS(toUser), 0, id);
        res.json({ debateId, message: "Дебаты начаты! Вы делаете первый ход." });
    } catch (error) {
        console.error(`Error in POST /invitation/${req.params.id}/accept:`, error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post("/invitation/:id/reject", async (req, res) => {
    try {
        const { id } = req.params;
        const invData = await redis.hgetall(KEY_INVITATION(id));
        if (!invData.fromUser) return res.status(404).json({ error: "Приглашение не найдено." });
        const { fromUser, toUser, topic } = invData;
        await redis.rpush(KEY_INBOX(fromUser), `❌ ${toUser} отклонил(а) ваше приглашение на дебаты на тему «${topic}».`);
        await redis.del(KEY_INVITATION(id));
        await redis.lrem(KEY_USER_INVITATIONS(toUser), 0, id);
        res.json({ message: "Приглашение отклонено." });
    } catch (error) {
        console.error(`Error in POST /invitation/${req.params.id}/reject:`, error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get("/user/:user/invitations", async (req, res) => {
    try {
        const ids = await redis.lrange(KEY_USER_INVITATIONS(req.params.user), 0, -1);
        const invitations = [];
        for (const id of ids) {
            const data = await redis.hgetall(KEY_INVITATION(id));
            if (data.fromUser) {
                invitations.push({ invitationId: id, ...data });
            }
        }
        res.json(invitations);
    } catch (error) {
        console.error(`Error in GET /user/${req.params.user}/invitations:`, error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// ───────── Дебаты ─────────

app.get("/debates/:user", async (req, res) => {
  try {
    const ids = await redis.lrange(KEY_DEBATES(req.params.user), 0, -1);
    const out = [];
    for (const id of ids) {
      const m = await redis.hgetall(KEY_DEBATE(id));
      if (Object.keys(m).length > 0) {
        out.push({ debateId: id, ...m });
      }
    }
    res.json(out);
  } catch (error) {
    console.error(`Error in GET /debates/${req.params.user}:`, error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/debate/:id/message", async (req, res) => {
  try {
    const { from, text } = req.body;
    const debateId = req.params.id;
    // ЗАЩИТА: Проверка входных данных
    if (!from || !text) {
        return res.status(400).json({ error: "from and text are required." });
    }
    const msg = { from, text, ts: Date.now() };
    const m = await redis.hgetall(KEY_DEBATE(debateId));
    if(m.status !== 'active') return res.status(403).json({ error: "Debate is not active." });

    await redis.rpush(KEY_HISTORY(debateId), JSON.stringify(msg));
    const to = from === m.userA ? m.userB : m.userA;
    await redis.hset(KEY_DEBATE(debateId), 'turn', to); // Смена хода
    await redis.rpush(KEY_INBOX(to),`💬 Новое сообщение в дебате «${m.topic}» (ID: ${debateId}) от ${from}: ${text}`);
    res.json({ delivered: true });
  } catch(error) {
      console.error(`Error in POST /debate/${req.params.id}/message:`, error);
      res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/debate/:id/history", async (req, res) => {
    try {
        const history = (await redis.lrange(KEY_HISTORY(req.params.id), 0, -1)).map(JSON.parse);
        res.json(history);
    } catch(error) {
        console.error(`Error in GET /debate/${req.params.id}/history:`, error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post("/debate/:id/finish", async (req, res) => {
  try {
    const { user, wantWinner } = req.body;
    if (user === undefined || wantWinner === undefined) {
        return res.status(400).json({ error: "user and wantWinner are required." });
    }
    const id = req.params.id;
    await redis.setex(`${KEY_FINISH(id)}:${user}`, 3600, wantWinner ? "want" : "no");
    const m = await redis.hgetall(KEY_DEBATE(id));
    const other = user === m.userA ? m.userB : m.userA;
    const otherFlag = await redis.get(`${KEY_FINISH(id)}:${other}`);

    if (wantWinner === false || otherFlag === "no") {
        await redis.hset(KEY_DEBATE(id), "status", "ended", "endedAt", Date.now());
        await redis.rpush(KEY_INBOX(other), `ℹ️ ${user} завершил(а) дебат «${m.topic}».`);
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

        await redis.zadd(KEY_LEADER, Number(winsW || 0) - Number(lossesW || 0), winner);
        await redis.zadd(KEY_LEADER, Number(winsL || 0) - Number(lossesL || 0), loser);

        await redis.rpush(KEY_INBOX(other), `🏆 Дебат «${m.topic}» завершен. Победитель: ${winner}!`);
        return res.json({ ended: true, winner });
    }

    await redis.rpush(KEY_INBOX(other),`✅ ${user} предложил завершить дебат (ID: ${id}) и определить победителя. Для согласия вызовите команду завершения.`);
    res.json({ awaitingConfirmation: true });
  } catch(error) {
      console.error(`Error in POST /debate/${req.params.id}/finish:`, error);
      res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/user/:user/context", async (req, res) => {
  try {
    const u = req.params.user;
    const claims = (await redis.lrange(KEY_CLAIMS(u), 0, -1)).map(JSON.parse);
    const debateIds = await redis.lrange(KEY_DEBATES(u), 0, -1);
    const debates = [];
    for(const id of debateIds) {
        const debateData = await redis.hgetall(KEY_DEBATE(id));
        if (Object.keys(debateData).length > 0) {
            debates.push({ debateId: id, ...debateData });
        }
    }
    
    const stats = await redis.hgetall(KEY_STATS(u));
    const lb = await redis.zrevrange(KEY_LEADER, 0, 4, "WITHSCORES");
    const leaderboard = [];
    for (let i = 0; i < lb.length; i += 2) {
      leaderboard.push({ user: lb[i], score: Number(lb[i + 1]) });
    }
    const userProfile = await redis.hgetall(KEY_USER(u));
    const invitationIds = await redis.lrange(KEY_USER_INVITATIONS(u), 0, -1);
    const invitations = [];
    for (const id of invitationIds) {
        const invData = await redis.hgetall(KEY_INVITATION(id));
        if (invData.fromUser) {
            invitations.push({ invitationId: id, ...invData });
        }
    }
    
    res.json({ user: u, profile: userProfile, claims, debates, stats, leaderboard, invitations });
  } catch (error) {
    console.error(`Error in GET /user/${req.params.user}/context:`, error);
    res.status(500).json({ error: "Failed to fetch user context", details: error.message });
  }
});

// ───────── Статистика и служебные эндпоинты ─────────

app.get("/leaderboard", async (_req, res) => {
    try {
        const d = await redis.zrevrange(KEY_LEADER, 0, 4, "WITHSCORES");
        const out = [];
        for (let i = 0; i < d.length; i += 2)
            out.push({ user: d[i], score: Number(d[i + 1]) });
        res.json(out);
    } catch (error) {
        console.error("Error in GET /leaderboard:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get("/openapi.json", (req, res) => {
  // Эта часть кода остается без изменений, т.к. она генерирует статичную схему
  // и не взаимодействует с базой данных.
  const host = req.get('host');
  const schema = {
    openapi: "3.1.0",
    info: { title: "Debate Arena API", version: "v1.2.0-stable" },
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

// Простой эндпоинт для проверки, что сервер жив
app.get("/ping", (_req, res) => res.json({ ok: true, timestamp: Date.now() }));

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
