/**
 * `/admin/users` — creating users, blocking them, and resetting passwords.
 *
 * There is no per-category permission model any more: any signed-in user may
 * read and manage every document. The one choice left when creating an account
 * is whether it is an administrator, which is what gates this page and the other
 * admin-only screens.
 */

import { useEffect, useState, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

      <h3 className="mt-7 mb-3">{t("users.allUsers")}</h3>

      {usersQuery.isPending ? (
        <Spinner />
      ) : usersQuery.error ? (
        <ErrorFlash error={errorMessage(usersQuery.error)} />
      ) : usersQuery.data.length === 0 ? (
        <Empty title={t("users.none")} />
      ) : (
        <Table className="min-w-160">
          <TableHeader>
            <TableRow>
              <TableHead>{t("users.thUsername")}</TableHead>
              <TableHead>{t("users.thRole")}</TableHead>
              <TableHead>{t("users.thStatus")}</TableHead>
              <TableHead>{t("users.thResetPassword")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usersQuery.data.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                isSelf={me?.id === user.id}
                onChanged={(message) => void afterChange(message)}
              />
            ))}
          </TableBody>
        </Table>
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
    <Card>
      <CardHeader>
        <CardTitle>{t("users.createUser")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <div className="flex flex-wrap gap-3">
            <div className="min-w-48 flex-1 space-y-1.5">
              <Label htmlFor="new-username">{t("users.username")}</Label>
              <Input
                id="new-username"
                type="text"
                autoComplete="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="min-w-48 flex-1 space-y-1.5">
              <Label htmlFor="new-password">{t("users.initialPassword")}</Label>
              <div className="flex gap-2">
                <Input
                  id="new-password"
                  type="text"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-10 shrink-0"
                  title={t("users.generateTitle")}
                  aria-label={t("common.generate")}
                  onClick={generatePassword}
                >
                  <RefreshCw />
                </Button>
              </div>
              <p className="text-[13px] text-muted-foreground">{t("users.atLeast6")}</p>
            </div>
          </div>

          <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={isAdmin} onCheckedChange={(v) => setIsAdmin(v === true)} />
            {t("users.isAdminLabel")}
          </label>

          <ErrorFlash error={error} />

          <div className="mt-3.5">
            <Button
              type="submit"
              disabled={create.isPending || !username.trim() || password.length < 6}
            >
              {create.isPending ? t("users.creating") : t("users.createUser")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
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
    <TableRow>
      <TableCell>
        {user.username}
        {isSelf && <span className="ml-1.5 text-muted-foreground">{t("users.you")}</span>}
      </TableCell>
      <TableCell>{user.is_admin ? t("users.roleAdmin") : t("users.roleUser")}</TableCell>
      <TableCell>
        {user.is_active ? (
          isSelf ? (
            // The server refuses this too; saying so here saves the round-trip
            // and the confusing error.
            <Badge variant="success" title={t("users.cannotDisableSelf")}>
              {t("users.active")}
            </Badge>
          ) : (
            <ConfirmButton
              label={t("users.block")}
              confirmLabel={t("users.block")}
              pending={setActive.isPending}
              onConfirm={() => setActive.mutate(false)}
            />
          )
        ) : (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <Badge variant="destructive">{t("users.blocked")}</Badge>
            <Button
              size="sm"
              variant="success"
              type="button"
              disabled={setActive.isPending}
              onClick={() => setActive.mutate(true)}
            >
              {t("users.activate")}
            </Button>
          </span>
        )}
        <ErrorFlash error={error} />
      </TableCell>
      <TableCell>
        <span className="flex flex-wrap items-center gap-2">
          <Input
            type="text"
            className="h-8 w-40 text-xs"
            aria-label={t("users.newPasswordAria", { name: user.username })}
            placeholder={t("users.newPasswordPlaceholder")}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={resetPassword.isPending || newPassword.length < 6}
            onClick={() => resetPassword.mutate()}
          >
            {t("common.reset")}
          </Button>
        </span>
        <p className="mt-1 text-[13px] text-muted-foreground">{formatDate(user.created_at)}</p>
      </TableCell>
    </TableRow>
  );
}
