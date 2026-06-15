import base64
import hashlib
import hmac
import json
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional
from uuid import uuid4


DEFAULT_PLANS = [
    {
        "id": "basic_30",
        "name": "30 dias",
        "price": 29.90,
        "days": 30,
        "max_screens": 1,
        "allow_adult_content": False,
    },
    {
        "id": "family_30",
        "name": "30 dias - 2 telas",
        "price": 39.90,
        "days": 30,
        "max_screens": 2,
        "allow_adult_content": False,
    },
]

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def env_required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Configure {name}")
    return value


def json_request(
    url: str,
    payload: Optional[Dict] = None,
    headers: Optional[Dict[str, str]] = None,
    method: Optional[str] = None,
    timeout: float = 30,
) -> Dict:
    body = None
    request_headers = {"Accept": "application/json", **(headers or {})}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            if not raw:
                return {}
            return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} from {url}: {details[:500]}") from exc


def load_plans() -> List[Dict]:
    raw = os.getenv("PLANS_JSON", "").strip()
    plans = json.loads(raw) if raw else DEFAULT_PLANS
    normalized = []
    for plan in plans:
        normalized.append(
            {
                "id": str(plan["id"]),
                "name": str(plan["name"]),
                "price": float(plan["price"]),
                "days": int(plan["days"]),
                "max_screens": int(plan.get("max_screens") or 1),
                "allow_adult_content": bool(plan.get("allow_adult_content", False)),
                "catalog_access_mode": str(plan.get("catalog_access_mode") or "full"),
                "catalog_allowed_terms": list(plan.get("catalog_allowed_terms") or []),
                "catalog_featured_sections": list(plan.get("catalog_featured_sections") or []),
            }
        )
    return normalized


def normalize_email(value: str) -> str:
    return str(value or "").strip().lower()


def is_valid_email(value: str) -> bool:
    return bool(EMAIL_RE.match(normalize_email(value)))


