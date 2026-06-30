# foreman-remote

Static remote-control panel for [claude-foreman](https://github.com/andersnordmann/claude-foreman).

Open the GitHub Pages URL on your phone, enter your own Turso **Sync URL + token** (kept in your
browser's localStorage only), and watch / pause / resume / stop your foreman runs — one entry per
instance. **No secrets live here**: the page talks directly to *your own* Turso DB over HTTPS; this
repo is just the static UI.
