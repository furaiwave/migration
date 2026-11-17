# Docker / VPS

The application can run as one instance on a Linux VPS. React, NestJS and Rust are packaged in one image, with Caddy providing HTTPS. This is a shared workspace for an owner or trusted team: one account, shared sessions and access to the server's network. Per-user data isolation and a multi-tenant SaaS model are not implemented.

## First launch

You need Docker Engine with Compose v2, a domain whose DNS A/AAAA records point to the VPS, and inbound TCP ports 80/443. Do not create an AAAA record unless IPv6 is configured. At least 4 GB RAM is recommended for compiling Rust; Compose limits the running application to 2 GB. On a small VPS, build the image on another machine or in CI.

From the repository root on the VPS:

~~~sh
cp .env.example .env
# Set the actual APP_DOMAIN and APP_USER in .env.
mkdir -p secrets
chmod 700 secrets
docker run --rm node:24-bookworm-slim node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > secrets/app_password.txt
# The file is bind-mounted into a container running as node (UID 1000).
# The private secrets directory protects it on the host; UID 1000 must be able to read the file.
chmod 644 secrets/app_password.txt

docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app proxy
~~~

Open https://your-domain. The browser asks for APP_USER and the password in secrets/app_password.txt, which you can inspect locally with cat. Do not use a database password as the application password. The password is not stored in the image or .env; it is passed as a Compose secret and not exposed in child-process arguments. .env and secrets/ are excluded from Git and the Docker build context.

Caddy obtains and renews certificates automatically. The API is not published on a host port; access goes through HTTPS. Do not expose port 3000 publicly. Built-in authentication uses HTTP Basic, so external access must use HTTPS. You can further restrict VPS access with a VPN or network rules.

## Database connections

Rust runs inside the container. Discovery sees processes and ports in that container, rather than on the user's computer or in neighboring containers. localhost / 127.0.0.1 in a connection form refers to the application container. For a database in another container, use its service DNS name on a shared Docker network. For a database on another server, use an address reachable from the application container. You can edit the address in the import form after source upload.

A database on the user's computer is reachable from the cloud only through a configured private network/VPN and database access rules. MongoDB connections also originate from the VPS. Do not expose a database port to the whole internet for an import. Server discovery and credential checking are separate operations.

## Data and restarts

- The sessions volume stores table files, memo files, CDX indexes and session metadata. Data survives container recreation. Inactive sessions are retained for one day; cleanup runs on startup and new uploads.
- Database passwords stay in form/running-task memory and are not saved in session metadata. Caddy certificates are stored in caddy_data; caddy_config holds its working configuration.
- Import states stay in server memory. Do not update or restart the application during a transfer. After an interrupted import, inspect the destination before retrying: MySQL/MongoDB may contain partial changes. A new instance does not resume the task automatically.
- Run one application replica. Multiple processes do not synchronize jobs or session changes.
- Caddy limits each upload HTTP request to 128 MB including multipart overhead; a single file is limited to 100 MB. Split larger datasets into multiple sessions. Decoded tables may require more memory than their source files.
- The activity console keeps the last 2000 browser events and exports .log files. It is not a centralized audit log. Server logs are available through docker compose logs and rotate across three 10 MB files.

To update, wait for imports to finish, then run docker compose build and docker compose up -d. Sessions are preserved. Do not use docker compose down -v when you want to retain data: -v deletes volumes.

Back up sessions after completing imports:

~~~sh
docker compose stop app
docker compose run --rm --no-deps app tar -C /data/sessions -czf - . > sessions-backup.tar.gz
docker compose start app
~~~

The archive contains source source data. Restrict access to it and verify restore procedures on a separate instance.

## Web process configuration

| Variable | Purpose |
| --- | --- |
| PUBLIC_ORIGIN | The sole interface origin, e.g. https://migration.example.com; Compose derives it from APP_DOMAIN |
| APP_USER | Login for the shared workspace |
| APP_PASSWORD_FILE | Password file path; /run/secrets/app_password in Compose |
| APP_PASSWORD | Alternative to a secret file when using an external secrets manager; cannot be combined with APP_PASSWORD_FILE |
| HOST / PORT | Listening address; the image uses 0.0.0.0:3000 |
| DBF_CLIENT_DIR | Absolute path to the built interface |
| DBF_SESSION_DIR | Absolute path to a writable session directory |
| DBF_CONNECTOR_BIN | Absolute path to the compiled Rust executable |

The web process refuses to start without credentials, a valid origin, the interface, the Rust module or an accessible session directory. The password must contain 16–8192 UTF-8 bytes with no control characters. GET /healthz returns only process status without authentication; it does not check database availability.

To run web mode locally without Docker, build native/db-connector, build client with VITE_API_BASE=/ and VITE_DEPLOYMENT=cloud, then build migration-gateway. Set the variables above and run npm run start:web in migration-gateway. HTTP is suitable for loopback testing; use an HTTPS proxy for external access.

## Verification

- npm test -- --runInBand in migration-gateway checks the API, configuration, authentication and safe file serving.
- npm run test:web in that directory, after building the client, server and Rust module, checks actual startup, authentication, TCP diagnostics, source upload and recovery after restart, including corrupted sessions and Windows paths.
- .github/workflows/cloud.yml builds the Linux Docker image, runs Rust tests, checks Compose/Caddy configuration and smoke-tests the image as an unprivileged user with a read-only filesystem. The workflow does not publish or deploy anything.

Docker was not available in the development environment. The web process was checked locally; verify the Linux image build and Caddy by running the Cloud checks workflow or docker compose build on the VPS.

Configuration references: [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/), [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/), [Caddy HTTPS](https://caddyserver.com/docs/automatic-https).
