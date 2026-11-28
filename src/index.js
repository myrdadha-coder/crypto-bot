
const currencies = ["USDT", "GRAM", "SOL", "TRX", "BTC", "ETH", "LTC", "BNB", "USDC", "XAUT"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) return new Response(null, {status:204,headers:corsHeaders()});

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "crypto-bot", mode: "virtual" });
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
      if (!env.BOT_TOKEN) return demoJson({ error: "Bot is not configured" }, request, { status: 503 });
      const initData = request.headers.get("X-Telegram-Init-Data") || "";
      const user = await verifyInitData(initData, env.BOT_TOKEN);
      if (!user?.id) return demoJson({ error: "Open inside Telegram" }, request, { status: 401 });
      const userId = String(user.id);
      await env.DB.prepare("INSERT OR IGNORE INTO users(user_id,first_name) VALUES(?,?)").bind(userId, user.first_name || "").run();
      if (url.pathname === "/api/demo/state" && request.method === "GET") {
        const rows = await env.DB.prepare("SELECT currency,amount FROM balances WHERE user_id=?").bind(userId).all();
        const offers = await env.DB.prepare("SELECT offer_id AS id,seller_id,currency,amount,price_usd,created_at FROM p2p_offers WHERE status='open' AND seller_id<>? ORDER BY created_at DESC LIMIT 50").bind(userId).all();
        return demoJson({ mode: "virtual", balances: Object.fromEntries(rows.results.map(row => [row.currency, row.amount])), offers: offers.results }, request);
      }
      if (url.pathname === "/api/demo/claim" && request.method === "POST") {
        const existing = await env.DB.prepare("SELECT id FROM demo_transactions WHERE user_id=? AND kind='starter_credit' LIMIT 1").bind(userId).first();
        if (existing) return demoJson({error:"Стартовые средства уже получены."},request,{status:409});
        const now=Date.now(), amount=100;
        await env.DB.batch([
          env.DB.prepare("INSERT INTO balances(user_id,currency,amount) VALUES(?,'USDT',?) ON CONFLICT(user_id,currency) DO UPDATE SET amount=amount+excluded.amount").bind(userId,amount),
          env.DB.prepare("INSERT INTO demo_transactions(user_id,kind,currency,amount,details,created_at) VALUES(?,'starter_credit','USDT',?,'{}',?)").bind(userId,amount,now)
        ]);
        return demoJson({ok:true,currency:"USDT",amount},request);
      }
      if (url.pathname === "/api/demo/swap" && request.method === "POST") {
        const body=await request.json().catch(()=>({}));
        const from=String(body.from||"").toUpperCase(),to=String(body.to||"").toUpperCase(),amount=Number(body.amount);
        if(!currencies.includes(from)||!currencies.includes(to)||from===to||!Number.isFinite(amount)||amount<=0||amount>1e12||Math.round(amount*1e8)/1e8!==amount) return demoJson({error:"Проверь валюты и сумму."},request,{status:400});
        const ids={USDT:"tether",GRAM:"the-open-network",SOL:"solana",TRX:"tron",BTC:"bitcoin",ETH:"ethereum",LTC:"litecoin",BNB:"binancecoin",USDC:"usd-coin",XAUT:"tether-gold"};
        const response=await fetch("https://api.coingecko.com/api/v3/simple/price?ids="+encodeURIComponent([...new Set([ids[from],ids[to]])].join(","))+"&vs_currencies=usd");
        if(!response.ok)return demoJson({error:"Рыночный курс временно недоступен."},request,{status:503});
        const prices=await response.json(),fromRate=Number(prices[ids[from]]?.usd),toRate=Number(prices[ids[to]]?.usd);
        if(!(fromRate>0)||!(toRate>0))return demoJson({error:"Не удалось получить курс для выбранной пары."},request,{status:503});
        const received=Math.floor((amount*fromRate/toRate)*1e8)/1e8;
        if(!(received>0)||!Number.isFinite(received))return demoJson({error:"Слишком малая сумма обмена."},request,{status:400});
        const now=Date.now(),details=JSON.stringify({from,to,rate:fromRate/toRate});
        const result=await env.DB.batch([
          env.DB.prepare("UPDATE balances SET amount=amount-? WHERE user_id=? AND currency=? AND amount>=?").bind(amount,userId,from,amount),
          env.DB.prepare("INSERT INTO balances(user_id,currency,amount) SELECT ?,?,? WHERE changes()>0 ON CONFLICT(user_id,currency) DO UPDATE SET amount=amount+excluded.amount").bind(userId,to,received),
          env.DB.prepare("INSERT INTO demo_transactions(user_id,kind,currency,amount,details,created_at) SELECT ?,'swap_out',?,?,?,? WHERE changes()>0").bind(userId,from,amount,details,now),
          env.DB.prepare("INSERT INTO demo_transactions(user_id,kind,currency,amount,details,created_at) SELECT ?,'swap_in',?,?,?,? WHERE changes()>0").bind(userId,to,received,details,now)
        ]);
        if(!result[0]?.meta?.changes)return demoJson({error:"Недостаточно средств."},request,{status:400});
        return demoJson({ok:true,from,to,spent:amount,received},request);
      }
      if (url.pathname === "/api/demo/transfer" && request.method === "POST") {
        const body=await request.json().catch(()=>({}));
        const recipient=String(body.recipient||"").trim(),currency=String(body.currency||"").toUpperCase(),amount=Number(body.amount);
        if(!/^\\d{5,20}$/.test(recipient)||recipient===userId||!currencies.includes(currency)||!Number.isFinite(amount)||amount<=0||amount>1e12||Math.round(amount*1e8)/1e8!==amount)return demoJson({error:"Проверь Telegram ID, валюту и сумму."},request,{status:400});
        const target=await env.DB.prepare("SELECT user_id FROM users WHERE user_id=?").bind(recipient).first();
        if(!target)return demoJson({error:"Получатель ещё не запускал этого бота."},request,{status:404});
        const now=Date.now(),details=JSON.stringify({recipient});
        const result=await env.DB.batch([
          env.DB.prepare("UPDATE balances SET amount=amount-? WHERE user_id=? AND currency=? AND amount>=?").bind(amount,userId,currency,amount),
          env.DB.prepare("INSERT INTO balances(user_id,currency,amount) SELECT ?,?,? WHERE changes()>0 ON CONFLICT(user_id,currency) DO UPDATE SET amount=amount+excluded.amount").bind(recipient,currency,amount),
          env.DB.prepare("INSERT INTO demo_transactions(user_id,kind,currency,amount,details,created_at) SELECT ?,'transfer_out',?,?,?,? WHERE changes()>0").bind(userId,currency,amount,details,now),
          env.DB.prepare("INSERT INTO demo_transactions(user_id,kind,currency,amount,details,created_at) SELECT ?,'transfer_in',?,?,?,? WHERE changes()>0").bind(recipient,currency,amount,JSON.stringify({sender:userId}),now)
        ]);
        if(!result[0]?.meta?.changes)return demoJson({error:"Недостаточно средств."},request,{status:400});
        return demoJson({ok:true,recipient,currency,amount},request);
      }
      if (url.pathname === "/api/demo/p2p/offer" && request.method === "POST") {
        const body=await request.json().catch(()=>({}));
        const currency=String(body.currency||"").toUpperCase(),amount=Number(body.amount),price=Number(body.priceUsd);
        if(!currencies.includes(currency)||currency==="USDT"||!Number.isFinite(amount)||amount<=0||amount>1e9||Math.round(amount*1e8)/1e8!==amount||!Number.isFinite(price)||price<=0||price>1e9)return demoJson({error:"Проверь валюту, количество и цену в USDT."},request,{status:400});
        const available=await env.DB.prepare("SELECT amount FROM balances WHERE user_id=? AND currency=?").bind(userId,currency).first();
        if(!available||Number(available.amount)<amount)return demoJson({error:"Недостаточно средств для объявления."},request,{status:400});
        const id=crypto.randomUUID();
        await env.DB.prepare("INSERT INTO p2p_offers(offer_id,seller_id,currency,amount,price_usd,status,created_at) VALUES(?,?,?,?,?,'open',?)").bind(id,userId,currency,amount,price,Date.now()).run();
        return demoJson({ok:true,offerId:id},request);
      }
      if (url.pathname === "/api/demo/p2p/buy" && request.method === "POST") {
        const body=await request.json().catch(()=>({}));
        const id=String(body.offerId||""),offer=await env.DB.prepare("SELECT offer_id,seller_id,currency,amount,price_usd FROM p2p_offers WHERE offer_id=? AND status='open'").bind(id).first();
        if(!offer||offer.seller_id===userId)return demoJson({error:"Объявление недоступно."},request,{status:404});
        const quote=Math.ceil(Number(offer.amount)*Number(offer.price_usd)*1e8)/1e8,now=Date.now();
        const result=await env.DB.batch([
          env.DB.prepare("UPDATE p2p_offers SET status='filled' WHERE offer_id=? AND status='open'").bind(id),
          env.DB.prepare("UPDATE balances SET amount=amount-? WHERE user_id=? AND currency='USDT' AND amount>=? AND changes()>0").bind(quote,userId,quote),
          env.DB.prepare("UPDATE balances SET amount=amount-? WHERE user_id=? AND currency=? AND amount>=? AND changes()>0").bind(offer.amount,offer.seller_id,offer.currency,offer.amount),
          env.DB.prepare("INSERT INTO balances(user_id,currency,amount) SELECT ?,?,? WHERE changes()>0 ON CONFLICT(user_id,currency) DO UPDATE SET amount=amount+excluded.amount").bind(userId,offer.currency,offer.amount),
          env.DB.prepare("INSERT INTO balances(user_id,currency,amount) SELECT ?, 'USDT', ? WHERE changes()>0 ON CONFLICT(user_id,currency) DO UPDATE SET amount=amount+excluded.amount").bind(offer.seller_id,quote),
          env.DB.prepare("INSERT INTO demo_transactions(user_id,kind,currency,amount,details,created_at) SELECT ?,'p2p_buy',?,?,?,? WHERE changes()>0").bind(userId,offer.currency,offer.amount,JSON.stringify({offerId:id,quote}),now),
          env.DB.prepare("INSERT INTO demo_transactions(user_id,kind,currency,amount,details,created_at) SELECT ?,'p2p_sell',?,?,?,? WHERE changes()>0").bind(offer.seller_id,'USDT',quote,JSON.stringify({offerId:id}),now)
        ]);
        if(!result[0]?.meta?.changes||!result[1]?.meta?.changes||!result[2]?.meta?.changes)return demoJson({error:"Сделка не состоялась: проверьте балансы или объявление."},request,{status:409});
        return demoJson({ok:true,currency:offer.currency,amount:offer.amount,paid:quote},request);
      }
      if (url.pathname === "/api/demo/history" && request.method === "GET") {
        const rows = await env.DB.prepare("SELECT kind,currency,amount,details,created_at FROM demo_transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 100").bind(userId).all();
        return demoJson({transactions:rows.results},request);
      }
      return demoJson({error:"Not found"},request,{status:404});
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


