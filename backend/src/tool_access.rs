//! «Внутренние инструменты» — who may use which internal tool.
//!
//! A second permission family, independent of documents (which any signed-in
//! user may manage). The rule, re-read from the database on every request so a
//! revoked grant takes effect at once:
//!
//! ```text
//! allowed(user, tool, level) = user.is_admin
//!                           OR grant(user, tool, level)
//!                           OR (level = use AND grant(user, tool, edit))
//! ```
//!
//! As with [`crate::auth::CurrentUser`], the check is an extractor: a handler
//! that takes `RequireTool<DcRoom, Edit>` cannot run for someone without
//! `dc_room:edit`.

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{ApiResult, internal};
use crate::models::User;

/// The registry. Adding a tool = a variant here, its key in [`Tool::key`], its
/// levels in [`Tool::levels`], and the key in the table's CHECK (a migration).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tool {
    PortChecker,
    MailTester,
    OnlinePinger,
    DnsChecker,
    DcRoom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Use,
    Edit,
}

impl Tool {
    pub const ALL: [Tool; 5] = [
        Tool::PortChecker,
        Tool::MailTester,
        Tool::OnlinePinger,
        Tool::DnsChecker,
        Tool::DcRoom,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Tool::PortChecker => "port_checker",
            Tool::MailTester => "mail_tester",
            Tool::OnlinePinger => "online_pinger",
            Tool::DnsChecker => "dns_checker",
            Tool::DcRoom => "dc_room",
        }
    }

    pub fn from_key(key: &str) -> Option<Tool> {
        Tool::ALL.into_iter().find(|t| t.key() == key)
    }

    /// The levels an admin can grant for this tool.
    pub fn levels(self) -> &'static [Level] {
        match self {
            Tool::DcRoom => &[Level::Use, Level::Edit],
            _ => &[Level::Use],
        }
    }
}

impl Level {
    pub fn key(self) -> &'static str {
        match self {
            Level::Use => "use",
            Level::Edit => "edit",
        }
    }

    pub fn from_key(key: &str) -> Option<Level> {
        match key {
            "use" => Some(Level::Use),
            "edit" => Some(Level::Edit),
            _ => None,
        }
    }
}

/// A tool and the levels it offers, for the admin page.
#[derive(Clone, Debug, Serialize)]
pub struct ToolInfo {
    pub tool: Tool,
    pub levels: &'static [Level],
}

pub fn registry() -> Vec<ToolInfo> {
    Tool::ALL
        .into_iter()
        .map(|tool| ToolInfo {
            tool,
            levels: tool.levels(),
        })
        .collect()
}

/// One stored grant, as the admin API and `/auth/me/tools` send it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ToolGrant {
    pub tool: Tool,
    pub level: Level,
}

/// Does a set of stored grants allow `level` on `tool`? The rule above, minus
/// the admin term, as a pure function so it can be tested without a database.
pub fn grants_allow(grants: &[ToolGrant], tool: Tool, level: Level) -> bool {
    grants.iter().any(|g| {
        g.tool == tool && (g.level == level || (level == Level::Use && g.level == Level::Edit))
    })
}

/// The grants stored for one user, ignoring rows whose keys this build does
/// not know (a tool removed from the registry before its rows were).
pub async fn stored_grants(pool: &PgPool, user_id: Uuid) -> ApiResult<Vec<ToolGrant>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT tool, level FROM user_tool_permissions WHERE user_id = $1 ORDER BY tool, level",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(|e| internal("reading a user's tool permissions", e))?;
    Ok(rows
        .into_iter()
        .filter_map(|(t, l)| {
            Some(ToolGrant {
                tool: Tool::from_key(&t)?,
                level: Level::from_key(&l)?,
            })
        })
        .collect())
}

/// What a user may actually do: every level of every tool for an admin, their
/// grants (with `edit` implying `use`) otherwise. This is what navigation is
/// built from.
pub async fn effective_grants(pool: &PgPool, user: &User) -> ApiResult<Vec<ToolGrant>> {
    let stored = if user.is_admin {
        Vec::new()
    } else {
        stored_grants(pool, user.id).await?
    };
    let mut out = Vec::new();
    for tool in Tool::ALL {
        for &level in tool.levels() {
            if user.is_admin || grants_allow(&stored, tool, level) {
                out.push(ToolGrant { tool, level });
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(tool: Tool, level: Level) -> ToolGrant {
        ToolGrant { tool, level }
    }

    #[test]
    fn registry_has_the_five_keys() {
        let keys: Vec<_> = Tool::ALL.iter().map(|t| t.key()).collect();
        assert_eq!(
            keys,
            [
                "port_checker",
                "mail_tester",
                "online_pinger",
                "dns_checker",
                "dc_room"
            ]
        );
        for t in Tool::ALL {
            assert_eq!(Tool::from_key(t.key()), Some(t));
        }
    }

    #[test]
    fn only_dc_room_has_edit() {
        assert_eq!(Tool::DcRoom.levels(), &[Level::Use, Level::Edit]);
        assert_eq!(Tool::PortChecker.levels(), &[Level::Use]);
    }

    #[test]
    fn edit_implies_use_but_not_the_reverse() {
        let edit = [g(Tool::DcRoom, Level::Edit)];
        assert!(grants_allow(&edit, Tool::DcRoom, Level::Use));
        assert!(grants_allow(&edit, Tool::DcRoom, Level::Edit));
        let use_only = [g(Tool::DcRoom, Level::Use)];
        assert!(grants_allow(&use_only, Tool::DcRoom, Level::Use));
        assert!(!grants_allow(&use_only, Tool::DcRoom, Level::Edit));
    }

    #[test]
    fn a_grant_on_one_tool_is_not_a_grant_on_another() {
        let grants = [g(Tool::PortChecker, Level::Use)];
        assert!(!grants_allow(&grants, Tool::DcRoom, Level::Use));
        assert!(!grants_allow(&[], Tool::DcRoom, Level::Use));
    }
}
