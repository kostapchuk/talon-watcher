#!/usr/bin/env python3
"""
Слежка за записью к врачам на talon.by.

Обходит карточки врачей, за которыми следят подписчики (список забирает
у бота на Cloudflare Workers), и сообщает, когда кнопка «Записаться на
платный приём» становится кликабельной — и когда снова гаснет.

Зависимостей нет — только стандартная библиотека.
"""

import argparse
import calendar
import html
import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(BASE_DIR, "state.json")
LOG_FILE = os.path.join(BASE_DIR, "watcher.log")

SITE = "https://talon.by"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
BOT_USER_AGENT = "talon-watcher/1.0 (+https://github.com/kostapchuk/talon-watcher)"

# Карточка врача: /policlinic/<учреждение>/doctors/<id>
DOCTOR_URL_RE = re.compile(
    r"^https?://(?:www\.)?talon\.by/policlinic/([a-z0-9_-]+)/doctors/(\d+)/?$", re.I)

# «приём» на сайте пишут и через «е» — принимаем оба написания
PAID_LABEL = r"Записаться\s+на\s+платный\s+при[её]м"
# кликабельная кнопка: <a href="..." class="button">Записаться на платный приём</a>
OPEN_RE = re.compile(
    r'<a\s[^>]*href="([^"]+)"[^>]*class="[^"]*\bbutton\b[^"]*"[^>]*>\s*' + PAID_LABEL, re.I)
# закрытая: <span class="button notAvailable">Записаться на платный приём</span>
CLOSED_RE = re.compile(
    r'<span\s[^>]*class="[^"]*\bnotAvailable\b[^"]*"[^>]*>\s*' + PAID_LABEL, re.I)

PAID = "paid"  # вид слежки; для бесплатных талонов будет свой
MISSES_BEFORE_CLOSED = 2  # сколько обходов подряд кнопка гаснет, чтобы счесть запись закрытой
MAX_MESSAGES_PER_CALL = 20  # у Cloudflare на бесплатном тарифе 50 подзапросов на запрос

log = logging.getLogger("talon-watcher")


# --------------------------------------------------------------------------- #
# config
# --------------------------------------------------------------------------- #

