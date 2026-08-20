/**
 * `/admin/users` — creating users and granting them categories (§5.2, §8).
 *
 * The whole screen is the category matrix, because that is the whole of the
 * permission model (§4.2.1). There are no global permission checkboxes here,
 * and there is no endpoint behind them: a non-admin's rights are exactly the
 * rows they have in `user_category_permissions`, so a user created with an
 * empty matrix can sign in and see nothing at all.
 */

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "../api/client";
import { categories as categoriesApi, users as usersApi } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { ConfirmButton } from "../components/ConfirmButton";
import { ErrorFlash, Flash } from "../components/Flash";
import { Empty, Spinner } from "../components/Loading";
import { formatDate } from "../format";
import type { Category, CategoryPermission, User, Uuid } from "../api/types";

/** The matrix as the UI holds it: one entry per category, all four flags. */
type Matrix = Record<Uuid, CategoryPermission>;

const FLAGS = [
  { key: "can_read", label: "Read" },
  { key: "can_write", label: "Write" },
  { key: "can_edit", label: "Edit" },
  { key: "can_delete", label: "Delete" },
] as const;

type FlagKey = (typeof FLAGS)[number]["key"];

function emptyMatrix(categories: Category[]): Matrix {
  const matrix: Matrix = {};
  for (const c of categories) {
    matrix[c.id] = {
      category_id: c.id,
      can_read: false,
      can_write: false,
      can_edit: false,
      can_delete: false,
    };
  }
  return matrix;
}

function matrixFor(categories: Category[], grants: CategoryPermission[]): Matrix {
  const matrix = emptyMatrix(categories);
  for (const g of grants) {
    // A grant on a category that has since been deleted has nothing to render
    // against; the server drops it on the next save anyway.
    if (matrix[g.category_id]) matrix[g.category_id] = { ...g };
  }
  return matrix;
}

/** Only the rows with something ticked — the shape the API wants. */
function toGrants(matrix: Matrix): CategoryPermission[] {
  return Object.values(matrix).filter(
    (g) => g.can_read || g.can_write || g.can_edit || g.can_delete,
  );
}

