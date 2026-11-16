-- Telegram chats subscribed to document notifications.
--
-- A row appears when someone sends the bot /start and disappears on /stop (or
-- when a send comes back 403 — the user blocked the bot, which is the same
-- request made without typing). `username` is display-only, for debugging who
-- a chat_id belongs to; Telegram's chat_id is the real identity.

CREATE TABLE telegram_subscribers (
    chat_id    BIGINT PRIMARY KEY,
    username   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