def load_dotenv(path):
    """Простой парсер .env — чтобы не тащить python-dotenv."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def setup_logging(verbose):
    handlers = [logging.FileHandler(LOG_FILE, encoding="utf-8")]
    if verbose or sys.stdout.isatty():
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-7s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        handlers=handlers,
    )


# --------------------------------------------------------------------------- #
# fetch + parse
# --------------------------------------------------------------------------- #

def normalize_url(raw):
    """
    Ссылка на карточку врача в каноническом виде. None — если это не она.
    Точно такая же проверка есть в боте (bot/worker.js): он отсеивает мусор
    ещё при добавлении, сюда ссылка приходит уже приведённой.
    """
    raw = (raw or "").strip().split("?")[0].split("#")[0]
    found = DOCTOR_URL_RE.match(raw)
    if not found:
        return None
    return f"{SITE}/policlinic/{found.group(1).lower()}/doctors/{found.group(2)}"


def fetch(url, timeout=45):
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "ru-RU,ru;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def clean(text):
    return html.unescape(re.sub(r"<[^>]+>", " ", text or "")).replace("\xa0", " ").strip()


def parse_doctor(page_html):
    """
    Состояние карточки врача.

    Кнопка бывает в трёх видах: ссылка (запись открыта), серая заглушка
    (закрыта) и её отсутствие — у врача просто нет платного приёма. Последнее
    от закрытой записи отличаем: молча ждать открытия, которого не будет, —
    худшее, что может сделать вотчер.
    """
    header = re.search(r'(?s)<div\s+id="doctor_header".{0,4000}', page_html)
    block = header.group(0) if header else ""
    name = re.search(r"(?s)<h3[^>]*>(.*?)</h3>", block)
    speciality = re.search(r'(?s)<p[^>]*class="[^"]*\bgrey\b[^"]*"[^>]*>(.*?)</p>', block)
    title = re.search(r"(?s)<title>(.*?)</title>", page_html)

    if not name:
        raise RuntimeError("не узнал разметку страницы: нет карточки врача")

    open_button = OPEN_RE.search(page_html)
    has_button = bool(open_button or CLOSED_RE.search(page_html))

    return {
        "doctor": clean(name.group(1)),
        "speciality": clean(speciality.group(1)) if speciality else "",
        # в <title> после длинного тире стоит название учреждения
        "clinic": clean(title.group(1)).split("–")[-1].strip() if title else "",
        "available": bool(open_button),
        "booking_url": urllib.parse.urljoin(SITE, open_button.group(1)) if open_button else "",
        "has_button": has_button,
    }


def scrape(url):
    """Карточка врача целиком. Бросает исключение, если страница недоступна."""
    try:
        page = fetch(url)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"страница ответила {exc.code}") from None
    except Exception as exc:
        raise RuntimeError(f"не открылась: {exc}") from None
    return parse_doctor(page)


# --------------------------------------------------------------------------- #
# сообщения
# --------------------------------------------------------------------------- #

def esc(value):
    return html.escape(str(value or ""))


def label(watch):
    """Как называть слежку в сообщении: алиас человека или имя врача."""
    return watch.get("alias") or watch.get("doctor") or "приём"


def format_open(info, url, alias, first_seen=False):
    head = "🎉 <b>Открылась запись</b>" if not first_seen else "✅ <b>Запись открыта</b>"
    lines = [f"{head}{f' · «{esc(alias)}»' if alias else ''}", ""]
    lines.append(f"<b>{esc(info.get('doctor'))}</b>")
    if info.get("speciality"):
        lines.append(esc(info["speciality"]))
    if info.get("clinic"):
        lines.append(esc(info["clinic"]))
    lines.append("")
    if info.get("booking_url"):
        lines.append(f'👉 <a href="{esc(info["booking_url"])}">Записаться на платный приём</a>')
    lines.append(f'<a href="{esc(url)}">Карточка врача</a>')
    return "\n".join(lines)


def format_closed(info, url, alias):
    lines = [f"🔕 <b>Запись закрылась</b>{f' · «{esc(alias)}»' if alias else ''}", ""]
    lines.append(esc(info.get("doctor")))
    if info.get("speciality"):
        lines.append(esc(info["speciality"]))
    lines.append("")
    lines.append(f'Слежу дальше — напишу, когда откроется снова.\n'
                 f'<a href="{esc(url)}">Карточка врача</a>')
    return "\n".join(lines)


def format_no_button(info, url, alias):
    lines = [f"⚠️ <b>Платного приёма нет</b>{f' · «{esc(alias)}»' if alias else ''}", ""]
    lines.append(esc(info.get("doctor")))
    lines.append("")
    lines.append("На странице врача нет кнопки платной записи — следить не за чем. "
                 "Похоже, приём ведётся только по бесплатным талонам.")
    lines.append(f'<a href="{esc(url)}">Карточка врача</a>')
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# обмен с ботом
# --------------------------------------------------------------------------- #

def bot_configured():
    return bool(os.environ.get("BOT_URL", "").strip()
                and os.environ.get("BROADCAST_SECRET", "").strip())


def bot_call(path, payload):
    """POST боту на Cloudflare Workers. None — если бот не настроен."""
    base = os.environ.get("BOT_URL", "").strip().rstrip("/")
    secret = os.environ.get("BROADCAST_SECRET", "").strip()
    if not base or not secret:
        return None

    req = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {secret}",
            # без своего User-Agent Cloudflare режет запрос по сигнатуре
            # клиента (ошибка 1010) — до воркера он даже не доходит
            "user-agent": BOT_USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")[:300]
        raise RuntimeError(f"бот ответил {exc.code} на {path}: {body}") from None


def bot_get(path):
    """GET у бота (список слежек). None — если бот не настроен."""
    base = os.environ.get("BOT_URL", "").strip().rstrip("/")
    secret = os.environ.get("BROADCAST_SECRET", "").strip()
    if not base or not secret:
        return None
    req = urllib.request.Request(f"{base}{path}?key={urllib.parse.quote(secret)}",
                                 headers={"user-agent": BOT_USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")[:200]
        raise RuntimeError(f"бот ответил {exc.code} на {path}: {body}") from None


def telegram_send(text, chat_id):
    """Запасной путь: напрямую в Telegram, когда бот не настроен."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    if not token:
        raise RuntimeError("не задан ни BOT_URL, ни TELEGRAM_BOT_TOKEN (см. .env)")
    data = urllib.parse.urlencode({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": "true",
    }).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage", data=data)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def notify(messages):
    """
    Отдаём боту готовые сообщения — [{chat_id, text}]. Он их разошлёт и сам
    отпишет тех, кто заблокировал бота.
    """
    if not messages:
        return
    if not bot_configured():
        chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
        if not chat_id:
            raise RuntimeError("не настроен ни BOT_URL, ни TELEGRAM_CHAT_ID")
        log.info("бот не настроен — шлю напрямую в чат %s", chat_id)
        for message in messages:
            telegram_send(message["text"], chat_id)
        return

    for start in range(0, len(messages), MAX_MESSAGES_PER_CALL):
        batch = messages[start:start + MAX_MESSAGES_PER_CALL]
        result = bot_call("/notify", {"messages": batch})
        log.info("  отправлено %s, не доставлено %s, отписано %s",
                 result.get("delivered"), result.get("failed"), result.get("dropped"))


