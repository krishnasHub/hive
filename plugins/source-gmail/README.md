# Gmail source

Watches your Gmail inbox and hands new messages to Hive, which triages them with Claude and pings you on your phone channel when one needs you.

- IMAP over TLS to `imap.gmail.com` with a Google app password. No OAuth app or public URL needed.
- Read-only: the inbox is opened with `EXAMINE` and bodies are fetched with `BODY.PEEK`, so nothing is marked as read, sent or deleted.
- Polls every few minutes (default 2). Uses Gmail's search (`X-GM-RAW`) to skip the Promotions, Social and Forums tabs, or to keep only Important mail.
- Starts from "now": the existing backlog is never sent. At most 25 messages are checked per poll.
- No dependencies: `imap.js` is a tiny IMAP client and `mime.js` a tolerant MIME parser.
