
const demoOffers = [
 {id:"offer-1",name:"mazzz",country:"🇷🇺 RU",deals:35,rating:"97.14%",price:85.98,available:698,limits:"40K – 45K RUB",payment:"СБП",minutes:15},
 {id:"offer-2",name:"CryptoSonic",country:"🇷🇺 RU",deals:13,rating:"100.00%",price:85.99,available:84,limits:"7.24K RUB",payment:"Сбербанк",minutes:15},
 {id:"offer-3",name:"Tribal Hyena",country:"🇺🇦 UA",deals:7,rating:"100.00%",price:88.57,available:240,limits:"11K RUB",payment:"СБП",minutes:15},
 {id:"offer-4",name:"FastHub",country:"🇷🇺 RU",deals:25,rating:"100.00%",price:88.65,available:1646,limits:"20K – 145.98K RUB",payment:"СБП, Т-Банк",minutes:15}
];

const currencies = ["BTC", "USDT", "GRAM", "TON", "ETH", "SOL", "TRX"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "crypto-bot", mode: "demo" });
    }

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      if (!env.BOT_TOKEN) return new Response("Bot is not configured", { status: 503 });
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (!constantTimeEqual(supplied, env.TELEGRAM_WEBHOOK_SECRET)) {
          return new Response("Unauthorized", { status: 401 });
        }
      }
      try {
        const update = await request.json();
        await handleUpdate(update, env);
        return new Response("ok");
      } catch (error) {
        console.error("Webhook processing failed", error);
        return new Response("Webhook error", { status: 500 });
      }
    }


    if (url.pathname.startsWith("/api/demo/")) {
      if (!env.BOT_TOKEN) return Response.json({ error: "Bot is not configured" }, { status: 503 });
      const initData = request.headers.get("X-Telegram-Init-Data") || "";
      const user = await verifyInitData(initData, env.BOT_TOKEN);
      if (!user?.id) return Response.json({ error: "Open inside Telegram" }, { status: 401 });
      const userId = String(user.id);
      await env.DB.prepare("INSERT OR IGNORE INTO users(user_id,first_name) VALUES(?,?)").bind(userId, user.first_name || "").run();
      if (url.pathname === "/api/demo/state" && request.method === "GET") {
        const rows = await env.DB.prepare("SELECT currency,amount FROM balances WHERE user_id=?").bind(userId).all();
        return Response.json({ mode: "demo", balances: Object.fromEntries(rows.results.map(row => [row.currency, row.amount])), offers: demoOffers });
      }
      if (url.pathname === "/api/demo/topup" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const amount = Number(body.amount), currency = String(body.currency || "USDT").toUpperCase(), source = String(body.source || "");
        if (!["USDT","BTC","GRAM","TON","ETH","SOL","TRX"].includes(currency) || !Number.isFinite(amount) || amount <= 0 || amount > 100000 || !["demo_card","demo_wallet","demo_transfer"].includes(source)) return Response.json({ error: "Некорректные тестовые данные" }, { status: 400 });
        await env.DB.prepare("INSERT INTO balances(user_id,currency,amount) VALUES(?,?,?) ON CONFLICT(user_id,currency) DO UPDATE SET amount=amount+excluded.amount").bind(userId,currency,amount).run();
        await env.DB.prepare("INSERT INTO demo_transactions(user_id,kind,currency,amount,details,created_at) VALUES(?,?,?,?,?,?)").bind(userId,"demo_topup",currency,amount,source,Date.now()).run();
        return Response.json({ ok:true, mode:"demo", message:"Тестовое пополнение зачислено", currency, amount });
      }
      if (url.pathname === "/api/demo/buy" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const offer = demoOffers.find(item => item.id === String(body.offerId || ""));
        const quantity = Number(body.quantity);
        if (!offer || !Number.isFinite(quantity) || quantity <= 0 || quantity > offer.available) return Response.json({ error:"Некорректное объявление или количество" }, {status:400});
        const total = Math.round(quantity * offer.price * 100) / 100;
        const debit = await env.DB.prepare("UPDATE balances SET amount=amount-? WHERE user_id=? AND currency='USDT' AND amount>=?").bind(total,userId,total).run();
        if (!debit.meta?.changes) return Response.json({error:"Недостаточно демо-баланса USDT",required:total},{status:409});
        await env.DB.prepare("INSERT INTO demo_transactions(user_id,kind,currency,amount,details,created_at) VALUES(?,?,?,?,?,?)").bind(userId,"demo_purchase","USDT",-total,JSON.stringify({offerId:offer.id,quantity}),Date.now()).run();
        return Response.json({ok:true,mode:"demo",quantity,total,currency:"USDT",offer:offer.name});
      }
      if (url.pathname === "/api/demo/history" && request.method === "GET") {
        const rows = await env.DB.prepare("SELECT kind,currency,amount,details,created_at FROM demo_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 100").bind(userId).all();
        return Response.json({transactions:rows.results});
      }
      return Response.json({error:"Not found"},{status:404});
    }

    if (url.pathname === "/api/me" && request.method === "GET") {
      if (!env.BOT_TOKEN) return Response.json({ error: "Bot is not configured" }, { status: 503 });
      const initData = request.headers.get("X-Telegram-Init-Data") || "";
      const user = await verifyInitData(initData, env.BOT_TOKEN);
      if (!user?.id) return Response.json({ error: "Open inside Telegram" }, { status: 401 });
      await env.DB.prepare(
        "INSERT OR IGNORE INTO users(user_id,first_name) VALUES(?,?)"
      ).bind(String(user.id), user.first_name || "").run();
      const rows = await env.DB.prepare(
        "SELECT currency, amount FROM balances WHERE user_id=?"
      ).bind(String(user.id)).all();
      return Response.json({
        firstName: user.first_name || "",
        balances: Object.fromEntries(rows.results.map(row => [row.currency, row.amount]))
      });
    }

    return env.ASSETS.fetch(request);
  }
};