def heartbeat(summary):
    """
    Отчёт владельцу о прошедшей проверке.
    HEARTBEAT: off — молчим, edit — переписываем одно сообщение, every — новое.
    """
    mode = os.environ.get("HEARTBEAT", "edit").strip().lower()
    if mode == "off":
        return

    # в отчёте человеку — местное время; в state.json остаётся UTC,
    # чтобы машинам было однозначно
    offset = int(os.environ.get("REPORT_UTC_OFFSET", "3"))
    stamp = time.strftime("%H:%M", time.gmtime(time.time() + offset * 3600))
    text = f"✅ <b>Проверка пройдена</b> · {stamp}\n{summary}"
    try:
        if bot_configured():
            bot_call("/heartbeat", {"text": text, "mode": mode})
        else:
            chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
            if chat_id:
                telegram_send(text, chat_id)
    except Exception as exc:  # отчёт не должен ронять проверку
        log.warning("не удалось отправить отчёт о проверке: %s", exc)


# --------------------------------------------------------------------------- #
# state
# --------------------------------------------------------------------------- #

def load_state():
    """
    Состояние: по ссылке на врача — что мы видели в прошлый раз.
    Ключ — сама ссылка: она уже канонична и одна на всех, кто за врачом следит.
    """
    if not os.path.exists(STATE_FILE):
        return {"doctors": {}, "fails": 0, "updated_utc": None}
    with open(STATE_FILE, encoding="utf-8") as fh:
        state = json.load(fh)
    state.setdefault("doctors", {})
    state.setdefault("fails", 0)
    return state


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_FILE)


def utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def collect_jobs():
    """
    Что обходить: ссылка → список следящих за ней слежек.
    Одну и ту же страницу несколько человек могут смотреть под разными
    названиями — качаем её один раз, сообщения потом у каждого свои.
    """
    info = bot_get("/watches") if bot_configured() else None
    if info is None:
        # локальный прогон без бота: следим за тем, что задано в .env
        chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
        jobs = {}
        for raw in os.environ.get("WATCH_URLS", "").split(","):
            url = normalize_url(raw)
            if url:
                jobs.setdefault(url, []).append({"chat_id": chat_id, "alias": "", "kind": PAID})
        return jobs

    jobs = {}
    for watch in info.get("watches", []):
        url = normalize_url(watch.get("url"))
        if not url:
            log.warning("пропускаю непонятную ссылку: %s", watch.get("url"))
            continue
        if watch.get("kind", PAID) != PAID:
            continue  # бесплатные талоны — следующий шаг, у них своя разметка
        jobs.setdefault(url, []).append({
            "chat_id": str(watch.get("chat_id")),
            "alias": watch.get("alias") or "",
            "kind": PAID,
        })
    return jobs


