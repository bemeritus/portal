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
import { useTranslation } from "react-i18next";

import { errorMessage } from "../api/client";
import { categories as categoriesApi, users as usersApi } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { ConfirmButton } from "../components/ConfirmButton";
import { ErrorFlash, Flash } from "../components/Flash";
import { Empty, Spinner } from "../components/Loading";
import { formatDate } from "../format";
import type { Category, CategoryPermission, SectionAccess, User, Uuid } from "../api/types";

/** The matrix as the UI holds it: one entry per category, all four flags. */
type Matrix = Record<Uuid, CategoryPermission>;

/**
 * The section boxes as the UI holds them. `learning` gates the author box: you
 * cannot make a teacher of someone who is not in the section.
 */
type SectionState = { templates: boolean; learning: boolean; learningAuthor: boolean };

const EMPTY_SECTIONS: SectionState = {
  templates: false,
  learning: false,
  learningAuthor: false,
};

function sectionStateFor(sections: SectionAccess[]): SectionState {
  const learning = sections.find((s) => s.section === "learning");
  return {
    templates: sections.some((s) => s.section === "templates"),
    learning: !!learning,
    learningAuthor: !!learning?.can_author,
  };
}

/** The shape the API wants — only the opened sections, author bit folded in. */
function toSections(state: SectionState): SectionAccess[] {
  const out: SectionAccess[] = [];
  if (state.templates) out.push({ section: "templates", can_author: false });
  if (state.learning) out.push({ section: "learning", can_author: state.learningAuthor });
  return out;
}

function SectionPicker({
  state,
  onChange,
  idPrefix,
  templatesForced = false,
}: {
  state: SectionState;
  onChange: (next: SectionState) => void;
  idPrefix: string;
  /** A held category grant implies the templates door, so the box is shown
      ticked and locked rather than letting the admin contradict what the
      server will store. */
  templatesForced?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="section-picker" style={{ display: "grid", gap: 6 }}>
      <label className="chk" htmlFor={`${idPrefix}-sec-templates`}>
        <input
          id={`${idPrefix}-sec-templates`}
          type="checkbox"
          checked={state.templates || templatesForced}
          disabled={templatesForced}
          onChange={(e) => onChange({ ...state, templates: e.target.checked })}
        />
        {t("users.sectionTemplates")}
      </label>
      <label className="chk" htmlFor={`${idPrefix}-sec-learning`}>
        <input
          id={`${idPrefix}-sec-learning`}
          type="checkbox"
          checked={state.learning}
          onChange={(e) =>
            // Leaving the section clears the author bit — a teacher with no
            // section is the kind of dead state the server would drop anyway.
            onChange({
              ...state,
              learning: e.target.checked,
              learningAuthor: e.target.checked && state.learningAuthor,
            })
          }
        />
        {t("users.sectionLearning")}
      </label>
      {state.learning && (
        <label className="chk" htmlFor={`${idPrefix}-sec-learning-author`} style={{ marginLeft: 22 }}>
          <input
            id={`${idPrefix}-sec-learning-author`}
            type="checkbox"
            checked={state.learningAuthor}
            onChange={(e) => onChange({ ...state, learningAuthor: e.target.checked })}
          />
          {t("users.sectionLearningAuthor")}
        </label>
      )}
      <p className="hint">{t("users.sectionsHint")}</p>
    </div>
  );
}

