/**
 * The client's copy of the permission rule (§4.2.1).
 *
 * This decides what to *show*. It never decides what is allowed — the server
 * re-checks every one of these on the request that follows, and it is the only
 * answer that counts (SR-9). Keeping the shapes identical is the point: a
 * button this file hides is a request the server would refuse anyway, so the
 * two can never disagree about the outcome, only about how early the user
 * finds out.
 */

import type { CategoryPermission, Permission, Section, User, Uuid } from "./api/types";

function allows(grant: CategoryPermission, perm: Permission): boolean {
  switch (perm) {
    case "read":
      return grant.can_read;
    case "write":
      return grant.can_write;
    case "edit":
      return grant.can_edit;
    case "delete":
      return grant.can_delete;
  }
}

function isEmpty(grant: CategoryPermission): boolean {
  return !(grant.can_read || grant.can_write || grant.can_edit || grant.can_delete);
}

/**
 * Whether the user holds the permission in one category.
 *
 * Admin, or a grant on that category. There is no third term — no global flag
 * and no author exemption, exactly as in `User::has_in`.
 */
export function hasIn(user: User | null, categoryId: Uuid, perm: Permission): boolean {
  if (!user) return false;
  if (user.is_admin) return true;
  return user.category_perms.some((g) => g.category_id === categoryId && allows(g, perm));
}

/**
 * Whether the user holds the permission on *some* category.
 *
 * For deciding whether an action exists at all — the "New document" button —
 * never for authorizing one.
 */
export function hasAnywhere(user: User | null, perm: Permission): boolean {
  if (!user) return false;
  if (user.is_admin) return true;
  return user.category_perms.some((g) => allows(g, perm));
}

/** The categories the user can see at all — those with any grant. */
export function accessibleCategories(user: User | null): Uuid[] {
  if (!user) return [];
  return user.category_perms.filter((g) => !isEmpty(g)).map((g) => g.category_id);
}

/**
 * Whether the user may enter a section — the outer door, mirroring
 * `User::in_section`. Admin, or a row for that section. Decides what nav to
 * show and which section routes to let through; the server re-checks (SR-9).
 */
export function inSection(user: User | null, section: Section): boolean {
  if (!user) return false;
  if (user.is_admin) return true;
  return user.sections.some((s) => s.section === section);
}

/**
 * Whether the user may author in a section — mirrors `User::can_author`. Only
 * ever true for `learning` (create resources/tests/labs) and `projects` (manage
 * boards and columns). Decides whether those actions are shown, never whether
 * one is allowed.
 */
export function canAuthor(user: User | null, section: Section): boolean {
  if (!user) return false;
  if (user.is_admin) return true;
  return user.sections.some((s) => s.section === section && s.can_author);
}
