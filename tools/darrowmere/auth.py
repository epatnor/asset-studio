"""Konton och sessioner för Darrowmeres kontrollpanel.

Lösenord sparas som PBKDF2-SHA256 med salt (aldrig i klartext), sessioner som slumpade nycklar i en kaka
(HttpOnly, SameSite=Lax, Secure bakom https). Bara nyckelns hash sparas på disken. För många misslyckade
inloggningar från samma adress spärras en stund. Första kontot kan bara skapas från hemmanätet.
"""
import hashlib
import hmac
import ipaddress
import json
import re
import secrets
import threading
import time
from pathlib import Path

ITERATIONS = 240_000
SESSION_DAYS = 30
COOKIE = "dm_session"
NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{2,32}$")
MAX_FAILS, FAIL_WINDOW = 8, 15 * 60


def _hash(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS).hex()


def is_private(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
        return a.is_private or a.is_loopback
    except ValueError:
        return False


class Auth:
    def __init__(self, state_dir: Path):
        self.users_file = state_dir / "users.json"
        self.sessions_file = state_dir / "sessions.json"
        self.lock = threading.Lock()
        self.users = self._load(self.users_file)
        self.sessions = self._load(self.sessions_file)
        self.fails: dict[str, list[float]] = {}

    @staticmethod
    def _load(path: Path) -> dict:
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError):
            return {}

    def _save(self, path: Path, data: dict):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1))
        tmp.chmod(0o600)
        tmp.replace(path)

    # Konton
    def has_users(self) -> bool:
        return bool(self.users)

    def list_users(self) -> list[dict]:
        with self.lock:
            return [{"name": n, "created": u.get("created")} for n, u in sorted(self.users.items())]

    def add_user(self, name: str, password: str):
        if not NAME_RE.match(name or ""):
            raise ValueError("The name must be 2–32 letters, digits, dots, dashes or underscores.")
        if len(password or "") < 8:
            raise ValueError("The password must be at least 8 characters.")
        with self.lock:
            if name in self.users:
                raise ValueError("That account already exists.")
            salt = secrets.token_bytes(16)
            self.users[name] = {"salt": salt.hex(), "hash": _hash(password, salt), "created": time.time()}
            self._save(self.users_file, self.users)

    def delete_user(self, name: str):
        with self.lock:
            if name not in self.users:
                raise ValueError("No such account.")
            if len(self.users) == 1:
                raise ValueError("The last account cannot be removed.")
            del self.users[name]
            self.sessions = {k: s for k, s in self.sessions.items() if s["user"] != name}
            self._save(self.users_file, self.users)
            self._save(self.sessions_file, self.sessions)

    def set_password(self, name: str, password: str):
        if len(password or "") < 8:
            raise ValueError("The password must be at least 8 characters.")
        with self.lock:
            salt = secrets.token_bytes(16)
            self.users[name].update(salt=salt.hex(), hash=_hash(password, salt))
            self._save(self.users_file, self.users)

    def verify(self, name: str, password: str) -> bool:
        u = self.users.get(name or "")
        salt = bytes.fromhex(u["salt"]) if u else b"\0" * 16
        ok = hmac.compare_digest(_hash(password or "", salt), u["hash"] if u else "0" * 64)  # lika lång tid oavsett
        return bool(u) and ok

    # Spärr mot gissning
    def blocked(self, ip: str) -> bool:
        now = time.time()
        self.fails[ip] = [t for t in self.fails.get(ip, []) if now - t < FAIL_WINDOW]
        return len(self.fails[ip]) >= MAX_FAILS

    def failed(self, ip: str):
        self.fails.setdefault(ip, []).append(time.time())

    # Sessioner
    def new_session(self, name: str) -> str:
        token = secrets.token_urlsafe(32)
        with self.lock:
            now = time.time()
            self.sessions = {k: s for k, s in self.sessions.items() if s["exp"] > now}
            self.sessions[hashlib.sha256(token.encode()).hexdigest()] = {"user": name, "exp": now + SESSION_DAYS * 86400}
            self._save(self.sessions_file, self.sessions)
        return token

    def session_user(self, token: str | None) -> str | None:
        if not token:
            return None
        s = self.sessions.get(hashlib.sha256(token.encode()).hexdigest())
        if not s or s["exp"] < time.time() or s["user"] not in self.users:
            return None
        return s["user"]

    def end_session(self, token: str | None):
        if not token:
            return
        with self.lock:
            if self.sessions.pop(hashlib.sha256(token.encode()).hexdigest(), None) is not None:
                self._save(self.sessions_file, self.sessions)
