/**
 * `/admin/users` — creating users, blocking them, and resetting passwords.
 *
 * There is no per-category permission model any more: any signed-in user may
 * read and manage every document. The one choice left when creating an account
 * is whether it is an administrator, which is what gates this page and the other
 * admin-only screens.
 */

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { errorMessage } from "../api/client";
import { users as usersApi } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { ConfirmButton } from "../components/ConfirmButton";
import { ErrorFlash, Flash } from "../components/Flash";
import { Empty, Spinner } from "../components/Loading";
import { formatDate } from "../format";
import type { User } from "../api/types";

export function AdminUsersPage() {
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const { t } = useTranslation();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    document.title = t("docTitle", { page: t("users.heading"), app: t("app.name") });
  }, [t]);

  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => usersApi.list(signal),
  });

  async function afterChange(message: string) {
    setNotice(message);
    await queryClient.invalidateQueries({ queryKey: ["users"] });
  }

  return (
    <>
      <h1>{t("users.heading")}</h1>

      <CreateUserForm
        onCreated={(username) => void afterChange(t("users.created", { name: username }))}
      />

      {notice && <Flash kind="ok">{notice}</Flash>}

      <h3 style={{ marginTop: 28 }}>{t("users.allUsers")}</h3>

      {usersQuery.isPending ? (
        <Spinner />
      ) : usersQuery.error ? (
        <ErrorFlash error={errorMessage(usersQuery.error)} />
      ) : usersQuery.data.length === 0 ? (
        <Empty title={t("users.none")} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("users.thUsername")}</th>
                <th>{t("users.thRole")}</th>
                <th>{t("users.thStatus")}</th>
                <th>{t("users.thResetPassword")}</th>
              </tr>
            </thead>
            <tbody>
              {usersQuery.data.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  isSelf={me?.id === user.id}
                  onChanged={(message) => void afterChange(message)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function CreateUserForm({ onCreated }: { onCreated: (username: string) => void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => usersApi.create({ username, password, is_admin: isAdmin }),
    onSuccess: () => {
      onCreated(username.trim());
      setUsername("");
      setPassword("");
      setIsAdmin(false);
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
      <h3 style={{ marginTop: 0 }}>{t("users.createUser")}</h3>
      <form onSubmit={onSubmit}>
        <div className="row">
          <div>
            <label htmlFor="new-username">{t("users.username")}</label>
            <input
              id="new-username"
              type="text"
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="new-password">{t("users.initialPassword")}</label>
            <div className="input-with-action">
              <input
                id="new-password"
                type="text"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="btn secondary icon-square"
                title={t("users.generateTitle")}
                aria-label={t("common.generate")}
                onClick={generatePassword}
              >
                <svg
                  viewBox="0 0 24 24"
                  width={18}
                  height={18}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v5h-5" />
                </svg>
              </button>
            </div>
            <p className="hint">{t("users.atLeast6")}</p>
          </div>
        </div>

        <label className="chk">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
          {t("users.isAdminLabel")}
        </label>

        <ErrorFlash error={error} />

        <div className="actions" style={{ marginTop: 14 }}>
          <button
            className="btn"
            type="submit"
            disabled={create.isPending || !username.trim() || password.length < 6}
          >
            {create.isPending ? t("users.creating") : t("users.createUser")}
          </button>
        </div>
      </form>
    </div>
  );
}

function UserRow({
  user,
  isSelf,
  onChanged,
}: {
  user: User;
  isSelf: boolean;
  onChanged: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const setActive = useMutation({
    mutationFn: (active: boolean) => usersApi.setActive(user.id, active),
    onSuccess: (_data, active) => {
      setError(null);
      onChanged(
        active
          ? t("users.activated", { name: user.username })
          : t("users.blockedNotice", { name: user.username }),
      );
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const resetPassword = useMutation({
    mutationFn: () => usersApi.resetPassword(user.id, newPassword),
    onSuccess: () => {
      setNewPassword("");
      setError(null);
      onChanged(t("users.passwordReset", { name: user.username }));
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <tr>
      <td>
        {user.username}
        {isSelf && <span className="muted">{t("users.you")}</span>}
      </td>
      <td>{user.is_admin ? t("users.roleAdmin") : t("users.roleUser")}</td>
      <td>
        {user.is_active ? (
          isSelf ? (
            // The server refuses this too; saying so here saves the round-trip
            // and the confusing error.
            <span className="badge active" title={t("users.cannotDisableSelf")}>
              {t("users.active")}
            </span>
          ) : (
            <ConfirmButton
              label={t("users.block")}
              confirmLabel={t("users.block")}
              pending={setActive.isPending}
              onConfirm={() => setActive.mutate(false)}
            />
          )
        ) : (
          <span className="actions" style={{ gap: 6 }}>
            <span className="badge blocked">{t("users.blocked")}</span>
            <button
              className="btn small success"
              type="button"
              disabled={setActive.isPending}
              onClick={() => setActive.mutate(true)}
            >
              {t("users.activate")}
            </button>
          </span>
        )}
        <ErrorFlash error={error} />
      </td>
      <td>
        <span className="actions">
          <input
            type="text"
            aria-label={t("users.newPasswordAria", { name: user.username })}
            placeholder={t("users.newPasswordPlaceholder")}
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
            {t("common.reset")}
          </button>
        </span>
        <p className="hint">{formatDate(user.created_at)}</p>
      </td>
    </tr>
  );
}
