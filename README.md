# SAHACHAR Standalone v3.16

This release reorganises the SAHACHAR Admin Console into a proper operational workspace while preserving the existing booking engine, student portal, counsellor dashboard, roster logic, database and SMTP workflow.

## Admin modules
- Dashboard
- Bookings
- Counsellors
- Halls
- Roster
- Block Slots
- Reports
- Audit Log

## Upgrade safety
Preserve the existing `.env` and `data/sahachar.db` when moving from an earlier working version. Do not create a new database if you need to retain existing bookings.

## Running with Docker

The application listens on port `8500` by default.

```sh
docker compose up -d --build
```

Open `http://localhost:8500`.

The SQLite database is stored at `data/sahachar.db`. SQLite may also create
`data/sahachar.db-shm` and `data/sahachar.db-wal`. Docker Compose bind-mounts
the local `data/` directory into the container, so bookings and configuration
survive container rebuilds and restarts. Back up the entire `data/` directory
while the application is stopped.


## Admin Reports Export
Admin Reports supports filtered Excel (.xlsx) export. Exported reports include booking and operational fields, including student contact number, and exclude the private appointment reason.
