const currencies = ["BTC","USDT","GRAM","TON","ETH","SOL","TRX"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/webhook" && request.method === "POST") {
      const update = await request.json();
      await handleUpdate(update, env);
      return new Response("ok");
    }
    if (url.pathname === "/api/me") {
      const initData = request.headers.get("X-Telegram-Init-Data") || "";
      const user = await verifyInitData(initData, env.BOT_TOKEN);
      if (!user?.id) return Response.json({error:"Open inside Telegram"}, {status:401});
      await env.DB.prepare("INSERT OR IGNORE INTO users(user_id,first_name) VALUES(?,?)").bind(String(user.id), user.first_name || "").run();
      const rows = await env.DB.prepare("SELECT currency, amount FROM balances WHERE user_id=?").bind(String(user.id)).all();
      return Response.json({firstName:user.first_name || "", balances:Object.fromEntries(rows.results.map(r=>[r.currency,r.amount]))});
    }
    return env.ASSETS.fetch(request);
  }
};

async function handleUpdate(u, env) {
  const m = u.message;
  if (!m?.text || !m.from) return;
  const id = String(m.from.id), text = m.text.trim();
  if (text.startsWith("/start")) {
    await env.DB.prepare("INSERT OR IGNORE INTO users(user_id,first_name) VALUES(?,?)").bind(id,m.from.first_name || "").run();
    return send(env, id, "Crypto Bot — независимый демонстрационный Mini App. Балансы условные, реальные криптовалюты и переводы не поддерживаются.", {
      inline_keyboard: [[{text:"Открыть приложение", web_app:{url:env.WEBAPP_URL}}]]
    });
  }
  if (text.startsWith("/balance")) {
    const rows = await env.DB.prepare("SELECT currency,amount FROM balances WHERE user_id=?").bind(id).all();
    return send(env,id,rows.results.length ? "Твой демо-баланс:\n"+rows.results.map(r=>r.currency+": "+r.amount).join("\n") : "Демо-баланс пока пуст.");
  }
  if (text.startsWith("/obves")) {
    if (!(env.ADMIN_IDS || "").split(",").map(x=>x.trim()).includes(id)) return send(env,id,"Команда доступна только администратору демо-бота.");
    const p=text.split(/\s+/);
    if (p.length!==3) return send(env,id,"Формат: /obves [ВАЛЮТА] [КОЛИЧЕСТВО]\nПример: /obves BTC 0.5");
    const c=p[1].toUpperCase(), a=Number(p[2]);
    if (!currencies.includes(c)) return send(env,id,"Доступно: "+currencies.join(", "));
    if (!Number.isFinite(a)||a<=0||a>1e12) return send(env,id,"Количество должно быть положительным числом.");
    await env.DB.prepare("INSERT INTO balances(user_id,currency,amount) VALUES(?,?,?) ON CONFLICT(user_id,currency) DO UPDATE SET amount=amount+excluded.amount").bind(id,c,a).run();
    const row=await env.DB.prepare("SELECT amount FROM balances WHERE user_id=? AND currency=?").bind(id,c).first();
    return send(env,id,"Начислено в демо-режиме: +"+a+" "+c+"\nНовый баланс: "+row.amount+" "+c);
  }
}
async function send(env, chat_id, text, reply_markup) {
  await fetch("https://api.telegram.org/bot"+env.BOT_TOKEN+"/sendMessage", {
    method:"POST", headers:{"content-type":"application/json"},
    body:JSON.stringify({chat_id,text,reply_markup})
  });
}
async function verifyInitData(raw, token) {
  if (!raw || !token) return null;
  const p=new URLSearchParams(raw), hash=p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+"="+v).join("\n");
  const enc=new TextEncoder();
  const secretKey=await crypto.subtle.importKey("raw",enc.encode("WebAppData"),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const secret=await crypto.subtle.sign("HMAC",secretKey,enc.encode(token));
  const key=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=Array.from(new Uint8Array(await crypto.subtle.sign("HMAC",key,enc.encode(check)))).map(b=>b.toString(16).padStart(2,"0")).join("");
  if (sig!==hash) return null;
  const date=Number(p.get("auth_date")||0);
  if (!date || Math.abs(Date.now()/1000-date)>86400) return null;
  try { return JSON.parse(p.get("user")||"null"); } catch { return null; }
}
