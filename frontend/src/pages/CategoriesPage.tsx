/**
 * `/categories` — admin category management (FR-9, FR-24).
 *
 * Deleting is refused by the server while documents still reference the
 * category; the grants on it cascade away. Both outcomes come back as the
 * server's own sentence, so this page does not try to predict either.
 */

import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "../api/client";
import { categories as categoriesApi } from "../api/endpoints";
import { ConfirmButton } from "../components/ConfirmButton";
import { ErrorFlash, Flash } from "../components/Flash";
import { Empty, Spinner } from "../components/Loading";
import { formatDate } from "../format";
import type { Category } from "../api/types";

export function CategoriesPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Category | null>(null);

  useEffect(() => {
    document.title = "Categories · Knowledge Base";
  }, []);

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
    mutationFn: () => categoriesApi.create({ name, description }),
    onSuccess: async (category) => {
      setName("");
      setDescription("");
      setCreateError(null);
      setNotice(`Created “${category.name}”.`);
      await invalidate();
    },
    onError: (e) => setCreateError(errorMessage(e)),
  });

  const update = useMutation({
    mutationFn: (category: Category) =>
      categoriesApi.update(category.id, {
        name: category.name,
        description: category.description ?? "",
      }),
    onSuccess: async () => {
      setEditing(null);
      setRowError(null);
      setNotice("Saved.");
      await invalidate();
    },
    onError: (e) => setRowError(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => categoriesApi.remove(id),
    onSuccess: async () => {
      setRowError(null);
      setNotice("Category deleted.");
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
      <h1>Categories</h1>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>New category</h3>
        <form onSubmit={onCreate}>
          <div className="row">
            <div>
              <label htmlFor="cat-name">Name</label>
              <input
                id="cat-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="cat-desc">Description (optional)</label>
              <input
                id="cat-desc"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="grow-0">
              <button className="btn" type="submit" disabled={create.isPending || !name.trim()}>
                {create.isPending ? "Adding…" : "Add"}
              </button>
            </div>
          </div>
          <ErrorFlash error={createError} />
        </form>
      </div>

      {notice && <Flash kind="ok">{notice}</Flash>}
      <ErrorFlash error={rowError} />

      <h3 style={{ marginTop: 28 }}>All categories</h3>

      {list.isPending ? (
        <Spinner />
      ) : list.error ? (
        <ErrorFlash error={errorMessage(list.error)} />
      ) : list.data.length === 0 ? (
        <Empty title="No categories yet">
          <p className="muted">Create one above; documents need a category to live in.</p>
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th className="wrap">Description</th>
                <th>Slug</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((category) =>
                editing?.id === category.id ? (
                  <tr key={category.id}>
                    <td>
                      <input
                        type="text"
                        value={editing.name}
                        aria-label="Category name"
                        onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      />
                    </td>
                    <td className="wrap">
                      <input
                        type="text"
                        value={editing.description ?? ""}
                        aria-label="Category description"
                        onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                      />
                    </td>
                    <td className="muted">{category.slug}</td>
                    <td className="muted">{formatDate(category.created_at)}</td>
                    <td>
                      <span className="actions">
                        <button
                          className="btn small"
                          type="button"
                          disabled={update.isPending || !editing.name.trim()}
                          onClick={() => update.mutate(editing)}
                        >
                          Save
                        </button>
                        <button
                          className="btn small secondary"
                          type="button"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </button>
                      </span>
                    </td>
                  </tr>
                ) : (
                  <tr key={category.id}>
                    <td>{category.name}</td>
                    <td className="wrap muted">{category.description ?? "—"}</td>
                    <td className="muted">
                      <code>{category.slug}</code>
                    </td>
                    <td className="muted">{formatDate(category.created_at)}</td>
                    <td>
                      <span className="actions">
                        <button
                          className="btn small secondary"
                          type="button"
                          onClick={() => {
                            setRowError(null);
                            setNotice(null);
                            setEditing(category);
                          }}
                        >
                          Rename
                        </button>
                        <ConfirmButton
                          label="Delete"
                          confirmLabel="Delete"
                          pending={remove.isPending}
                          onConfirm={() => {
                            setNotice(null);
                            remove.mutate(category.id);
                          }}
                        />
                      </span>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