def run(args):
    state = load_state()
    known = state["doctors"]

    try:
        jobs = collect_jobs()
    except Exception as exc:
        log.error("не смог забрать список слежек у бота: %s", exc)
        return 1

    if not jobs:
        log.info("следить не за чем — подписок нет")
        state["updated_utc"] = utc_now()
        state["doctors"] = {}
        state["fails"] = 0
        if not args.dry_run:
            save_state(state)
            heartbeat("Слежек нет.")
        return 0

    log.info("страниц к обходу: %d", len(jobs))

    fresh, messages, failures = {}, [], []
    opened = closed = 0

    for url, watchers in jobs.items():
        previous = known.get(url, {})
        try:
            info = scrape(url)
        except Exception as exc:
            log.error("%s: %s", url, exc)
            failures.append(url)
            if previous:  # состояние не трогаем, иначе после сбоя всё покажется новым
                fresh[url] = previous
            continue

        first_seen = "available" not in previous
        was_open = bool(previous.get("available"))
        misses = int(previous.get("misses", 0))

        if info["available"]:
            misses = 0
            available = True
        else:
            # Мигание выдачи — обычное дело: одна пропажа кнопки ещё не значит,
            # что запись закрыли. Открытие сообщаем сразу, закрытие — только
            # подтверждённое, иначе человек получит «закрылась/открылась» подряд.
            misses += 1
            available = was_open and misses < MISSES_BEFORE_CLOSED

        unchanged = available == was_open and not first_seen
        fresh[url] = {
            "kind": PAID,
            "available": available,
            # пока закрытие не подтверждено, держим прошлую ссылку на запись:
            # в /list у бота она ещё считается рабочей
            "booking_url": info["booking_url"] or (previous.get("booking_url", "")
                                                   if available else ""),
            "doctor": info["doctor"],
            "speciality": info["speciality"],
            "clinic": info["clinic"],
            "has_button": info["has_button"],
            "misses": misses,
            "checked_utc": utc_now(),
            "changed_utc": previous.get("changed_utc") if unchanged else utc_now(),
        }

        log.info("%s — %s%s", info["doctor"] or url,
                 "запись открыта" if available else "записи нет",
                 "" if info["has_button"] else " (кнопки платного приёма вообще нет)")

        if args.init:
            continue

        # Сообщаем только о переходах: открылось то, чего не было, или наоборот.
        if available and not was_open:
            opened += 1
            for watcher in watchers:
                messages.append({
                    "chat_id": watcher["chat_id"],
                    "text": format_open(info, url, watcher["alias"], first_seen=first_seen),
                })
        elif was_open and not available:
            closed += 1
            for watcher in watchers:
                messages.append({
                    "chat_id": watcher["chat_id"],
                    "text": format_closed(info, url, watcher["alias"]),
                })

        # Кнопки платного приёма нет вовсе — говорим один раз, при первой встрече:
        # ждать открытия тут бессмысленно, пусть человек решает, что делать.
        if first_seen and not info["has_button"]:
            for watcher in watchers:
                messages.append({
                    "chat_id": watcher["chat_id"],
                    "text": format_no_button(info, url, watcher["alias"]),
                })

    if failures and len(failures) == len(jobs):
        state["fails"] = state.get("fails", 0) + 1
        state["doctors"] = fresh
        if not args.dry_run:
            save_state(state)
        log.error("ни одна страница не открылась (%d раз подряд)", state["fails"])
        if state["fails"] in (3, 30) and not args.dry_run:
            owner = os.environ.get("OWNER_CHAT_ID", "").strip()
            if owner:
                try:
                    notify([{"chat_id": owner,
                             "text": "⚠️ Вотчер не может открыть talon.by "
                                     f"({state['fails']} раза подряд). Посмотри логи."}])
                except Exception as exc:
                    log.error("и в Telegram не ушло: %s", exc)
        return 1

    if args.dry_run:
        for message in messages:
            print(f"\n=== чат {message['chat_id']}\n{message['text']}")
    elif messages:
        notify(messages)

    # За кем больше не следят — забываем: вернут ссылку обратно, и первая
    # проверка честно покажет текущее состояние.
    state["doctors"] = fresh
    state["fails"] = 0
    state["updated_utc"] = utc_now()

    if not args.dry_run:
        if not args.init:
            heartbeat(f"Слежек: {sum(len(w) for w in jobs.values())} · страниц: {len(jobs)} · "
                      f"открылось: {opened} · закрылось: {closed}" +
                      (f"\n⚠️ не открылись: {len(failures)}" if failures else ""))
        save_state(state)
    return 0


