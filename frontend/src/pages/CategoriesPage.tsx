/**
 * `/templates/categories` — category management (FR-9, FR-24).
 *
 * Deleting is refused by the server while documents still reference the
 * category; the grants on it cascade away. Both outcomes come back as the
 * server's own sentence, so this page does not try to predict either.
 */

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { categories as categoriesApi } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { ConfirmButton } from "../components/ConfirmButton";
import { ErrorFlash, Flash } from "../components/Flash";
import { Empty, Spinner } from "../components/Loading";
import { formatDate } from "../format";
import type { Category } from "../api/types";

export function CategoriesPage() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Category | null>(null);

  useEffect(() => {
    document.title = t("docTitle", { page: t("categories.heading"), app: t("app.name") });
  }, [t]);

  const list = useQuery({
    queryKey: ["categories"],
    queryFn: ({ signal }) => categoriesApi.list(signal),
  });

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["categories"] }),
      // The editor's picker and the users page's matrix are both built from
      // categories, and both are wrong the moment this list changes.
      queryClient.invalidateQueries({ queryKey: ["documents"] }),
    ]);

  const create = useMutation({
    mutationFn: () => categoriesApi.create({ name }),
    onSuccess: async (category) => {
      setName("");
      setCreateError(null);
      setNotice(t("categories.created", { name: category.name }));
      await invalidate();
    },
    onError: (e) => setCreateError(errorMessage(e)),
  });

  const update = useMutation({
    mutationFn: (category: Category) =>
      categoriesApi.update(category.id, {
        name: category.name,
      }),
    onSuccess: async () => {
      setEditing(null);
      setRowError(null);
      setNotice(t("categories.saved"));
      await invalidate();
    },
    onError: (e) => setRowError(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => categoriesApi.remove(id),
    onSuccess: async () => {
      setRowError(null);
      setNotice(t("categories.deleted"));
      await invalidate();
    },
    onError: (e) => setRowError(errorMessage(e)),
  });

  function onCreate(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    create.mutate();
  }

  return (
    <>
      <h1>{t("categories.heading")}</h1>

      <Card>
        <CardHeader>
          <CardTitle>{t("categories.newCategory")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCreate}>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1 space-y-1.5">
                <Label htmlFor="cat-name">{t("categories.name")}</Label>
                <Input
                  id="cat-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={create.isPending || !name.trim()}>
                {create.isPending ? t("common.adding") : t("common.add")}
              </Button>
            </div>
            <ErrorFlash error={createError} />
          </form>
        </CardContent>
      </Card>

      {notice && <Flash kind="ok">{notice}</Flash>}
      <ErrorFlash error={rowError} />

      <h3 className="mt-7 mb-3">{t("categories.allHeading")}</h3>

      {list.isPending ? (
        <Spinner />
      ) : list.error ? (
        <ErrorFlash error={errorMessage(list.error)} />
      ) : list.data.length === 0 ? (
        <Empty title={t("categories.noneTitle")}>
          <p>{t("categories.noneBody")}</p>
        </Empty>
      ) : (
        <Table className="min-w-160">
          <TableHeader>
            <TableRow>
              <TableHead>{t("categories.thName")}</TableHead>
              <TableHead>{t("categories.thSlug")}</TableHead>
              <TableHead>{t("categories.thCreated")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data.map((category) =>
              editing?.id === category.id ? (
                <TableRow key={category.id}>
                  <TableCell>
                    <Input
                      type="text"
                      value={editing.name}
                      aria-label={t("categories.nameAria")}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{category.slug}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(category.created_at)}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        type="button"
                        disabled={update.isPending || !editing.name.trim()}
                        onClick={() => update.mutate(editing)}
                      >
                        {t("common.save")}
                      </Button>
                      <Button size="sm" variant="outline" type="button" onClick={() => setEditing(null)}>
                        {t("common.cancel")}
                      </Button>
                    </span>
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow key={category.id}>
                  <TableCell>{category.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <code className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-xs">
                      {category.slug}
                    </code>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(category.created_at)}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        onClick={() => {
                          setRowError(null);
                          setNotice(null);
                          setEditing(category);
                        }}
                      >
                        {t("common.rename")}
                      </Button>
                      {/* Deleting a category stays admin-only. */}
                      {user?.is_admin && (
                        <ConfirmButton
                          label={t("common.delete")}
                          confirmLabel={t("common.delete")}
                          pending={remove.isPending}
                          onConfirm={() => {
                            setNotice(null);
                            remove.mutate(category.id);
                          }}
                        />
                      )}
                    </span>
                  </TableCell>
                </TableRow>
              ),
            )}
          </TableBody>
        </Table>
      )}
    </>
  );
}
