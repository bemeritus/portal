//! Top-level Leptos component: metadata, the shared "current user" resource,
//! and the router / route table (§8).

use leptos::prelude::*;
use leptos_meta::{provide_meta_context, MetaTags, Stylesheet, Title};
use leptos_router::components::{Route, Router, Routes};
use leptos_router::hooks::use_location;
use leptos_router::path;

use crate::components::{provide_theme, Navbar, Sidebar};
use crate::models::User;
use crate::pages::admin_users::AdminUsersPage;
use crate::pages::audit::AuditLogPage;
use crate::pages::categories::CategoriesPage;
use crate::pages::document::DocumentPage;
use crate::pages::editor::{EditDocumentPage, NewDocumentPage};
use crate::pages::home::HomePage;
use crate::pages::login::LoginPage;
use crate::server::auth::current_user;

/// A resource holding the currently authenticated user, shared via context so
/// the navbar and pages can gate on permissions without re-fetching.
pub type UserResource = Resource<Option<User>>;

/// Pull the shared current-user resource out of context.
pub fn use_user() -> UserResource {
    expect_context::<UserResource>()
}

/// Whether the section rail is expanded on narrow screens. Shared through
/// context because the toggle lives in the top bar and the rail it opens is a
/// sibling, not a child.
#[derive(Clone, Copy)]
pub struct SidebarOpen(pub RwSignal<bool>);

/// Pull the shared sidebar open/closed signal out of context.
pub fn use_sidebar() -> RwSignal<bool> {
    expect_context::<SidebarOpen>().0
}

/// Applies the stored theme before hydration so there is no flash of the
/// default (dark) theme when the user has chosen another.
const THEME_BOOTSTRAP: &str = "(function(){try{var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();";

/// The HTML document shell used for server-side rendering.
pub fn shell(options: LeptosOptions) -> impl IntoView {
    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8"/>
                <meta name="viewport" content="width=device-width, initial-scale=1"/>
                <script inner_html=THEME_BOOTSTRAP></script>
                <AutoReload options=options.clone()/>
                <HydrationScripts options/>
                <MetaTags/>
            </head>
            <body>
                <App/>
            </body>
        </html>
    }
}

/// The navbar, minus the routes where it has nothing to offer. `/login` is
/// public and has no navigation to do, so it renders as a bare centred form.
#[component]
fn Chrome() -> impl IntoView {
    let path = use_location().pathname;
    view! {
        <Show when=move || path.get() != "/login" fallback=|| ()>
            <Navbar/>
        </Show>
    }
}

#[component]
pub fn App() -> impl IntoView {
    provide_meta_context();
    provide_theme();
    provide_context(SidebarOpen(RwSignal::new(false)));

    // A failure here is indistinguishable from being logged out: the navbar and
    // every permission gate fall back to the anonymous view. Which of the two
    // it was only ever shows up in the log.
    let user: UserResource = Resource::new(
        || (),
        |_| async move {
            match current_user().await {
                Ok(user) => user,
                Err(e) => {
                    leptos::logging::error!("could not load the current user: {e}");
                    None
                }
            }
        },
    );
    provide_context(user);

    view! {
        <Stylesheet id="leptos" href="/pkg/portal.css"/>
        <Title text="Knowledge Base"/>
        <Router>
            <Chrome/>
            <div class="layout">
                <Sidebar/>
                <main class="container">
                    <Routes fallback=|| {
                        view! {
                            <div class="empty">
                                <div class="empty-title">"Page not found"</div>
                                <p>"That address does not match anything on this portal."</p>
                                <a class="btn secondary" href="/">"Go to documents"</a>
                            </div>
                        }
                    }>
                        <Route path=path!("/login") view=LoginPage/>
                        <Route path=path!("/") view=HomePage/>
                        <Route path=path!("/docs/new") view=NewDocumentPage/>
                        <Route path=path!("/docs/:id/edit") view=EditDocumentPage/>
                        <Route path=path!("/docs/:id") view=DocumentPage/>
                        <Route path=path!("/categories") view=CategoriesPage/>
                        <Route path=path!("/admin/users") view=AdminUsersPage/>
                        <Route path=path!("/admin/logs") view=AuditLogPage/>
                    </Routes>
                </main>
            </div>
        </Router>
    }
}