function corsHeaders() {
  return { "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Methods":"GET,POST,OPTIONS", "Access-Control-Allow-Headers":"Content-Type,X-Telegram-Init-Data", "Access-Control-Max-Age":"86400" };
}
function demoJson(data, request, options={}) {
  return Response.json(data, { ...options, headers: { ...corsHeaders(), ...(options.headers||{}) } });
}

async function handleUpdate(update, env) {
  const message = update.message;
  if (!message?.text || !message.from) return;

  const userId = String(message.from.id);
  const text = message.text.trim();
  const command = text.split(/\s+/, 1)[0].replace(/@\w+$/, "").toLowerCase();

  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users(user_id,first_name) VALUES(?,?)"
    ).bind(userId, message.from.first_name || "").run();

    if (!env.WEBAPP_URL) throw new Error("WEBAPP_URL secret is missing");

    const appButton = (label, screen) => ({
      text: label,
      web_app: { url: withScreen(env.WEBAPP_URL, screen) }
    });

    await configureBotMenu(env);
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
      ? "Твой баланс:\n" + rows.results.map(row => row.currency + ": " + row.amount).join("\n")
      : "Баланс пока пуст."
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
      "Начислено: +" + amount + " " + currency +
      "\nНовый баланс: " + row.amount + " " + currency
    );
  }

  const appButton = (label, screen) => ({
    text: label,
    web_app: { url: withScreen(env.WEBAPP_URL, screen) }
  });
  const back = [appButton("« Назад", "home")];
  const commandViews = {
    "/p2p": {
      text: "💠 Здесь вы можете купить или продать криптовалюту переводом на карту или электронный кошелёк. Смотреть видеоинструкцию ›",
      rows: [
        [appButton("Открыть P2P Маркет", "p2p")],
        [appButton("Купить", "p2p-buy"), appButton("Продать", "p2p-sell")],
        [appButton("Мои сделки", "p2p-deals"), appButton("Создать объявление", "p2p-create")],
        [appButton("Оплата и валюта", "p2p-payment"), appButton("Мой профиль", "profile")],
        back
      ]
    },
    "/wallet": {
      text: await walletMessage(env, userId),
      rows: [
        [appButton("Открыть кошелёк", "wallet")],
        [appButton("Пополнить", "wallet-topup"), appButton("Вывести", "wallet-withdraw")],
        back
      ]
    },
    "/checks": {
      text: "Здесь вы можете создать чек для мгновенной отправки криптовалюты любому пользователю. Смотреть видеоинструкцию ›",
      rows: [[appButton("Создать чек", "checks-create"), appButton("Создать из чата", "checks-chat")], back]
    },
    "/invoices": {
      text: "Здесь вы можете создать счёт для получения оплаты или сбора средств в криптовалюте. Смотрите видеоинструкцию ›\n\nПопробовать счета можно в @CryptoBotDonates.",
      rows: [[appButton("Создать счёт", "invoice-create"), appButton("Создать из чата", "invoice-chat")], back]
    },
    "/giveaways": {
      text: "🎁 Здесь вы можете создать розыгрыш криптовалюты среди подписчиков вашего канала, чтобы привлечь новую аудиторию, поощрить текущих подписчиков или прорекламировать канал.\n\n🦋 Crypto Bot распределит криптовалюту случайным образом среди участников розыгрыша.",
      rows: [
        [appButton("Создать розыгрыш", "giveaway-create")],
        [appButton("Управление розыгрышами", "giveaways")],
        [appButton("Мой профиль", "profile"), appButton("Оставить отзыв", "feedback")],
        back
      ]
    },
    "/subscriptions": {
      text: "🍑 Здесь вы можете управлять своими платными подписками.\n\n💰 Подключите свой канал или группу, чтобы получать доход. Комиссия 5% включена в цену подписки. Смотреть видеоинструкцию ›",
      rows: [[appButton("Подключить", "subscriptions-connect")], back]
    },
    "/pay": {
      text: "🏝 Здесь вы можете интегрировать платёжную систему Crypto Pay в свои проекты. Подробнее ›\n\n🛒 Принимайте и отправляйте оплату в криптовалюте с помощью нашего API. Попробовать пример интеграции можно в @CryptoPayTestBot.",
      rows: [
        [appButton("Открыть в приложении", "pay")],
        [appButton("Создать приложение", "pay-create"), appButton("Мои приложения", "pay-apps")],
        [appButton("Документация API", "pay-docs"), appButton("Чат для разработчиков", "pay-chat")],
        back
      ]
    },
    "/settings": {
      text: "👤 " + (message.from.first_name || "Пользователь") + (message.from.last_name ? " " + message.from.last_name : "") +
        "\n\nЧасовой пояс: Europe/Moscow\nЛокальная валюта: USD",
      rows: [[appButton("Открыть настройки", "settings")], back]
    }
  };
  const view = commandViews[command];
  if (view) {
    if (!env.WEBAPP_URL) throw new Error("WEBAPP_URL secret is missing");
    return send(env, userId, view.text, { inline_keyboard: view.rows });
  }
}