class PaymentStore:
    def __init__(self, path: str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self._init_db()

    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=30, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = NORMAL")
        return connection

    def _init_db(self) -> None:
        with self.lock, self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS orders (
                    id TEXT PRIMARY KEY,
                    telegram_user_id TEXT NOT NULL,
                    telegram_chat_id TEXT NOT NULL,
                    telegram_username TEXT NOT NULL DEFAULT '',
                    plan_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    payment_id TEXT NOT NULL DEFAULT '',
                    amount REAL NOT NULL,
                    qr_code TEXT NOT NULL DEFAULT '',
                    access_url TEXT NOT NULL DEFAULT '',
                    error TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    approved_at REAL NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS processed_events (
                    event_key TEXT PRIMARY KEY,
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS telegram_customers (
                    telegram_user_id TEXT PRIMARY KEY,
                    telegram_chat_id TEXT NOT NULL,
                    telegram_username TEXT NOT NULL DEFAULT '',
                    payer_email TEXT NOT NULL,
                    pending_plan_id TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_orders_payment_id ON orders(payment_id);
                CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(telegram_user_id, status);
                CREATE INDEX IF NOT EXISTS idx_orders_user_plan_status ON orders(telegram_user_id, plan_id, status);
                """
            )
            columns = {row["name"] for row in db.execute("PRAGMA table_info(orders)").fetchall()}
            if "payer_email" not in columns:
                db.execute("ALTER TABLE orders ADD COLUMN payer_email TEXT NOT NULL DEFAULT ''")
            customer_columns = {row["name"] for row in db.execute("PRAGMA table_info(telegram_customers)").fetchall()}
            if "pending_plan_id" not in customer_columns:
                db.execute("ALTER TABLE telegram_customers ADD COLUMN pending_plan_id TEXT NOT NULL DEFAULT ''")

    def customer_email(self, telegram_user_id: str) -> str:
        customer = self.customer(telegram_user_id)
        return str(customer.get("payer_email") or "") if customer else ""

    def customer(self, telegram_user_id: str) -> Optional[Dict]:
        if not telegram_user_id:
            return None
        with self.lock, self._connect() as db:
            row = db.execute(
                "SELECT * FROM telegram_customers WHERE telegram_user_id = ?",
                (telegram_user_id,),
            ).fetchone()
        return dict(row) if row else None

    def save_customer_email(self, telegram_user: Dict, chat_id: str, payer_email: str) -> str:
        telegram_user_id = str(telegram_user.get("id") or "")
        payer_email = normalize_email(payer_email)
        if not telegram_user_id:
            raise ValueError("Usuario do Telegram invalido")
        if not is_valid_email(payer_email):
            raise ValueError("E-mail invalido")
        now = time.time()
        payload = {
            "telegram_user_id": telegram_user_id,
            "telegram_chat_id": str(chat_id),
            "telegram_username": str(telegram_user.get("username") or ""),
            "payer_email": payer_email,
            "pending_plan_id": "",
            "created_at": now,
            "updated_at": now,
        }
        with self.lock, self._connect() as db:
            db.execute(
                """
                INSERT INTO telegram_customers (
                    telegram_user_id, telegram_chat_id, telegram_username, payer_email, pending_plan_id, created_at, updated_at
                ) VALUES (
                    :telegram_user_id, :telegram_chat_id, :telegram_username, :payer_email, :pending_plan_id, :created_at, :updated_at
                )
                ON CONFLICT(telegram_user_id) DO UPDATE SET
                    telegram_chat_id = excluded.telegram_chat_id,
                    telegram_username = excluded.telegram_username,
                    payer_email = excluded.payer_email,
                    updated_at = excluded.updated_at
                """,
                payload,
            )
        return payer_email

    def save_pending_plan(self, telegram_user: Dict, chat_id: str, plan_id: str) -> None:
        telegram_user_id = str(telegram_user.get("id") or "")
        if not telegram_user_id:
            return
        now = time.time()
        payload = {
            "telegram_user_id": telegram_user_id,
            "telegram_chat_id": str(chat_id),
            "telegram_username": str(telegram_user.get("username") or ""),
            "pending_plan_id": str(plan_id or ""),
            "created_at": now,
            "updated_at": now,
        }
        with self.lock, self._connect() as db:
            db.execute(
                """
                INSERT INTO telegram_customers (
                    telegram_user_id, telegram_chat_id, telegram_username, payer_email, pending_plan_id, created_at, updated_at
                ) VALUES (
                    :telegram_user_id, :telegram_chat_id, :telegram_username, '', :pending_plan_id, :created_at, :updated_at
                )
                ON CONFLICT(telegram_user_id) DO UPDATE SET
                    telegram_chat_id = excluded.telegram_chat_id,
                    telegram_username = excluded.telegram_username,
                    pending_plan_id = excluded.pending_plan_id,
                    updated_at = excluded.updated_at
                """,
                payload,
            )

    def clear_pending_plan(self, telegram_user_id: str) -> None:
        if not telegram_user_id:
            return
        with self.lock, self._connect() as db:
            db.execute(
                "UPDATE telegram_customers SET pending_plan_id = '', updated_at = ? WHERE telegram_user_id = ?",
                (time.time(), str(telegram_user_id)),
            )

    def reset_purchase_context(self, telegram_user_id: str) -> None:
        if not telegram_user_id:
            return
        with self.lock, self._connect() as db:
            db.execute(
                "UPDATE telegram_customers SET payer_email = '', pending_plan_id = '', updated_at = ? WHERE telegram_user_id = ?",
                (time.time(), str(telegram_user_id)),
            )

    def create_order(self, telegram_user: Dict, chat_id: str, plan: Dict, payer_email: str) -> Dict:
        now = time.time()
        order = {
            "id": uuid4().hex,
            "telegram_user_id": str(telegram_user.get("id") or ""),
            "telegram_chat_id": str(chat_id),
            "telegram_username": str(telegram_user.get("username") or ""),
            "payer_email": normalize_email(payer_email),
            "plan_id": plan["id"],
            "status": "created",
            "payment_id": "",
            "amount": plan["price"],
            "qr_code": "",
            "access_url": "",
            "error": "",
            "created_at": now,
            "updated_at": now,
            "approved_at": 0,
        }
        with self.lock, self._connect() as db:
            db.execute(
                """
                INSERT INTO orders (
                    id, telegram_user_id, telegram_chat_id, telegram_username, payer_email, plan_id,
                    status, payment_id, amount, qr_code, access_url, error, created_at, updated_at, approved_at
                ) VALUES (
                    :id, :telegram_user_id, :telegram_chat_id, :telegram_username, :payer_email, :plan_id,
                    :status, :payment_id, :amount, :qr_code, :access_url, :error, :created_at, :updated_at, :approved_at
                )
                """,
                order,
            )
        return order

    def update_order(self, order_id: str, **updates) -> Dict:
        updates["updated_at"] = time.time()
        assignments = ", ".join(f"{key} = :{key}" for key in updates)
        payload = {"id": order_id, **updates}
        with self.lock, self._connect() as db:
            db.execute(f"UPDATE orders SET {assignments} WHERE id = :id", payload)
            row = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
        if row is None:
            raise RuntimeError("Pedido nao encontrado")
        return dict(row)

    def order_by_payment(self, payment_id: str) -> Optional[Dict]:
        with self.lock, self._connect() as db:
            row = db.execute("SELECT * FROM orders WHERE payment_id = ?", (payment_id,)).fetchone()
        return dict(row) if row else None

    def mark_event_seen(self, event_key: str) -> bool:
        with self.lock, self._connect() as db:
            try:
                db.execute("INSERT INTO processed_events (event_key, created_at) VALUES (?, ?)", (event_key, time.time()))
                return True
            except sqlite3.IntegrityError:
                return False

    def claim_order_for_access(self, order_id: str) -> bool:
        with self.lock, self._connect() as db:
            cursor = db.execute(
                """
                UPDATE orders
                SET status = ?, updated_at = ?
                WHERE id = ? AND status NOT IN (?, ?)
                """,
                ("issuing_access", time.time(), order_id, "issuing_access", "approved"),
            )
            return cursor.rowcount == 1


class TelegramClient:
    def __init__(self, token: str) -> None:
        self.base_url = f"https://api.telegram.org/bot{token}"

    def api(self, method: str, payload: Dict) -> Dict:
        return json_request(f"{self.base_url}/{method}", payload=payload, timeout=45)

    def send_message(self, chat_id: str, text: str, reply_markup: Optional[Dict] = None) -> None:
        payload = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup
        self.api("sendMessage", payload)

    def answer_callback_query(self, callback_id: str, text: str = "") -> None:
        if not callback_id:
            return
        payload = {"callback_query_id": callback_id}
        if text:
            payload["text"] = text
        try:
            self.api("answerCallbackQuery", payload)
        except Exception:
            pass

    def remove_message_reply_markup(self, chat_id: str, message_id) -> None:
        if not chat_id or not message_id:
            return
        try:
            self.api(
                "editMessageReplyMarkup",
                {
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "reply_markup": {"inline_keyboard": []},
                },
            )
        except Exception:
            pass

    def send_video(self, chat_id: str, video_path: str, caption: str = "") -> bool:
        if not video_path:
            return False
        path = Path(video_path)
        if not path.is_file():
            return False
        try:
            boundary = f"----stream-m3u8-{uuid4().hex}"
            fields = [
                (b"chat_id", str(chat_id).encode("utf-8")),
                (b"supports_streaming", b"true"),
            ]
            if caption:
                fields.append((b"caption", caption.encode("utf-8")))

            body = bytearray()
            for key, value in fields:
                body.extend(f"--{boundary}\r\n".encode("utf-8"))
                body.extend(b'Content-Disposition: form-data; name="' + key + b'"\r\n\r\n')
                body.extend(value + b"\r\n")
            body.extend(f"--{boundary}\r\n".encode("utf-8"))
            body.extend(b'Content-Disposition: form-data; name="video"; filename="' + path.name.encode("utf-8") + b'"\r\n')
            body.extend(b"Content-Type: video/mp4\r\n\r\n")
            body.extend(path.read_bytes() + b"\r\n")
            body.extend(f"--{boundary}--\r\n".encode("utf-8"))

            request = urllib.request.Request(
                f"{self.base_url}/sendVideo",
                data=bytes(body),
                headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            )
            urllib.request.urlopen(request, timeout=60).read()
            return True
        except Exception:
            return False

    def send_pix_qr(self, chat_id: str, qr_code: str, qr_code_base64: str = "") -> None:
        if qr_code_base64:
            try:
                image = base64.b64decode(qr_code_base64)
                boundary = f"----stream-m3u8-{uuid4().hex}"
                fields = [
                    (b"chat_id", str(chat_id).encode("utf-8")),
                    (b"caption", b"QR Code Pix"),
                ]
                body = bytearray()
                for key, value in fields:
                    body.extend(f"--{boundary}\r\n".encode("utf-8"))
                    body.extend(b'Content-Disposition: form-data; name="' + key + b'"\r\n\r\n')
                    body.extend(value + b"\r\n")
                body.extend(f"--{boundary}\r\n".encode("utf-8"))
                body.extend(b'Content-Disposition: form-data; name="photo"; filename="pix.png"\r\n')
                body.extend(b"Content-Type: image/png\r\n\r\n")
                body.extend(image + b"\r\n")
                body.extend(f"--{boundary}--\r\n".encode("utf-8"))
                request = urllib.request.Request(
                    f"{self.base_url}/sendPhoto",
                    data=bytes(body),
                    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
                )
                urllib.request.urlopen(request, timeout=30).read()
            except Exception:
                pass
        self.send_message(chat_id, "Pix copia e cola:")
        self.send_message(chat_id, qr_code)


class MercadoPagoClient:
    def __init__(self, access_token: str, notification_url: str = "") -> None:
        self.access_token = access_token
        self.notification_url = notification_url

    def create_pix_payment(self, order: Dict, plan: Dict, payer_email: str) -> Dict:
        payload = {
            "transaction_amount": round(float(plan["price"]), 2),
            "description": f"Stream M3U8 - {plan['name']}",
            "payment_method_id": "pix",
            "external_reference": order["id"],
            "payer": {"email": payer_email},
        }
        if self.notification_url:
            payload["notification_url"] = self.notification_url
        return json_request(
            "https://api.mercadopago.com/v1/payments",
            payload=payload,
            headers={
                "Authorization": f"Bearer {self.access_token}",
                "X-Idempotency-Key": order["id"],
            },
        )

    def get_payment(self, payment_id: str) -> Dict:
        return json_request(
            f"https://api.mercadopago.com/v1/payments/{urllib.parse.quote(payment_id, safe='')}",
            headers={"Authorization": f"Bearer {self.access_token}"},
            method="GET",
        )


class BotApp:
    def __init__(self) -> None:
        self.telegram = TelegramClient(env_required("TELEGRAM_BOT_TOKEN"))
        self.store = PaymentStore(os.getenv("BOT_DB_PATH", "/app/bot-data/orders.sqlite3"))
        self.plans = {plan["id"]: plan for plan in load_plans()}
        public_base = os.getenv("BOT_PUBLIC_BASE_URL", "").rstrip("/")
        webhook_secret = os.getenv("MERCADO_PAGO_WEBHOOK_SECRET", "").strip()
        notification_url = f"{public_base}/webhooks/mercadopago" if public_base else ""
        self.mercado_pago = MercadoPagoClient(env_required("MERCADO_PAGO_ACCESS_TOKEN"), notification_url=notification_url)
        self.app_internal_base_url = os.getenv("APP_INTERNAL_BASE_URL", "http://stream-m3u8:8000").rstrip("/")
        self.app_public_base_url = os.getenv("APP_PUBLIC_BASE_URL", "").rstrip("/")
        self.admin_token = env_required("AUTH_ADMIN_TOKEN")
        self.webhook_secret = webhook_secret
        self.demo_video_path = os.getenv("BOT_DEMO_VIDEO_PATH", "/app/bot/assets/demo.mp4").strip()
        self.polling_offset = 0

    def plan_keyboard(self) -> Dict:
        return {
            "inline_keyboard": [
                [
                    {
                        "text": "Me envie um Demo",
                        "callback_data": "demo:video",
                    }
                ],
            ]
            + [
                [
                    {
                        "text": self.plan_label(plan),
                        "callback_data": f"plan:{plan['id']}",
                    }
                ]
                for plan in self.plans.values()
            ]
        }

    def plan_label(self, plan: Dict) -> str:
        if float(plan["price"]) <= 0:
            return f"{plan['name']} - Gratuito"
        return f"{plan['name']} - R$ {plan['price']:.2f}".replace(".", ",")

    def demo_keyboard(self) -> Dict:
        return {"inline_keyboard": [[{"text": "Me envie um Demo", "callback_data": "demo:video"}]]}

    def ask_for_email(self, chat_id: str) -> None:
        self.telegram.send_message(
            chat_id,
            "Agora envie seu e-mail para cadastro.\n\nEle sera usado para gerar o cadastro no app.",
        )

    def send_plan_intro(self, chat_id: str) -> None:
        self.telegram.send_message(
            chat_id,
            "Escolha um plano para continuar.",
            reply_markup=self.plan_keyboard(),
        )

    def send_plan_options(self, chat_id: str, payer_email: str) -> None:
        self.telegram.send_message(
            chat_id,
            f"E-mail cadastrado: <b>{payer_email}</b>\n\nEscolha um plano.",
            reply_markup=self.plan_keyboard(),
        )

    def start_purchase_flow(self, chat_id: str, telegram_user_id: str) -> None:
        self.store.reset_purchase_context(telegram_user_id)
        self.send_plan_intro(chat_id)

    def handle_update(self, update: Dict) -> None:
        if "message" in update:
            message = update["message"]
            text = str(message.get("text") or "")
            chat_id = str(message.get("chat", {}).get("id") or "")
            telegram_user = message.get("from") or {}
            telegram_user_id = str(telegram_user.get("id") or "")
            if text.startswith("/start") or text.startswith("/planos"):
                self.start_purchase_flow(chat_id, telegram_user_id)
                return
            if is_valid_email(text):
                customer = self.store.customer(telegram_user_id) or {}
                pending_plan_id = str(customer.get("pending_plan_id") or "")
                if not pending_plan_id:
                    self.telegram.send_message(
                        chat_id,
                        "Escolha um plano.",
                        reply_markup=self.plan_keyboard(),
                    )
                    return
                payer_email = self.store.save_customer_email(telegram_user, chat_id, text)
                self.telegram.send_message(chat_id, f"E-mail cadastrado: <b>{payer_email}</b>")
                self.process_plan_selection(pending_plan_id, chat_id, telegram_user)
                return
            customer = self.store.customer(telegram_user_id) or {}
            if customer.get("pending_plan_id"):
                self.telegram.send_message(chat_id, "Envie um e-mail valido para continuar. Exemplo: nome@email.com")
            else:
                self.telegram.send_message(chat_id, "Use os botoes para escolher um plano primeiro.", reply_markup=self.plan_keyboard())
            return

        callback = update.get("callback_query") or {}
        data = str(callback.get("data") or "")
        callback_id = str(callback.get("id") or "")
        if callback_id and not self.store.mark_event_seen(f"telegram_callback:{callback_id}"):
            self.telegram.answer_callback_query(callback_id, "Essa solicitacao ja foi processada.")
            return
        if data == "demo:video":
            self.telegram.answer_callback_query(callback_id, "Enviando demo...")
            message = callback.get("message") or {}
            chat_id = str(message.get("chat", {}).get("id") or "")
            sent = self.telegram.send_video(
                chat_id,
                self.demo_video_path,
                "Aqui está uma demo de como utilizar o app.",
            )
            if not sent:
                self.telegram.send_message(chat_id, "Nao consegui enviar a demo agora. Tente novamente em alguns instantes.")
            return
        if data.startswith("plan:"):
            self.telegram.answer_callback_query(callback_id, "Processando plano...")
            plan_id = data.split(":", 1)[1]
            self.create_order_from_callback(callback, plan_id)

    def create_order_from_callback(self, callback: Dict, plan_id: str) -> None:
        message = callback.get("message") or {}
        chat_id = str(message.get("chat", {}).get("id") or "")
        message_id = message.get("message_id")
        telegram_user = callback.get("from") or {}
        self.process_plan_selection(plan_id, chat_id, telegram_user, message_id)

    def process_plan_selection(self, plan_id: str, chat_id: str, telegram_user: Dict, message_id=None) -> None:
        plan = self.plans.get(plan_id)
        telegram_user_id = str(telegram_user.get("id") or "")
        if not plan:
            self.telegram.send_message(chat_id, "Plano invalido. Use /start para tentar novamente.")
            return
        payer_email = self.store.customer_email(telegram_user_id)
        if not payer_email:
            self.store.save_pending_plan(telegram_user, chat_id, plan_id)
            if message_id:
                self.telegram.remove_message_reply_markup(chat_id, message_id)
            self.telegram.send_message(chat_id, "Plano selecionado. Agora envie seu e-mail para cadastrar seu acesso.")
            return

        if message_id:
            self.telegram.remove_message_reply_markup(chat_id, message_id)
        self.store.clear_pending_plan(telegram_user_id)
        order = self.store.create_order(telegram_user, chat_id, plan, payer_email)
        if float(plan["price"]) <= 0:
            try:
                access_url = self.issue_access(order, plan)
                self.store.update_order(order["id"], status="approved", access_url=access_url, approved_at=time.time())
                self.telegram.send_message(
                    chat_id,
                    f"Teste gratuito liberado.\n\nSeu link de acesso:\n{access_url}\n\nValidade: {plan['days']} dias.",
                )
            except Exception as exc:
                self.store.update_order(order["id"], status="error", error=str(exc))
                self.telegram.send_message(chat_id, f"Nao foi possivel gerar o teste gratuito agora: {exc}")
            return
        try:
            payment = self.mercado_pago.create_pix_payment(order, plan, order["payer_email"])
            payment_id = str(payment.get("id") or "")
            transaction_data = (payment.get("point_of_interaction") or {}).get("transaction_data") or {}
            qr_code = str(transaction_data.get("qr_code") or "")
            qr_code_base64 = str(transaction_data.get("qr_code_base64") or "")
            self.store.update_order(order["id"], status="pending_payment", payment_id=payment_id, qr_code=qr_code)
            self.telegram.send_message(
                chat_id,
                f"Pedido criado: <b>{plan['name']}</b>\nValor: <b>R$ {plan['price']:.2f}</b>\n\nPague o Pix abaixo. Assim que aprovar, envio seu link automaticamente.".replace(".", ",", 1),
            )
            self.telegram.send_pix_qr(chat_id, qr_code, qr_code_base64)
        except Exception as exc:
            self.store.update_order(order["id"], status="error", error=str(exc))
            self.telegram.send_message(chat_id, f"Nao foi possivel gerar o Pix agora: {exc}")

    def process_payment_notification(self, payment_id: str, event_key: str = "") -> None:
        if event_key and not self.store.mark_event_seen(event_key):
            return
        payment = self.mercado_pago.get_payment(payment_id)
        order = self.store.order_by_payment(str(payment.get("id") or payment_id))
        if not order:
            return
        if order.get("status") == "approved" and order.get("access_url"):
            return
        if payment.get("status") != "approved":
            self.store.update_order(order["id"], status=str(payment.get("status") or "pending_payment"))
            return
        plan = self.plans.get(order["plan_id"])
        if not plan:
            self.store.update_order(order["id"], status="error", error="Plano nao encontrado")
            return
        if not self.store.claim_order_for_access(order["id"]):
            return
        try:
            access_url = self.issue_access(order, plan)
            self.store.update_order(order["id"], status="approved", access_url=access_url, approved_at=time.time())
            self.telegram.send_message(
                order["telegram_chat_id"],
                f"Pagamento aprovado.\n\nSeu link de acesso:\n{access_url}\n\nValidade: {plan['days']} dias.",
            )
        except Exception as exc:
            self.store.update_order(order["id"], status="error", error=str(exc))
            self.telegram.send_message(
                order["telegram_chat_id"],
                "Pagamento aprovado, mas houve erro ao gerar o acesso. O suporte ja pode verificar o pedido.",
            )

    def app_admin_request(self, path: str, payload: Optional[Dict] = None, method: Optional[str] = None) -> Dict:
        return json_request(
            f"{self.app_internal_base_url}{path}",
            payload=payload,
            headers={"X-Admin-Token": self.admin_token},
            method=method,
        )

    def access_url_for_user(self, user: Dict, data: Optional[Dict] = None) -> str:
        access_hash = user.get("access_hash") or ""
        if self.app_public_base_url and access_hash:
            return f"{self.app_public_base_url}/access/{urllib.parse.quote(access_hash, safe='')}"
        data = data or {}
        return user.get("access_url") or data.get("access_url") or ""

    def issue_access(self, order: Dict, plan: Dict) -> str:
        username = order.get("telegram_username") or order["telegram_user_id"]
        payer_email = normalize_email(order.get("payer_email") or "")
        if not payer_email:
            payer_email = f"telegram-{order['telegram_user_id']}-{order['id'][:8]}@stream.local"
        payload = {
            "name": f"Telegram {username}",
            "email": payer_email,
            "max_screens": plan["max_screens"],
            "access_expires_in_days": plan["days"],
            "allow_adult_content": plan["allow_adult_content"],
            "catalog_access_mode": plan.get("catalog_access_mode") or "full",
            "catalog_allowed_terms": plan.get("catalog_allowed_terms") or [],
            "catalog_featured_sections": plan.get("catalog_featured_sections") or [],
            "active": True,
        }
        try:
            data = self.app_admin_request("/api/admin/users", payload=payload)
        except RuntimeError as exc:
            if "HTTP 409" not in str(exc):
                raise
            users = self.app_admin_request("/api/admin/users", method="GET").get("users") or []
            existing_user = next((user for user in users if normalize_email(user.get("email") or "") == payer_email), None)
            if not existing_user:
                raise
            user_id = urllib.parse.quote(str(existing_user.get("id") or ""), safe="")
            update_payload = {
                "email": payer_email,
                "name": payload["name"],
                "max_screens": payload["max_screens"],
                "allow_adult_content": payload["allow_adult_content"],
                "active": True,
                "access_expires_at": time.time() + max(int(plan["days"] or 1), 1) * 24 * 60 * 60,
                "catalog_access_mode": payload["catalog_access_mode"],
                "catalog_allowed_terms": payload["catalog_allowed_terms"],
                "catalog_featured_sections": payload["catalog_featured_sections"],
            }
            self.app_admin_request(f"/api/admin/users/{user_id}", payload=update_payload, method="PUT")
            data = self.app_admin_request(f"/api/admin/users/{user_id}/rotate-link", payload={}, method="POST")
        user = data.get("user") or {}
        return self.access_url_for_user(user, data)

    def poll_forever(self) -> None:
        while True:
            try:
                data = self.telegram.api(
                    "getUpdates",
                    {"timeout": 30, "offset": self.polling_offset, "allowed_updates": ["message", "callback_query"]},
                )
                for update in data.get("result", []):
                    self.polling_offset = max(self.polling_offset, int(update.get("update_id") or 0) + 1)
                    self.handle_update(update)
            except Exception as exc:
                print(f"BOT polling error: {exc}", flush=True)
                time.sleep(5)


def payment_id_from_payload(path: str, payload: Dict) -> str:
    params = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
    for key in ("data.id", "id"):
        if params.get(key):
            return str(params[key][0])
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    value = str(data.get("id") or payload.get("id") or payload.get("resource") or "")
    if value.startswith(("http://", "https://")):
        return value.rstrip("/").rsplit("/", 1)[-1]
    return value


def parse_signature_header(value: str) -> Dict[str, str]:
    parts = {}
    for item in value.split(","):
        key, separator, part_value = item.strip().partition("=")
        if separator:
            parts[key.strip()] = part_value.strip()
    return parts


def signature_data_id_from_path(path: str) -> str:
    params = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
    data_id = str((params.get("data.id") or [""])[0])
    return data_id.lower() if data_id.isalnum() else data_id


def is_valid_mercado_pago_signature(path: str, headers, secret: str) -> bool:
    if not secret:
        return True
    signature = parse_signature_header(headers.get("x-signature", ""))
    timestamp = signature.get("ts", "")
    received_signature = signature.get("v1", "")
    request_id = headers.get("x-request-id", "")
    if not timestamp or not received_signature or not request_id:
        return False

    manifest = ""
    data_id = signature_data_id_from_path(path)
    if data_id:
        manifest += f"id:{data_id};"
    manifest += f"request-id:{request_id};ts:{timestamp};"
    expected_signature = hmac.new(secret.encode("utf-8"), manifest.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected_signature, received_signature)


def make_handler(app: BotApp):
    class BotWebhookHandler(BaseHTTPRequestHandler):
        def handle(self):
            try:
                super().handle()
            except (BrokenPipeError, ConnectionResetError):
                return

        def do_GET(self):
            if self.path == "/healthz":
                body = b'{"status":"ok"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_error(404)

        def do_POST(self):
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path.rstrip("/") != "/webhooks/mercadopago":
                self.send_error(404)
                return
            if not is_valid_mercado_pago_signature(self.path, self.headers, app.webhook_secret):
                self.send_error(403)
                return
            length = int(self.headers.get("Content-Length") or 0)
            payload = {}
            if length:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            payment_id = payment_id_from_payload(self.path, payload)
            if payment_id:
                event_key = str(payload.get("id") or self.headers.get("X-Request-Id") or "")
                threading.Thread(target=app.process_payment_notification, args=(payment_id, event_key), daemon=True).start()
            body = b'{"status":"received"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):
            return

    return BotWebhookHandler


def main() -> None:
    app = BotApp()
    host = os.getenv("BOT_HOST", "0.0.0.0")
    port = int(os.getenv("BOT_PORT", "8081"))
    server = ThreadingHTTPServer((host, port), make_handler(app))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"Telegram Pix bot webhook listening on {host}:{port}", flush=True)
    app.poll_forever()


if __name__ == "__main__":
    main()
