// Your site's identity — edit freely; deploys never overwrite this file.
// See CUSTOMIZE.md for every option.
window.SITE_CONFIG = {
  name: "My Community Forum",
  tagline: "A place for our community to meet, talk, and share.",
  logo: "assets/logo.svg",            // path under web/
  footer: "My Community Forum · powered by a serverless forum on AWS",
  layout: "sidebar",                  // "sidebar" | "topnav"
  theme: "neutral-light",             // a file name in web/themes/
  nav: [
    { label: "Home",    href: "#/" },
    { label: "About",   href: "#/about" },
    { label: "Contact", href: "#/contact" },
    { label: "Forum",   href: "#/forum" },
    { label: "Photos",  href: "#/photos" },
    { label: "Members", href: "#/members" },
    { label: "Links",   href: "#/links" },
    // Deep-link nav items to a forum category like this:
    // { label: "Events", href: "#/category/events" },
  ],
};
