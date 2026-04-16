# Beer Pong Night

Single-project full-stack app for running daily beer pong tournaments on one Render instance.

## Stack

- React frontend
- Express backend
- Socket.IO for real-time updates
- MongoDB as the main database
- PWA-ready setup with manifest and service worker

## Current flow

1. The public screen only shows tournament details and a name input.
2. After a player registers, the app tells them to pay at the cashier desk.
3. Players only become confirmed after cashier approval.
4. Admin manually opens and closes registration.
5. When registration closes, a live countdown starts for everyone connected.
6. The app switches to a separate draw screen and reveals teams gradually.
7. Matches are assigned automatically to table 1 and table 2.
8. Admin can mark match winners and keep each table moving live.

## Admin access

- Primary admin name: `AdminArenaBeerPong8768`
- Primary admin password: `admin8768`
- Additional admins and cashiers are created from the app by the primary admin.

## Environment variables

Copy [.env.example](/Users/kevinderitis/Documents/Proyectos/beerpong-app/.env.example) into `.env` and paste your MongoDB connection string in `MONGODB_URI`.

- `PORT`
- `MONGODB_URI`
- `MONGODB_DB_NAME`
- `APP_TIMEZONE`
- `JWT_SECRET`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `DRAW_REVEAL_INTERVAL_MS`
- `DRAW_COUNTDOWN_SECONDS`
- `VAPID_SUBJECT`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`

To enable push notifications while the app is closed, generate VAPID keys and set them in `.env`.

```bash
npx web-push generate-vapid-keys
```

## Run locally

```bash
npm install
npm run dev
```

## Production

```bash
npm run build
npm start
```

## Deploy

Render config is included in [render.yaml](/Users/kevinderitis/Documents/Proyectos/beerpong-app/render.yaml).