function PermMatrix({
  categories,
  matrix,
  onChange,
  idPrefix,
}: {
  categories: Category[];
  matrix: Matrix;
  onChange: (next: Matrix) => void;
  idPrefix: string;
}) {
  if (categories.length === 0) {
    return <p className="hint">Create a category first — there is nothing to grant yet.</p>;
  }

  function toggle(categoryId: Uuid, flag: FlagKey) {
    const row = matrix[categoryId];
    onChange({ ...matrix, [categoryId]: { ...row, [flag]: !row[flag] } });
  }

  return (
    <div className="perm-matrix">
      <table>
        <thead>
          <tr>
            <th>Category</th>
            {FLAGS.map((f) => (
              <th key={f.key}>{f.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categories.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              {FLAGS.map((f) => (
                <td key={f.key}>
                  <label htmlFor={`${idPrefix}-${c.id}-${f.key}`}>
                    <input
                      id={`${idPrefix}-${c.id}-${f.key}`}
                      type="checkbox"
                      aria-label={`${f.label} in ${c.name}`}
                      checked={matrix[c.id]?.[f.key] ?? false}
                      onChange={() => toggle(c.id, f.key)}
                    />
                  </label>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminUsersPage() {
  const queryClient = useQueryClient();
  const { user: me, refresh } = useAuth();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Users · Knowledge Base";
  }, []);

  const categoriesQuery = useQuery({
    queryKey: ["categories"],
    queryFn: ({ signal }) => categoriesApi.list(signal),
  });
  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => usersApi.list(signal),
  });

  const categories = useMemo(() => categoriesQuery.data ?? [], [categoriesQuery.data]);

  async function afterChange(message: string, changedSelf: boolean) {
    setNotice(message);
    await queryClient.invalidateQueries({ queryKey: ["users"] });
    // Changing your own grants changes what the rail and the buttons should
    // show. Without this the UI keeps offering what you just took away.
    if (changedSelf) await refresh();
  }

  return (
    <>
      <h1>Users</h1>

      <CreateUserForm
        categories={categories}
        onCreated={(username) => void afterChange(`Created “${username}”.`, false)}
      />

      {notice && <Flash kind="ok">{notice}</Flash>}

      <h3 style={{ marginTop: 28 }}>All users</h3>

      {usersQuery.isPending ? (
        <Spinner />
      ) : usersQuery.error ? (
        <ErrorFlash error={errorMessage(usersQuery.error)} />
      ) : usersQuery.data.length === 0 ? (
        <Empty title="No users" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th className="wrap">Categories</th>
                <th>Status</th>
                <th>Reset password</th>
              </tr>
            </thead>
            <tbody>
              {usersQuery.data.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  categories={categories}
                  isSelf={me?.id === user.id}
                  onChanged={(message) => void afterChange(message, me?.id === user.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function CreateUserForm({
  categories,
  onCreated,
}: {
  categories: Category[];
  onCreated: (username: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [matrix, setMatrix] = useState<Matrix>({});
  const [error, setError] = useState<string | null>(null);

  // Categories arrive after the first render, and a category created while
  // this form is open should appear in it.
  useEffect(() => {
    setMatrix((prev) => {
      const next = emptyMatrix(categories);
      for (const id of Object.keys(next)) {
        if (prev[id]) next[id] = prev[id];
      }
      return next;
    });
  }, [categories]);

  const create = useMutation({
    mutationFn: () =>
      usersApi.create({
        username,
        password,
        is_admin: isAdmin,
        // An admin holds everything everywhere, so sending a matrix for one
        // would store rows that can never change an outcome.
        category_perms: isAdmin ? [] : toGrants(matrix),
      }),
    onSuccess: () => {
      onCreated(username.trim());
      setUsername("");
      setPassword("");
      setIsAdmin(false);
      setMatrix(emptyMatrix(categories));
      setError(null);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  /** A password the admin can hand over, from the browser's CSPRNG. */
  function generatePassword() {
    const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = new Uint32Array(16);
    crypto.getRandomValues(bytes);
    setPassword(Array.from(bytes, (b) => alphabet[b % alphabet.length]).join(""));
  }

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Create user</h3>
      <form onSubmit={onSubmit}>
        <div className="row">
          <div>
            <label htmlFor="new-username">Username</label>
            <input
              id="new-username"
              type="text"
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="new-password">Initial password</label>
            <input
              id="new-password"
              type="text"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="hint">At least 6 characters.</p>
          </div>
          <div className="grow-0">
            <button
              type="button"
              className="btn secondary"
              title="Generate a random password"
              onClick={generatePassword}
            >
              Generate
            </button>
          </div>
        </div>

        <label className="chk">
          <input
            type="checkbox"
            checked={isAdmin}
            onChange={(e) => setIsAdmin(e.target.checked)}
          />
          Administrator (holds every permission in every category)
        </label>

        {!isAdmin && (
          <div style={{ marginTop: 14 }}>
            <label>Category permissions</label>
            <PermMatrix
              categories={categories}
              matrix={matrix}
              onChange={setMatrix}
              idPrefix="new"
            />
            <p className="hint">
              A user with nothing ticked can sign in and see an empty platform.
            </p>
          </div>
        )}

        <ErrorFlash error={error} />

        <div className="actions" style={{ marginTop: 14 }}>
          <button
            className="btn"
            type="submit"
            disabled={create.isPending || !username.trim() || password.length < 6}
          >
            {create.isPending ? "Creating…" : "Create user"}
          </button>
        </div>
      </form>
    </div>
  );
}

function UserRow({
  user,
  categories,
  isSelf,
  onChanged,
}: {
  user: User;
  categories: Category[];
  isSelf: boolean;
  onChanged: (message: string) => void;
}) {
  const [matrix, setMatrix] = useState<Matrix>(() => matrixFor(categories, user.category_perms));
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the list refetches or a category is added.
  useEffect(() => {
    setMatrix(matrixFor(categories, user.category_perms));
  }, [categories, user.category_perms]);

  const savePermissions = useMutation({
    mutationFn: () => usersApi.setPermissions(user.id, toGrants(matrix)),
    onSuccess: () => {
      setError(null);
      onChanged(`Permissions saved for “${user.username}”.`);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const setActive = useMutation({
    mutationFn: (active: boolean) => usersApi.setActive(user.id, active),
    onSuccess: (_data, active) => {
      setError(null);
      onChanged(`“${user.username}” ${active ? "activated" : "blocked"}.`);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const resetPassword = useMutation({
    mutationFn: () => usersApi.resetPassword(user.id, newPassword),
    onSuccess: () => {
      setNewPassword("");
      setError(null);
      onChanged(`Password reset for “${user.username}”.`);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const grantCount = user.category_perms.length;

  return (
    <tr>
      <td>
        {user.username}
        {isSelf && <span className="muted"> (you)</span>}
      </td>
      <td>{user.is_admin ? "Admin" : "User"}</td>
      <td className="wrap">
        {user.is_admin ? (
          <span className="muted">all</span>
        ) : (
          <details className="cat-perms">
            <summary>
              {grantCount === 0
                ? "No categories"
                : `${grantCount} categor${grantCount === 1 ? "y" : "ies"}`}
            </summary>
            <PermMatrix
              categories={categories}
              matrix={matrix}
              onChange={setMatrix}
              idPrefix={user.id}
            />
            <div className="actions" style={{ marginTop: 10 }}>
              <button
                className="btn small"
                type="button"
                disabled={savePermissions.isPending}
                onClick={() => savePermissions.mutate()}
              >
                {savePermissions.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          </details>
        )}
        <ErrorFlash error={error} />
      </td>
      <td>
        {user.is_active ? (
          isSelf ? (
            // The server refuses this too; saying so here saves the round-trip
            // and the confusing error.
            <span className="muted" title="You cannot disable your own account">
              Active
            </span>
          ) : (
            <ConfirmButton
              label="Block"
              confirmLabel="Block"
              pending={setActive.isPending}
              onConfirm={() => setActive.mutate(false)}
            />
          )
        ) : (
          <span className="actions" style={{ gap: 6 }}>
            <span className="badge">blocked</span>
            <button
              className="btn small secondary"
              type="button"
              disabled={setActive.isPending}
              onClick={() => setActive.mutate(true)}
            >
              Activate
            </button>
          </span>
        )}
      </td>
      <td>
        <span className="actions">
          <input
            type="text"
            aria-label={`New password for ${user.username}`}
            placeholder="New password"
            style={{ minWidth: 150 }}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <button
            className="btn small secondary"
            type="button"
            disabled={resetPassword.isPending || newPassword.length < 6}
            onClick={() => resetPassword.mutate()}
          >
            Reset
          </button>
        </span>
        <p className="hint">{formatDate(user.created_at)}</p>
      </td>
    </tr>
  );
}
