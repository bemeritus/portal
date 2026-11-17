/**
 * Self-hosted fonts of the three themes (SPEC §10.1), bundled as woff2 by
 * Vite from the @fontsource packages: no request to Google at run time.
 * Each CSS file declares every subset with `unicode-range`, so the browser
 * downloads only the Cyrillic / Latin / Latin Extended files a page needs.
 */
import "@fontsource/golos-text/400.css";
import "@fontsource/golos-text/500.css";
import "@fontsource/golos-text/600.css";
import "@fontsource/onest/400.css";
import "@fontsource/onest/500.css";
import "@fontsource/onest/600.css";
import "@fontsource/fira-sans/400.css";
import "@fontsource/fira-sans/500.css";
import "@fontsource/fira-sans-condensed/500.css";
import "@fontsource/fira-sans-condensed/600.css";
import "@fontsource/fira-mono/400.css";
import "@fontsource/fira-mono/500.css";
