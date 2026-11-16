//! Telegram notifications: whoever sends the bot `/start` gets a message when
//! a document is created or edited.
//!
//! Two halves, both best-effort and both off unless `TELEGRAM_BOT_TOKEN` is
//! set:
//!
//! * **The poller** — one background task long-polling `getUpdates`. `/start`
//!   subscribes the chat (an upsert, so repeating it is harmless), `/stop`
//!   unsubscribes. The offset lives in memory: after a restart Telegram may
//!   replay the last few updates, and the upsert makes that a no-op.
//! * **Notifications** — `notify_document` is called by the document handlers
//!   *after* their transaction commits, and fans the message out from a spawned
//!   task so an unreachable Telegram can never slow down or fail a save. A send
//!   that comes back 403 means the user blocked the bot — that chat is dropped
//!   from the table, since it is the same request made without typing /stop.
//!
//! Messages are HTML-formatted; titles and usernames pass through
//! `escape_html` because they are user input and `<b>` is markup here.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;

/// What happened to the document — picks the verb and the emoji.
#[derive(Clone, Copy)]
pub enum DocEvent {
    Created,
    Updated,
}

#[derive(Clone)]
pub struct Telegram {
    inner: Arc<Inner>,
}

struct Inner {
    token: String,
    /// E.g. "https://kb.example.com" — makes titles clickable. Optional.
    base_url: Option<String>,
    client: reqwest::Client,
    pool: PgPool,
}

// --- The slice of Telegram's update shape this bot actually reads. ---

#[derive(Deserialize)]
struct TgResponse<T> {
    ok: bool,
    result: Option<T>,
    description: Option<String>,
}

#[derive(Deserialize)]
struct TgUpdate {
    update_id: i64,
    message: Option<TgMessage>,
}

#[derive(Deserialize)]
struct TgMessage {
    chat: TgChat,
    from: Option<TgUser>,
    text: Option<String>,
}

#[derive(Deserialize)]
struct TgChat {
    id: i64,
}

#[derive(Deserialize)]
struct TgUser {
    username: Option<String>,
}

impl Telegram {
    /// `None` when no token is configured — the caller stores that `None` in
    /// `AppState` and the whole feature disappears.
    pub fn from_config(pool: PgPool, config: &Config) -> Option<Self> {
        let token = config.telegram_bot_token.clone()?;
        Some(Telegram {
            inner: Arc::new(Inner {
                token,
                base_url: config.public_base_url.clone(),
                client: reqwest::Client::new(),
                pool,
            }),
        })
    }

    fn url(&self, method: &str) -> String {
        format!("https://api.telegram.org/bot{}/{method}", self.inner.token)
    }

    /// Start the `getUpdates` long-poll loop on the runtime and return.
    pub fn spawn_poller(&self) {
        let this = self.clone();
        tokio::spawn(async move { this.poll_loop().await });
    }