async function handleUpdate(update, env) {
  const message = update.message;
  if (!message?.text || !message.from) return;

  const userId = String(message.from.id);
  const text = message.text.trim();

  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users(user_id,first_name) VALUES(?,?)"
    ).bind(userId, message.from.first_name || "").run();

    if (!env.WEBAPP_URL) throw new Error("WEBAPP_URL secret is missing");

    const appButton = (label, screen) => ({
      text: label,
      web_app: { url: withScreen(env.WEBAPP_URL, screen) }
    });

    const keyboard = {
      inline_keyboard: [
        [appButton("👛 Кошелёк", "wallet"), appButton("🔁 Обмен", "exchange")],
        [appButton("🟦 P2P", "p2p"), appButton("📊 Биржа", "market")],
        [appButton("🧾 Чеки", "history"), appButton("📥 Счета", "deposit")],
        [appButton("💳 Crypto Pay", "profile"), appButton("🎁 Розыгрыши", "profile")],
        [appButton("📣 Подписки", "profile"), appButton("⚙️ Настройки", "profile")]
      ]
    };

    const welcome =
      "🔷 <b>Мультивалютный криптокошелёк.</b>\n" +
      "Покупайте, продавайте, храните, отправляйте криптовалюту и платите ею, когда хотите.\n\n" +
      "Подписывайтесь на наш канал и вступайте в наш чат.\n\n" +
      "🍂 Осенний фестиваль с 🔷 <b>Crypto Bot!</b>\n" +
      "<b>Получить баллы ›</b>";

    return send(env, userId, welcome, keyboard, "HTML");
  }

  if (/^\/balance(?:@\w+)?$/i.test(text)) {
    const rows = await env.DB.prepare(
      "SELECT currency,amount FROM balances WHERE user_id=?"
    ).bind(userId).all();

    return send(env, userId, rows.results.length
      ? "Твой демо-баланс:\n" + rows.results.map(row => row.currency + ": " + row.amount).join("\n")
      : "Демо-баланс пока пуст."
    );
  }

  if (/^\/obves(?:@\w+)?(?:\s|$)/i.test(text)) {
    const admins = (env.ADMIN_IDS || "").split(",").map(value => value.trim());
    if (!admins.includes(userId)) {
      return send(env, userId, "Команда доступна только администратору демо-бота.");
    }

    const parts = text.split(/\s+/);
    if (parts.length !== 3) {
      return send(env, userId, "Формат: /obves [ВАЛЮТА] [КОЛИЧЕСТВО]\nПример: /obves BTC 0.5");
    }

    const currency = parts[1].toUpperCase();
    const amount = Number(parts[2]);
    if (!currencies.includes(currency)) {
      return send(env, userId, "Доступно: " + currencies.join(", "));
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
      return send(env, userId, "Количество должно быть положительным числом.");
    }

    await env.DB.prepare(
      "INSERT INTO balances(user_id,currency,amount) VALUES(?,?,?) " +
      "ON CONFLICT(user_id,currency) DO UPDATE SET amount=amount+excluded.amount"
    ).bind(userId, currency, amount).run();

    const row = await env.DB.prepare(
      "SELECT amount FROM balances WHERE user_id=? AND currency=?"
    ).bind(userId, currency).first();

    return send(env, userId,
      "Начислено в демо-режиме: +" + amount + " " + currency +
      "\nНовый баланс: " + row.amount + " " + currency
    );
  }

  const menuRoutes = {
    "👛 Кошелёк": "wallet",
    "🔁 Обмен": "exchange",
    "🟦 P2P": "p2p",
    "📊 Биржа": "market",
    "🧾 Чеки": "history",
    "📥 Счета": "deposit",
    "💳 Crypto Pay": "profile",
    "🎁 Розыгрыши": "profile",
    "📣 Подписки": "profile",
    "⚙️ Настройки": "profile"
  };
  if (menuRoutes[text]) {
    return send(env, userId, "Откройте раздел через кнопку меню ниже.");
  }
}

function withScreen(base, screen) {
  const url = new URL(base);
  url.searchParams.set("screen", screen);
  return url.toString();
}

async function send(env, chatId, text, replyMarkup, parseMode) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN secret is missing");
  const body = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  if (parseMode) body.parse_mode = parseMode;
  const response = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    console.error("Telegram sendMessage failed", result);
    throw new Error("Telegram sendMessage failed");
  }
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyInitData(raw, token) {
  if (!raw || !token) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (!hash) return null;

  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + "=" + value)
    .join("\n");

  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    "raw", encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const secret = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(token));
  const key = await crypto.subtle.importKey(
    "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = Array.from(new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(checkString))
  )).map(byte => byte.toString(16).padStart(2, "0")).join("");

  if (!constantTimeEqual(signature, hash)) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400 || authDate > Date.now() / 1000 + 60) return null;

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}
