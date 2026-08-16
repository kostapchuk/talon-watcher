/**
 * Telegram-бот вотчера записи на talon.by. Живёт на Cloudflare Workers
 * и отвечает мгновенно.
 *
 * Разделение обязанностей:
 *   - этот бот — общение с людьми и всё хранилище: подписки, слежки и то,
 *     что мы в последний раз видели на странице;
 *   - GitHub Actions — обход страниц по расписанию. Слежки вместе с последним
 *     известным состоянием он забирает здесь (GET /watches), а сообщения
 *     и случившиеся переходы отдаёт обратно (POST /notify).
 *
 * Проверялка сама ничего не помнит: она открывает страницу и говорит, что там
 * сейчас. Всё, что должно пережить запуск, — это поле available на слежке,
 * то есть один бит «мы уже сказали, что открыто». Ради него отдельное
 * хранилище не заводится: живёт там же, где сама слежка.
 *
 * Ещё воркер по расписанию (cron в wrangler.toml) дёргает проверку в GitHub
 * через repository_dispatch: у Cloudflare расписание точное.
 *
 * Настройки в панели Cloudflare (Workers → Settings):
 *   Variables:  BOT_TOKEN, WEBHOOK_SECRET, BROADCAST_SECRET, OWNER_CHAT_ID,
 *               GH_TOKEN, GH_REPO
 *   KV binding: SUBS
 * При сборке из репозитория привязка и несекретные переменные берутся
 * из wrangler.toml.
 *
 * Ключи в KV:
 *   subs:<chatId>      — подписчик
 *   watch:<chatId>     — все слежки человека вместе с их состоянием, одним списком
 *   index:watches      — чаты, у которых слежки есть
 *   heartbeat:<chatId> — сообщение-табло с временем проверки
 *   trigger:<chatId>   — когда человек последний раз просил проверить вручную
 *   last_check         — когда проверка отчитывалась в последний раз
 *   fails              — сколько проверок подряд сайт не открывается
 *
 * Почему такая схема: в KV операция list согласована лишь в конечном счёте —
 * только что записанный ключ может не попадать в перебор ещё около минуты.
 * Поэтому всё, что нужно читать сразу после записи (слежки человека и список
 * таких людей), лежит в конкретных ключах и читается через get, а не list.
 */

const MAX_WATCHES = 3;
const PAID = "paid"; // вид слежки; для бесплатных талонов будет свой

// Описания видно в меню команд Telegram — по ним человек и понимает,
// что дописать после команды. Поэтому здесь не «добавить врача»,
// а прямо образец того, что вставлять.
const COMMANDS = [
  { command: "add", description: "Вставь ссылку на врача с talon.by и, если хочешь, название" },
  { command: "list", description: "Мои слежки и их состояние" },
  { command: "remove", description: "Перестать следить за врачом" },
  { command: "check", description: "Проверить прямо сейчас" },
  { command: "start", description: "Подписаться на уведомления" },
  { command: "stop", description: "Отписаться от уведомлений" },
];

const EXAMPLE_URL = "https://talon.by/policlinic/klinika-merci/doctors/89829";

const HOW_TO_ADD = [
  "После <code>/add</code> нужна ссылка на страницу врача — вот так:",
  "",
  `<code>/add ${EXAMPLE_URL}</code>`,
  "",
  "Где её взять: открой на <a href=\"https://talon.by\">talon.by</a> нужного врача " +
    "и скопируй адрес из строки браузера. Ссылку можно прислать и просто " +
    "сообщением, без команды.",
  "",
  "Через пробел можно дописать название — <code>/add ссылка гинеколог</code>. " +
    "Тогда в уведомлениях врач будет так и подписан.",
].join("\n");

const INTRO = [
  "Слежу за записью к врачам на talon.by и пишу, как только кнопка " +
    "«Записаться на платный приём» становится кликабельной.",
  "",
  `Можно следить за ${MAX_WATCHES} врачами одновременно. Проверяю раз в 15 минут.`,
  "",
  "/add <i>ссылка на врача</i> — следить за ним",
  "/list — мои слежки",
  "/remove — перестать следить",
  "/check — проверить прямо сейчас",
  "/stop — отписаться",
].join("\n");

