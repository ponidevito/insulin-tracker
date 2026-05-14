# Insulin Bot

Telegram bot for tracking insulin injections with Firebase Firestore.

## Features

- Save insulin injections with dose and insulin type.
- Show the last injection.
- Show today's injections.
- Show today's statistics.
- Cancel the last saved injection.

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env`:

```env
BOT_TOKEN=your_telegram_bot_token
```

3. Add Firebase service account file to the project root for local development:

```text
firebase-key.json
```

4. Start the bot:

```bash
npm start
```

## Production Notes

- Do not commit `.env` or Firebase service account files.
- Run only one bot instance when using Telegram long polling.
- For hosting, use a background worker process with `npm start`.
- Set these environment variables on your hosting provider:

```env
BOT_TOKEN=your_telegram_bot_token
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
NODE_ENV=production
```

`FIREBASE_SERVICE_ACCOUNT` should contain the full Firebase service account JSON.

## Railway

1. Create a new Railway project from this GitHub repository.
2. Add variables from `.env.example`.
3. Deploy the service.
4. Check logs for `Bot started`.
