-- «Внутренние инструменты»: a permission family for internal tools, separate
-- from documents. A grant is (user, tool, level); `tool` is a key from the
-- registry in `src/tool_access.rs`, which is also where the CHECK below has
-- to grow when a tool is added. `edit` implies `use` — in the rule, not by
-- storing both rows.
CREATE TABLE user_tool_permissions (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tool    TEXT NOT NULL
        CHECK (tool IN ('port_checker', 'mail_tester', 'online_pinger', 'dns_checker', 'dc_room')),
    level   TEXT NOT NULL CHECK (level IN ('use', 'edit')),
    PRIMARY KEY (user_id, tool, level)
);