const FLAGS = [
  { key: "can_read", labelKey: "perm.read" },
  { key: "can_write", labelKey: "perm.write" },
  { key: "can_edit", labelKey: "perm.edit" },
  { key: "can_delete", labelKey: "perm.delete" },
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
  const { t } = useTranslation();

  if (categories.length === 0) {
    return <p className="hint">{t("perm.createFirst")}</p>;
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
            <th>{t("perm.category")}</th>
            {FLAGS.map((f) => (
              <th key={f.key}>{t(f.labelKey)}</th>
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
                      aria-label={t("perm.flagIn", { flag: t(f.labelKey), category: c.name })}
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
  const { t } = useTranslation();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    document.title = t("docTitle", { page: t("users.heading"), app: t("app.name") });
  }, [t]);

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
      <h1>{t("users.heading")}</h1>

      <CreateUserForm
        categories={categories}
        onCreated={(username) => void afterChange(t("users.created", { name: username }), false)}
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
                <th>{t("users.thSections")}</th>
                <th className="wrap">{t("users.thCategories")}</th>
                <th>{t("users.thStatus")}</th>
                <th>{t("users.thResetPassword")}</th>
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
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [matrix, setMatrix] = useState<Matrix>({});
  const [sections, setSections] = useState<SectionState>(EMPTY_SECTIONS);
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
        // An admin holds everything everywhere, so sending a matrix or section
        // list for one would store rows that can never change an outcome.
        category_perms: isAdmin ? [] : toGrants(matrix),
        // Fold in the templates door a category grant implies, so the payload
        // matches what the picker shows (and what the server would add anyway).
        sections: isAdmin
          ? []
          : toSections({
              ...sections,
              templates: sections.templates || toGrants(matrix).length > 0,
            }),
      }),
    onSuccess: () => {
      onCreated(username.trim());
      setUsername("");
      setPassword("");
      setIsAdmin(false);
      setMatrix(emptyMatrix(categories));
      setSections(EMPTY_SECTIONS);
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
            <input
              id="new-password"
              type="text"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="hint">{t("users.atLeast6")}</p>
          </div>
          <div className="grow-0">
            <button
              type="button"
              className="btn secondary"
              title={t("users.generateTitle")}
              onClick={generatePassword}
            >
              {t("common.generate")}
            </button>
          </div>
        </div>

        <label className="chk">
          <input
            type="checkbox"
            checked={isAdmin}
            onChange={(e) => setIsAdmin(e.target.checked)}
          />
          {t("users.isAdminLabel")}
        </label>

        {!isAdmin && (
          <div style={{ marginTop: 14 }}>
            <label>{t("users.sectionAccess")}</label>
            <SectionPicker
              state={sections}
              onChange={setSections}
              idPrefix="new"
              templatesForced={toGrants(matrix).length > 0}
            />

            <label style={{ marginTop: 14, display: "block" }}>
              {t("users.categoryPermissions")}
            </label>
            <PermMatrix
              categories={categories}
              matrix={matrix}
              onChange={setMatrix}
              idPrefix="new"
            />
            <p className="hint">{t("users.nothingTicked")}</p>
          </div>
        )}

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
  categories,
  isSelf,
  onChanged,
}: {
  user: User;
  categories: Category[];
  isSelf: boolean;
  onChanged: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [matrix, setMatrix] = useState<Matrix>(() => matrixFor(categories, user.category_perms));
  const [sections, setSections] = useState<SectionState>(() => sectionStateFor(user.sections));
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Re-sync when the list refetches or a category is added.
  useEffect(() => {
    setMatrix(matrixFor(categories, user.category_perms));
  }, [categories, user.category_perms]);
  useEffect(() => {
    setSections(sectionStateFor(user.sections));
  }, [user.sections]);

  const savePermissions = useMutation({
    // Grants and sections go together: the server writes them in one
    // transaction and derives the templates door from the grants, so we fold
    // that same implication into the payload here.
    mutationFn: () =>
      usersApi.setPermissions(
        user.id,
        toGrants(matrix),
        toSections({
          ...sections,
          templates: sections.templates || toGrants(matrix).length > 0,
        }),
      ),
    onSuccess: () => {
      setError(null);
      onChanged(t("users.permsSaved", { name: user.username }));
    },
    onError: (e) => setError(errorMessage(e)),
  });

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

  const grantCount = user.category_perms.length;

  return (
    <tr>
      <td>
        {user.username}
        {isSelf && <span className="muted">{t("users.you")}</span>}
      </td>
      <td>{user.is_admin ? t("users.roleAdmin") : t("users.roleUser")}</td>
      <td className="wrap">
        {user.is_admin ? (
          <span className="muted">{t("users.all")}</span>
        ) : user.sections.length === 0 ? (
          <span className="muted">{t("users.noSections")}</span>
        ) : (
          user.sections
            .map((s) =>
              s.section === "learning" && s.can_author ? `${s.section} (author)` : s.section,
            )
            .join(", ")
        )}
      </td>
      <td className="wrap">
        {user.is_admin ? (
          <span className="muted">{t("users.all")}</span>
        ) : (
          <details className="cat-perms">
            <summary>
              {grantCount === 0
                ? t("users.noCategories")
                : t("users.categories", { count: grantCount })}
            </summary>
            <div style={{ marginTop: 10 }}>
              <label>{t("users.sectionAccess")}</label>
              <SectionPicker
                state={sections}
                onChange={setSections}
                idPrefix={user.id}
                templatesForced={toGrants(matrix).length > 0}
              />
            </div>
            <label style={{ marginTop: 12, display: "block" }}>
              {t("users.categoryPermissions")}
            </label>
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
                {savePermissions.isPending ? t("common.saving") : t("common.save")}
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