def main():
    parser = argparse.ArgumentParser(description="Вотчер записи к врачам talon.by → Telegram")
    parser.add_argument("--init", action="store_true",
                        help="запомнить текущее состояние, ничего не отправляя")
    parser.add_argument("--dry-run", action="store_true",
                        help="печатать сообщения в консоль вместо Telegram")
    parser.add_argument("--ping", action="store_true",
                        help="проверить связку с ботом: тестовое сообщение владельцу и выход")
    parser.add_argument("--watches", action="store_true",
                        help="показать слежки, которые придут из бота, и выйти")
    parser.add_argument("--once", metavar="URL",
                        help="проверить одну ссылку и выйти (ничего не отправляя)")
    parser.add_argument("--if-stale", type=int, metavar="МИНУТ", default=0,
                        help="работать, только если последняя проверка старше этого срока")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    load_dotenv(os.path.join(BASE_DIR, ".env"))
    setup_logging(args.verbose)

    if args.once:
        url = normalize_url(args.once)
        if not url:
            print("это не ссылка на карточку врача talon.by")
            return 2
        info = scrape(url)
        print(f"{info['doctor']} — {info['speciality']}")
        print(f"{info['clinic']}")
        print("запись открыта" if info["available"]
              else ("записи нет" if info["has_button"] else "кнопки платного приёма нет"))
        if info["booking_url"]:
            print(info["booking_url"])
        return 0

    if args.ping:
        owner = os.environ.get("OWNER_CHAT_ID", "").strip() \
            or os.environ.get("TELEGRAM_CHAT_ID", "").strip()
        if not owner:
            print("не задан OWNER_CHAT_ID")
            return 2
        notify([{"chat_id": owner,
                 "text": "🧪 Проверка связи: GitHub Actions → бот → Telegram.\n"
                         "Если это сообщение пришло, рассылка настроена верно."}])
        print("Отправлено " + ("через бота." if bot_configured() else "напрямую."))
        return 0

    if args.if_stale:
        # когда проверка отчитывалась в последний раз, знает бот: в состоянии
        # отметка обновляется не при каждом запуске и для этого не годится
        last = None
        if bot_configured():
            try:
                last = (bot_get("/health") or {}).get("last_check")
                if last:
                    last = last[:19] + "Z"  # ISO из JS с миллисекундами
            except Exception as exc:
                log.warning("не спросил бота о последней проверке: %s", exc)
        if last:
            age = time.time() - calendar.timegm(time.strptime(last, "%Y-%m-%dT%H:%M:%SZ"))
            if age < args.if_stale * 60:
                log.info("проверка была %d мин назад — уступаю основному расписанию", age // 60)
                return 0
            log.info("последняя проверка %d мин назад — работаю сам", age // 60)

    if args.watches:
        for url, watchers in collect_jobs().items():
            who = ", ".join(w["chat_id"] + (" (" + w["alias"] + ")" if w["alias"] else "")
                            for w in watchers)
            print(f"{url}  ←  {who}")
        return 0

    return run(args)


if __name__ == "__main__":
    sys.exit(main())