// Карточка врача: /policlinic/<учреждение>/doctors/<id>.
// Ровно та же проверка есть в check.py — ссылки в KV лежат уже канонические.
const DOCTOR_URL = /^https?:\/\/(?:www\.)?talon\.by\/policlinic\/([a-z0-9_-]+)\/doctors\/(\d+)\/?$/i;

function normalizeUrl(raw) {
  const clean = String(raw || "").trim().split("?")[0].split("#")[0];
  const found = clean.match(DOCTOR_URL);
  if (!found) return null;
  return `https://talon.by/policlinic/${found[1].toLowerCase()}/doctors/${found[2]}`;
}

/** «2026-08-16T14:00:00Z» → «16.08, 17:00» (Минск) — время в отчётах для людей */
function moment(stamp) {
  const parsed = Date.parse(stamp || "");
  if (!parsed) return "";
  const local = new Date(parsed + 3 * 3600 * 1000);
  const two = (value) => String(value).padStart(2, "0");
  return `${two(local.getUTCDate())}.${two(local.getUTCMonth() + 1)}, ` +
    `${two(local.getUTCHours())}:${two(local.getUTCMinutes())}`;
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

function api(env, method, payload) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * Отправляет сообщение. Возвращает { delivered, messageId }.
 * delivered=false — чат недоступен, подписчика надо убрать.
 */
async function text(env, chatId, message) {
  const response = await api(env, "sendMessage", {
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  if (response.ok) {
    const body = await response.json().catch(() => null);
    return { delivered: true, messageId: body && body.result && body.result.message_id };
  }

  const body = await response.text();
  console.error(`sendMessage -> ${response.status}: ${body.slice(0, 200)}`);
  // 403 — бот заблокирован, 400 chat not found — чат удалён
  if (response.status === 403 || body.includes("chat not found")) {
    return { delivered: false };
  }
  return { delivered: true }; // не доставили, но подписчик ни при чём — оставляем
}

/**
 * Разбирает отказ на правку сообщения.
 *   unchanged — текст совпал с текущим, это не ошибка;
 *   gone      — сообщение удалили или оно старше 48 часов, нужно новое;
 *   иначе     — временная беда, новое слать не надо, чтобы не плодить дубли.
 */
function editFailure(detail) {
  if (detail.includes("message is not modified")) return "unchanged";
  if (detail.includes("message to edit not found") ||
      detail.includes("message can't be edited") ||
      detail.includes("MESSAGE_ID_INVALID")) return "gone";
  return "transient";
}

// ---------------------------------------------------------------------------
// Подписчики и слежки
// ---------------------------------------------------------------------------

async function subscribe(env, chatId, info) {
  const existing = await env.SUBS.get(`subs:${chatId}`);
  if (existing) return false;
  await env.SUBS.put(`subs:${chatId}`, JSON.stringify(info));
  return true;
}

async function unsubscribe(env, chatId) {
  const existing = await env.SUBS.get(`subs:${chatId}`);
  await env.SUBS.delete(`subs:${chatId}`);
  return Boolean(existing);
}

async function subscribers(env) {
  const ids = new Set();
  const listed = await env.SUBS.list({ prefix: "subs:" });
  for (const key of listed.keys) ids.add(key.name.slice("subs:".length));
  return [...ids];
}

/** Слежки одного человека: [{ id, url, alias, kind, doctor, available, ... }] */
async function userWatches(env, chatId) {
  const stored = await env.SUBS.get(`watch:${chatId}`);
  return stored ? JSON.parse(stored) : [];
}

async function saveWatches(env, chatId, watches) {
  await env.SUBS.put(`watch:${chatId}`, JSON.stringify(watches));

  // указатель, чтобы обходиться без list — он отстаёт от записи
  const stored = await env.SUBS.get("index:watches");
  const chats = new Set(stored ? JSON.parse(stored) : []);
  const before = chats.size;
  watches.length ? chats.add(chatId) : chats.delete(chatId);
  if (chats.size !== before) {
    await env.SUBS.put("index:watches", JSON.stringify([...chats]));
  }
}

/**
 * Все слежки всех людей — для проверялки.
 *
 * Читаем из двух источников сразу: указатель знает про свежие записи, до
 * которых перебор ещё не дошёл, а перебор — про всё, что мимо указателя
 * (например, записанное прежней версией). Объединение закрывает оба провала.
 */
async function allWatches(env) {
  const chats = new Set();

  const stored = await env.SUBS.get("index:watches");
  for (const chatId of stored ? JSON.parse(stored) : []) chats.add(chatId);

  const listed = await env.SUBS.list({ prefix: "watch:" });
  for (const key of listed.keys) chats.add(key.name.slice("watch:".length));

  const watches = [];
  for (const chatId of chats) {
    // отписавшимся не шлём: слежки храним, но обходить их незачем
    if (!(await env.SUBS.get(`subs:${chatId}`))) continue;
    const value = await env.SUBS.get(`watch:${chatId}`);
    for (const watch of value ? JSON.parse(value) : []) {
      watches.push({
        id: watch.id,
        chat_id: chatId,
        url: watch.url,
        alias: watch.alias || "",
        kind: watch.kind || PAID,
        // что мы видели в прошлый раз — по этому проверялка и поймёт,
        // случился ли переход, о котором надо написать
        available: Boolean(watch.available),
      });
    }
  }
  return watches;
}

function newWatchId() {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Проверялка сообщила, что у слежек изменилось состояние:
 * [{ chat_id, id, available, booking_url }]. Пишем по одному разу на человека.
 */
async function applyStatuses(env, statuses) {
  const byChat = new Map();
  for (const status of statuses || []) {
    const chatId = String(status.chat_id || "");
    if (!chatId || !status.id) continue;
    if (!byChat.has(chatId)) byChat.set(chatId, []);
    byChat.get(chatId).push(status);
  }

  let updated = 0;
  for (const [chatId, changes] of byChat) {
    const watches = await userWatches(env, chatId);
    let touched = false;
    for (const change of changes) {
      const watch = watches.find((item) => item.id === change.id);
      // слежку могли убрать, пока шла проверка — тогда и записывать нечего
      if (!watch || Boolean(watch.available) === Boolean(change.available)) continue;
      watch.available = Boolean(change.available);
      watch.bookingUrl = change.available ? (change.booking_url || "") : "";
      watch.changed = new Date().toISOString();
      touched = true;
      updated++;
    }
    if (touched) await saveWatches(env, chatId, watches);
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Страница врача: что на ней сейчас
// ---------------------------------------------------------------------------

const PAID_LABEL = "Записаться\\s+на\\s+платный\\s+при[ёе]м";
const OPEN_BUTTON = new RegExp(
  `<a\\s[^>]*href="([^"]+)"[^>]*class="[^"]*\\bbutton\\b[^"]*"[^>]*>\\s*${PAID_LABEL}`, "i");
const CLOSED_BUTTON = new RegExp(
  `<span\\s[^>]*class="[^"]*\\bnotAvailable\\b[^"]*"[^>]*>\\s*${PAID_LABEL}`, "i");

/**
 * Смотрим страницу глазами человека, добавляющего слежку: существует ли врач
 * и что с кнопкой прямо сейчас. Проверялка делает ровно то же самое (check.py,
 * parse_doctor) — здесь это нужно, чтобы ответить сразу, а не через 10 минут.
 */
async function probe(url) {
  let page;
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "accept-language": "ru-RU,ru;q=0.9",
      },
    });
    if (response.status === 404) return { ok: false, reason: "нет такой страницы" };
    if (!response.ok) return { ok: false, reason: `сайт ответил ${response.status}` };
    page = await response.text();
  } catch (error) {
    console.error("probe:", error);
    return { ok: false, reason: "сайт не открылся" };
  }

  const header = page.match(/<div\s+id="doctor_header"[\s\S]{0,4000}/);
  const name = header && header[0].match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
  if (!name) return { ok: false, reason: "не похоже на карточку врача" };

  const speciality = header[0].match(/<p[^>]*class="[^"]*\bgrey\b[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  const open = page.match(OPEN_BUTTON);
  const strip = (value) => value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  return {
    ok: true,
    doctor: strip(name[1]),
    speciality: speciality ? strip(speciality[1]) : "",
    available: Boolean(open),
    bookingUrl: open ? new URL(open[1], "https://talon.by").toString() : "",
    hasButton: Boolean(open || page.match(CLOSED_BUTTON)),
  };
}

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------

async function addWatch(env, chatId, url, alias) {
  const watches = await userWatches(env, chatId);
  if (watches.length >= MAX_WATCHES) {
    await text(env, chatId,
      `Больше ${MAX_WATCHES} слежек одновременно не потяну. Освободи место: /list`);
    return;
  }
  if (watches.some((watch) => watch.url === url)) {
    await text(env, chatId, "За этим врачом я уже слежу. Список: /list");
    return;
  }

  const found = await probe(url);
  if (!found.ok) {
    await text(env, chatId, `Не смог открыть страницу врача: ${found.reason}.\n\n` +
      "Проверь ссылку — она должна выглядеть так:\n" +
      `<code>${EXAMPLE_URL}</code>`);
    return;
  }

  watches.push({
    id: newWatchId(),
    url,
    alias: alias || "",
    kind: PAID,
    doctor: found.doctor,
    speciality: found.speciality,
    // состояние знаем прямо сейчас — записываем его сразу, иначе первая же
    // проверка сочтёт открытую запись новостью и напишет о ней второй раз
    available: found.available,
    bookingUrl: found.bookingUrl,
    changed: new Date().toISOString(),
    created: new Date().toISOString(),
  });
  await saveWatches(env, chatId, watches);
  await subscribe(env, chatId, { since: new Date().toISOString() });

  const lines = [`✅ Слежу за: <b>${esc(found.doctor)}</b>`];
  if (found.speciality) lines.push(esc(found.speciality));
  if (alias) lines.push(`Название: «${esc(alias)}»`);
  lines.push("");

  if (!found.hasButton) {
    lines.push("⚠️ На странице нет кнопки платной записи — похоже, у этого врача " +
      "только бесплатные талоны. Следить буду, но открыться там нечему.");
  } else if (found.available) {
    lines.push("🎉 <b>Запись уже открыта!</b>",
      `👉 <a href="${esc(found.bookingUrl)}">Записаться на платный приём</a>`);
  } else {
    lines.push("Сейчас записи нет — проверяю каждые 15 минут и напишу, как только откроется.");
  }
  lines.push("", "Мои слежки: /list");
  await text(env, chatId, lines.join("\n"));
}

async function listWatches(env, chatId) {
  const watches = await userWatches(env, chatId);
  if (!watches.length) {
    await text(env, chatId, "Пока ни за кем не слежу.\n\n" + HOW_TO_ADD);
    return;
  }

  const lines = watches.map((watch, index) => {
    const title = watch.alias || watch.doctor || "врач";
    const status = watch.available
      ? (watch.bookingUrl
        ? `🎉 <a href="${esc(watch.bookingUrl)}">запись открыта</a>`
        : "🎉 запись открыта")
      : "⏳ записи нет";
    return `${index + 1}. <b>${esc(title)}</b> — ${status}\n` +
      `${watch.doctor && watch.alias ? esc(watch.doctor) + "\n" : ""}` +
      `<a href="${esc(watch.url)}">карточка</a> · убрать: /remove_${watch.id}`;
  });

  const last = await env.SUBS.get("last_check");
  await text(env, chatId,
    `Слежу за ${watches.length} из ${MAX_WATCHES}:\n\n` + lines.join("\n\n") +
    (moment(last) ? `\n\nПоследняя проверка: ${moment(last)}` : "") +
    "\n\nДобавить ещё — /add");
}

async function removeWatch(env, chatId, id) {
  const watches = await userWatches(env, chatId);

  if (!id) {
    if (!watches.length) {
      await text(env, chatId, "Убирать нечего — я ни за кем не слежу.\n\n" + HOW_TO_ADD);
      return;
    }
    const lines = watches.map((watch) =>
      `• <b>${esc(watch.alias || watch.doctor || watch.url)}</b> — убрать: /remove_${watch.id}`);
    await text(env, chatId, "За кем перестать следить?\n\n" + lines.join("\n"));
    return;
  }

  const doomed = watches.find((watch) => watch.id === id);
  if (!doomed) {
    await text(env, chatId, "Такой слежки нет. Список: /list");
    return;
  }
  await saveWatches(env, chatId, watches.filter((watch) => watch.id !== id));
  await text(env, chatId,
    `🗑 Больше не слежу за «${esc(doomed.alias || doomed.doctor || "врачом")}». Остальные: /list`);
}

/**
 * Проверка по просьбе человека. Дёргать GitHub на каждое сообщение нельзя —
 * запуски встанут в очередь и расписание поедет, поэтому не чаще раза в минуту.
 */
async function checkNow(env, chatId) {
  const recent = await env.SUBS.get(`trigger:${chatId}`);
  if (recent) {
    await text(env, chatId, "Проверка уже запущена, подожди минутку.");
    return;
  }
  const result = await triggerCheck(env);
  if (!result.ok) {
    console.error("ручной запуск:", JSON.stringify(result));
    await text(env, chatId, "Не смог запустить проверку. Ближайшая всё равно будет " +
      "в течение 10 минут.");
    return;
  }
  await env.SUBS.put(`trigger:${chatId}`, new Date().toISOString(), { expirationTtl: 60 });
  await text(env, chatId, "🔄 Запустил проверку — если что-то изменилось, сейчас напишу.");
}

async function handleUpdate(env, update) {
  const message = update.message;
  const chat = message && message.chat;
  if (!chat || !chat.id || typeof message.text !== "string") return;

  const chatId = String(chat.id);
  const body = message.text.trim();
  const command = body.split(/\s+/)[0].split("@")[0].toLowerCase();
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
  console.log(`${command} от ${name || chatId} (${chatId})`);

  // Ссылка на врача = новая слежка, хоть с /add, хоть без. Остаток сообщения —
  // её название.
  const link = body.match(/https?:\/\/\S*talon\.by\/\S+/i);
  if (link) {
    const url = normalizeUrl(link[0]);
    if (!url) {
      await text(env, chatId,
        "Эту ссылку я пока не понимаю — нужна страница врача, вида\n" +
        `<code>${EXAMPLE_URL}</code>\n\n` +
        "Бесплатные талоны — следующим шагом.");
      return;
    }
    const alias = body.replace(link[0], "").replace(/^\/\w+/, "").trim().slice(0, 60);
    await addWatch(env, chatId, url, alias);
    return;
  }

  if (command === "/start") {
    const isNew = await subscribe(env, chatId, {
      name,
      username: chat.username || "",
      since: new Date().toISOString(),
    });
    await text(env, chatId,
      (isNew ? "✅ Подписал!\n\n" : "Ты уже подписан 👌\n\n") + INTRO);
    if (!isNew) await listWatches(env, chatId);
    return;
  }

  if (command === "/stop") {
    const was = await unsubscribe(env, chatId);
    await text(env, chatId, was
      ? "🔕 Отписал. Слежки сохранил — вернуться можно командой /start"
      : "Ты и так не подписан. Подписаться — /start");
    return;
  }

  if (command === "/add") {
    await text(env, chatId, HOW_TO_ADD);
    return;
  }

  if (command === "/list") {
    await listWatches(env, chatId);
    return;
  }

  if (command === "/remove" || command.startsWith("/remove_") ||
      command === "/del" || command.startsWith("/del_")) {
    const id = command.includes("_")
      ? command.slice(command.indexOf("_") + 1)
      : (body.split(/\s+/)[1] || "").replace(/^\//, "");
    await removeWatch(env, chatId, id);
    return;
  }

  if (command === "/check") {
    await checkNow(env, chatId);
    return;
  }

  await text(env, chatId, INTRO);
}

// ---------------------------------------------------------------------------
// Обмен с проверялкой
// ---------------------------------------------------------------------------

async function handleWatches(env) {
  return Response.json({ watches: await allWatches(env) });
}

/**
 * Итог проверки: готовые сообщения [{ chat_id, text }] и случившиеся переходы
 * [{ chat_id, id, available, booking_url }]. Тексты собирает проверялка —
 * только она знает, что именно изменилось.
 *
 * Сначала отправляем, потом записываем: если запись в KV сорвётся, человек
 * получит уведомление дважды — неприятно, но лучше, чем не получить вовсе.
 */
async function handleNotify(env, request) {
  const payload = await request.json().catch(() => null);
  const messages = (payload && payload.messages) || [];
  const statuses = (payload && payload.statuses) || [];
  if (!messages.length && !statuses.length) {
    return new Response("нужны messages[] или statuses[]", { status: 400 });
  }

  let delivered = 0;
  let failed = 0;
  const dropped = new Set();

  for (const message of messages) {
    const chatId = String(message.chat_id || "");
    if (!chatId || !message.text || dropped.has(chatId)) continue;

    const sent = await text(env, chatId, message.text);
    if (sent.delivered) {
      delivered++;
    } else {
      failed++;
      dropped.add(chatId);
      await env.SUBS.delete(`subs:${chatId}`); // заблокировал бота — отписываем
      console.log(`отписан ${chatId}: чат недоступен`);
    }
  }

  const updated = await applyStatuses(env, statuses);
  return Response.json({ delivered, failed, dropped: dropped.size, updated });
}

/**
 * Считаем проверки, в которых сайт не открылся ни разу, и на третьей будим
 * владельца: вотчер, который молча ничего не проверяет, выглядит ровно так же,
 * как вотчер, которому нечего сообщить. Второй раз напоминаем на тридцатой,
 * чтобы не превращать поломку в поток сообщений.
 */
async function countFailures(env, failedAll) {
  if (!failedAll) {
    if (await env.SUBS.get("fails")) await env.SUBS.delete("fails");
    return;
  }
  const fails = Number(await env.SUBS.get("fails") || 0) + 1;
  await env.SUBS.put("fails", String(fails));
  if ((fails === 3 || fails === 30) && env.OWNER_CHAT_ID) {
    await text(env, String(env.OWNER_CHAT_ID),
      `⚠️ Не могу открыть talon.by — ${fails} проверки подряд. Посмотри логи Actions.`);
  }
}

/**
 * Отчёт о прошедшей проверке владельцу.
 *
 * mode=edit — держим одно сообщение и переписываем его: чат не забивается,
 * а закреплённое сообщение всегда показывает свежее время.
 * mode=every — отдельное сообщение на каждую проверку.
 */
async function handleHeartbeat(env, request) {
  const payload = await request.json().catch(() => null);
  const chatId = String(payload?.chat_id || env.OWNER_CHAT_ID || "");
  const body = payload?.text;
  if (!chatId || !body) return new Response("нужны chat_id и text", { status: 400 });

  await env.SUBS.put("last_check", new Date().toISOString());
  await countFailures(env, Boolean(payload.failed_all));

  // HEARTBEAT=off — проверялка всё равно приходит сюда, чтобы отметиться;
  // сообщение при этом не нужно, а тревога о недоступном сайте уже ушла
  if (payload.mode === "off") return Response.json({ noted: true });

  if (payload.mode === "edit") {
    const known = await env.SUBS.get(`heartbeat:${chatId}`);
    if (known) {
      const response = await api(env, "editMessageText", {
        chat_id: chatId,
        message_id: Number(known),
        text: body,
        parse_mode: "HTML",
      });
      if (response.ok) return Response.json({ edited: Number(known) });

      const reason = editFailure(await response.text());
      // текст тот же — Telegram отказывает, но табло и так актуально
      if (reason === "unchanged") return Response.json({ unchanged: Number(known) });
      // временная беда: новое слать нельзя, иначе при каждом сбое будет дубль
      if (reason === "transient") return Response.json({ skipped: Number(known) });
      console.log("табло удалено или устарело, завожу новое");
    }
    const sent = await text(env, chatId, body);
    if (sent.messageId) await env.SUBS.put(`heartbeat:${chatId}`, String(sent.messageId));
    return Response.json({ sent: sent.messageId || null });
  }

  const sent = await text(env, chatId, body);
  return Response.json({ sent: sent.messageId || null });
}

// ---------------------------------------------------------------------------
// Запуск проверки в GitHub Actions
// ---------------------------------------------------------------------------

async function triggerCheck(env) {
  if (!env.GH_TOKEN || !env.GH_REPO) {
    return { ok: false, error: "не заданы GH_TOKEN или GH_REPO" };
  }
  const response = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "talon-watcher-bot",
    },
    body: JSON.stringify({ event_type: "check" }),
  });
  if (response.ok) return { ok: true };
  return { ok: false, status: response.status, error: (await response.text()).slice(0, 200) };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function authorized(env, request, url) {
  const header = request.headers.get("authorization") || "";
  const provided = header.replace(/^Bearer\s+/i, "") || url.searchParams.get("key") || "";
  return Boolean(env.BROADCAST_SECRET) && provided === env.BROADCAST_SECRET;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (env.WEBHOOK_SECRET &&
          request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
        return new Response("нет", { status: 401 });
      }
      const update = await request.json().catch(() => null);
      if (update) await handleUpdate(env, update);
      return new Response("ok"); // Telegram доволен в любом случае
    }

    if (url.pathname === "/watches") {
      if (!authorized(env, request, url)) return new Response("нет", { status: 401 });
      return await handleWatches(env);
    }

    if (url.pathname === "/notify" && request.method === "POST") {
      if (!authorized(env, request, url)) return new Response("нет", { status: 401 });
      return await handleNotify(env, request);
    }

    if (url.pathname === "/heartbeat" && request.method === "POST") {
      if (!authorized(env, request, url)) return new Response("нет", { status: 401 });
      return await handleHeartbeat(env, request);
    }

    // Разовая настройка: привязать вебхук к этому адресу и задать меню команд
    if (url.pathname === "/setup") {
      if (!authorized(env, request, url)) return new Response("нет", { status: 401 });
      const webhook = await api(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message"],
        drop_pending_updates: false,
      });
      const menu = await api(env, "setMyCommands", { commands: COMMANDS });
      return Response.json({ webhook: await webhook.json(), commands: await menu.json() });
    }

    if (url.pathname === "/trigger" && authorized(env, request, url)) {
      return Response.json(await triggerCheck(env));
    }

    if (url.pathname === "/keys" && authorized(env, request, url)) {
      const listed = await env.SUBS.list();
      const names = listed.keys.map((key) => key.name);
      if (!url.searchParams.has("values")) return Response.json({ keys: names });

      const dump = {};
      for (const name of names) dump[name] = await env.SUBS.get(name);
      return Response.json({ keys: names.length, values: dump });
    }

    // Диагностика настройки: только факт наличия, без значений
    if (url.pathname === "/health") {
      return Response.json({
        last_check: env.SUBS ? await env.SUBS.get("last_check") : null,
        fails: env.SUBS ? Number(await env.SUBS.get("fails") || 0) : null,
        kv_binding_SUBS: Boolean(env.SUBS),
        BOT_TOKEN: Boolean(env.BOT_TOKEN),
        WEBHOOK_SECRET: Boolean(env.WEBHOOK_SECRET),
        BROADCAST_SECRET: Boolean(env.BROADCAST_SECRET),
        GH_TOKEN: Boolean(env.GH_TOKEN),
        GH_REPO: env.GH_REPO || null,
        OWNER_CHAT_ID: env.OWNER_CHAT_ID || null,
      });
    }

    if (url.pathname === "/") {
      if (!env.SUBS) {
        return new Response(
          "Не привязано хранилище KV: Settings → Bindings → KV namespace, " +
          "Variable name должен быть SUBS. Подробности: /health\n",
          { status: 500 },
        );
      }
      const people = (await subscribers(env)).length;
      const watches = (await allWatches(env)).length;
      const last = await env.SUBS.get("last_check");
      return new Response(
        `Вотчер записи на talon.by жив. Подписчиков: ${people}, слежек: ${watches}\n` +
        `Последняя проверка: ${last || "—"}\n`,
      );
    }

    return new Response("не найдено", { status: 404 });
  },

  // расписание Cloudflare: просто просим GitHub запустить проверку
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      triggerCheck(env).then((result) => console.log("cron →", JSON.stringify(result))),
    );
  },
};