    async fn poll_loop(self) {
        let mut offset: i64 = 0;
        loop {
            // 50s long poll: the request itself blocks until something
            // happens, so this loop is one idle connection, not a busy wait.
            let resp = self
                .inner
                .client
                .post(self.url("getUpdates"))
                .json(&json!({
                    "offset": offset,
                    "timeout": 50,
                    "allowed_updates": ["message"],
                }))
                .timeout(std::time::Duration::from_secs(60))
                .send()
                .await;

            let updates = match resp {
                Ok(r) => match r.json::<TgResponse<Vec<TgUpdate>>>().await {
                    Ok(TgResponse {
                        ok: true,
                        result: Some(u),
                        ..
                    }) => u,
                    Ok(TgResponse { description, .. }) => {
                        tracing::warn!(
                            "telegram getUpdates refused: {}",
                            description.as_deref().unwrap_or("(no description)")
                        );
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        continue;
                    }
                    Err(e) => {
                        tracing::warn!("telegram getUpdates returned malformed JSON: {e}");
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        continue;
                    }
                },
                Err(e) => {
                    // Network trouble: back off and keep trying — subscriptions
                    // are the only thing this loop serves, nothing depends on it.
                    tracing::warn!("telegram getUpdates failed: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    continue;
                }
            };

            for update in updates {
                offset = offset.max(update.update_id + 1);
                if let Some(msg) = update.message {
                    self.handle_message(msg).await;
                }
            }
        }
    }

    async fn handle_message(&self, msg: TgMessage) {
        // "/start@MyBot arg" and "/start" must both match: group chats append
        // the bot's name, and /start can carry a deep-link payload.
        let command = msg
            .text
            .as_deref()
            .unwrap_or("")
            .split_whitespace()
            .next()
            .unwrap_or("")
            .split('@')
            .next()
            .unwrap_or("");
        let chat_id = msg.chat.id;

        match command {
            "/start" => {
                let username = msg.from.and_then(|u| u.username);
                let saved = sqlx::query(
                    "INSERT INTO telegram_subscribers (chat_id, username) VALUES ($1, $2)
                     ON CONFLICT (chat_id) DO UPDATE SET username = EXCLUDED.username",
                )
                .bind(chat_id)
                .bind(username)
                .execute(&self.inner.pool)
                .await;
                match saved {
                    Ok(_) => {
                        self.send(
                            chat_id,
                            "✅ Obuna bo'ldingiz. Yangi yoki tahrirlangan hujjatlar haqida \
                             xabar olasiz.\n\nTo'xtatish: /stop",
                        )
                        .await;
                    }
                    Err(e) => tracing::warn!("saving a telegram subscriber failed: {e}"),
                }
            }
            "/stop" => {
                if let Err(e) = sqlx::query("DELETE FROM telegram_subscribers WHERE chat_id = $1")
                    .bind(chat_id)
                    .execute(&self.inner.pool)
                    .await
                {
                    tracing::warn!("removing a telegram subscriber failed: {e}");
                }
                self.send(chat_id, "Obuna bekor qilindi. Qayta obuna bo'lish: /start")
                    .await;
            }
            // Anything else — a lost human. Say what the bot is for.
            _ => {
                self.send(
                    chat_id,
                    "Bu bot bilimlar bazasidagi hujjat o'zgarishlari haqida xabar beradi.\n\
                     Obuna: /start · To'xtatish: /stop",
                )
                .await;
            }
        }
    }

    /// Queue a broadcast about a document; returns immediately. Called after
    /// the document's transaction commits — never before, or subscribers would
    /// hear about saves that then rolled back.
    pub fn notify_document(
        &self,
        event: DocEvent,
        doc_id: Uuid,
        title: &str,
        status: &str,
        actor: &str,
    ) {
        let (emoji, verb) = match event {
            DocEvent::Created => ("🆕", "yangi hujjat yaratdi"),
            DocEvent::Updated => ("✏️", "hujjatni tahrirladi"),
        };
        let title_html = match &self.inner.base_url {
            Some(base) => format!(
                "<a href=\"{base}/templates/docs/{doc_id}\">{}</a>",
                escape_html(title)
            ),
            None => format!("<b>{}</b>", escape_html(title)),
        };
        let status_label = if status == "published" {
            "nashr qilingan"
        } else {
            "qoralama"
        };
        let text = format!(
            "{emoji} {} {verb}:\n{title_html}\nHolati: {status_label}",
            escape_html(actor)
        );

        let this = self.clone();
        tokio::spawn(async move { this.broadcast(text).await });
    }

    async fn broadcast(self, text: String) {
        let chat_ids: Vec<i64> =
            match sqlx::query_scalar("SELECT chat_id FROM telegram_subscribers")
                .fetch_all(&self.inner.pool)
                .await
            {
                Ok(ids) => ids,
                Err(e) => {
                    tracing::warn!("listing telegram subscribers failed: {e}");
                    return;
                }
            };

        for chat_id in chat_ids {
            self.send(chat_id, &text).await;
        }
    }

    /// One sendMessage. Failures are logged, not returned — nothing upstream
    /// can do anything about them. A 403 unsubscribes the chat (bot blocked).
    async fn send(&self, chat_id: i64, text: &str) {
        let resp = self
            .inner
            .client
            .post(self.url("sendMessage"))
            .json(&json!({
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": true,
            }))
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await;

        match resp {
            Ok(r) if r.status() == reqwest::StatusCode::FORBIDDEN => {
                tracing::info!("telegram chat {chat_id} blocked the bot; unsubscribing it");
                let _ = sqlx::query("DELETE FROM telegram_subscribers WHERE chat_id = $1")
                    .bind(chat_id)
                    .execute(&self.inner.pool)
                    .await;
            }
            Ok(r) if !r.status().is_success() => {
                let status = r.status();
                let body = r.text().await.unwrap_or_default();
                tracing::warn!("telegram sendMessage to {chat_id} failed: {status} {body}");
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("telegram sendMessage to {chat_id} failed: {e}"),
        }
    }
}

/// The three characters HTML parse_mode treats as markup.
fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::escape_html;

    #[test]
    fn escape_html_covers_markup_characters() {
        assert_eq!(escape_html("a < b & c > d"), "a &lt; b &amp; c &gt; d");
        assert_eq!(escape_html("plain title"), "plain title");
    }
}
