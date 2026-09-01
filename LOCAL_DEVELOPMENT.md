# Local Development

Use the backend locally when testing changes before pushing to GitHub or waiting for Render deployment.

## Backend

1. Install dependencies:

```bash
npm install
```

2. Copy the example environment file if needed:

```bash
cp .env.example .env
```

3. Update `.env` with real local development values:

```env
PORT=5002
NODE_ENV=development
MONGO_URI=mongodb+srv://<username>:<password>@<cluster>/laxmiMaterial?retryWrites=true&w=majority
BASE_URL=http://localhost:5002
FRONTEND_URL=http://localhost:5173
CORS_ORIGINS=http://localhost:5173,http://localhost:5174
```

`JWT_SECRET` is required for login. Cloudinary variables are required for intent images and delivery challan uploads.

4. Start the backend:

```bash
npm run dev
```

Expected local API:

```text
http://localhost:5002/api
```

Health check:

```text
http://localhost:5002/api/health
```

## Frontend

In the frontend repository, use:

```env
VITE_API_BASE_URL=http://localhost:5002/api
```

Then run:

```bash
npm run dev -- --host 0.0.0.0 --port 5173
```

Expected local frontend:

```text
http://localhost:5173
```

## Safety

Do not commit `.env`, MongoDB credentials, JWT secrets, Cloudinary secrets, uploaded files, `node_modules`, or build output. Keep production URLs configured in Render/Vercel environment variables.
