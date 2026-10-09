"""Private durable inbox, task ownership and outbox; no transport credentials in logs."""
import json
import os
import sqlite3
from pathlib import Path


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)
        self.path = self.directory / 'relay.sqlite3'
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        os.chmod(self.path, 0o600)
        self.db = sqlite3.connect(self.path, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, token TEXT NOT NULL, session TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS inbox (
              ref TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL, text TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'received', task_id TEXT,
              attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0,
              created INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)));
        ''')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS tasks (
              task_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ref TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
              polled REAL NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS outbox (
              event TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL,
              chunks TEXT NOT NULL, next_chunk INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'pending', error TEXT,
              created INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)));
        ''')

    def close(self):
        self.db.close()

    def meta(self, key, default=''):
        row = self.db.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
        return row['value'] if row else default

    def set_meta(self, key, value):
        self.db.execute('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, value))

    def recover(self):
        # Only the exclusive running service calls this, never the concurrent reply CLI.
        with self.db:
            interrupted=self.db.execute("SELECT * FROM inbox WHERE status='gadget_sending'").fetchall()
            self.db.execute("UPDATE inbox SET status='needs_attention' WHERE status='gadget_sending'")
            self.db.execute("UPDATE outbox SET status='uncertain',error='发送期间服务中断，需核对是否收到。' WHERE status='sending'")
        return interrupted

    def enqueue(self, event, user_id, token, chunks):
        if not token:
            raise ValueError('Reply context is missing')
        self.db.execute('INSERT OR IGNORE INTO outbox(event,user_id,token,chunks) VALUES (?,?,?,?)',
                        (event, user_id, token, json.dumps(chunks, ensure_ascii=False)))

    def acknowledge(self, ref):
        self.db.execute("UPDATE inbox SET status='done' WHERE ref=?", (ref,))

    def pending(self):
        return self.db.execute("SELECT * FROM inbox WHERE status='received' AND next_attempt<=CAST(strftime('%s','now') AS INTEGER) ORDER BY created,rowid LIMIT 1").fetchone()

    def receipt(self, ref):
        return self.db.execute('SELECT * FROM inbox WHERE ref=?', (ref,)).fetchone()

    def task_owner(self, task_id):
        return self.db.execute('SELECT * FROM tasks WHERE task_id=?', (task_id,)).fetchone()
