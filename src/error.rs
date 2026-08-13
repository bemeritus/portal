//! Turning a [`ServerFnError`] into a sentence worth showing a person.
//!
//! Leptos formats `ServerFnError` for developers: its `Display` prefixes every
//! server-side failure with "error running server function: ", and the
//! transport variants read like a stack trace. Rendering that straight into a
//! flash message is how a mistyped password came out as
//! *"error running server function: Invalid username or password"*.
//!
//! The server functions in this crate put the user-facing sentence in
//! `ServerError`, optionally behind an HTTP-style status marker (`401: `,
//! `403: `) so the client can tell the cases apart. [`user_message`] is what
//! unwraps that; nothing else should render a `ServerFnError` directly.

use leptos::prelude::ServerFnError;

/// Shown when the failure is not the user's doing and there is nothing for them
/// to act on. The specifics were logged on the server (see `backend::internal`).
const GENERIC: &str = "Something went wrong. Please try again.";

/// The sentence to show the user for `error`.
pub fn user_message(error: &ServerFnError) -> String {
    match error {
        // The only variant carrying a message this crate wrote itself.
        ServerFnError::ServerError(message) => match split_status(message) {
            // A session that expired mid-visit is not an error the user made;
            // "not authenticated" would read as a bug in the portal.
            (Some("401"), _) => "Your session has ended. Please sign in again.".to_string(),
            (_, message) => message.to_string(),
        },
        // The call never made it there and back: server down, connection
        // dropped, browser offline. `Request` is the only variant that means
        // this — `Response` is raised *by the server* when it fails to build a
        // reply, so telling the user to check their connection would send them
        // after a fault that is not on their side.
        ServerFnError::Request(_) => {
            "Could not reach the server. Check your connection and try again.".to_string()
        }
        // Anything left is a defect in this app — a reply that could not be
        // built, a serialization mismatch, an endpoint that was never
        // registered. The user cannot act on any of it.
        _ => GENERIC.to_string(),
    }
}

/// Split a leading `NNN: ` status marker off a message. The marker is for the
/// client to branch on, never for the reader.
fn split_status(message: &str) -> (Option<&str>, &str) {
    match message.split_once(": ") {
        Some((status, rest)) if status.len() == 3 && status.chars().all(|c| c.is_ascii_digit()) => {
            (Some(status), rest)
        }
        _ => (None, message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_plain_message_as_written() {
        let error = ServerFnError::new("Title is required");
        assert_eq!(user_message(&error), "Title is required");
    }

    #[test]
    fn drops_the_status_marker() {
        let error = ServerFnError::new("403: you cannot edit this document");
        assert_eq!(user_message(&error), "you cannot edit this document");
    }

    #[test]
    fn rewrites_an_expired_session() {
        let error = ServerFnError::new("401: not authenticated");
        assert_eq!(
            user_message(&error),
            "Your session has ended. Please sign in again."
        );
    }

    #[test]
    fn leaves_a_colon_that_is_not_a_status_alone() {
        let error = ServerFnError::new("Note: this is fine");
        assert_eq!(user_message(&error), "Note: this is fine");
    }

    #[test]
    fn does_not_show_transport_details() {
        let error: ServerFnError =
            ServerFnError::Request("connection refused at 10.0.0.4:5432".to_string());
        assert_eq!(
            user_message(&error),
            "Could not reach the server. Check your connection and try again."
        );
    }

    #[test]
    fn a_failed_reply_is_not_blamed_on_the_connection() {
        let error: ServerFnError =
            ServerFnError::Response("could not serialize the body".to_string());
        assert_eq!(user_message(&error), GENERIC);
    }
}
