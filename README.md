# MERCADO — GitHub / Render deployment

## Project structure
- `server.js` — Express backend, CJ catalogue integration, pricing, CamPay and Telegram.
- `public/index.html` — MERCADO storefront. English is the first-visit default; language selector is in the header.
- `data/products.json` — optional local catalogue fallback.
- `package.json` — Node dependencies and start command.
- `.env.example` — environment variable template. Copy values into Render Environment; do not commit real secrets.

## Deploy
1. Put the contents of this folder at the root of your GitHub repository (not inside another nested folder).
2. In Render, set the service Root Directory to blank / repository root.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add the environment variables listed below in Render. Never commit real API keys.
6. Keep `CAMPAY_ENV=DEMO` until a complete test payment is successful. Only then switch to `PROD`.

## Required Render variables
- `CJ_API_KEY`
- `CAMPAY_ENV=DEMO`
- `CAMPAY_TOKEN` (or `CAMPAY_USERNAME` and `CAMPAY_PASSWORD`)
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `PUBLIC_BASE_URL=https://YOUR-RENDER-SERVICE.onrender.com`
- `PROFIT_USD=10`

Optional: `CORS_ORIGIN`, `ADMIN_KEY`, `MIN_IMG_PX`, `ANTHROPIC_API_KEY`, `DEEPL_API_KEY`, `GOOGLE_TRANSLATE_API_KEY`.

## Important behavior
- The public storefront is branded MERCADO; CJ is only the supplier API behind the server and is not the customer's checkout destination.
- First visit defaults to English; the visitor can select English, French, German, Spanish, Italian or Portuguese. Selection is stored in browser local storage.
- Product variant options are taken from CJ product details. If CJ returns size/colour data in an interpretable format, the site shows size and colour selectors. Otherwise it shows the raw variant option; it must not invent a size.
- The server checks the chosen variant ID and recalculates the current supplier price plus the configured USD margin before creating the CamPay payment link.
- Telegram sends a pending-order notification when the order is saved, and a paid notification after the server confirms the CamPay transaction. Both Telegram environment variables must be configured.
- Email verification / Resend is not used in this project.
- The server records orders locally in `data/orders.json` and payment references in `data/payments.json`; these runtime files are ignored by Git.
- Automatic supplier purchase/fulfilment at CJ after successful payment is NOT implemented in this version; the merchant must place/fulfil the supplier order separately.

## Verification performed
- `node --check server.js`: passed.
- Extracted inline JavaScript from `public/index.html` and ran `node --check`: passed.
- HTML parser check: passed; no duplicate HTML IDs detected.
- JSON parsing for `package.json` and `data/products.json`: passed.
- ZIP integrity test: passed.

These are static checks only. Live CJ API, real CamPay payment, Telegram message delivery, browser behavior on all devices, and Render deployment cannot be certified without the owner's credentials and a live test.
