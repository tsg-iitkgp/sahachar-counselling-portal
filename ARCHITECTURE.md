# SAHACHAR Standalone Architecture

## Principle
SAHACHAR owns the workflow. No ERP, ERP API, or institutional SSO is required.

## Components
- Student web portal
- Counsellor web portal
- Admin web portal
- Express application server
- SQLite development database (PostgreSQL for production)
- SMTP email service
- Session-based authentication

## Booking flow
Student -> email OTP -> choose date/hall -> choose counsellor -> choose free 60-minute slot -> booking transaction -> confirmation -> counsellor notification -> audit log.

## Source of truth
The SAHACHAR database is the source of truth for:
- counsellors
- halls
- weekly roster
- blocked slots
- student profiles
- bookings
- notifications
- audit events

## Security boundary
Student data is not exposed through public availability APIs. Counsellor access is scoped to the authenticated counsellor. Admin access is separate.

## Future production upgrades
PostgreSQL, Redis/session store if needed, HTTPS, rate limiting, structured logging, backups, monitoring, institutional mail, and optional approved SSO.