async function walletMessage(env, userId) {
  const rows = await env.DB.prepare(
    "SELECT currency,amount FROM balances WHERE user_id=?"
  ).bind(userId).all();
  const balances = Object.fromEntries(rows.results.map(row => [String(row.currency).toUpperCase(), Number(row.amount)]));
  const assets = [
    ["Tether","USDT"],["Gram","GRAM"],["Solana","SOL"],["TRON","TRX"],
    ["Bitcoin","BTC"],["Ethereum","ETH"],["Litecoin","LTC"],
    ["Binance Coin","BNB"],["USD Coin","USDC"],["Tether Gold","XAUT"]
  ];
  const lines = assets.map(([name, code]) => "🪙 " + name + ": " + (balances[code] || 0) + " " + code);
  return "👛 Кошелёк\n\n" + lines.join("\n\n") + "\n\n≈ 0 BTC";
}

async function configureBotMenu(env) {
  const commands = [
    {command:"start",description:"Главное меню Crypto Bot"},
    {command:"p2p",description:"P2P — купить и продать"},
    {command:"wallet",description:"Кошелёк и баланс"},
    {command:"checks",description:"Мои чеки"},
    {command:"invoices",description:"Счета"},
    {command:"giveaways",description:"Розыгрыши"},
    {command:"subscriptions",description:"Подписки"},
    {command:"pay",description:"Crypto Pay"},
    {command:"settings",description:"Настройки"}
  ];
  await telegramCall(env, "setMyCommands", {commands});
  await telegramCall(env, "setChatMenuButton", {menu_button:{type:"commands"}});
}

async function telegramCall(env, method, payload) {
  const response = await fetch("https://api.telegram.org/bot" + env.BOT_TOKEN + "/" + method, {
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    console.error("Telegram " + method + " failed", result);
    throw new Error("Telegram " + method + " failed");
  }
  return result;
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
