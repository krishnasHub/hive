# WhatsApp channel (beta)

Uses the **official WhatsApp Business Cloud API**. Unofficial "WhatsApp Web" libraries are not used because they can get your number banned.

WhatsApp delivers replies by calling a public webhook, and Hive runs on your laptop. So replies go through a tiny relay that you deploy for free on Cloudflare Workers ([`relay/whatsapp-relay`](../../relay/whatsapp-relay)). The relay checks Meta's signature on every webhook, keeps replies for at most 24 hours, and only hands them to the Hive instance that has your relay secret.

```
Hive ──(Graph API)──▶ WhatsApp ──▶ your phone
your phone ──▶ WhatsApp ──(webhook)──▶ relay ◀──(long poll)── Hive
```

## Setup

1. **Meta app.** At <https://developers.facebook.com/apps> create an app (type *Business*) and add the **WhatsApp** product. Meta gives you a test business number. Under *API Setup*, add your own phone number as a recipient.
2. **Token.** For anything beyond a quick test, create a System User in Business Settings and generate a permanent token with `whatsapp_business_messaging`. The temporary token on the API Setup page expires after 24h.
3. **Relay.** Deploy it:
   ```sh
   cd relay/whatsapp-relay
   npm install
   npx wrangler secret put RELAY_SECRET   # any long random string; also goes into Hive
   npx wrangler secret put VERIFY_TOKEN   # any string; also goes into Meta's webhook form
   npx wrangler secret put APP_SECRET     # Meta app → Settings → Basic → App secret
   npx wrangler deploy
   ```
4. **Webhook.** In the Meta app go to WhatsApp → Configuration → Webhook. Set the callback URL to `https://<your-relay>/webhook` and the verify token to your `VERIFY_TOKEN`, then subscribe to **messages**.
5. **Hive.** Open Settings → Phone channels → WhatsApp. Fill in the token, phone number ID, your number, the relay URL and the relay secret. Enable the plugin, then click **Send test message**.

## The 24-hour rule

WhatsApp only lets a business send you free-form messages within 24 hours of your last message to it. Outside that window you have two options:

- Send any message (e.g. "hi") to the business number before you step away, or
- Set a **wake-up template**, an approved message template such as Meta's default `hello_world`. Hive sends the template, and when you reply it delivers the real notification.
