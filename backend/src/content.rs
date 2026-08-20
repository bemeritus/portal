//! Turning authored Markdown into HTML that is safe to insert, and names into
//! slugs.

use uuid::Uuid;

/// Render (untrusted) markdown to sanitized HTML (FR-13 + defense in depth).
///
/// This runs on the server, not in the browser, and that is deliberate: the
/// frontend inserts the result with `dangerouslySetInnerHTML`, so the sanitizer
/// is the thing standing between an authored `<script>` and every later reader.
/// A sanitizer that ran on the client would be one the client could skip.
pub fn render_markdown(markdown: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    let parser = Parser::new_ext(markdown, options);
    let mut unsafe_html = String::new();
    html::push_html(&mut unsafe_html, parser);
    ammonia::clean(&unsafe_html)
}

/// A URL-safe slug for a category name.
pub fn slugify(name: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    // A name with no ASCII alphanumerics at all — "Что нового", "設計" — would
    // otherwise slug to the empty string, and the second such category would
    // collide with the first on a unique index.
    if trimmed.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        trimmed
    }
}

/// Trim, and treat an all-whitespace description as absent.
pub fn optional_text(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_collapses_and_trims() {
        assert_eq!(slugify("Getting Started"), "getting-started");
        assert_eq!(slugify("  Two   Words  "), "two-words");
        assert_eq!(slugify("C++ / Rust"), "c-rust");
    }

    #[test]
    fn slugify_never_returns_empty() {
        assert!(!slugify("!!!").is_empty());
        assert!(!slugify("設計").is_empty());
    }

    #[test]
    fn markdown_is_sanitized() {
        let html = render_markdown("# Hi\n\n<script>alert(1)</script>\n\nplain");
        assert!(html.contains("<h1>"));
        assert!(!html.contains("<script"));
    }

    #[test]
    fn markdown_keeps_images_and_links() {
        let html = render_markdown("![shot](/uploads/a.png) and [link](https://example.com)");
        assert!(html.contains("<img"));
        assert!(html.contains("href=\"https://example.com\""));
    }
}
