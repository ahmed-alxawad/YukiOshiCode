# Placeholders in plugin skills

Some bundled skills come from Claude plugins and mention tool categories with a
`~~` prefix (for example `~~project tracker` or `~~design tool`) or refer to a
`CONNECTORS.md` file. Those are connectors a Claude app user may have attached.

YukiOshi Code has no connectors. When a skill mentions one, use the tools you
do have (files, search, Git, terminal commands, `web_fetch` for public pages),
ask the user to paste the information, or explain what is missing.
