# Subscription Reconciler

## Run Locally

```bash
docker compose up --build
```

The API listens on `http://localhost:3000` and the mock carrier listens on
`http://localhost:3001`.

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{ "status": "ok" }
```

## Development

The runtime target is Node.js `24.16.0`.

```bash
npm run build
npm run seed
```

`config.ts` validates startup environment before the app or mock carrier begins
listening. `docker-compose.yml` supplies the same variables shown in
`.env.example`.
