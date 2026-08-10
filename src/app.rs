//! Top-level Leptos component: metadata, the shared "current user" resource,
//! and the router / route table (§8).

use leptos::prelude::*;
use leptos_meta::{provide_meta_context, MetaTags, Stylesheet, Title};
use leptos_router::components::{Route, Router, Routes};
use leptos_router::path;

use crate::components::Navbar;
use crate::models::User;
use crate::pages::admin_users::AdminUsersPage;
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

/// The HTML document shell used for server-side rendering.
pub fn shell(options: LeptosOptions) -> impl IntoView {
    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8"/>
                <meta name="viewport" content="width=device-width, initial-scale=1"/>
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

#[component]
pub fn App() -> impl IntoView {
    provide_meta_context();

    let user: UserResource = Resource::new(
        || (),
        |_| async move { current_user().await.ok().flatten() },
    );
    provide_context(user);

    view! {
        <Stylesheet id="leptos" href="/pkg/portal.css"/>
        <Title text="Knowledge Base"/>
        <Router>
            <Navbar/>
            <main class="container">
                <Routes fallback=|| view! { <p class="muted">"Page not found."</p> }>
                    <Route path=path!("/login") view=LoginPage/>
                    <Route path=path!("/") view=HomePage/>
                    <Route path=path!("/docs/new") view=NewDocumentPage/>
                    <Route path=path!("/docs/:id/edit") view=EditDocumentPage/>
                    <Route path=path!("/docs/:id") view=DocumentPage/>
                    <Route path=path!("/categories") view=CategoriesPage/>
                    <Route path=path!("/admin/users") view=AdminUsersPage/>
                </Routes>
            </main>
        </Router>
    }
}
