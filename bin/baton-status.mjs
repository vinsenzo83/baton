#!/usr/bin/env node
// BATON statusLine segment — shows only that the tool is installed & available in this session.
// It does NOT show room/member counts: those are per-room and would be misleading if shown
// globally (a session that never joined a room must never look "connected" to one).
// Real room/connection state is per-session — check with baton_who or the watcher log.
process.stdout.write("\x1b[2m🏃 baton\x1b[0m");
